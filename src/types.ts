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
   * **선택**: createSession/listSessions/products 등 서버 메서드는 필수. buyer-facing 공개 메서드
   * (getPublicSession/getStatus/issueDepositAddress)는 apiKey 가 필요 없다(issueDepositAddress 는 session_token 필요).
   * 단 **브라우저(CORS)** 에서 임의 머천트 도메인이 직접 부를 수 있는 것은 `getPublicSession` 뿐이다 —
   * `issueDepositAddress`/`getStatus` 는 머천트 백엔드를 경유해 호출한다(자체 결제 UI = 헤드리스 checkout).
   * 절대 secret 키를 브라우저에 노출하지 말 것.
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

/** 응답/정규화된 line item — amount 는 항상 canonical 6dp atomic 정수(실제 결제 토큰 decimals 아님). */
export interface LineItem {
  name: string;
  /** canonical 6dp atomic 정수 문자열("1"="1000000", "29"="29000000"). */
  amount: string;
  currency: string;
  quantity?: number;
}

/**
 * 세션 생성 입력용 line item. 금액은 둘 중 **하나**:
 *   - `amount`(권장): 사람 표기 canonical 6dp 문자열(예 "29", "0.5", "29.00"). decimal 신경 쓸 필요 없음.
 *     ※ `currency`(예: 'USDC'/'USDT'/'JPYC')가 실제 결제 통화를 결정한다 — `amount`는 그 통화의 canonical
 *     6dp 표기일 뿐 항상 USD 를 뜻하지 않는다(예: currency='JPYC' + amount="29" → 29 JPYC/29엔, 환율
 *     변환 없음). 실제 결제 토큰 decimals(USDC 6dp / JPYC 18dp 등)로의 재스케일은 발급 시 서버가 처리.
 *   - `amount_atomic`: 이미 raw canonical 6dp 정수 문자열($1="1000000")인 경우(고급/기존 코드).
 * 둘 다 지정하거나 둘 다 생략하면 SDK 가 에러를 throw 한다.
 */
export interface LineItemInput {
  name: string;
  currency: string;
  quantity?: number;
  /** 사람 표기 canonical 6dp 금액(예 "29", "0.5") — 권장. amount_atomic 과 상호배타. */
  amount?: string;
  /** raw canonical 6dp 정수($1="1000000") — 고급/기존. amount 와 상호배타. */
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
  /** @deprecated 서버가 사용하지 않는다(무시됨). 입금자 주소는 결제 시 온체인에서 기록된다. */
  payer_wallet?: string;
  /** 결제 체인 (예: eip155:8453). 단일 고정 — allowed_pay_chains와 상호 배타. */
  pay_chain?: string;
  /**
   * 허용 결제 체인 목록 (CAIP-2). 구매자가 이 중에서 선택하며, 하나뿐이면 자동 선택된다.
   * pay_chain(단일 고정)과 **상호 배타** — 동시 지정 시 SDK가 에러를 throw한다.
   * 예: ['eip155:84532', 'eip155:11155420', 'eip155:80002', 'eip155:421614']
   */
  allowed_pay_chains?: string[];
  /**
   * chain×token cell 허용 목록(**결제 수단** 표준 입력) — buyer 가 (체인, 토큰) 조합을 고른다.
   * allowed_pay_chains(×단일 currency shorthand)보다 우선. 서로 다른 토큰을 섞을 때 사용.
   * `chain` 은 short-name('base','tron','solana') 또는 CAIP-2 둘 다 허용(서버가 mode-relative 로 정규화).
   * paymentLinks.allowed_assets 와 동일 형태(SDK 일관).
   * 예: [{ chain: 'base', token: 'USDC' }, { chain: 'tron', token: 'USDT' }]
   */
  allowed_assets?: Array<{ chain: string; token: string }>;
  /** @deprecated 서버가 사용하지 않는다(무시됨). 결제 자산은 `allowed_assets` 로 지정한다. */
  pay_asset?: string;
  /**
   * @deprecated 부족 결제는 수용하지 않는다 — "0" 만 허용, 그 외 값은 400.
   *   부족하게 들어오면 `unresolved_underpaid` 가 되고 같은 주소로 나머지를 보내면 완료된다.
   */
  tolerance_percent?: string;
  /**
   * 결제 대기 시간(분). 1~60, 기본 15. 이 시간이 지나면 세션이 만료된다
   * (만료 후 도착한 정확 금액은 7일 안이면 늦은 결제로 인정 — `late: true`).
   */
  expires_in_minutes?: number;
  /**
   * @deprecated `expires_in_minutes` 를 쓴다. 60~3600 초만 허용되고 분 단위로 올림해 보낸다.
   * (0.11 까지는 서버가 이 필드를 몰라 무시했고, 항상 기본 15분이 적용됐다.)
   */
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
  /** 'TEST' | 'LIVE' — 조회(getSession/listSessions) 응답에 있다. */
  mode?: 'TEST' | 'LIVE';
  /** 지금까지 입금주소로 들어온 금액 — 결제 토큰 atomic(`token_decimals` 기준). */
  amount_received?: string | null;
  /** 결제 토큰 decimals(USDC/USDT=6, BSC-USD=18). amount_total 은 항상 6dp. */
  token_decimals?: number | null;
  payment_method?: string | null;
  deposit_address?: string | null;
  refund_address?: string | null;
  /** 입금주소로 실제 들어온 토큰 컨트랙트/mint. */
  received_token?: string | null;
  deposit_tx_hash?: string | null;
  sweep_tx_hash?: string | null;
  fee_amount?: string | null;
  fee_rate?: string | null;
  net_amount?: string | null;
  /** 수수료·정산액을 결제 토큰 자릿수(token_decimals) 그대로 — 온체인 금액과 정확히 같다. 발급 전 null. */
  fee_amount_token?: string | null;
  net_amount_token?: string | null;
  success_url?: string | null;
  cancel_url?: string | null;
  metadata?: Record<string, unknown> | null;
  payment_link_id?: string | null;
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
  /** 이 토큰으로 보낼 정확 금액(atomic, 이 토큰의 decimals 기준). */
  amount_atomic?: string;
  /**
   * false = 목록에는 보이지만 아직 선택할 수 없는 옵션(`unavailable_reason` 참고). 이 옵션으로 `issueDepositAddress` 를
   * 호출하면 409 `CHECKOUT_CHAIN_COMING_SOON`. 0.13.0 에서 추가 — 이전 API 응답에는 없을 수 있어 optional.
   */
  available?: boolean;
  /** 선택할 수 없는 이유. `coming_soon` = 이 네트워크는 곧 결제가 열린다. 선택 가능하면 null. */
  unavailable_reason?: 'coming_soon' | null;
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
  /**
   * 주문 총액 — **canonical μUSD(6dp) 정수 문자열**(가격 통화 기준, $1 = "1000000"). 결제 토큰 decimals 와 무관하다
   * (18dp 토큰으로 결제해도 6dp). 온체인으로 보낼 토큰 단위 금액은 `pay_amount`(또는 발급 응답 `expectedAmount`).
   */
  amount_total: string;
  /** 지금까지 입금주소에 들어온 금액 — **결제 토큰 atomic**(`token_decimals` 기준). 미입금이면 null. */
  amount_received?: string | null;
  /**
   * 선택된 결제 토큰 단위의 총액(atomic, `token_decimals` 기준) — 구매자가 송금할 정확 금액. 자산 미선택이면 null.
   * = canonicalToTokenAtomic(amount_total, token_decimals). 부족액 = pay_amount − amount_received.
   */
  pay_amount?: string | null;
  pay_chain: string | null;
  pay_asset: string | null;
  /** 발급된 주문별 forwarder 입금주소(미발급이면 null). */
  deposit_address?: string | null;
  /**
   * Solana 전용: 구매자가 받는 사람으로 넣을 지갑(owner) 주소 — 입금 토큰 계정(deposit_address)을 소유한 주문 계정.
   * 지갑은 이 주소에서 토큰 계정을 도출하므로 이것을 수신자로 쓴다. EVM/Tron 은 null.
   */
  deposit_owner?: string | null;
  /**
   * 입금주소 발급 후: 그 주소로 보낸 송금을 정상 처리하는 마감(ISO, expires_at + grace ~90분). 미발급이면 null.
   * expires_at 이 지나면 새 송금을 받지 말고(주소 비노출) 이 시각까지 확인을 기다린다.
   */
  payment_deadline_at?: string | null;
  /** 구매자 선택 가능한 결제 옵션(서버 권위). 단일-자산이면 1개. */
  payment_options: PaymentOption[];
  chain_id: number | null;
  token_address: string | null;
  /** 선택된 pay 토큰 decimals(발급 후). amount_received / pay_amount 해석에 사용 — 6dp 가정 금지(amount_total 은 항상 6dp). */
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
  /** Solana 전용: 수신자로 넣을 지갑(owner) 주소(`PublicSession.deposit_owner` 와 같음). EVM/Tron 은 null. */
  depositOwner?: string | null;
}

/**
 * `getStatus()` (`GET /v1/checkout/sessions/:id/status`) 응답 — 경량 폴링용(API 키, 자기 세션만).
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

/** 목록 응답 meta — total 은 필터 조건에 맞는 전체 개수(페이지 무관). */
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
 *   - `amount`(권장): 사람 표기 canonical 6dp 문자열(예 "29", "0.5"). decimal 신경 쓸 필요 없음.
 *   - `amount_atomic`: raw canonical 6dp 정수($1="1000000") — 고급/기존.
 * 둘 다 지정하거나 둘 다 생략하면 서버가 400 을 반환한다.
 *
 * `amount`/`amount_atomic`은 실제 결제 토큰의 decimals 가 아니라 **항상 canonical 6dp**다 — 서버가
 * 결제 시점에 실제 토큰 decimals(예: JPYC=18dp)로 재스케일한다(1:1 가정, 환율 변환 없음). 즉
 * `token_symbol: 'JPYC'`로 "29"를 등록하면 29 JPYC(≈29엔)로 결제되지, 29 USD 상당의 JPYC로
 * 환산되지 않는다.
 *
 * `currency`는 입력받지 않는다 — 서버가 `token_symbol`에서 파생한다(불일치 방지).
 */
export interface CreatePriceParams {
  /** 사람 표기 canonical 6dp 금액(예 "29", "0.5") — 권장. amount_atomic 과 상호배타. */
  amount?: string;
  /** raw canonical 6dp 정수($1="1000000") — 고급/기존. amount 와 상호배타. */
  amount_atomic?: string;
  /** 'USDC' | 'USDT' | 'JPYC' — 미지정 시 'USDC'. 이 Price 의 유일한 결제 자산(currency 는 여기서 파생). */
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
