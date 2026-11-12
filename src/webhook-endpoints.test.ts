/**
 * webhook-endpoints.test.ts — 웹훅 엔드포인트 관리 리소스(S-10, API 키는 테스트 모드 전용).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitPalCheckoutClient } from './client.js';

function stub(data: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(status < 400 ? { data } : data), { status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}

const client = () => new BitPalCheckoutClient({ apiKey: 'bp_test_1', baseUrl: 'http://api.test' });
const ID = '00000000-0000-4000-8000-000000000001';

describe('webhooks (endpoint management)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('create → POST /v1/webhooks with Idempotency-Key, returns the one-time secret', async () => {
    const calls = stub({ id: ID, secret: 'whsec_once' });
    const { data } = await client().webhooks.create({ endpoint_url: 'https://x.example/h', subscribed_events: ['*'] }, { idempotencyKey: 'reg-0001' });
    expect(data.secret).toBe('whsec_once');
    expect(calls[0]!.url).toBe('http://api.test/v1/webhooks');
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe('reg-0001');
  });

  it('rotateSecret sends an empty body by default; replay sends event_id', async () => {
    const calls = stub({ id: ID });
    await client().webhooks.rotateSecret(ID);
    await client().webhooks.replay(ID, 'evt-1');
    expect(calls[0]!.url).toBe(`http://api.test/v1/webhooks/${ID}/rotate-secret`);
    expect(JSON.parse(String(calls[0]!.init.body ?? '{}'))).toEqual({});
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ event_id: 'evt-1' });
  });

  it('a live key gets the API 403 as BitPalError', async () => {
    stub({ error: 'Live webhook endpoints can only be managed in the console', code: 'FORBIDDEN', retryable: false }, 403);
    await expect(client().webhooks.list()).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });
});
