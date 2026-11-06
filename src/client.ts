/**
 * @bitpal/checkout SDK — 클라이언트
 *
 * Phase 1 범위: 세션 생성/조회, 결제 링크 생성/조회, 수수료 미리보기.
 * 크레딧 잔액/충전은 BitPal non-custodial 모델에서 제거됨.
 */

import type {
  BitPalConfig,
  CreateSessionParams,
  CheckoutLineItemInput,
  CheckoutSession,
  PublicSession,
  SessionStatus,
  IssueDepositAddressParams,
  DepositAddress,
  FeePreview,
  ApiResponse,
  ListResponse,
} from './types.js';
import { ProductsResource, PricesResource, PaymentLinksResource } from './catalog.js';

/**
 * line item one-of 검증 — 금액은 `amount`(사람 표기 canonical 6dp) XOR `amount_atomic`(raw canonical
 * 6dp) 중 하나. 실제 결제 통화는 `currency`('USDC'/'USDT'/'JPYC')가 결정하고 amount 는 그 통화 기준
 * 값이다(USD 로 고정된 게 아님). 변환은 서버가 수행하므로 SDK 는 그대로 전달(실제 토큰 decimal 무관 —
 * 발급 시 서버가 재스케일). price_id 항목은 서버가 금액 resolve 하므로 그대로. 둘 다/둘 다없음은 SDK 가
 * 즉시 에러.
 */
/** API 의 결제 대기 시간 범위(분) — createSessionSchema.expires_in_minutes 와 같다. */
const EXPIRY_MIN_MINUTES = 1;
const EXPIRY_MAX_MINUTES = 60;

/**
 * expires_in_minutes / (deprecated) expires_in_seconds → API 의 expires_in_minutes.
 * 서버는 expires_in_seconds 를 모른다(조용히 무시돼 항상 15분이었다) — SDK 가 분으로 변환해 보낸다.
 */
function resolveExpiryMinutes(minutes: number | undefined, seconds: number | undefined): number | undefined {
  if (minutes !== undefined && seconds !== undefined) {
    throw new Error("[BitPal] pass only one of `expires_in_minutes` or `expires_in_seconds`.");
  }
  const resolved = seconds !== undefined ? Math.ceil(seconds / 60) : minutes;
  if (resolved === undefined) return undefined;
  if (!Number.isInteger(resolved) || resolved < EXPIRY_MIN_MINUTES || resolved > EXPIRY_MAX_MINUTES) {
    throw new Error(`[BitPal] session expiry must be ${EXPIRY_MIN_MINUTES}–${EXPIRY_MAX_MINUTES} minutes (expires_in_minutes) — got ${seconds !== undefined ? seconds + "s" : minutes}.`);
  }
  return resolved;
}

function validateLineItem(li: CheckoutLineItemInput): CheckoutLineItemInput {
  if ('price_id' in li) return li;
  const hasHuman = li.amount != null;
  const hasAtomic = li.amount_atomic != null;
  if (hasHuman === hasAtomic) {
    throw new Error('[BitPal] line item requires exactly one of `amount` (canonical decimal number, e.g. "29") or `amount_atomic` (raw canonical 6dp integer, e.g. "29000000").');
  }
  return li;
}

const DEFAULT_BASE_URL = 'https://api.bitpal.io';
const DEFAULT_TIMEOUT = 30_000;

export class BitPalCheckoutClient {
  /** 서버 메서드용 secret 키. 공개(buyer-facing) 메서드는 없이도 동작. */
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeout: number;

  /** PROD-LINK-3a-SDK: Product 카탈로그 관리 (server-side 전용) */
  readonly products: ProductsResource;
  /** PROD-LINK-3a-SDK: immutable Price 관리 — 가격 변경은 비활성화 + 새 price 생성 */
  readonly prices: PricesResource;
  /** PROD-LINK-4-SDK: Payment Link 관리 — 대시보드 없이 코드로 결제 링크 생성 (server-side 전용) */
  readonly paymentLinks: PaymentLinksResource;

  constructor(config: BitPalConfig) {
    // apiKey 선택 — 서버 메서드는 필요(없으면 서버가 401), 공개 메서드는 apiKey 없이 동작.
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;

    const requester = <T>(method: string, path: string, body?: unknown): Promise<T> =>
      this.request<T>(method, path, body);
    this.products = new ProductsResource(requester);
    this.prices = new PricesResource(requester);
    this.paymentLinks = new PaymentLinksResource(requester);
  }

  /* ─── 내부 HTTP ─── */

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          // 공개 메서드(session_token 기반)는 apiKey 없이 호출 가능 — 있을 때만 Authorization 첨부.
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...(extraHeaders ?? {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      // 프록시/게이트웨이 오류(HTML 502 등)는 JSON 이 아니다 — 파싱 실패를 SyntaxError 로 흘리지 않는다.
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        if (!res.ok) throw new BitPalError(`HTTP ${res.status}`, res.status);
        throw new BitPalError(`Invalid JSON response (HTTP ${res.status})`, res.status);
      }

      if (!res.ok) {
        const err = json && typeof json === 'object' ? (json as Record<string, unknown>).error : undefined;
        const msg = typeof err === 'string' && err.length > 0 ? err : `HTTP ${res.status}`;
        throw new BitPalError(msg, res.status, parseApiErrorBody(json));
      }

      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ─── Sessions ─── */

  /**
   * 체크아웃 세션 생성.
   *
   * `line_items[].amount` 는 사람 표기 canonical 6dp 문자열("29", "0.5") — decimal 계산 불필요.
   * `currency`('USDC'/'USDT'/'JPYC')가 실제 결제 통화를 결정하고, amount 는 항상 그 통화 기준 값이다
   * (USD 로 고정된 게 아님 — currency='JPYC' + amount='1500' → 1500엔/1500 JPYC, 환율 변환 없음).
   * 이미 raw canonical 6dp 정수라면 `amount_atomic`("29000000") 사용(고급). 둘은 상호 배타.
   *
   * @example
   * import { BitPal } from '@bitpal/checkout';
   * const bp = new BitPal('bp_test_...');
   * const { data } = await bp.checkout.createSession({
   *   // amount: 사람 표기 canonical 6dp("29", "0.5"). 체인/토큰 decimal 은 발급 시 서버가 재스케일.
   *   line_items: [{ name: 'Pro', amount: '29', currency: 'USDC' }],
   * });
   * console.log(data.url); // → buyer를 redirect할 결제 페이지
   *
   * // 멀티체인 허용 — 구매자가 Base/Optimism 중 선택(하나뿐이면 자동 선택):
   * //   어떤 체인·토큰이든 amount 그대로 — 서버가 발급 시 토큰 decimals 로 재스케일.
   * await bp.checkout.createSession({
   *   line_items: [{ name: 'Pro', amount: '29', currency: 'USDC' }],
   *   allowed_pay_chains: ['eip155:84532', 'eip155:11155420'],
   * });
   * // 단일 체인 고정은 pay_chain 사용(둘은 상호 배타).
   */
  async createSession(params: CreateSessionParams): Promise<ApiResponse<CheckoutSession>> {
    // pay_chain(단일 고정)과 allowed_pay_chains(다중 허용)는 상호 배타 — 서버도 막지만
    // SDK 사용자가 즉시 피드백 받도록 클라이언트에서 선제 차단.
    if (params.pay_chain && params.allowed_pay_chains && params.allowed_pay_chains.length > 0) {
      throw new Error('[BitPal] pay_chain and allowed_pay_chains are mutually exclusive — use only one.');
    }
    // one-of 검증만 — amount(사람 USD) / amount_atomic(raw μUSD) 변환은 서버가 수행.
    //   allowed_assets 는 SDK 표준 {chain, token} → createSession API 필드명(caip2)으로 매핑.
    //   chain 값(short-name/CAIP-2)은 서버가 mode-relative 로 정규화(payment-link 는 API 가 직접 chain 수용).
    // payer_wallet / pay_asset 는 deprecated — API 스키마에 없어 서버가 조용히 버리던 필드라 보내지 않는다
    //   (OpenAPI 계약 테스트 contract.test.ts 가 스펙에 없는 바디 키를 drift 로 잡는다).
    const { expires_in_seconds, payer_wallet: _payerWallet, pay_asset: _payAsset, ...rest } = params;
    const expiresInMinutes = resolveExpiryMinutes(params.expires_in_minutes, expires_in_seconds);
    const body = {
      ...rest,
      ...(expiresInMinutes !== undefined ? { expires_in_minutes: expiresInMinutes } : {}),
      line_items: params.line_items.map(validateLineItem),
      ...(params.allowed_assets
        ? { allowed_assets: params.allowed_assets.map((a) => ({ caip2: a.chain, token: a.token })) }
        : {}),
    };
    const res = await this.request<ApiResponse<CheckoutSession>>(
      'POST',
      '/v1/checkout/sessions',
      body,
    );
    // Backend가 token 쿼리까지 포함한 정확한 URL을 `checkout_url`로 보낸다.
    // SDK는 mirror해서 `url`로도 노출 (backwards compat). 자체적으로 URL을 조립하지 않는 이유:
    //   - token 쿼리 누락 시 결제 페이지가 "세션 토큰이 없습니다"로 fail-close 함
    //   - API base와 web URL이 분리된 환경에서 host derive가 부정확할 수 있음
    if (res.data) {
      if (res.data.checkout_url) {
        res.data.url = res.data.checkout_url;
      } else if (!res.data.url) {
        // 극단적 fallback — backend가 양쪽 다 안 주는 경우만.
        res.data.url = `${this.baseUrl.replace('api.', '')}/pay/${res.data.id}`;
      }
    }
    return res;
  }

  /** 세션 조회 */
  async getSession(sessionId: string): Promise<ApiResponse<CheckoutSession>> {
    return this.request<ApiResponse<CheckoutSession>>(
      'GET',
      `/v1/checkout/sessions/${sessionId}`,
    );
  }

  /** 세션 목록 조회 */
  async listSessions(params?: { status?: string; limit?: number; offset?: number }): Promise<ListResponse<CheckoutSession>> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    const query = qs.toString();
    return this.request<ListResponse<CheckoutSession>>(
      'GET',
      `/v1/checkout/sessions${query ? `?${query}` : ''}`,
    );
  }

  /* ─── 안2 비수탁 결제 (deposit-address) ─── */

  /**
   * 공개 세션 조회 (`GET /v1/checkout/sessions/:id/public`) — 인증 불요.
   *
   * buyer-facing 결제 페이지가 표시/자산선택에 쓰는 서버 권위 뷰. `payment_options` 로
   * 구매자 선택 가능한 chain×token 을 얻고, 발급 후에는 `deposit_address` 가 채워진다.
   */
  async getPublicSession(sessionId: string): Promise<ApiResponse<PublicSession>> {
    return this.request<ApiResponse<PublicSession>>(
      'GET',
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/public`,
    );
  }

  /**
   * 주문별 비수탁 입금주소 발급 (`POST /v1/checkout/sessions/:id/deposit-address`).
   *
   * 안2 결제 진입점. 구매자가 자산(멀티옵션이면 chain/token)과 환불 주소를 확정하면 서버가
   * 그 주문 전용 CREATE2 forwarder 주소를 돌려준다. 구매자는 아무 지갑/거래소에서 **정확한 금액**을
   * 그 주소로 일반 송금하면 된다(서명·연결 불필요). watcher 가 감지 → keeper 가 정산.
   *
   * refundAddress 는 입금주소에 커밋되어 발급 후 변경 불가. session_token 은 createSession 응답값.
   *
   * @example
   * ```ts
   * const { data } = await bitpal.checkout.issueDepositAddress(sessionId, {
   *   session_token: session.session_token!,
   *   refundAddress: '0xBuyerWallet...',
   *   chain: 'eip155:8453', // 멀티옵션 세션만 필요
   *   token: 'USDC',
   * });
   * console.log(data.depositAddress, data.expectedAmount); // 이 주소로 정확 금액 송금
   * ```
   */
  async issueDepositAddress(
    sessionId: string,
    params: IssueDepositAddressParams,
  ): Promise<ApiResponse<DepositAddress>> {
    return this.request<ApiResponse<DepositAddress>>(
      'POST',
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/deposit-address`,
      params,
    );
  }

  /**
   * 경량 상태 폴링 (`GET /v1/checkout/sessions/:id/status`) — 인증 불요.
   *
   * status: awaiting_deposit → deposit_detected → paid_confirmed/swept. 확정/정산은 webhook 으로도
   * 통지되므로, 서버 사이드 확정은 webhook 을 신뢰(폴링은 buyer UX 용).
   */
  async getStatus(sessionId: string): Promise<ApiResponse<SessionStatus>> {
    return this.request<ApiResponse<SessionStatus>>(
      'GET',
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/status`,
    );
  }

  /* ─── Fees ─── */

  /**
   * 수수료 미리보기 — `/v1/checkout/fee-preview`.
   *
   * `amount` 는 **사람 표기**다("100", "0.5") — line item / Price / x402 와 같은 모델이라
   * decimals 를 계산할 필요가 없다. raw μUSD 를 직접 넣으려면 `amountAtomic` 을 쓴다(상호 배타).
   * 응답은 계속 atomic 이다(계산 결과라 정밀도가 곧 계약이다).
   *
   * @example
   * const { data } = await bp.checkout.previewFee('100');       // $100
   * const { data } = await bp.checkout.previewFee({ amountAtomic: '100000000' });
   */
  async previewFee(amount: string | { amountAtomic: string }): Promise<ApiResponse<FeePreview>> {
    const qs =
      typeof amount === 'string'
        ? `amount=${encodeURIComponent(amount)}`
        : `amount_atomic=${encodeURIComponent(amount.amountAtomic)}`;
    if (typeof amount === 'string' && !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(amount)) {
      throw new Error('[BitPal] previewFee: amount must be a decimal string like "100" or "0.5" (max 6 decimals). For raw μUSD use { amountAtomic }.');
    }
    return this.request<ApiResponse<FeePreview>>('GET', `/v1/checkout/fee-preview?${qs}`);
  }
}

/* ─── Error ─── */

/** Structured fields parsed from an API error body. All optional — older endpoints omit some. */
export interface BitPalErrorDetails {
  /** Machine-readable error code, e.g. `"FEATURE_NOT_ENABLED"`. */
  code?: string;
  /** Human-readable message from the API, when it sent one separately from the code. */
  apiMessage?: string;
  /** Whether retrying the same request may succeed. */
  retryable?: boolean;
  /** Server trace id — include it when contacting support. */
  traceId?: string;
}

export class BitPalError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly apiMessage?: string;
  readonly retryable?: boolean;
  readonly traceId?: string;
  constructor(message: string, statusCode: number, details: BitPalErrorDetails = {}) {
    super(message);
    this.name = 'BitPalError';
    this.statusCode = statusCode;
    this.code = details.code;
    this.apiMessage = details.apiMessage;
    this.retryable = details.retryable;
    this.traceId = details.traceId;
  }
}

const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * API 에러 body → BitPalError 상세. 두 가지 shape 를 모두 읽는다:
 *   - 표준: `{ error: <message>, code, retryable, trace_id }`
 *   - 일부 라우트: `{ error: <CODE>, message }`
 * `message`(Error.message)는 0.11 과 같게 `body.error` 를 유지한다(하위 호환) — 추가 정보는 필드로만.
 */
export function parseApiErrorBody(body: unknown): BitPalErrorDetails {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const error = str(b.error);
  const explicitCode = str(b.code);
  const message = str(b.message);
  const code = explicitCode ?? (error && ERROR_CODE_RE.test(error) ? error : undefined);
  const apiMessage = message ?? (explicitCode && error && error !== explicitCode ? error : undefined);
  return {
    code,
    apiMessage,
    retryable: typeof b.retryable === 'boolean' ? b.retryable : undefined,
    traceId: str(b.trace_id),
  };
}
