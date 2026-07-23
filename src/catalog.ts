/**
 * catalog.ts — Product / immutable Price 관리 리소스 (PROD-LINK-3a-SDK)
 *
 * server-side SDK 전용 (secret API key). 브라우저에서 사용 금지.
 *
 * 사용 예:
 * ```ts
 * const bitpal = new BitPal({ apiKey: 'bp_test_...' });
 * const { data: product } = await bitpal.checkout.products.create({ name: 'Pro Plan' });
 * const { data: price } = await bitpal.checkout.prices.create(product.id, {
 *   amount_atomic: toAtomicUSDC('29.00'),
 * });
 * ```
 *
 * Price immutable 원칙: 가격 변경은 update가 아니라 "새 price 생성"이다.
 * `prices.update`는 nickname(표시 메타)만 받는다 — 금액류 필드 변경 helper는 의도적으로 없다.
 * "그만 팔기"는 Price 를 끄는 게 아니라 그 Price 를 쓰는 Payment Link 를 inactive 로 한다.
 */
import type {
  ApiResponse,
  ListResponse,
  CheckoutProduct,
  CheckoutPrice,
  CreateProductParams,
  UpdateProductParams,
  CreatePriceParams,
  UpdatePriceParams,
  ListProductsParams,
  ListPricesParams,
} from './types.js';

/** client.ts의 private request를 리소스에 주입하기 위한 시그니처 */
export type CatalogRequester = <T>(method: string, path: string, body?: unknown) => Promise<T>;

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

  /** POST /v1/checkout/products */
  create(params: CreateProductParams): Promise<ApiResponse<CheckoutProduct>> {
    return this.request('POST', '/v1/checkout/products', params);
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

  /** POST /v1/checkout/products/:id/prices */
  create(productId: string, params: CreatePriceParams): Promise<ApiResponse<CheckoutPrice>> {
    return this.request('POST', `/v1/checkout/products/${encodeURIComponent(productId)}/prices`, params);
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
   * PATCH /v1/checkout/prices/:id — nickname(표시 메타)만.
   * 금액류 필드(amount_atomic 등)는 immutable — 서버가 PRICE_IMMUTABLE_FIELD로 거부한다.
   * 가격 변경은 `prices.create()`로 새 price를 만들 것. "그만 팔기"는 해당 Price 를 쓰는
   * Payment Link 를 inactive 로 한다(Price 자체에는 active/inactive 개념이 없다).
   */
  update(priceId: string, params: UpdatePriceParams): Promise<ApiResponse<CheckoutPrice>> {
    return this.request('PATCH', `/v1/checkout/prices/${encodeURIComponent(priceId)}`, params);
  }
}
