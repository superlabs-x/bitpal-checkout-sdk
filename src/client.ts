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
 * line item one-of 검증 — 금액은 `amount`(사람 USD) XOR `amount_atomic`(raw μUSD) 중 하나.
 * 변환은 서버가 수행하므로 SDK 는 그대로 전달(체인/토큰 decimal 무관 — 발급 시 서버가 재스케일).
 * price_id 항목은 서버가 금액 resolve 하므로 그대로. 둘 다/둘 다없음은 SDK 가 즉시 에러.
 */
function validateLineItem(li: CheckoutLineItemInput): CheckoutLineItemInput {
  if ('price_id' in li) return li;
  const hasHuman = li.amount != null;
  const hasAtomic = li.amount_atomic != null;
  if (hasHuman === hasAtomic) {
    throw new Error('[BitPal] line item requires exactly one of `amount` (USD number, e.g. "29") or `amount_atomic` (raw μUSD integer, e.g. "29000000").');
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

      const json = await res.json();

      if (!res.ok) {
        const msg = (json as Record<string, unknown>).error ?? `HTTP ${res.status}`;
        throw new BitPalError(String(msg), res.status);
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
   * `line_items[].amount` 는 사람 표기 USD 문자열("29", "0.5") — decimal 계산 불필요.
   * 이미 raw μUSD 정수라면 `amount_atomic`("29000000") 사용(고급). 둘은 상호 배타.
   *
   * @example
   * import { BitPal } from '@bitpal/checkout';
   * const bp = new BitPal('bp_test_...');
   * const { data } = await bp.checkout.createSession({
   *   // amount: 사람 표기 USD("29", "0.5"). 금액은 USD 가격이라 체인/토큰 decimal 무관.
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
    const body = {
      ...params,
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

  /** 수수료 미리보기 — `/v1/checkout/fee-preview` (Phase 1 credit system 폐기 후 canonical path) */
  async previewFee(amount: string): Promise<ApiResponse<FeePreview>> {
    return this.request<ApiResponse<FeePreview>>(
      'GET',
      `/v1/checkout/fee-preview?amount=${encodeURIComponent(amount)}`,
    );
  }
}

/* ─── Error ─── */

export class BitPalError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'BitPalError';
    this.statusCode = statusCode;
  }
}
