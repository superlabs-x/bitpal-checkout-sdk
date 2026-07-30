/**
 * @bitpal/checkout SDK — 타입 정의
 */

export interface BitPalConfig {
  /**
   * API 키(서버 전용, secret). prefix 가 mode 를 결정합니다:
   *   - `bp_test_...` → TEST mode (testnet 또는 local anvil)
   *   - `bp_live_...` → LIVE mode (mainnet)
   *
   * BitPal 콘솔 → Developers → API Keys 에서 발급.
   *
   * **선택**: createSession/listSessions/products 등 서버 메서드는 필수. 그러나 buyer-facing 공개 메서드
   * (getPublicSession/getStatus/issueDepositAddress)는 인증 불요(session_token 기반)이므로 브라우저에서
   * apiKey 없이 쓸 수 있다 — 절대 secret 키를 브라우저에 노출하지 말 것.
   */
  apiKey?: string;
  /**
   * BitPal API 기본 URL. 환경별로 다릅니다:
   *   - production: `https://api.bitpal.io` (기본값) — 실제 testnet/mainnet 컨트랙트
   *   - local dev:  `http://localhost:3100`  — anvil 로컬 체인 + 로컬 BitPal API
   *
   * mode (TEST/LIVE) 와 baseUrl 은 직교 (orthogonal): 어떤 baseUrl 이든 키 prefix 가 mode 를 결정.
   */
  baseUrl?: string;
  /** 요청 타임아웃 (ms, 기본값: 30000) */
  timeout?: number;
}

/** 응답/정규화된 line item — amount 는 항상 atomic μUSD 정수. */
export interface LineItem {
  name: string;
  /** Atomic μUSD 정수 문자열($1="1000000", $29="29000000"). */
  amount: string;
  currency: string;
  quantity?: number;
}

/**
 * 세션 생성 입력용 line item. 금액은 둘 중 **하나**:
 *   - `amount`(권장): 사람 표기 USD 문자열(예 "29", "0.5", "29.00"). decimal 신경 쓸 필요 없음.
 *     ※ 금액은 **USD 가격**이다(체인/토큰 decimal 무관). 토큰(USDC 6dp / BNB USDT 18dp)별 스케일은 발급 시 서버가 처리.
 *   - `amount_atomic`: 이미 raw μUSD 정수 문자열($1="1000000")인 경우(고급/기존 코드).
 * 둘 다 지정하거나 둘 다 생략하면 SDK 가 에러를 throw 한다.
 */
export interface LineItemInput {
  name: string;
  currency: string;
  quantity?: number;
  /** 사람 표기 USD 금액(예 "29", "0.5") — 권장. amount_atomic 과 상호배타. */
  amount?: string;
  /** raw μUSD 정수($1="1000000") — 고급/기존. amount 와 상호배타. */
  amount_atomic?: string;
}

// PROD-LINK-3b: SDK Catalog Checkout — BitPal에 저장된 price_id 참조 line item.
// 금액/통화는 보내지 않는다 — 서버가 Price를 resolve해 세션 snapshot으로 고정한다
// (Price ID가 금액 source of truth). v1은 raw와 price_id를 한 세션에 혼합할 수 없다
// (서버가 MIXED_LINE_ITEMS로 거부).
export interface PriceLineItem {
  /** price_... — bitpal.checkout.prices.create()로 만든 가격 */
  price_id: string;
  quantity?: number;
}

export type CheckoutLineItemInput = LineItemInput | PriceLineItem;

export interface CreateSessionParams {
  line_items: CheckoutLineItemInput[];
  /** 고객 지갑 주소 (선택) */
  payer_wallet?: string;
  /** 결제 체인 (예: eip155:8453). 단일 고정 — allowed_pay_chains와 상호 배타. */
  pay_chain?: string;
  /**
   * 허용 결제 체인 목록 (CAIP-2). 구매자가 이 중에서 선택하며, 하나뿐이면 자동 선택된다.
   * pay_chain(단일 고정)과 **상호 배타** — 동시 지정 시 SDK가 에러를 throw한다.
   * 예: ['eip155:84532', 'eip155:11155420', 'eip155:80002', 'eip155:421614']
   */
  allowed_pay_chains?: string[];
  /** 결제 자산 (예: USDC) */
  pay_asset?: string;
  /** 허용 오차 (%, 기본값: 2.00) */
  tolerance_percent?: string;
  /** 만료 시간 (초, 기본값: 1800) */
  expires_in_seconds?: number;
  /** 메타데이터 (모든 값은 string 이어야 함) */
  metadata?: Record<string, string>;
  /** 결제 완료 후 buyer 가 redirect 될 URL (선택) */
  success_url?: string;
  /** 결제 취소 시 buyer 가 redirect 될 URL (선택) */
  cancel_url?: string;
}

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
  tx_hash: string | null;
  created_at: string;
  /** 'hosted' — 결제 경로. 안2 는 hosted deposit-address 단일 경로. */
  payment_source?: string;
  /** 호스티드 결제 페이지 URL (token 쿼리 포함). backend 응답 그대로 사용 — buyer를 이 URL로 redirect. */
  checkout_url?: string;
  /** 1회용 session token. `checkout_url`에 이미 query로 박혀 있어 별도 사용 불필요. */
  session_token?: string;
  /** `checkout_url`의 별칭 (backwards compat). buyer redirect 시 이 필드 또는 `checkout_url` 사용. */
  url: string;
}

/**
 * 안2 결제 옵션(chain×token). `/public` 이 서버 권위로 내려주며, buyer 가 하나를 골라
 * `issueDepositAddress({ chain, token })` 로 입금주소를 발급받는다. 단일-자산 세션은 1개.
 */
export interface PaymentOption {
  /** CAIP-2 (예: eip155:8453, tron:0x2b6653dc, solana:5eykt4…). 체인 식별의 canonical. */
  caip2: string;
  /** EVM numeric chainId. 비-EVM(Tron/Solana)은 null — 식별은 caip2 사용. */
  chain_id: number | null;
  token_symbol: string;
  /** 토큰 컨트랙트/mint 주소(EVM 0x / Tron base58 / Solana base58 mint). */
  token_address: string;
  /** 토큰 decimals(USDC/USDT=6, BSC-USD=18). atomic↔decimal 변환에 필수 — 6dp 가정 금지. */
  decimals: number;
}

/**
 * `getPublicSession()` (`GET /v1/checkout/sessions/:id/public`) 응답 — 인증 불요(공개).
 * buyer-facing 결제 페이지가 표시/폴링에 쓰는 서버 권위 뷰.
 */
export interface PublicSession {
  id: string;
  /** created | awaiting_deposit | deposit_detected | paid_confirmed | swept | unresolved_* | wrong_token | expired ... */
  status: string;
  mode: string | null;
  currency: string;
  /** Atomic 정수 문자열(토큰 decimals 기준). */
  amount_total: string;
  amount_received?: string | null;
  pay_chain: string | null;
  pay_asset: string | null;
  /** 발급된 주문별 forwarder 입금주소(미발급이면 null). */
  deposit_address?: string | null;
  /** 구매자 선택 가능한 결제 옵션(서버 권위). 단일-자산이면 1개. */
  payment_options: PaymentOption[];
  chain_id: number | null;
  token_address: string | null;
  /** 선택된 pay 토큰 decimals(발급 후). amount_total/amount_received atomic 해석에 사용 — 6dp 가정 금지. */
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
  line_items: LineItem[];
}

/**
 * `issueDepositAddress()` 요청 파라미터.
 * chain/token 은 멀티옵션 세션에서만 필요(단일-자산 세션은 생략). refundAddress 는 필수 —
 * 금액부족/잘못된토큰/만료 시 이 주소로 환불되며, 입금주소에 커밋되어 발급 후 변경 불가.
 */
export interface IssueDepositAddressParams {
  /** 결제 페이지 접근 증명(HMAC). createSession 응답의 session_token. */
  session_token: string;
  /**
   * 환불 주소. 필수. 선택한 체인의 VM 형식이어야 한다:
   *   EVM=0x…, Tron=base58(T…), Solana=base58. 결제와 같은 네트워크의 본인 주소.
   * 금액부족/잘못된토큰/만료 시 이 주소로 환불되며, 입금주소에 커밋되어 발급 후 변경 불가.
   */
  refundAddress: string;
  /** 선택 자산의 chain(CAIP-2 또는 short-name). 멀티옵션 세션 필수. */
  chain?: string;
  /** 선택 자산의 token symbol(예: USDC). 멀티옵션 세션 필수. */
  token?: string;
}

/**
 * `issueDepositAddress()` 응답 — 이 주소로 정확 금액을 송금하면 watcher 가 감지, keeper 가 정산한다.
 */
export interface DepositAddress {
  sessionId: string;
  chain: string;
  /** 주문별 결정적 입금주소(EVM/Tron=CREATE2 forwarder, Solana=order PDA 의 deposit ATA). */
  depositAddress: string;
  expectedToken: string;
  /** Atomic 정수 문자열. */
  expectedAmount: string;
  feeAmount: string;
  refundAddress: string;
  /** Unix seconds — on-chain deadline. */
  deadline: string;
  expiresAt: string | null;
}

/**
 * `getStatus()` (`GET /v1/checkout/sessions/:id/status`) 응답 — 경량 폴링용(인증 불요).
 */
export interface SessionStatus {
  status: string;
  paid_at: string | null;
}

/**
 * 수수료 미리보기 응답.
 * amount, fee_amount, net_amount는 모두 atomic μUSDC 문자열 (e.g. "1500000" = $1.50).
 * fee_rate는 비율 문자열 (e.g. "0.015" = 1.5%).
 */
export interface FeePreview {
  amount: string;
  fee_rate: string;
  fee_amount: string;
  net_amount: string;
}

/**
 * 환불은 온체인 자동 경로 — SDK 에 수동 환불 API 는 없다.
 * 금액부족/잘못된토큰/만료 시 issueDepositAddress 에 지정한 refundAddress 로 자동 환불되고,
 * 세션 status(expired/unresolved) + webhook 으로 통지된다.
 */

/**
 * 멱등성 키 — 동일 키로 재시도 시 backend가 같은 결과 반환.
 */
export interface IdempotencyOptions {
  idempotencyKey?: string;
}

export interface ApiResponse<T> {
  data: T;
  error?: string;
}

export interface ListResponse<T> {
  data: T[];
  total?: number;
}

// ── Product / immutable Price 관리 (server-side) ──
// Price는 immutable — amount_atomic/currency/token_symbol/billing_type/product_id는
// 생성 후 변경 불가 (update params에 존재하지 않음). token_address는 Price에 없다
// (chain-agnostic, K-11 — chain별 token address는 세션 생성 시 registry가 결정).

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
  /** 원자 단위 정수 문자열 ($1 = "1000000") — 불변 */
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
 * 가격 생성 입력. 금액은 둘 중 **하나** (line item 과 동일 모델):
 *   - `amount`(권장): 사람 표기 USD 문자열(예 "29", "0.5"). decimal 신경 쓸 필요 없음.
 *   - `amount_atomic`: raw μUSD 정수($1="1000000") — 고급/기존.
 * 둘 다 지정하거나 둘 다 생략하면 서버가 400 을 반환한다.
 */
export interface CreatePriceParams {
  /** 사람 표기 USD 금액(예 "29", "0.5") — 권장. amount_atomic 과 상호배타. */
  amount?: string;
  /** raw μUSD 정수($1="1000000") — 고급/기존. amount 와 상호배타. */
  amount_atomic?: string;
  currency?: string;
  token_symbol?: string;
  billing_type?: 'one_time';
  nickname?: string;
  lookup_key?: string;
}

/**
 * Price는 lifecycle 없는 immutable record — 변경 가능한 것은 nickname(표시 메타)뿐.
 * 금액류 필드(amount_atomic 등)는 immutable, "그만 팔기"는 Price 가 아니라 그 Price 를 쓰는
 * Payment Link 를 inactive 로 한다.
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

// ── Payment Link 관리 (server-side) ──
// 대시보드 UI 없이 코드로 결제 링크를 만드는 경로. 흐름: product → price → payment link.
// link ↔ price binding 은 생성 후 고정(immutable) — 다른 가격은 새 링크로. share_token 은
// 서버가 자동 생성하며 호스티드 결제 URL 은 `{checkoutBase}/plink/{share_token}` 형태.

export interface CheckoutPaymentLink {
  /** plink_... */
  id: string;
  /** 고엔트로피 공개 토큰 — 호스티드 URL `{checkoutBase}/plink/{share_token}` 에 사용 */
  share_token: string;
  /** price_... — 이 링크가 파는 가격(생성 후 고정) */
  price_id: string;
  title: string | null;
  description: string | null;
  collect_email: boolean;
  email_required: boolean;
  /** CAIP-2 목록 또는 null(legacy) */
  allowed_pay_chains: string[] | null;
  /** chain×token cell 목록 또는 null */
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
  /** price_... — bitpal.checkout.prices.create() 로 만든 가격. 필수. */
  price_id: string;
  title?: string;
  description?: string;
  /** buyer 이메일 수집(기본 true) */
  collect_email?: boolean;
  /** buyer 이메일 필수(기본 true). true 면 collect_email 도 true 여야 함. */
  email_required?: boolean;
  /** 허용 결제 체인(CAIP-2 또는 short-name). allowed_assets 가 있으면 그쪽 우선. */
  allowed_pay_chains?: string[];
  /** chain×token cell 허용 목록 — allowed_pay_chains 보다 우선. */
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
  status?: 'active' | 'inactive';
  max_uses?: number | null;
  expires_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListPaymentLinksParams {
  status?: 'active' | 'inactive';
  limit?: number;
  offset?: number;
}
