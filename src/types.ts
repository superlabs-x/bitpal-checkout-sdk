/**
 * @bitpal/checkout SDK — type definitions
 */

export interface BitPalConfig {
  /**
   * API key (server-side only, secret). The prefix selects the mode:
   *   - `bp_test_...` → TEST mode (testnets)
   *   - `bp_live_...` → LIVE mode (mainnets)
   *
   * Create one in the BitPal console → Developers → API Keys.
   *
   * **Optional**: required for server methods such as createSession/listSessions/products. The buyer-facing public
   * methods (getPublicSession/getStatus/issueDepositAddress) do not need an apiKey (issueDepositAddress needs a session_token).
   * However, only `getPublicSession` can be called directly from a **browser (CORS)** on an arbitrary merchant domain —
   * call `issueDepositAddress`/`getStatus` through your backend (custom payment UI = headless checkout).
   * Never expose your secret key in the browser.
   */
  apiKey?: string;
  /**
   * BitPal API base URL. Defaults to `https://api.bitpal.io`.
   *
   * TEST vs LIVE is chosen by the API key prefix (`bp_test_` / `bp_live_`), not by the URL.
   */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

/** Normalized line item as returned — amount is always a canonical 6dp atomic integer (not the pay token's decimals). */
export interface LineItem {
  name: string;
  /** Canonical 6dp atomic integer string ("1"="1000000", "29"="29000000"). */
  amount: string;
  currency: string;
  quantity?: number;
}

/**
 * Line item input for session creation. Provide **exactly one** amount field:
 *   - `amount` (recommended): human-readable canonical 6dp string (e.g. "29", "0.5", "29.00"). No decimals handling needed.
 *     Note: `currency` (e.g. 'USDC'/'USDT'/'JPYC') determines the actual payment currency — `amount` is just the canonical
 *     6dp notation in that currency and does not always mean USD (e.g. currency='JPYC' + amount="29" → 29 JPYC/29 yen,
 *     no FX conversion). Rescaling to the actual pay token's decimals (USDC 6dp / JPYC 18dp, etc.) is done by the server.
 *   - `amount_atomic`: when you already have a raw canonical 6dp integer string ($1="1000000") (advanced/legacy code).
 * The SDK throws if both or neither are given.
 */
export interface LineItemInput {
  name: string;
  currency: string;
  quantity?: number;
  /** Human-readable canonical 6dp amount (e.g. "29", "0.5") — recommended. Mutually exclusive with amount_atomic. */
  amount?: string;
  /** Raw canonical 6dp integer ($1="1000000") — advanced/legacy. Mutually exclusive with amount. */
  amount_atomic?: string;
}

// Catalog checkout: a line item referencing a price_id stored in BitPal.
// Do not send amount/currency — the server resolves the Price and freezes it into the session snapshot
// (the Price is the source of truth for the amount). Raw line items and price_id items cannot be mixed
// in one session (the server rejects with MIXED_LINE_ITEMS).
export interface PriceLineItem {
  /** price_... — a price created with bitpal.checkout.prices.create() */
  price_id: string;
  quantity?: number;
}

export type CheckoutLineItemInput = LineItemInput | PriceLineItem;

export interface CreateSessionParams {
  /**
   * Line items. The total (sum of `amount × quantity`) must be at least 1.00 in the session currency
   * (USDC/USDT: $1, JPYC: ¥1), otherwise the API returns `400 CHECKOUT_AMOUNT_TOO_LOW`. Some networks need more
   * (Tron: $300, JPYC: ¥100 on every network) and are not offered for smaller totals.
   */
  line_items: CheckoutLineItemInput[];
  /** @deprecated Ignored by the server. The payer address is recorded on-chain at payment time. */
  payer_wallet?: string;
  /** Payment chain (e.g. eip155:8453). Single fixed chain — mutually exclusive with allowed_pay_chains. */
  pay_chain?: string;
  /**
   * Allowed payment chains (CAIP-2). The buyer picks one; if there is only one it is selected automatically.
   * **Mutually exclusive** with pay_chain (single fixed chain) — the SDK throws if both are given.
   * Example: ['eip155:84532', 'eip155:11155420', 'eip155:80002', 'eip155:421614']
   */
  allowed_pay_chains?: string[];
  /**
   * Allowed chain×token cells (the standard input for **payment methods**) — the buyer picks a (chain, token) pair.
   * Takes precedence over allowed_pay_chains (× single currency shorthand). Use it to mix different tokens.
   * `chain` accepts a short name ('base', 'tron', 'solana') or CAIP-2 (the server normalizes it for the current mode).
   * Same shape as paymentLinks.allowed_assets.
   * Example: [{ chain: 'base', token: 'USDC' }, { chain: 'tron', token: 'USDT' }]
   */
  allowed_assets?: Array<{ chain: string; token: string }>;
  /** @deprecated Ignored by the server. Specify payment assets with `allowed_assets`. */
  pay_asset?: string;
  /**
   * @deprecated Underpayments are not accepted — only "0" is allowed; any other value returns 400.
   *   An underpaid session becomes `unresolved_underpaid`; sending the remainder to the same address completes it.
   */
  tolerance_percent?: string;
  /**
   * Payment window in minutes. 1–60, default 15. The session expires after this
   * (an exact payment arriving after expiry is accepted as a late payment within 7 days — `late: true`).
   */
  expires_in_minutes?: number;
  /**
   * @deprecated Use `expires_in_minutes`. Only 60–3600 seconds are accepted; the value is rounded up to minutes.
   * (Up to 0.11 the server ignored this field and the default 15 minutes always applied.)
   */
  expires_in_seconds?: number;
  /**
   * Your data (e.g. `{ order_id: '1042' }`). Returned on the session and included in every webhook's `data.metadata`.
   * Reserved keys BitPal writes itself (`_bitpal`, `payer_email`, `allowed_pay_chains`, `allowed_assets`) are dropped
   * from webhooks — don't use them.
   */
  metadata?: Record<string, string>;
  /** URL the buyer is redirected to after payment (optional) */
  success_url?: string;
  /** URL the buyer is redirected to on cancel (optional) */
  cancel_url?: string;
  /**
   * What happens to a full payment that arrives after the payment deadline.
   * - `'accept'` (default): accepted as a late payment for up to 7 days (`checkout.session.paid` with `late: true`).
   * - `'refund'`: never accepted — refunded automatically to the buyer's refund address about 7 days after the
   *   deadline (refund kind `late_deposit`). The non-custodial deposit contract does not allow an earlier refund.
   */
  late_payments?: CheckoutLatePayments;
}

/** Session option for full payments that arrive after the deadline. See `CreateSessionParams.late_payments`. */
export type CheckoutLatePayments = 'accept' | 'refund';

export interface CheckoutSession {
  id: string;
  status: string;
  amount_total: string;
  currency: string;
  line_items: LineItem[];
  pay_chain: string | null;
  pay_asset: string | null;
  payer_wallet: string | null;
  seller_wallet: string;
  tolerance_percent: string;
  expires_at: string | null;
  paid_at: string | null;
  settled_at: string | null;
  /**
   * @deprecated Kept for compatibility; returns the same value as `deposit_tx_hash`.
   * Use `deposit_tx_hash` (buyer payment) and `sweep_tx_hash` (settlement to your wallet).
   */
  tx_hash: string | null;
  created_at: string;
  /** 'TEST' | 'LIVE' — present in retrieval responses (getSession/listSessions). */
  mode?: 'TEST' | 'LIVE';
  /** Amount received at the deposit address so far — pay-token atomic units (per `token_decimals`). */
  amount_received?: string | null;
  /** Pay token decimals (USDC/USDT=6, BSC-USD=18). amount_total is always 6dp. */
  token_decimals?: number | null;
  payment_method?: string | null;
  deposit_address?: string | null;
  refund_address?: string | null;
  /** Late-payment option the session was created with (`'accept'` when not set). */
  late_payments?: CheckoutLatePayments;
  /** Address of the token contract/mint actually received at the deposit address (not the symbol). Tron: base58 `T…`. */
  received_token?: string | null;
  /** Symbol of `received_token` (e.g. `USDC`). null if nothing was received yet or the token is unknown (e.g. a wrong token). */
  received_token_symbol?: string | null;
  /** The buyer's payment into the deposit address. */
  deposit_tx_hash?: string | null;
  /** The settlement to your payout wallet (or the refund/rescue for a refunded session). */
  sweep_tx_hash?: string | null;
  fee_amount?: string | null;
  fee_rate?: string | null;
  net_amount?: string | null;
  /** Fee and net amount in the pay token's own decimals (token_decimals) — exactly matches the on-chain amounts. null before a deposit address is issued. */
  fee_amount_token?: string | null;
  net_amount_token?: string | null;
  success_url?: string | null;
  cancel_url?: string | null;
  metadata?: Record<string, unknown> | null;
  payment_link_id?: string | null;
  /** 'hosted' — the payment path (hosted deposit address). */
  payment_source?: string;
  /** Hosted payment page URL (includes the token query). Use as returned — redirect the buyer here. */
  checkout_url?: string;
  /** One-time session token. Already embedded in `checkout_url`, so no separate use is needed. */
  session_token?: string;
  /** Alias of `checkout_url` (backwards compat). Redirect the buyer using this or `checkout_url`. */
  url: string;
}

/**
 * Payment option (chain×token). Provided authoritatively by `/public`; the buyer picks one and
 * calls `issueDepositAddress({ chain, token })` to get a deposit address. Single-asset sessions have exactly one.
 */
export interface PaymentOption {
  /** CAIP-2 (e.g. eip155:8453, tron:0x2b6653dc, solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp). Canonical chain identifier. */
  caip2: string;
  /** EVM numeric chainId. null for non-EVM (Tron/Solana) — use caip2 to identify. */
  chain_id: number | null;
  token_symbol: string;
  /** Token contract/mint address (EVM 0x / Tron base58 / Solana base58 mint). */
  token_address: string;
  /** Token decimals (USDC/USDT=6, BSC-USD=18). Required for atomic↔decimal conversion — do not assume 6dp. */
  decimals: number;
  /** Exact amount to send in this token (atomic, in this token's decimals). */
  amount_atomic?: string;
  /**
   * false = shown in the list but not selectable right now (see `unavailable_reason`). Calling `issueDepositAddress` with
   * this option returns 409 `CHECKOUT_CHAIN_COMING_SOON` (`coming_soon`) or 503 `NETWORK_PAUSED` (`paused`).
   * Added in 0.13.0 — optional because older API responses may omit it.
   */
  available?: boolean;
  /**
   * Why the option is not selectable. null when selectable.
   * - `coming_soon` — payments on this network open soon.
   * - `paused` — new payments on this network are temporarily paused by BitPal; it becomes selectable again when resumed.
   */
  unavailable_reason?: 'coming_soon' | 'paused' | null;
}

/**
 * `getPublicSession()` (`GET /v1/checkout/sessions/:id/public`) response — public, no authentication.
 * Server-authoritative view used by buyer-facing payment pages for display/polling.
 */
export interface PublicSession {
  id: string;
  /** created | awaiting_deposit | deposit_detected | paid_confirmed | swept | unresolved_* | wrong_token | expired ... */
  status: string;
  mode: string | null;
  currency: string;
  /**
   * Order total — **canonical μUSD (6dp) integer string** (in the price currency, $1 = "1000000"), independent of the
   * pay token's decimals (still 6dp when paying with an 18dp token). The token amount to send on-chain is `pay_amount`
   * (or `expectedAmount` in the issue response).
   */
  amount_total: string;
  /** Amount received at the deposit address so far — **pay-token atomic** (per `token_decimals`). null if nothing received. */
  amount_received?: string | null;
  /**
   * Total in the selected pay token (atomic, per `token_decimals`) — the exact amount the buyer must send. null if no asset selected.
   * = canonicalToTokenAtomic(amount_total, token_decimals). Remaining = pay_amount − amount_received.
   */
  pay_amount?: string | null;
  pay_chain: string | null;
  pay_asset: string | null;
  /** Issued per-order forwarder deposit address (null if not issued). */
  deposit_address?: string | null;
  /**
   * Solana only: the wallet (owner) address the buyer should use as recipient — the order account that owns the
   * deposit token account (deposit_address). Wallets derive the token account from this address. null for EVM/Tron.
   */
  deposit_owner?: string | null;
  /**
   * After a deposit address is issued: deadline (ISO, expires_at + ~90 min grace) until which transfers to that address
   * are processed normally. null if not issued. After expires_at, stop accepting new transfers (hide the address) and
   * wait for confirmation until this time.
   */
  payment_deadline_at?: string | null;
  /** Payment options the buyer can choose (server-authoritative). Exactly one for single-asset sessions. */
  payment_options: PaymentOption[];
  chain_id: number | null;
  token_address: string | null;
  /** Selected pay token decimals (after issue). Use to interpret amount_received / pay_amount — do not assume 6dp (amount_total is always 6dp). */
  token_decimals?: number | null;
  tx_hash: string | null;
  release_tx_hash?: string | null;
  expires_at: string | null;
  success_url: string | null;
  cancel_url: string | null;
  fee_amount: string | null;
  net_amount: string | null;
  seller_wallet: string;
  paid_at: string | null;
  settled_at: string | null;
  created_at: string;
  /** Your organization name (Console → Settings → Organization) as shown to the buyer. null if not set. */
  merchant_name?: string | null;
  line_items: LineItem[];
}

/**
 * `issueDepositAddress()` request parameters.
 * chain/token are only needed for multi-option sessions (omit for single-asset sessions). refundAddress is required —
 * underpayments, wrong tokens and expired payments are refunded to it; it is committed into the deposit address and cannot be changed after issue.
 */
export interface IssueDepositAddressParams {
  /** Proof of payment-page access (HMAC). The session_token from the createSession response. */
  session_token: string;
  /**
   * Refund address. Required. Must match the selected chain's VM format:
   *   EVM=0x…, Tron=base58 (T…), Solana=base58. The buyer's own address on the same network as the payment.
   * Underpayments, wrong tokens and expired payments are refunded to it; it is committed into the deposit address and cannot be changed after issue.
   */
  refundAddress: string;
  /** Chain of the selected asset (CAIP-2 or short name). Required for multi-option sessions. */
  chain?: string;
  /** Token symbol of the selected asset (e.g. USDC). Required for multi-option sessions. */
  token?: string;
}

/**
 * `issueDepositAddress()` response — send the exact amount to this address; BitPal detects and settles it.
 */
export interface DepositAddress {
  sessionId: string;
  chain: string;
  /** Deterministic per-order deposit address (EVM/Tron = CREATE2 forwarder, Solana = deposit ATA of the order PDA). */
  depositAddress: string;
  expectedToken: string;
  /** Atomic integer string. */
  expectedAmount: string;
  feeAmount: string;
  refundAddress: string;
  /** Unix seconds — on-chain deadline. */
  deadline: string;
  expiresAt: string | null;
  /** Solana only: wallet (owner) address to use as recipient (same as `PublicSession.deposit_owner`). null for EVM/Tron. */
  depositOwner?: string | null;
}

/**
 * `getStatus()` (`GET /v1/checkout/sessions/:id/status`) response — lightweight polling (API key, own sessions only).
 */
export interface SessionStatus {
  status: string;
  paid_at: string | null;
}

/**
 * Fee preview response.
 * amount, fee_amount and net_amount are atomic μUSDC strings (e.g. "1500000" = $1.50).
 * fee_rate is a ratio string (e.g. "0.015" = 1.5%).
 */
export interface FeePreview {
  amount: string;
  fee_rate: string;
  fee_amount: string;
  net_amount: string;
}

/**
 * Refunds — there is **no refund method in this SDK, by design.** BitPal is non-custodial: payments settle straight
 * to your payout wallet and BitPal cannot pull them back.
 * - Mismatched payments (underpaid, overpaid excess, wrong token, late deposit) are refunded automatically on-chain
 *   to the buyer's `refundAddress`.
 * - A completed payment is refunded by you in the BitPal console (Sessions → session → Refund): send from your own
 *   wallet and record the transaction there. Recording is console-only (an API key gets `403 REFUND_CONSOLE_ONLY`).
 * Every refund fires the `checkout.refund.recorded` webhook with a {@link CheckoutRefundRecord} as `data`.
 */

/**
 * Refund kinds. Automatic: `overpay_excess`, `underpay_expired`, `wrong_token`, `late_deposit`.
 * `merchant`: you refunded a completed payment from your own wallet and recorded it in the console.
 * New kinds may be added — treat unknown values as a generic refund.
 */
export type CheckoutRefundKind = 'overpay_excess' | 'underpay_expired' | 'wrong_token' | 'late_deposit' | 'merchant';

/** `data` of the `checkout.refund.recorded` webhook (and an item of `GET /v1/checkout/sessions/{id}/refunds`). */
export interface CheckoutRefundRecord {
  session_id?: string;
  kind: CheckoutRefundKind | (string & {});
  /** Atomic integer string in the token's own decimals. */
  amount: string;
  /** Token contract / mint address. */
  token: string;
  tx_hash: string;
  refund_address: string;
  /** `merchant` only: the wallet the refund was sent from. */
  from_address?: string | null;
  /** `merchant` only: `customer_request` | `duplicate` | `product_issue` | `other`. */
  reason_code?: string | null;
}

/**
 * Idempotency key — retrying with the same key returns the same result.
 */
export interface IdempotencyOptions {
  idempotencyKey?: string;
}

export interface ApiResponse<T> {
  data: T;
  error?: string;
}

/** List response meta — total is the number of all records matching the filter (independent of paging). */
export interface ListMeta {
  total?: number;
  limit?: number;
  offset?: number;
  mode?: 'TEST' | 'LIVE';
  requestId?: string | null;
}

export interface ListResponse<T> {
  data: T[];
  meta?: ListMeta;
}

// ── Product / immutable Price management (server-side) ──
// Prices are immutable — amount_atomic/currency/token_symbol/billing_type/product_id cannot be
// changed after creation (they are not in the update params). A Price has no token_address
// (chain-agnostic — the per-chain token address is resolved when a session is created).

export interface CheckoutProduct {
  /** prod_... */
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  /** 'active' | 'inactive' */
  status: string;
  metadata: Record<string, unknown>;
  mode: string;
  created_at: string;
  updated_at: string;
}

export interface CheckoutPrice {
  /** price_... */
  id: string;
  /** prod_... */
  product_id: string;
  /** Atomic integer string ($1 = "1000000") — immutable */
  amount_atomic: string;
  currency: string;
  token_symbol: string;
  /** v1: 'one_time' */
  billing_type: string;
  nickname: string | null;
  lookup_key: string | null;
  mode: string;
  created_at: string;
}

export interface CreateProductParams {
  name: string;
  description?: string;
  image_url?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateProductParams {
  name?: string;
  description?: string | null;
  image_url?: string | null;
  metadata?: Record<string, unknown>;
  status?: 'active' | 'inactive';
}

/**
 * Price creation input. Provide **exactly one** amount field (same model as line items):
 *   - `amount` (recommended): human-readable canonical 6dp string (e.g. "29", "0.5"). No decimals handling needed.
 *   - `amount_atomic`: raw canonical 6dp integer ($1="1000000") — advanced/legacy.
 * The server returns 400 if both or neither are given.
 *
 * `amount`/`amount_atomic` are **always canonical 6dp**, not the pay token's decimals — the server rescales to the
 * actual token decimals (e.g. JPYC=18dp) at payment time (1:1, no FX conversion). So registering "29" with
 * `token_symbol: 'JPYC'` charges 29 JPYC (≈29 yen), not the JPYC equivalent of 29 USD.
 *
 * `currency` is not an input — the server derives it from `token_symbol` (to prevent mismatches).
 */
export interface CreatePriceParams {
  /** Human-readable canonical 6dp amount (e.g. "29", "0.5") — recommended. Mutually exclusive with amount_atomic. */
  amount?: string;
  /** Raw canonical 6dp integer ($1="1000000") — advanced/legacy. Mutually exclusive with amount. */
  amount_atomic?: string;
  /** 'USDC' | 'USDT' | 'JPYC' — defaults to 'USDC'. The only payment asset of this Price (currency is derived from it). */
  token_symbol?: string;
  billing_type?: 'one_time';
  nickname?: string;
  lookup_key?: string;
}

/**
 * A Price is an immutable record with no lifecycle — only nickname (display metadata) can be changed.
 * Amount fields (amount_atomic etc.) are immutable. To stop selling, set the Payment Link that uses
 * the Price to inactive rather than changing the Price.
 */
export interface UpdatePriceParams {
  nickname?: string | null;
}

export interface ListProductsParams {
  status?: 'active' | 'inactive';
  limit?: number;
  offset?: number;
}

export interface ListPricesParams {
  limit?: number;
  offset?: number;
}

// ── Payment Link management (server-side) ──
// Create payment links in code without the dashboard. Flow: product → price → payment link.
// The link ↔ price binding is fixed after creation — use a new link for a different price. share_token is
// generated by the server; the hosted payment URL is `{checkoutBase}/plink/{share_token}`.

export interface CheckoutPaymentLink {
  /** plink_... */
  id: string;
  /** High-entropy public token — used in the hosted URL `{checkoutBase}/plink/{share_token}` */
  share_token: string;
  /** price_... — the price this link sells (fixed after creation) */
  price_id: string;
  title: string | null;
  description: string | null;
  collect_email: boolean;
  email_required: boolean;
  /** CAIP-2 list, or null (legacy) */
  allowed_pay_chains: string[] | null;
  /** chain×token cell list, or null */
  allowed_assets: Array<{ caip2: string; token: string }> | null;
  success_url: string | null;
  cancel_url: string | null;
  /** 'active' | 'inactive' */
  status: string;
  max_uses: number | null;
  paid_use_count: number;
  expires_at: string | null;
  mode: string;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentLinkParams {
  /** price_... — a price created with bitpal.checkout.prices.create(). Required. */
  price_id: string;
  title?: string;
  description?: string;
  /** Collect buyer email (default true) */
  collect_email?: boolean;
  /** Require buyer email (default true). If true, collect_email must also be true. */
  email_required?: boolean;
  /** Allowed payment chains (CAIP-2 or short name). allowed_assets takes precedence if set. */
  allowed_pay_chains?: string[];
  /** Allowed chain×token cells — takes precedence over allowed_pay_chains. */
  allowed_assets?: Array<{ chain: string; token: string }>;
  success_url?: string;
  cancel_url?: string;
  max_uses?: number;
  /** ISO-8601 datetime */
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdatePaymentLinkParams {
  title?: string | null;
  description?: string | null;
  collect_email?: boolean;
  email_required?: boolean;
  allowed_pay_chains?: string[] | null;
  allowed_assets?: Array<{ chain: string; token: string }> | null;
  success_url?: string | null;
  cancel_url?: string | null;
  /**
   * Deactivating (`'inactive'`): the console asks for a reason; with an API key `reason_code` is optional —
   * without it the change is recorded as `api_request`.
   */
  status?: 'active' | 'inactive';
  max_uses?: number | null;
  expires_at?: string | null;
  metadata?: Record<string, unknown>;
  /** Why the status changes — optional with an API key (recorded as `api_request` when omitted). Recorded in your audit log. */
  reason_code?: 'user_request' | 'security_concern' | 'rotation' | 'no_longer_needed' | 'other';
  /** Optional free-text note for the status change (max 500 characters). */
  reason_note?: string;
}

export interface ListPaymentLinksParams {
  status?: 'active' | 'inactive';
  limit?: number;
  offset?: number;
}

// ── Reconciliation reports (server-side) ──

/** Report type for `reports.csv()`. */
export type CheckoutReportKind = 'payments' | 'payouts' | 'fees';

/** Date range, UTC dates `YYYY-MM-DD`, both inclusive. Omit a bound for no limit on that side. */
export interface CheckoutReportRange {
  from?: string;
  to?: string;
}

/** JSON report page. `limit` 1–100 (default 50). */
export interface CheckoutReportParams extends CheckoutReportRange {
  limit?: number;
  offset?: number;
}

/** Totals over the whole date range (not just the page). 6-decimal atomic strings; currencies are added together. */
export interface CheckoutReportSummary {
  total_count: number;
  total_amount_atomic: string;
  total_fees_atomic: string;
  total_net_atomic: string;
}

export interface CheckoutReportResponse<Row> {
  data: Row[];
  meta: ListMeta & { total: number; limit: number; offset: number };
  summary: CheckoutReportSummary;
}

/** Fields shared by every report row. Amount fields are atomic integer strings. */
export interface CheckoutReportRowBase {
  session_id: string;
  currency: string;
  /** 6-decimal ("29000000" = 29). */
  amount_total: string;
  pay_chain: string | null;
  pay_asset: string | null;
  /** Platform fee, 6-decimal. */
  fee_amount: string | null;
  /** Your net, 6-decimal. */
  net_amount: string | null;
  /** Payment token decimals (USDC/USDT = 6, BSC-USD = 18). */
  token_decimals: number | null;
  /** Platform fee in the payment token's atomic units — matches the on-chain transfer exactly. */
  fee_amount_token: string | null;
  /** Your net in the payment token's atomic units — matches the on-chain sweep exactly. */
  net_amount_token: string | null;
  /** The metadata you set on the session (BitPal's reserved keys removed). */
  metadata: Record<string, unknown>;
}

/** `reports.payments()` row — every session created in the range. */
export interface PaymentReportRow extends CheckoutReportRowBase {
  created_at: string;
  paid_at: string | null;
  settled_at: string | null;
  status: string;
  /** In `token_decimals` units. */
  amount_received: string | null;
  payer_wallet: string | null;
  deposit_tx_hash: string | null;
  sweep_tx_hash: string | null;
  fee_rate: string | null;
}

/** `reports.payouts()` row — every session settled in the range. */
export interface PayoutReportRow extends CheckoutReportRowBase {
  settled_at: string;
  paid_at: string | null;
  deposit_tx_hash: string | null;
  sweep_tx_hash: string | null;
}

/** `reports.fees()` row — every session paid in the range. */
export interface FeeReportRow extends CheckoutReportRowBase {
  paid_at: string;
  fee_rate: string | null;
}

// ── Webhook endpoint management (server-side; API keys: test mode only) ──

/** Event names an endpoint can subscribe to, or `'*'` for every event. */
export type WebhookSubscribableEvent = '*' | import('./webhook.js').CheckoutWebhookEvent;

export interface WebhookRetryPolicy {
  /** Total delivery attempts (1–20, default 10). */
  max_retries?: number;
  /** Ignored — the retry schedule is fixed. */
  backoff?: 'exponential' | 'linear' | 'fixed';
}

export interface WebhookEndpoint {
  id: string;
  mode: 'TEST' | 'LIVE';
  endpoint_url: string;
  subscribed_events: string[];
  retry_policy: WebhookRetryPolicy;
  dead_letter_destination: string | null;
  status: 'active' | 'paused' | 'disabled';
  created_at: string;
  updated_at: string;
}

/** Returned by `create` and `rotateSecret` only. */
export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  /** `whsec_…` signing secret — shown only once. */
  secret: string;
}

export interface CreateWebhookEndpointParams {
  endpoint_url: string;
  subscribed_events: WebhookSubscribableEvent[];
  retry_policy?: WebhookRetryPolicy;
  dead_letter_destination?: string | null;
}

export type WebhookReasonCode = 'user_request' | 'security_concern' | 'rotation' | 'no_longer_needed' | 'other';

export interface UpdateWebhookEndpointParams {
  endpoint_url?: string;
  subscribed_events?: WebhookSubscribableEvent[];
  /** `'disabled'` removes the endpoint. */
  status?: 'active' | 'paused' | 'disabled';
  retry_policy?: WebhookRetryPolicy;
  dead_letter_destination?: string | null;
  /** Why the endpoint is disabled. Optional with a test API key (recorded as `api_request`); required in the console. */
  reason_code?: WebhookReasonCode;
  reason_note?: string;
}

export interface RotateWebhookSecretParams {
  /** Optional with a test API key (recorded as `api_request`). */
  reason_code?: WebhookReasonCode;
  reason_note?: string;
}

export interface ListWebhookEndpointsParams {
  limit?: number;
  offset?: number;
}

/** A queued delivery (from `replay`). */
export interface WebhookDelivery {
  /** Sent as `X-Webhook-Delivery-Id`. */
  id: string;
  webhook_id: string;
  /** The event's envelope `id` — unchanged, so your dedup still applies. */
  event_id: string;
  event_type: string;
  status: string;
  attempt_count: number;
  replayed_from_event_id: string | null;
  created_at: string;
}
