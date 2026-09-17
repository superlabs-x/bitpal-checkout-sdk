/**
 * x402 미들웨어 — 돈이 걸린 경계만 잠근다.
 *
 * 특히 두 가지: (1) 같은 결제로 두 번 리소스를 내주지 않는다, (2) HTTP 200 이어도
 * status 가 confirmed 가 아니면 리소스를 내주지 않는다.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { X402Gate, createMemoryReplayStore, decodePaymentHeader, encodePaymentHeader } from './x402.js';
import type { X402PaymentPayload } from './x402.js';

const PAY_TO = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ASSET = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const FROM = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RESOURCE = 'https://api.test/report';

const ACCEPT = {
  scheme: 'exact' as const,
  network: 'base',
  asset: ASSET,
  payTo: PAY_TO,
  maxAmountRequired: '1000000',
  resource: RESOURCE,
  description: '',
  mimeType: 'application/json',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2', chainId: 8453 },
  feeBreakdown: { netAmount: '985000', feeAmount: '15000', feeBps: 150, feeRecipient: '0xfee' },
};

function payload(nonce = `0x${'2'.repeat(64)}`): X402PaymentPayload {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    // x402 표준 payload — 단일 authorization + 65바이트 packed 서명.
    payload: {
      signature: `0x${'1'.repeat(64)}${'3'.repeat(64)}1b`,
      authorization: {
        from: FROM,
        to: PAY_TO,
        // gross 다. 포워더가 받아 net/fee 로 쪼갠다.
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce,
      },
    },
  };
}

/** path 별 응답을 순서대로 꺼내 쓰는 fetch stub. */
function stubFetch(routes: Record<string, Array<{ status: number; body: unknown }>>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      const queue = routes[path];
      const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
      if (!next) throw new Error(`unstubbed ${path}`);
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

function gate(overrides: Partial<ConstructorParameters<typeof X402Gate>[0]> = {}) {
  return new X402Gate({
    apiKey: 'bp_test_1',
    payTo: PAY_TO,
    amount: '1',
    baseUrl: 'http://api.test',
    ...overrides,
  });
}

const REQUIREMENTS_OK = { status: 200, body: { data: { x402Version: 1, accepts: [ACCEPT] } } };
const VERIFY_OK = { status: 200, body: { data: { valid: true, payment_id: 'pay_1', status: 'created' } } };
const SETTLE_OK = {
  status: 200,
  body: {
    data: { success: true, payment_id: 'pay_1', status: 'confirmed', tx_hash: '0xdead', network: 'base' },
  },
};

afterEach(() => vi.restoreAllMocks());

describe('x402 게이트 — 결제 없음', () => {
  it('X-PAYMENT 헤더가 없으면 402 + 결제 조건', async () => {
    stubFetch({ '/v1/x402/requirements': [REQUIREMENTS_OK] });
    const r = await gate().collect({ resource: RESOURCE });
    expect(r.kind).toBe('payment_required');
    expect(r.status).toBe(402);
    expect(r.kind === 'payment_required' && r.body.accepts[0]!.maxAmountRequired).toBe('1000000');
  });

  it('헤더가 깨졌으면 재서명하라고 402 로 돌려준다', async () => {
    stubFetch({ '/v1/x402/requirements': [REQUIREMENTS_OK] });
    const r = await gate().collect({ header: 'not-base64-json', resource: RESOURCE });
    expect(r.kind).toBe('payment_required');
    expect(r.kind === 'payment_required' && r.body.error).toBe('MALFORMED_PAYMENT_HEADER');
  });
});

describe('x402 게이트 — 정상 정산', () => {
  it('verify → settle 후 리소스를 내주고 X-PAYMENT-RESPONSE 를 만든다', async () => {
    const calls = stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_OK],
      '/v1/x402/verify': [VERIFY_OK],
      '/v1/x402/settle': [SETTLE_OK],
    });
    const r = await gate().collect({ header: encodePaymentHeader(payload()), resource: RESOURCE });

    expect(r.kind).toBe('settled');
    expect(calls).toEqual(['/v1/x402/requirements', '/v1/x402/verify', '/v1/x402/settle']);
    if (r.kind !== 'settled') throw new Error('unreachable');
    expect(r.payment.txHash).toBe('0xdead');
    expect(r.payment.payer).toBe(FROM);
    expect(JSON.parse(Buffer.from(r.paymentResponseHeader, 'base64').toString())).toMatchObject({
      success: true,
      transaction: '0xdead',
      network: 'base',
    });
  });

  it('결제 조건은 payer 가 보낸 값이 아니라 서버 값을 쓴다 (금액 바꿔치기 차단)', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        if (init?.body) sent.push({ path, body: JSON.parse(String(init.body)) });
        const body =
          path === '/v1/x402/requirements' ? REQUIREMENTS_OK.body : path === '/v1/x402/verify' ? VERIFY_OK.body : SETTLE_OK.body;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );

    await gate().collect({ header: encodePaymentHeader(payload()), resource: RESOURCE });

    const verify = sent.find(s => (s as { path: string }).path === '/v1/x402/verify') as {
      body: { paymentRequirements: Record<string, string> };
    };
    expect(verify.body.paymentRequirements).toEqual({
      asset: ASSET,
      payTo: PAY_TO,
      maxAmountRequired: '1000000',
      resource: RESOURCE,
    });
  });
});

describe('x402 게이트 — 재사용 차단 (결제 1건 = 응답 1건)', () => {
  it('같은 authorization 으로 두 번째 호출은 409', async () => {
    stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_OK],
      '/v1/x402/verify': [VERIFY_OK],
      '/v1/x402/settle': [SETTLE_OK],
    });
    const g = gate();
    const header = encodePaymentHeader(payload());

    const first = await g.collect({ header, resource: RESOURCE });
    expect(first.kind).toBe('settled');
    if (first.kind !== 'settled') throw new Error('unreachable');
    await first.commit(); // 응답을 실제로 내준 시점 = 소진 확정

    const second = await g.collect({ header, resource: RESOURCE });
    expect(second.kind).toBe('already_used');
    expect(second.status).toBe(409);
  });

  it('응답을 못 내주고 release 하면 같은 헤더로 다시 받을 수 있다', async () => {
    // 핸들러가 throw 한 경우. 결제는 됐는데 리소스를 못 줬으니 409 로 막으면 안 된다.
    stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_OK],
      '/v1/x402/verify': [VERIFY_OK],
      '/v1/x402/settle': [SETTLE_OK],
    });
    const g = gate();
    const header = encodePaymentHeader(payload());

    const first = await g.collect({ header, resource: RESOURCE });
    if (first.kind !== 'settled') throw new Error('unreachable');
    await first.release();

    const retry = await g.collect({ header, resource: RESOURCE });
    expect(retry.kind).toBe('settled');
  });

  it('commit 전(= 처리 중)에 같은 결제가 또 오면 리소스를 내주지 않는다', async () => {
    stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_OK],
      '/v1/x402/verify': [VERIFY_OK],
      '/v1/x402/settle': [SETTLE_OK],
    });
    const g = gate();
    const header = encodePaymentHeader(payload());

    const first = await g.collect({ header, resource: RESOURCE });
    expect(first.kind).toBe('settled');
    const concurrent = await g.collect({ header, resource: RESOURCE });
    expect(concurrent.kind).toBe('unconfirmed');
  });

  it('nonce 가 다르면 별개 결제로 통과한다', async () => {
    stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_OK],
      '/v1/x402/verify': [VERIFY_OK],
      '/v1/x402/settle': [SETTLE_OK],
    });
    const g = gate();
    expect((await g.collect({ header: encodePaymentHeader(payload()), resource: RESOURCE })).kind).toBe('settled');
    const other = await g.collect({ header: encodePaymentHeader(payload(`0x${'4'.repeat(64)}`)), resource: RESOURCE });
    expect(other.kind).toBe('settled');
  });

  it('settle 실패로 소진되지 않은 결제는 같은 헤더로 재시도할 수 있다', async () => {
    stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_OK, REQUIREMENTS_OK],
      '/v1/x402/verify': [VERIFY_OK, VERIFY_OK],
      '/v1/x402/settle': [{ status: 503, body: { error: 'PAYMENT_PENDING' } }, SETTLE_OK],
    });
    const g = gate();
    const header = encodePaymentHeader(payload());

    const first = await g.collect({ header, resource: RESOURCE });
    expect(first.kind).toBe('unconfirmed');
    // 여기서 402 를 주면 payer 가 다시 서명해 이중 지불한다 — 반드시 unconfirmed 여야 한다.
    expect(first.status).toBe(503);

    const retry = await g.collect({ header, resource: RESOURCE });
    expect(retry.kind).toBe('settled');
  });
});

describe('x402 게이트 — 실패 매핑', () => {
  it('verify 4xx(서명/금액 불일치)는 402 로 되돌려 재서명을 유도한다', async () => {
    stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_OK],
      '/v1/x402/verify': [{ status: 400, body: { error: 'AMOUNT_MISMATCH' } }],
    });
    const r = await gate().collect({ header: encodePaymentHeader(payload()), resource: RESOURCE });
    expect(r.kind).toBe('payment_required');
    expect(r.kind === 'payment_required' && r.body.error).toBe('AMOUNT_MISMATCH');
  });

  it('settle 이 200 이어도 status 가 confirmed 가 아니면 리소스를 내주지 않는다', async () => {
    // 이미 reverted 로 종결된 결제를 다시 settle 하면 서버는 그 결과를 200 으로 돌려준다.
    stubFetch({
      '/v1/x402/requirements': [REQUIREMENTS_OK],
      '/v1/x402/verify': [VERIFY_OK],
      '/v1/x402/settle': [
        {
          status: 200,
          body: { data: { success: true, payment_id: 'pay_1', status: 'reverted', tx_hash: '0xbad', network: 'base' } },
        },
      ],
    });
    const r = await gate().collect({ header: encodePaymentHeader(payload()), resource: RESOURCE });
    expect(r.kind).toBe('payment_required');
    expect(r.kind === 'payment_required' && r.body.error).toBe('PAYMENT_REVERTED');
  });

  it('settle 200 + 미확정 상태(submitted 등)는 402 가 아니라 503 — 재서명은 이중 지불이다', async () => {
    // 자금이 이미 움직였을 수 있는 상태다. 여기서 402 를 주면 payer 가 새 authorization 에
    // 서명해 두 번 낸다. reverted/expired/failed 만 재서명 대상이다.
    for (const status of ['created', 'submitted', 'unknown', 'reconciliation_needed']) {
      stubFetch({
        '/v1/x402/requirements': [REQUIREMENTS_OK],
        '/v1/x402/verify': [VERIFY_OK],
        '/v1/x402/settle': [
          {
            status: 200,
            body: { data: { success: true, payment_id: 'pay_1', status, tx_hash: null, network: 'base' } },
          },
        ],
      });
      const r = await gate().collect({ header: encodePaymentHeader(payload()), resource: RESOURCE });
      expect(r.kind, `status=${status}`).toBe('unconfirmed');
      expect(r.status).toBe(503);
    }
  });

  it('요청 검증 — payTo 형식이 틀리면 생성 시점에 막는다', () => {
    expect(() => gate({ payTo: 'not-an-address' })).toThrow(/payTo/);
  });

  it('금액은 사람 표기 amount XOR raw amountAtomic 이다', () => {
    // 체크아웃 line item / Price 와 같은 모델 — 머천트가 decimals 를 계산하지 않는다.
    expect(() => gate({ amount: undefined })).toThrow(/exactly one/);
    expect(() => gate({ amount: '1', amountAtomic: '1000000' })).toThrow(/exactly one/);
    expect(() => gate({ amount: '0.0000001' })).toThrow(/decimal string/);
    expect(() => gate({ amount: undefined, amountAtomic: '1.5' })).toThrow(/integer string/);
    expect(() => gate({ amount: '0.1' })).not.toThrow();
    expect(() => gate({ amount: undefined, amountAtomic: '100000' })).not.toThrow();
  });

  it('사람 표기는 amount 로, raw 는 amountAtomic 으로 서버에 보낸다 (변환은 서버 몫)', async () => {
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      if (init?.body) sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(REQUIREMENTS_OK.body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    await gate({ amount: '0.1' }).requirements(RESOURCE);
    expect(sent[0]).toMatchObject({ amount: '0.1' });
    expect(sent[0]).not.toHaveProperty('amountAtomic');

    sent.length = 0;
    await gate({ amount: undefined, amountAtomic: '100000' }).requirements(RESOURCE);
    expect(sent[0]).toMatchObject({ amountAtomic: '100000' });
    expect(sent[0]).not.toHaveProperty('amount');
  });
});

describe('헤더 인코딩 / replay store', () => {
  it('encode → decode 왕복', () => {
    const p = payload();
    expect(decodePaymentHeader(encodePaymentHeader(p))).toEqual(p);
  });

  it('평문 JSON 헤더도 받아준다', () => {
    const p = payload();
    expect(decodePaymentHeader(JSON.stringify(p))).toEqual(p);
  });

  it('형태가 틀린 헤더는 거부한다 (인증 전 외부 입력)', () => {
    const bad = (mut: (p: X402PaymentPayload) => void) => {
      const p = payload();
      mut(p);
      return () => decodePaymentHeader(JSON.stringify(p));
    };
    expect(bad(p => { p.payload.authorization.from = 'nope'; })).toThrow(/authorization.from/);
    expect(bad(p => { p.payload.authorization.value = '-1'; })).toThrow(/authorization.value/);
    expect(bad(p => { p.payload.authorization.nonce = '0x1234'; })).toThrow(/authorization.nonce/);
    expect(bad(p => { p.payload.signature = '0xdead'; })).toThrow(/payload.signature/);
    expect(bad(p => { (p as { x402Version: number }).x402Version = 2; })).toThrow(/x402Version/);
    expect(() => decodePaymentHeader('x'.repeat(9000))).toThrow(/too large/);
  });

  it('검증된 필드만 통과시킨다 — 임의 키가 API 바디로 새지 않는다', () => {
    const p = payload() as unknown as Record<string, unknown>;
    (p.payload as { authorization: Record<string, unknown> }).authorization.__proto__x = 'evil';
    (p.payload as { authorization: Record<string, unknown> }).authorization.extra = 'junk';
    const decoded = decodePaymentHeader(JSON.stringify(p));
    expect(Object.keys(decoded.payload.authorization).sort()).toEqual(
      ['from', 'nonce', 'to', 'validAfter', 'validBefore', 'value'],
    );
  });

  it('memory store — claim 은 한 번만 ok, commit 후엔 used', async () => {
    const store = createMemoryReplayStore();
    expect(await store.claim('k', 300)).toBe('ok');
    expect(await store.claim('k', 300)).toBe('inflight');
    await store.commit('k');
    expect(await store.claim('k', 300)).toBe('used');
    await store.release('k');
    expect(await store.claim('k', 300)).toBe('ok');
  });
});
