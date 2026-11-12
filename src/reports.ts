/**
 * reports.ts — reconciliation reports (`GET /v1/checkout/reports/payments|payouts|fees`).
 *
 * Server-side only (secret API key). Only the key's mode (test or live) is included.
 *
 * ```ts
 * const bitpal = new BitPal({ apiKey: process.env.BITPAL_API_KEY! });
 * // One JSON page (newest first) plus totals over the whole range:
 * const { data, meta, summary } = await bitpal.checkout.reports.payouts({ from: '2026-11-01', to: '2026-11-30' });
 * // The whole range as one CSV file:
 * const csv = await bitpal.checkout.reports.csv('payouts', { from: '2026-11-01', to: '2026-11-30' });
 * ```
 *
 * `from` / `to` are UTC dates (`YYYY-MM-DD`), both inclusive. Amounts are atomic integer strings.
 */
import type {
  CheckoutReportKind,
  CheckoutReportParams,
  CheckoutReportRange,
  CheckoutReportResponse,
  FeeReportRow,
  PaymentReportRow,
  PayoutReportRow,
} from './types.js';
import type { CatalogRequester } from './catalog.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function reportQuery(params: CheckoutReportParams | undefined, format: 'json' | 'csv'): string {
  const qs = new URLSearchParams();
  for (const key of ['from', 'to'] as const) {
    const v = params?.[key];
    if (v === undefined) continue;
    if (!DATE_RE.test(v)) throw new Error(`[BitPal] reports: \`${key}\` must be a UTC date like "2026-11-30" — got "${v}".`);
    qs.set(key, v);
  }
  if (format === 'csv') qs.set('format', 'csv');
  else {
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export class ReportsResource {
  constructor(
    private readonly request: CatalogRequester,
    private readonly requestText: (path: string) => Promise<string>,
  ) {}

  /** GET /v1/checkout/reports/payments — sessions created in the range (any status). */
  async payments(params?: CheckoutReportParams): Promise<CheckoutReportResponse<PaymentReportRow>> {
    return this.request('GET', `/v1/checkout/reports/payments${reportQuery(params, 'json')}`);
  }

  /** GET /v1/checkout/reports/payouts — sessions settled to your payout wallet in the range (by `settled_at`). */
  async payouts(params?: CheckoutReportParams): Promise<CheckoutReportResponse<PayoutReportRow>> {
    return this.request('GET', `/v1/checkout/reports/payouts${reportQuery(params, 'json')}`);
  }

  /** GET /v1/checkout/reports/fees — sessions paid in the range (by `paid_at`), with the platform fee. */
  async fees(params?: CheckoutReportParams): Promise<CheckoutReportResponse<FeeReportRow>> {
    return this.request('GET', `/v1/checkout/reports/fees${reportQuery(params, 'json')}`);
  }

  /**
   * The whole range as one RFC 4180 CSV string (`format=csv`) — same columns as the JSON rows,
   * empty cells for null, `metadata` as a JSON string, CRLF line endings.
   */
  async csv(kind: CheckoutReportKind, range?: CheckoutReportRange): Promise<string> {
    return this.requestText(`/v1/checkout/reports/${kind}${reportQuery(range, 'csv')}`);
  }
}
