/**
 * @bitpal/checkout — BitPal Checkout SDK
 *
 * 체크아웃 세션 생성, 결제 링크 관리, 수수료 미리보기를 위한 공식 SDK
 *
 * @example
 * ```ts
 * import { BitPal } from '@bitpal/checkout';
 *
 * const bitpal = new BitPal({ apiKey: 'bp_test_...' });
 *
 * const { data: session } = await bitpal.checkout.createSession({
 *   // amount 는 원자 단위 μUSDC 문자열(6 decimals). $29.00 → '29000000'. toAtomicUSDC 사용 권장.
 *   line_items: [{ name: 'Pro Plan', amount: toAtomicUSDC('29.00'), currency: 'USDC' }],
 * });
 *
 * console.log(session.url); // 호스티드 결제 페이지 URL (checkout_url 별칭)
 * ```
 */

export { BitPalCheckoutClient, BitPalError } from './client.js';
export type {
  BitPalConfig,
  LineItem,
  PriceLineItem,
  CheckoutLineItemInput,
  CreateSessionParams,
  CheckoutSession,
  FeePreview,
  IdempotencyOptions,
  ApiResponse,
  ListResponse,
  // 비수탁 입금주소 결제
  PublicSession,
  SessionStatus,
  PaymentOption,
  IssueDepositAddressParams,
  DepositAddress,
  // PROD-LINK-3a-SDK: Product/immutable Price 관리
  CheckoutProduct,
  CheckoutPrice,
  CreateProductParams,
  UpdateProductParams,
  CreatePriceParams,
  UpdatePriceParams,
  ListProductsParams,
  ListPricesParams,
} from './types.js';
export { ProductsResource, PricesResource } from './catalog.js';

export {
  verifyWebhookSignature,
  parseWebhookEvent,
  CHECKOUT_WEBHOOK_EVENTS,
  WEBHOOK_HEADERS,
} from './webhook.js';
export type { CheckoutWebhookEvent, WebhookPayload } from './webhook.js';

export { toAtomicUSDC, fromAtomicUSDC } from './amount.js';


// 편의 팩토리
import { BitPalCheckoutClient } from './client.js';
import type { BitPalConfig } from './types.js';

/**
 * BitPal SDK 메인 엔트리
 */
export class BitPal {
  readonly checkout: BitPalCheckoutClient;

  constructor(config: BitPalConfig | string) {
    const cfg = typeof config === 'string' ? { apiKey: config } : config;
    this.checkout = new BitPalCheckoutClient(cfg);
  }
}
