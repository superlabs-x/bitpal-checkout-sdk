/**
 * reports.test.ts — 정산 리포트 리소스(S-8): 경로·쿼리 직렬화, CSV 는 텍스트 그대로, 날짜 형식 사전 검증.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitPalCheckoutClient, BitPalError } from './client.js';

function stub(body: string, status = 200, contentType = 'application/json') {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(body, { status, headers: { 'Content-Type': contentType } });
    }),
  );
  return calls;
}

const client = () => new BitPalCheckoutClient({ apiKey: 'bp_test_1', baseUrl: 'http://api.test' });

describe('reports', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('payouts() → GET JSON page with range + paging', async () => {
    const calls = stub(JSON.stringify({ data: [], meta: { total: 0, limit: 10, offset: 0 }, summary: { total_count: 0 } }));
    const res = await client().reports.payouts({ from: '2026-11-01', to: '2026-11-30', limit: 10 });
    expect(calls[0]).toBe('http://api.test/v1/checkout/reports/payouts?from=2026-11-01&to=2026-11-30&limit=10');
    expect(res.meta.total).toBe(0);
  });

  it('csv() returns the raw CSV text and ignores paging', async () => {
    const csv = 'session_id,paid_at\r\ncs_1,2026-11-10T00:00:00.000Z\r\n';
    const calls = stub(csv, 200, 'text/csv');
    expect(await client().reports.csv('fees', { from: '2026-11-01' })).toBe(csv);
    expect(calls[0]).toBe('http://api.test/v1/checkout/reports/fees?from=2026-11-01&format=csv');
  });

  it('csv() errors still surface as BitPalError with the API code', async () => {
    stub(JSON.stringify({ error: 'bad', code: 'VALIDATION_FAILED', retryable: false }), 400);
    await expect(client().reports.csv('payments')).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' });
    await expect(client().reports.csv('payments')).rejects.toBeInstanceOf(BitPalError);
  });

  it('rejects a non-date `from`/`to` before calling the API', async () => {
    const calls = stub('{}');
    await expect(client().reports.payments({ from: '2026-11-01T00:00:00Z' })).rejects.toThrow(/UTC date/);
    expect(calls).toHaveLength(0);
  });
});
