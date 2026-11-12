/**
 * catalog.ts — Product / immutable Price management resources
 *
 * Server-side only (secret API key). Do not use in the browser.
 *
 * Example:
 * ```ts
 * const bitpal = new BitPal({ apiKey: 'bp_test_...' });
 * const { data: product } = await bitpal.checkout.products.create({ name: 'Pro Plan' });
 * const { data: price } = await bitpal.checkout.prices.create(product.id, {
 *   amount_atomic: toAtomicUSDC('29.00'),
 * });
 * ```
 *
 * Prices are immutable: to change a price, create a new price instead of updating it.
 * `prices.update` only accepts nickname (display metadata) — there is intentionally no helper to change amount fields.
 * To stop selling, set the Payment Link that uses the Price to inactive rather than disabling the Price.
 */
import type {
  ApiResponse,
  IdempotencyOptions,
  ListResponse,
  CheckoutProduct,
  CheckoutPrice,
  CreateProductParams,
  UpdateProductParams,
  CreatePriceParams,
  UpdatePriceParams,
  ListProductsParams,
  ListPricesParams,
  CheckoutPaymentLink,
  CreatePaymentLinkParams,
  UpdatePaymentLinkParams,
  ListPaymentLinksParams,
} from './types.js';

/** Signature used to inject the client's request function into resources */
export type CatalogRequester = <T>(method: string, path: string, body?: unknown, options?: IdempotencyOptions) => Promise<T>;

function toQuery(params?: object): string {
  if (!params) return '';
  const entries = Object.entries(params as Record<string, string | number | undefined>)
    .filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  const qs = new URLSearchParams(entries.map(([k, v]) => [k, String(v)]));
  return `?${qs.toString()}`;
}

export class ProductsResource {
  constructor(private readonly request: CatalogRequester) {}

  /** POST /v1/checkout/products — pass options.idempotencyKey to send an Idempotency-Key header (safe retries). */
  create(params: CreateProductParams, options?: IdempotencyOptions): Promise<ApiResponse<CheckoutProduct>> {
    return this.request('POST', '/v1/checkout/products', params, options);
  }

  /** GET /v1/checkout/products */
  list(params?: ListProductsParams): Promise<ListResponse<CheckoutProduct>> {
    return this.request('GET', `/v1/checkout/products${toQuery(params)}`);
  }

  /** GET /v1/checkout/products/:id */
  retrieve(productId: string): Promise<ApiResponse<CheckoutProduct>> {
    return this.request('GET', `/v1/checkout/products/${encodeURIComponent(productId)}`);
  }

  /** PATCH /v1/checkout/products/:id */
  update(productId: string, params: UpdateProductParams): Promise<ApiResponse<CheckoutProduct>> {
    return this.request('PATCH', `/v1/checkout/products/${encodeURIComponent(productId)}`, params);
  }
}

export class PricesResource {
  constructor(private readonly request: CatalogRequester) {}

  /** POST /v1/checkout/products/:id/prices — supports options.idempotencyKey. */
  create(productId: string, params: CreatePriceParams, options?: IdempotencyOptions): Promise<ApiResponse<CheckoutPrice>> {
    return this.request('POST', `/v1/checkout/products/${encodeURIComponent(productId)}/prices`, params, options);
  }

  /** GET /v1/checkout/products/:id/prices */
  list(productId: string, params?: ListPricesParams): Promise<ListResponse<CheckoutPrice>> {
    return this.request('GET', `/v1/checkout/products/${encodeURIComponent(productId)}/prices${toQuery(params)}`);
  }

  /** GET /v1/checkout/prices/:id */
  retrieve(priceId: string): Promise<ApiResponse<CheckoutPrice>> {
    return this.request('GET', `/v1/checkout/prices/${encodeURIComponent(priceId)}`);
  }

  /**
   * PATCH /v1/checkout/prices/:id — nickname (display metadata) only.
   * Amount fields (amount_atomic etc.) are immutable — the server rejects them with PRICE_IMMUTABLE_FIELD.
   * To change a price, create a new one with `prices.create()`. To stop selling, set the Payment Link that
   * uses the Price to inactive (Prices themselves have no active/inactive state).
   */
  update(priceId: string, params: UpdatePriceParams): Promise<ApiResponse<CheckoutPrice>> {
    return this.request('PATCH', `/v1/checkout/prices/${encodeURIComponent(priceId)}`, params);
  }
}

/**
 * Payment Link resource — create and manage payment links in code, without the dashboard.
 *
 * Flow: create product -> create price -> create payment link. The link<->price binding is fixed after creation.
 *
 * ```ts
 * const { data: product } = await bitpal.checkout.products.create({ name: 'Pro Plan' });
 * const { data: price }   = await bitpal.checkout.prices.create(product.id, { amount: '29' });
 * const { data: link }    = await bitpal.checkout.paymentLinks.create({
 *   price_id: price.id,
 *   allowed_pay_chains: ['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
 * });
 * // Hosted payment page URL: `{checkoutBase}/plink/${link.share_token}`
 * ```
 */
export class PaymentLinksResource {
  constructor(private readonly request: CatalogRequester) {}

  /** POST /v1/checkout/payment-links — supports options.idempotencyKey. */
  create(params: CreatePaymentLinkParams, options?: IdempotencyOptions): Promise<ApiResponse<CheckoutPaymentLink>> {
    return this.request('POST', '/v1/checkout/payment-links', params, options);
  }

  /** GET /v1/checkout/payment-links */
  list(params?: ListPaymentLinksParams): Promise<ListResponse<CheckoutPaymentLink>> {
    return this.request('GET', `/v1/checkout/payment-links${toQuery(params)}`);
  }

  /** GET /v1/checkout/payment-links/:id */
  retrieve(linkId: string): Promise<ApiResponse<CheckoutPaymentLink>> {
    return this.request('GET', `/v1/checkout/payment-links/${encodeURIComponent(linkId)}`);
  }

  /** PATCH /v1/checkout/payment-links/:id */
  update(linkId: string, params: UpdatePaymentLinkParams): Promise<ApiResponse<CheckoutPaymentLink>> {
    return this.request('PATCH', `/v1/checkout/payment-links/${encodeURIComponent(linkId)}`, params);
  }
}
