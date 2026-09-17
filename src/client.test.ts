import { describe, expect, it, vi, afterEach } from 'vitest';
import { BitPalCheckoutClient } from './client.js';

describe('@bitpal/checkout — 안2 deposit-address 결제', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stub(calls: Array<{ url: string; init: RequestInit }>, body: unknown) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
  }

  it('createSession — amount(사람 USD) / amount_atomic(raw μUSD) 그대로 전달(변환은 서버)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    stub(calls, { data: { id: 'cs_1', status: 'created', amount_total: '0', currency: 'USDC', line_items: [] } });
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_1', baseUrl: 'http://api.test' });
    await client.createSession({
      line_items: [
        { name: 'A', amount: '20', currency: 'USDC' },
        { name: 'B', amount: '0.5', currency: 'USDT' },
        { name: 'C', amount_atomic: '1000000', currency: 'USDC' }, // raw μUSD 직접(고급)
      ],
    });
    const sent = JSON.parse(String(calls[0]!.init.body));
    // SDK 는 변환하지 않고 그대로 전달 — API 가 canonical μUSD 로 정규화.
    expect(sent.line_items[0].amount).toBe('20');
    expect(sent.line_items[1].amount).toBe('0.5');
    expect(sent.line_items[2].amount_atomic).toBe('1000000');
  });

  it('createSession — amount/amount_atomic 둘 다 또는 둘 다 없음 → throw', async () => {
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_1', baseUrl: 'http://api.test' });
    await expect(client.createSession({ line_items: [{ name: 'A', currency: 'USDC' } as never] })).rejects.toThrow(/exactly one/);
    await expect(client.createSession({ line_items: [{ name: 'A', currency: 'USDC', amount: '1', amount_atomic: '1000000' } as never] })).rejects.toThrow(/exactly one/);
  });

  it('issueDepositAddress → POST /deposit-address (session_token + chain/token + refundAddress)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    stub(calls, {
      data: {
        sessionId: 'cs_123',
        chain: 'eip155:8453',
        depositAddress: '0x' + 'ab'.repeat(20),
        expectedToken: '0x' + 'cd'.repeat(20),
        expectedAmount: '1000000',
        feeAmount: '15000',
        refundAddress: '0x' + '01'.repeat(20),
        deadline: '1778650000',
        expiresAt: null,
      },
    });
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_123', baseUrl: 'http://api.test' });
    const res = await client.issueDepositAddress('cs_123', {
      session_token: 'sess_secret',
      refundAddress: '0x' + '01'.repeat(20),
      chain: 'eip155:8453',
      token: 'USDC',
    });
    expect(res.data.depositAddress).toBe('0x' + 'ab'.repeat(20));
    expect(res.data.expectedAmount).toBe('1000000');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://api.test/v1/checkout/sessions/cs_123/deposit-address');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      session_token: 'sess_secret',
      refundAddress: '0x' + '01'.repeat(20),
      chain: 'eip155:8453',
      token: 'USDC',
    });
  });

  it('getPublicSession → GET /public (멀티VM payment_options + decimals)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    // EVM(6dp) + BNB USDT(18dp) + Solana(6dp, base58 mint) — chain_id 는 비-EVM 에서 null.
    stub(calls, { data: { id: 'cs_123', status: 'created', token_decimals: 6, payment_options: [
      { caip2: 'eip155:8453', chain_id: 8453, token_symbol: 'USDC', token_address: '0x' + 'cd'.repeat(20), decimals: 6 },
      { caip2: 'eip155:97', chain_id: 97, token_symbol: 'USDT', token_address: '0x' + 'ef'.repeat(20), decimals: 18 },
      { caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', chain_id: null, token_symbol: 'USDC', token_address: '5j85fTizkSWaUWvc5gT1QxPVN5jZayxgQxsMivE8WR37', decimals: 6 },
    ] } });
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_123', baseUrl: 'http://api.test' });
    const res = await client.getPublicSession('cs_123');
    expect(calls[0]!.url).toBe('http://api.test/v1/checkout/sessions/cs_123/public');
    expect(res.data.payment_options[0]!.decimals).toBe(6);
    expect(res.data.payment_options[1]!.decimals).toBe(18); // non-6dp 노출
    expect(res.data.payment_options[2]!.chain_id).toBeNull(); // Solana=비-EVM
    expect(res.data.token_decimals).toBe(6);
  });

  it('issueDepositAddress — Solana base58 refundAddress 통과(EVM 전용 아님)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const solRefund = 'UxV98Jw3fEZwG5afZZQaWgAfdZARemuGfgrneTdq5KR';
    stub(calls, { data: { sessionId: 'cs_9', chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', depositAddress: solRefund, expectedToken: '5j85fTizkSWaUWvc5gT1QxPVN5jZayxgQxsMivE8WR37', expectedAmount: '1000000', feeAmount: '0', refundAddress: solRefund, deadline: '1778650000', expiresAt: null } });
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_123', baseUrl: 'http://api.test' });
    await client.issueDepositAddress('cs_9', { session_token: 's', refundAddress: solRefund, chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', token: 'USDC' });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ refundAddress: solRefund });
  });

  it('getStatus → GET /status (경량 폴링)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    stub(calls, { data: { status: 'deposit_detected', paid_at: null } });
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_123', baseUrl: 'http://api.test' });
    const res = await client.getStatus('cs_123');
    expect(calls[0]!.url).toBe('http://api.test/v1/checkout/sessions/cs_123/status');
    expect(res.data.status).toBe('deposit_detected');
  });

  it('previewFee — 사람 표기는 amount, raw 는 amount_atomic 으로 보낸다', async () => {
    // line item / Price / x402 와 같은 금액 모델. 머천트가 decimals 를 계산하지 않는다.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    stub(calls, { data: { amount: '100000000', fee_rate: '0.015', fee_amount: '1500000', net_amount: '98500000' } });
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_1', baseUrl: 'http://api.test' });

    await client.previewFee('100');
    expect(calls[0]!.url).toContain('amount=100');
    expect(calls[0]!.url).not.toContain('amount_atomic');

    await client.previewFee({ amountAtomic: '100000000' });
    expect(calls[1]!.url).toContain('amount_atomic=100000000');
  });

  it('previewFee — atomic 을 문자열로 넘기던 실수를 잡아준다', async () => {
    // 구 계약(atomic 문자열)을 그대로 넘기면 백배가 되므로 형식에서 끊는다.
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_1', baseUrl: 'http://api.test' });
    await expect(client.previewFee('0.0000001')).rejects.toThrow(/decimal string/);
  });

});

describe('@bitpal/checkout - createSession allowed_pay_chains (MULTICHAIN-MERCHANT-UI-3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch(calls: Array<{ url: string; init: RequestInit }>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ data: { id: 'cs_1', checkout_url: 'http://web.test/pay/cs_1' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }));
  }

  const lineItems = [{ name: 'Pro', amount: '1000000', currency: 'USDC' }];

  it('allowed_pay_chains가 POST body에 그대로 직렬화된다', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    stubFetch(calls);
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_1', baseUrl: 'http://api.test' });
    await client.createSession({
      line_items: lineItems,
      allowed_pay_chains: ['eip155:84532', 'eip155:11155420'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://api.test/v1/checkout/sessions');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      allowed_pay_chains: ['eip155:84532', 'eip155:11155420'],
    });
  });

  it('pay_chain + allowed_pay_chains 동시 지정 → 네트워크 호출 전 throw', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    stubFetch(calls);
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_1', baseUrl: 'http://api.test' });
    await expect(
      client.createSession({
        line_items: lineItems,
        pay_chain: 'eip155:84532',
        allowed_pay_chains: ['eip155:11155420'],
      }),
    ).rejects.toThrow(/mutually exclusive/);
    expect(calls).toHaveLength(0);
  });

  it('pay_chain 단일 사용 회귀 — body에 pay_chain', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    stubFetch(calls);
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_1', baseUrl: 'http://api.test' });
    await client.createSession({ line_items: lineItems, pay_chain: 'eip155:84532' });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ pay_chain: 'eip155:84532' });
  });

});
