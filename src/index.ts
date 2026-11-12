/**
 * @bitpal/checkout — BitPal Checkout SDK
 *
 * Official SDK for creating checkout sessions, managing payment links, and previewing fees.
 *
 * @example
 * ```ts
 * import { BitPal } from '@bitpal/checkout';
 *
 * const bitpal = new BitPal({ apiKey: 'bp_test_...' });
 *
 * const { data: session } = await bitpal.checkout.createSession({
 *   // amount: human-readable decimal ("29", "0.5"); no decimals math needed, independent of chain/token decimals.
 *   line_items: [{ name: 'Pro Plan', amount: '29', currency: 'USDC' }],
 * });
 *
 * console.log(session.url); // hosted payment page URL (alias of checkout_url)
 * ```
 */

export { BitPalCheckoutClient, BitPalError, parseApiErrorBody, TRANSPORT_ERROR_CODES } from './client.js';
export type { BitPalErrorDetails, TransportErrorCode } from './client.js';
export type {
  BitPalConfig,
  LineItem,
  PriceLineItem,
  CheckoutLineItemInput,
  CreateSessionParams,
  CheckoutSession,
  CheckoutLatePayments,
  CheckoutRefundKind,
  CheckoutRefundRecord,
  FeePreview,
  IdempotencyOptions,
  ApiResponse,
  ListResponse,
  // Non-custodial deposit-address payments
  PublicSession,
  SessionStatus,
  PaymentOption,
  IssueDepositAddressParams,
  DepositAddress,
  // Products / immutable Prices
  CheckoutProduct,
  CheckoutPrice,
  CreateProductParams,
  UpdateProductParams,
  CreatePriceParams,
  UpdatePriceParams,
  ListProductsParams,
  ListPricesParams,
  // Payment Links
  CheckoutPaymentLink,
  CreatePaymentLinkParams,
  UpdatePaymentLinkParams,
  ListPaymentLinksParams,
  // Reconciliation reports
  CheckoutReportKind,
  CheckoutReportRange,
  CheckoutReportParams,
  CheckoutReportSummary,
  CheckoutReportResponse,
  CheckoutReportRowBase,
  PaymentReportRow,
  PayoutReportRow,
  FeeReportRow,
  // Webhook endpoint management (API keys: test mode only)
  WebhookSubscribableEvent,
  WebhookRetryPolicy,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  CreateWebhookEndpointParams,
  UpdateWebhookEndpointParams,
  RotateWebhookSecretParams,
  ListWebhookEndpointsParams,
  WebhookReasonCode,
  WebhookDelivery,
} from './types.js';
export { ProductsResource, PricesResource, PaymentLinksResource } from './catalog.js';
export { ReportsResource } from './reports.js';
export { WebhookEndpointsResource } from './webhook-endpoints.js';

export {
  verifyWebhookSignature,
  parseWebhookEvent,
  CHECKOUT_WEBHOOK_EVENTS,
  WEBHOOK_HEADERS,
} from './webhook.js';
export type {
  CheckoutWebhookEvent,
  WebhookPayload,
  WebhookEvent,
  WebhookEventDataMap,
  WebhookSessionMetadata,
  CheckoutSessionEventBase,
  CheckoutSessionCreatedData,
  CheckoutSessionDepositDetectedData,
  CheckoutSessionPaidData,
  CheckoutSessionSettledData,
  CheckoutSessionUnresolvedData,
  CheckoutSessionExpiredData,
  CheckoutRefundRecordedData,
  X402PaymentResolvedData,
} from './webhook.js';

export { toAtomic, fromAtomic, toAtomicUSDC, fromAtomicUSDC } from './amount.js';

// x402 — pay-per-call lane. Provides both the merchant side (middleware) and the payer side (signing helper).
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

export { createX402Payment, normalizeSignature, TRANSFER_WITH_AUTHORIZATION_TYPES } from './x402-pay.js';
export type {
  CreateX402PaymentOptions,
  X402PaymentResult,
  X402Signer,
  X402TypedDataRequest,
  Eip712Domain,
} from './x402-pay.js';


// Convenience factory
import { BitPalCheckoutClient } from './client.js';
import type { BitPalConfig } from './types.js';

/**
 * BitPal SDK main entry point
 */
export class BitPal {
  readonly checkout: BitPalCheckoutClient;

  constructor(config: BitPalConfig | string) {
    const cfg = typeof config === 'string' ? { apiKey: config } : config;
    this.checkout = new BitPalCheckoutClient(cfg);
  }
}
