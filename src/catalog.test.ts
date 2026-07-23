/**
 * PROD-LINK-3a-SDK — Product/Price 관리 helper 테스트 (fetch stub)
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { BitPalCheckoutClient } from './client.js';
import type { UpdatePriceParams } from './types.js';

function stubFetch(responseData: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: responseData }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

function makeClient() {
  return new BitPalCheckoutClient({ apiKey: 'bp_test_123', baseUrl: 'http://api.test' });
}

describe('@bitpal/checkout - products/prices resources', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('products.create → POST /v1/checkout/products (API key 헤더 포함)', async () => {
    const calls = stubFetch({ id: 'prod_1', name: 'Pro Plan' });
    const client = makeClient();

    const res = await client.products.create({ name: 'Pro Plan', description: 'desc' });
    expect(res.data.id).toBe('prod_1');
    expect(calls[0]!.url).toBe('http://api.test/v1/checkout/products');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: 'Pro Plan', description: 'desc' });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer bp_test_123');
  });

  it('products.list → GET 쿼리 직렬화 (undefined 제외)', async () => {
    const calls = stubFetch([]);
    await makeClient().products.list({ status: 'active', limit: 10 });
    expect(calls[0]!.url).toBe('http://api.test/v1/checkout/products?status=active&limit=10');
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('products.retrieve / update → id 경로 인코딩', async () => {
    const calls = stubFetch({ id: 'prod_2' });
    const client = makeClient();
    await client.products.retrieve('prod_2');
    await client.products.update('prod_2', { status: 'inactive' });
    expect(calls[0]!.url).toBe('http://api.test/v1/checkout/products/prod_2');
    expect(calls[1]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ status: 'inactive' });
  });

  it('prices.create → POST /products/:id/prices (nested)', async () => {
    const calls = stubFetch({ id: 'price_1', amount_atomic: '29000000' });
    const res = await makeClient().prices.create('prod_2', { amount_atomic: '29000000' });
    expect(res.data.id).toBe('price_1');
    expect(calls[0]!.url).toBe('http://api.test/v1/checkout/products/prod_2/prices');
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('prices.list / retrieve / update 경로 매핑', async () => {
    const calls = stubFetch({ id: 'price_1' });
    const client = makeClient();
    await client.prices.list('prod_2');
    await client.prices.retrieve('price_1');
    await client.prices.update('price_1', { nickname: 'v1' });
    expect(calls[0]!.url).toBe('http://api.test/v1/checkout/products/prod_2/prices');
    expect(calls[1]!.url).toBe('http://api.test/v1/checkout/prices/price_1');
    expect(calls[2]!.url).toBe('http://api.test/v1/checkout/prices/price_1');
    expect(calls[2]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ nickname: 'v1' });
  });

  it('UpdatePriceParams는 nickname만 — immutable/lifecycle 필드는 타입에 없음', () => {
    // 컴파일 타임 보증: 아래는 타입 에러가 나야 정상 (런타임 단언은 키 목록으로)
    const params: UpdatePriceParams = { nickname: 'x' };
    // @ts-expect-error active는 제거됨 — Price 는 lifecycle 없는 immutable record (PRICE-LIFECYCLE-2)
    const bad0: UpdatePriceParams = { active: false };
    // @ts-expect-error amount_atomic은 immutable — UpdatePriceParams에 없음
    const bad1: UpdatePriceParams = { amount_atomic: '1' };
    // @ts-expect-error token_address는 Price에 존재하지 않음 (chain-agnostic)
    const bad2: UpdatePriceParams = { token_address: '0x0' };
    void bad0; void bad1; void bad2;
    expect(Object.keys(params).sort()).toEqual(['nickname']);
  });
});
