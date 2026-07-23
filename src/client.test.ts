import { describe, expect, it, vi, afterEach } from 'vitest';
import { BitPalCheckoutClient } from './client.js';

describe('@bitpal/checkout — deposit-address 결제', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stub(calls: Array<{ url: string; init: RequestInit }>, body: unknown) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
  }

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

  it('getPublicSession → GET /public (인증 불요, payment_options)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    stub(calls, { data: { id: 'cs_123', status: 'created', payment_options: [{ caip2: 'eip155:8453', chain_id: 8453, token_symbol: 'USDC', token_address: '0x' + 'cd'.repeat(20) }] } });
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_123', baseUrl: 'http://api.test' });
    const res = await client.getPublicSession('cs_123');
    expect(calls[0]!.url).toBe('http://api.test/v1/checkout/sessions/cs_123/public');
    expect(res.data.payment_options[0]!.token_symbol).toBe('USDC');
  });

  it('getStatus → GET /status (경량 폴링)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    stub(calls, { data: { status: 'deposit_detected', paid_at: null } });
    const client = new BitPalCheckoutClient({ apiKey: 'bp_test_123', baseUrl: 'http://api.test' });
    const res = await client.getStatus('cs_123');
    expect(calls[0]!.url).toBe('http://api.test/v1/checkout/sessions/cs_123/status');
    expect(res.data.status).toBe('deposit_detected');
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
