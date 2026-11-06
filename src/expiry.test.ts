import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitPalCheckoutClient } from './client.js';

const lineItems = [{ name: 'Pro', amount: '29', currency: 'USDC' }];

function captureBody(): { body: () => Record<string, unknown> } {
  let last: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    last = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ data: { id: 'cs_1', status: 'created' } }), { status: 201 });
  }));
  return { body: () => last };
}

describe('createSession — session expiry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const client = () => new BitPalCheckoutClient({ apiKey: 'bp_test_x' });

  it('sends expires_in_minutes as-is', async () => {
    const cap = captureBody();
    await client().createSession({ line_items: lineItems, expires_in_minutes: 30 });
    expect(cap.body().expires_in_minutes).toBe(30);
  });

  it('converts deprecated expires_in_seconds to minutes (rounded up) and drops the seconds field', async () => {
    const cap = captureBody();
    await client().createSession({ line_items: lineItems, expires_in_seconds: 1800 });
    expect(cap.body().expires_in_minutes).toBe(30);
    expect(cap.body()).not.toHaveProperty('expires_in_seconds');
    await client().createSession({ line_items: lineItems, expires_in_seconds: 90 });
    expect(cap.body().expires_in_minutes).toBe(2);
  });

  it('omits the field when neither is given (server default 15 min)', async () => {
    const cap = captureBody();
    await client().createSession({ line_items: lineItems });
    expect(cap.body()).not.toHaveProperty('expires_in_minutes');
  });

  it('rejects out-of-range or conflicting values before calling the API', async () => {
    captureBody();
    await expect(client().createSession({ line_items: lineItems, expires_in_minutes: 61 })).rejects.toThrow(/1–60 minutes/);
    await expect(client().createSession({ line_items: lineItems, expires_in_seconds: 7200 })).rejects.toThrow(/1–60 minutes/);
    await expect(client().createSession({ line_items: lineItems, expires_in_minutes: 0 })).rejects.toThrow(/1–60 minutes/);
    await expect(
      client().createSession({ line_items: lineItems, expires_in_minutes: 10, expires_in_seconds: 600 }),
    ).rejects.toThrow(/only one/);
  });
});
