/**
 * x402 `upto` 게이트 — exact 와 **순서가 뒤집힌** 경로의 경계만 잠근다.
 *
 * exact 는 정산하고 나서 응답한다. upto 는 청구액이 핸들러의 결과물이라 **검증 → 핸들러 →
 * 청구** 순이다. 순서가 뒤집히면 위험도 뒤집힌다 — "일은 해줬는데 청구가 실패"가 새로 생기고,
 * "상한만 승인했는데 그 이상 청구"가 가능해진다. 아래는 그 둘과, 전송 계층이 v1 로 되돌아가지
 * 않는지를 잠근다.
 *
 * v2 봉투·헤더 모양은 상상한 게 아니라 순정 `@x402/*` 2.31.0 이 실제로 보내는 것을 채집한
 * 것이다(scripts/x402-upto-stock-client-probe.mjs).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { X402Gate } from './x402.js';
import {
  decodePaymentSignatureHeader,
  X402_PAYMENT_REQUIRED_HEADER,
  type X402V2PaymentPayload,
  type Permit2Authorization,
} from './x402-v2.js';

const MERCHANT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FORWARDER = '0xdddddddddddddddddddddddddddddddddddddddd';
const ASSET = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const FROM = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SETTLER = '0xcccccccccccccccccccccccccccccccccccccccc';
const PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';
const RESOURCE = 'https://api.test/summarize';

const ACCEPT = {
  scheme: 'upto' as const,
  network: 'eip155:8453',
  asset: ASSET,
  payTo: FORWARDER,
  amount: '5000000', // 상한 5 USDC
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2', chainId: 8453, facilitatorAddress: SETTLER },
  feeBreakdown: { feeBps: 150, feeRecipient: '0xfee' },
};

const REQUIREMENTS_V2 = {
  status: 200,
  body: {
    data: {
      x402Version: 2,
      resource: { url: RESOURCE, mimeType: 'application/json' },
      accepts: [ACCEPT],
    },
  },
};

function uptoPayload(nonce = '12345678901234567890'): X402V2PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: RESOURCE, mimeType: 'application/json' },
    // ★ scheme·network 가 여기 안에 있다. 최상위가 아니다.
    //   복사본을 넘긴다 — 참조로 두면 변조 테스트가 서버 응답(REQUIREMENTS_V2)까지 오염시킨다.
    accepted: structuredClone(ACCEPT),
    payload: {
      signature: `0x${'1'.repeat(64)}${'3'.repeat(64)}1b`,
      permit2Authorization: {
        permitted: { token: ASSET, amount: '5000000' },
        from: FROM,
        spender: PROXY,
        nonce,
        deadline: '9999999999',
        witness: { to: FORWARDER, facilitator: SETTLER, validAfter: '0' },
      },
    },
  };
}

const sigHeader = (p = uptoPayload()): string => Buffer.from(JSON.stringify(p), 'utf8').toString('base64');

function stubFetch(routes: Record<string, Array<{ status: number; body: unknown }>>) {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      const path = new URL(url).pathname;
      bodies.push({ path, body: init?.body ? JSON.parse(init.body) : {} });
      const queue = routes[path];
      const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
      if (!next) throw new Error(`unstubbed ${path}`);
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return bodies;
}

function gate(overrides: Partial<ConstructorParameters<typeof X402Gate>[0]> = {}) {
  return new X402Gate({
    apiKey: 'bp_test_1',
    payTo: MERCHANT,
    scheme: 'upto',
    amount: '5',
    baseUrl: 'http://api.test',
    ...overrides,
  });
}

const VERIFY_OK = { status: 200, body: { data: { valid: true, payment_id: 'pay_u1', status: 'authorized' } } };
const settleOk = (status = 'confirmed') => ({
  status: 200,
  body: {
    data: { success: true, payment_id: 'pay_u1', status, tx_hash: '0xbeef', network: 'eip155:8453' },
  },
});

afterEach(() => vi.restoreAllMocks());

describe('x402 upto — 402 전송', () => {
  it('결제가 없으면 402 의 요구사항이 **헤더**로 나간다 (바디 아님)', async () => {
    // 순정 v2 클라이언트는 바디를 x402Version===1 일 때만 읽는다. 바디로만 주면 못 본다.
    stubFetch({ '/v1/x402/requirements': [REQUIREMENTS_V2] });
    const r = await gate().collect({ resource: RESOURCE });

    expect(r.kind).toBe('payment_required');
    if (r.kind !== 'payment_required') return;
    expect(r.status).toBe(402);
    expect(r.headers?.[X402_PAYMENT_REQUIRED_HEADER]).toBeTruthy();
    expect(r.headers?.['Cache-Control']).toBe('no-store');
    expect('accepts' in r.body).toBe(false);

    const decoded = JSON.parse(
      Buffer.from(r.headers![X402_PAYMENT_REQUIRED_HEADER]!, 'base64').toString('utf8'),
    );
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe(RESOURCE);
    expect(decoded.accepts[0].amount).toBe('5000000');
  });

  it('/requirements 에 scheme=upto 를 싣는다', async () => {
    const bodies = stubFetch({ '/v1/x402/requirements': [REQUIREMENTS_V2] });
    await gate().collect({ resource: RESOURCE });
    expect(bodies[0]!.body.scheme).toBe('upto');
  });

  it('서버가 v1 바디를 돌려주면 조용히 넘어가지 않는다', async () => {
    // 설정 실수(allow_x402 는 켰는데 upto 미지원 체인 등)를 500 으로 드러낸다.
    stubFetch({
      '/v1/x402/requirements': [{ status: 200, body: { data: { x402Version: 1, accepts: [] } } }],
    });
    await expect(gate().collect({ resource: RESOURCE })).rejects.toThrow(/v2 \(upto\) 402/);
  });
});

describe('x402 upto — 검증 → 핸들러 → 청구', () => {
  it('collect 는 검증까지만 한다 — settle 을 부르지 않는다', async () => {
    const bodies = stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_V2],
      '/v1/x402/verify': [VERIFY_OK],
    });
    const r = await gate().collect({ paymentSignature: sigHeader(), resource: RESOURCE });

    expect(r.kind).toBe('authorized');
    if (r.kind !== 'authorized') return;
    expect(r.maxAmount).toBe('5000000');
    expect(r.payer).toBe(FROM);
    // settle 이 안 불렸다는 게 핵심 — 핸들러가 돌기 전에 돈이 움직이면 upto 가 아니다.
    expect(bodies.some(b => b.path === '/v1/x402/settle')).toBe(false);
  });

  it('verify 는 **상한**으로, settle 은 **실청구액**으로 부른다', async () => {
    const bodies = stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_V2],
      '/v1/x402/verify': [VERIFY_OK],
      '/v1/x402/settle': [settleOk()],
    });
    const r = await gate().collect({ paymentSignature: sigHeader(), resource: RESOURCE });
    if (r.kind !== 'authorized') throw new Error(r.kind);
    const charged = await r.charge('2.00');

    const amountSent = (path: string): string =>
      (bodies.find(b => b.path === path)!.body as { paymentRequirements: { amount: string } })
        .paymentRequirements.amount;
    expect(amountSent('/v1/x402/verify')).toBe('5000000');
    expect(amountSent('/v1/x402/settle')).toBe('2000000');

    expect(charged.kind).toBe('charged');
    if (charged.kind !== 'charged') return;
    expect(charged.payment.amount).toBe('2000000');
    expect(charged.paymentResponseHeader).toBeTruthy();
  });

  it('merchant 는 우리 설정값을 보낸다 — 결제자가 고른 accepted 가 아니다', async () => {
    // accepted 를 믿으면 결제자가 목적지를 바꿔치기할 수 있다.
    const tampered = uptoPayload();
    (tampered.accepted as Record<string, unknown>).payTo = '0x9999999999999999999999999999999999999999';
    const bodies = stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_V2],
      '/v1/x402/verify': [VERIFY_OK],
    });
    await gate().collect({ paymentSignature: sigHeader(tampered), resource: RESOURCE });

    const reqs = bodies.find(b => b.path === '/v1/x402/verify')!.body as {
      paymentRequirements: { merchant: string; payTo: string };
    };
    expect(reqs.paymentRequirements.merchant).toBe(MERCHANT);
    expect(reqs.paymentRequirements.payTo).toBe(FORWARDER); // 서버가 준 값
  });

  it('상한을 넘겨 청구하면 네트워크를 타기 전에 막는다', async () => {
    stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_V2],
      '/v1/x402/verify': [VERIFY_OK],
    });
    const r = await gate().collect({ paymentSignature: sigHeader(), resource: RESOURCE });
    if (r.kind !== 'authorized') throw new Error(r.kind);
    // 서버도 막지만, 여기서 막아야 머천트가 자기 버그를 즉시 안다.
    await expect(r.charge('6.00')).rejects.toThrow(/exceeds the approved ceiling/);
  });

  it('사람 표기를 원자 단위로 정확히 바꾼다 (부동소수 금지)', async () => {
    const bodies = stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_V2],
      '/v1/x402/verify': [VERIFY_OK],
      '/v1/x402/settle': [settleOk()],
    });
    const r = await gate().collect({ paymentSignature: sigHeader(), resource: RESOURCE });
    if (r.kind !== 'authorized') throw new Error(r.kind);
    await r.charge('0.000001'); // 1 atomic unit
    const settleBody = bodies.find(b => b.path === '/v1/x402/settle')!.body as {
      paymentRequirements: { amount: string };
    };
    expect(settleBody.paymentRequirements.amount).toBe('1');
  });

  it('0 청구는 온체인 거래 없이 종결된다', async () => {
    stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_V2],
      '/v1/x402/verify': [VERIFY_OK],
      '/v1/x402/settle': [settleOk('voided')],
    });
    const r = await gate().collect({ paymentSignature: sigHeader(), resource: RESOURCE });
    if (r.kind !== 'authorized') throw new Error(r.kind);
    const charged = await r.charge('0');
    expect(charged.kind).toBe('voided');
  });
});

describe('x402 upto — 재사용 차단', () => {
  it('청구까지 끝난 승인은 두 번째 요청에서 409', async () => {
    stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_V2, REQUIREMENTS_V2],
      '/v1/x402/verify': [VERIFY_OK, VERIFY_OK],
      '/v1/x402/settle': [settleOk()],
    });
    const g = gate();
    const first = await g.collect({ paymentSignature: sigHeader(), resource: RESOURCE });
    if (first.kind !== 'authorized') throw new Error(first.kind);
    await first.charge('2.00');

    const second = await g.collect({ paymentSignature: sigHeader(), resource: RESOURCE });
    expect(second.kind).toBe('already_used');
  });

  it('청구 전에 release 하면 같은 승인으로 다시 시도할 수 있다', async () => {
    // 핸들러가 터졌을 때 결제자가 돈만 묶이고 아무것도 못 받는 상태가 되면 안 된다.
    stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_V2, REQUIREMENTS_V2],
      '/v1/x402/verify': [VERIFY_OK, VERIFY_OK],
    });
    const g = gate();
    const first = await g.collect({ paymentSignature: sigHeader(), resource: RESOURCE });
    if (first.kind !== 'authorized') throw new Error(first.kind);
    await first.release();

    const second = await g.collect({ paymentSignature: sigHeader(), resource: RESOURCE });
    expect(second.kind).toBe('authorized');
  });

  it('정산 결과를 모르면 claim 을 쥐고 있는다 — 재서명 유도 금지', async () => {
    // 여기서 402 를 돌려주면 결제자가 새로 서명해 **두 번 낼 수** 있다.
    stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_V2],
      '/v1/x402/verify': [VERIFY_OK],
      '/v1/x402/settle': [{ status: 502, body: { error: 'upstream' } }],
    });
    const r = await gate().collect({ paymentSignature: sigHeader(), resource: RESOURCE });
    if (r.kind !== 'authorized') throw new Error(r.kind);
    const charged = await r.charge('2.00');
    expect(charged.kind).toBe('unconfirmed');
  });
});

describe('x402 upto — 헤더 파싱', () => {
  it('망가진 PAYMENT-SIGNATURE 는 402 로 돌려준다 (크래시 아님)', async () => {
    stubFetch({ '/v1/x402/requirements': [REQUIREMENTS_V2] });
    const r = await gate().collect({ paymentSignature: 'not-base64!!', resource: RESOURCE });
    expect(r.kind).toBe('payment_required');
    if (r.kind === 'payment_required') expect(r.body.error).toBe('MALFORMED_PAYMENT_SIGNATURE');
  });

  it('v1 평면 봉투는 upto 로 받지 않는다', async () => {
    // scheme 이 최상위에 있는 건 v1 이다. 받아 주면 accepted 없이 분기가 진행된다.
    const flat = Buffer.from(
      JSON.stringify({ x402Version: 2, scheme: 'upto', network: 'eip155:8453', payload: uptoPayload().payload }),
      'utf8',
    ).toString('base64');
    stubFetch({ '/v1/x402/requirements': [REQUIREMENTS_V2] });
    const r = await gate().collect({ paymentSignature: flat, resource: RESOURCE });
    expect(r.kind).toBe('payment_required');
  });

  it('ERC-6492 래핑 서명은 길이로 거부하지 않는다', () => {
    // 스마트 계정 결제자의 서명은 65바이트보다 길다.
    const p = uptoPayload();
    p.payload.signature = `0x${'ab'.repeat(400)}`;
    expect(() => decodePaymentSignatureHeader(sigHeader(p))).not.toThrow();
  });

  it('주소·숫자 필드가 망가지면 거부한다', () => {
    for (const mutate of [
      (p: X402V2PaymentPayload) => ((p.payload as { permit2Authorization: Permit2Authorization }).permit2Authorization.from = 'nope'),
      (p: X402V2PaymentPayload) => ((p.payload as { permit2Authorization: Permit2Authorization }).permit2Authorization.nonce = '0xdeadbeef'), // 10진이어야 한다
      (p: X402V2PaymentPayload) => ((p.payload as { permit2Authorization: Permit2Authorization }).permit2Authorization.witness.to = ''),
    ]) {
      const p = uptoPayload();
      mutate(p);
      expect(() => decodePaymentSignatureHeader(sigHeader(p))).toThrow();
    }
  });
});

describe('x402 upto — exact 와 섞이지 않는다', () => {
  it('Express 미들웨어는 upto 를 받지 않는다', async () => {
    const { x402 } = await import('./x402.js');
    // 청구액은 핸들러의 결과물이라 투명 미들웨어가 알 수 없다. 조용히 exact 처럼 굴면 안 된다.
    expect(() => x402({ apiKey: 'bp_test_1', payTo: MERCHANT, scheme: 'upto', amount: '5' })).toThrow(
      /Express middleware supports scheme 'exact' only/,
    );
  });

  it('scheme 기본값은 exact 다', async () => {
    const bodies = stubFetch({
      '/v1/x402/requirements': [
        { status: 200, body: { data: { x402Version: 2, resource: { url: RESOURCE }, accepts: [{ ...ACCEPT, scheme: 'exact' }] } } },
      ],
    });
    await new X402Gate({ apiKey: 'bp_test_1', payTo: MERCHANT, amount: '1', baseUrl: 'http://api.test' })
      .collect({ resource: RESOURCE });
    expect(bodies[0]!.body.scheme).toBeUndefined();
  });
});
