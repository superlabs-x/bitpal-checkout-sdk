import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitPalCheckoutClient, BitPalError, parseApiErrorBody } from './client.js';

function stubFetch(status: number, body: string, contentType = 'application/json') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': contentType } })));
}

async function catchErr(p: Promise<unknown>): Promise<BitPalError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BitPalError) return e;
    throw e;
  }
  throw new Error('expected BitPalError');
}

describe('BitPalError — API error body parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('standard shape { error: message, code, retryable, trace_id }', async () => {
    stubFetch(403, JSON.stringify({ error: 'Checkout is not enabled', code: 'FEATURE_NOT_ENABLED', retryable: false, trace_id: 'tr_1' }));
    const err = await catchErr(new BitPalCheckoutClient({ apiKey: 'bp_test_x' }).getSession('cs_1'));
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Checkout is not enabled');
    expect(err.code).toBe('FEATURE_NOT_ENABLED');
    expect(err.apiMessage).toBe('Checkout is not enabled');
    expect(err.retryable).toBe(false);
    expect(err.traceId).toBe('tr_1');
  });

  it('legacy shape { error: CODE, message } keeps message = code and exposes apiMessage', async () => {
    stubFetch(400, JSON.stringify({ error: 'INVALID_LINE_ITEMS', message: 'line_items[0].amount must be > 0' }));
    const err = await catchErr(new BitPalCheckoutClient({ apiKey: 'bp_test_x' }).getSession('cs_1'));
    expect(err.message).toBe('INVALID_LINE_ITEMS');
    expect(err.code).toBe('INVALID_LINE_ITEMS');
    expect(err.apiMessage).toBe('line_items[0].amount must be > 0');
  });

  it('non-JSON error body (gateway HTML) → BitPalError, not SyntaxError', async () => {
    stubFetch(502, '<html>Bad Gateway</html>', 'text/html');
    const err = await catchErr(new BitPalCheckoutClient({ apiKey: 'bp_test_x' }).getSession('cs_1'));
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe('HTTP 502');
    expect(err.code).toBeUndefined();
  });

  it('parseApiErrorBody ignores non-objects and lowercase error text as code', () => {
    expect(parseApiErrorBody(null)).toEqual({});
    expect(parseApiErrorBody({ error: 'not found' }).code).toBeUndefined();
  });
});
