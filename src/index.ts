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
 *   // amount: 사람 표기 USD("29","0.5"). decimal 계산 불필요 — 체인/토큰 decimal 무관.
 *   line_items: [{ name: 'Pro Plan', amount: '29', currency: 'USDC' }],
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
  // 안2 비수탁 입금주소 결제
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
  // PROD-LINK-4-SDK: Payment Link 관리
  CheckoutPaymentLink,
  CreatePaymentLinkParams,
  UpdatePaymentLinkParams,
  ListPaymentLinksParams,
} from './types.js';
export { ProductsResource, PricesResource, PaymentLinksResource } from './catalog.js';

export {
  verifyWebhookSignature,
  parseWebhookEvent,
  CHECKOUT_WEBHOOK_EVENTS,
  WEBHOOK_HEADERS,
} from './webhook.js';
export type { CheckoutWebhookEvent, WebhookPayload } from './webhook.js';

export { toAtomic, fromAtomic, toAtomicUSDC, fromAtomicUSDC } from './amount.js';

// x402 — 호출당 과금 레인. 머천트(미들웨어)와 payer(서명 헬퍼) 양쪽을 한 패키지에서 제공한다.
export {
  x402,
  X402Gate,
  createMemoryReplayStore,
  decodePaymentHeader,
  encodePaymentHeader,
  X402_PAYMENT_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
} from './x402.js';
export type {
  X402MiddlewareOptions,
  X402GateOptions,
  X402GateResult,
  X402SettledPayment,
  X402ReplayStore,
  X402ClaimState,
  X402Requirements,
  X402Accept,
  X402FeeBreakdown,
  X402PaymentPayload,
  Eip3009Authorization,
  X402Request,
  X402Response,
} from './x402.js';

export { createX402Payment, splitSignature, TRANSFER_WITH_AUTHORIZATION_TYPES } from './x402-pay.js';
export type {
  CreateX402PaymentOptions,
  X402PaymentResult,
  X402Signer,
  X402TypedDataRequest,
  Eip712Domain,
} from './x402-pay.js';


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
