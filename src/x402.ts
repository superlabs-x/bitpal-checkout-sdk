/**
 * x402 — 라우트 호출 1건당 과금하는 머천트 미들웨어.
 *
 * 머천트 코드는 "이 라우트는 $1" 만 선언한다. 402 조립, `X-PAYMENT` 파싱, verify → settle 순서,
 * 에러 매핑, 재사용 차단은 전부 여기 안에 있다. 수수료는 BitPal이 계산해 402에 실어주므로
 * 머천트는 **자기가 받고 싶은 총액(gross) 하나만** 넘긴다(체크아웃 `line_items[].amount` 와 동일 UX).
 *
 * 두 가지를 특히 조심해서 다룬다:
 *
 *  1. **"결제 1건 = 응답 1건" 은 미들웨어 책임이다.** BitPal `/settle` 의 멱등성은 "같은 nonce로 두 번
 *     정산 요청해도 자금은 한 번만 움직인다" 만 보장한다. 같은 `X-PAYMENT` 를 100번 보내면 100번
 *     성공 응답이 오므로, 그것만 믿으면 결제 1건으로 API를 무한 호출할 수 있다. 그래서 이미 리소스를
 *     내준 authorization 을 로컬에 기록해 재사용을 막는다(`X402ReplayStore`).
 *
 *  2. **HTTP 200 은 정산 성공이 아니다.** 이미 종결된 결제를 다시 settle 하면 서버는 그 결과를 그대로
 *     돌려준다 — `reverted` 여도 200 이다. 리소스는 `status === 'confirmed'` 일 때만 내준다.
 */

import { BitPalError } from './client.js';
import type { ApiResponse } from './types.js';

/* ─── 상수 ─── */

/** payer → resource server. base64(JSON) 결제 payload. */
export const X402_PAYMENT_HEADER = 'x-payment';
/** resource server → payer. base64(JSON) 정산 결과(txHash 포함). */
export const X402_PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

const DEFAULT_BASE_URL = 'https://api.bitpal.io';
const DEFAULT_TIMEOUT = 60_000;
/** 402 의 기본 유효시간(초) — 서버 기본값과 동일. inflight 점유 TTL 로도 쓴다. */
const DEFAULT_MAX_TIMEOUT_SECONDS = 300;
/** 사용 완료된 nonce 를 기억하는 기간(초). EIP-3009 유효창을 크게 넘기면 재사용 위험이 없다. */
const CONSUMED_TTL_SECONDS = 24 * 60 * 60;
/** 기본 in-memory store 상한 — 넘으면 오래된 것부터 버린다. */
const MEMORY_STORE_MAX_ENTRIES = 50_000;

/* ─── 402 바디 타입(서버가 만들어 주는 값) ─── */

export interface X402FeeBreakdown {
  netAmount: string;
  feeAmount: string;
  feeBps: number;
  feeRecipient: string | null;
}

export interface X402Accept {
  scheme: 'exact';
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  /** payer 가 EIP-712 domain 을 그대로 만들 수 있는 값. */
  extra: { name: string; version: string; chainId: number };
  /** BitPal 확장 — payer 가 merchant/fee 두 authorization 을 만들 수 있도록 서버가 확정한 분해. */
  feeBreakdown: X402FeeBreakdown;
}

export interface X402Requirements {
  x402Version: 1;
  accepts: X402Accept[];
}

/* ─── X-PAYMENT payload ─── */

export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: { v: number; r: string; s: string };
}

export interface X402PaymentPayload {
  x402Version: 1;
  scheme: 'exact';
  /** x402 wire 이름 — 'base' / 'base-sepolia'. */
  network: string;
  payload: {
    merchant: Eip3009Authorization;
    /** 서버가 계산한 feeAmount > 0 이면 필수. */
    fee?: Eip3009Authorization;
  };
}

/* ─── 재사용 차단 store ─── */

/** `ok` = 이번 호출이 최초 점유 / `inflight` = 다른 요청이 처리 중 / `used` = 이미 리소스를 내줌. */
export type X402ClaimState = 'ok' | 'inflight' | 'used';

/**
 * authorization 재사용 차단 저장소.
 *
 * 기본 구현은 프로세스 메모리다 — 단일 인스턴스에선 충분하지만, 여러 인스턴스로 스케일 아웃하면
 * 인스턴스마다 기억이 따로라 결제 1건으로 인스턴스 수만큼 호출할 수 있다. 다중 인스턴스 배포라면
 * Redis/DB 기반 구현을 넘겨야 한다(키는 `network:from:nonce` 문자열 하나).
 */
export interface X402ReplayStore {
  claim(key: string, inflightTtlSeconds: number): X402ClaimState | Promise<X402ClaimState>;
  /** 리소스를 내줬다 — 이 키는 영구 소진. */
  commit(key: string): void | Promise<void>;
  /** 정산이 안 끝났다 — 점유만 풀고 재시도를 허용(소진 처리 아님). */
  release(key: string): void | Promise<void>;
}

/** 프로세스 메모리 기반 기본 store. */
export function createMemoryReplayStore(): X402ReplayStore {
  const entries = new Map<string, { state: 'inflight' | 'used'; expiresAt: number }>();

  const prune = (now: number): void => {
    for (const [k, v] of entries) {
      if (v.expiresAt <= now) entries.delete(k);
    }
    // 만료만으로 안 줄어들면 삽입 순서대로 버린다(Map 은 삽입 순서 보장).
    while (entries.size > MEMORY_STORE_MAX_ENTRIES) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  return {
    claim(key, inflightTtlSeconds) {
      const now = Date.now();
      prune(now);
      const found = entries.get(key);
      if (found) return found.state;
      entries.set(key, { state: 'inflight', expiresAt: now + inflightTtlSeconds * 1000 });
      return 'ok';
    },
    commit(key) {
      entries.set(key, { state: 'used', expiresAt: Date.now() + CONSUMED_TTL_SECONDS * 1000 });
    },
    release(key) {
      entries.delete(key);
    },
  };
}

/* ─── Gate(프레임워크 무관 코어) ─── */

export interface X402GateOptions {
  /** 머천트가 이미 쓰고 있는 `bp_test_…` / `bp_live_…` 키. prefix 가 곧 네트워크(테스트/라이브)다. */
  apiKey: string;
  /** 정산 지갑. 콘솔에 등록한 payout 주소와 같은 값이어야 한다. */
  payTo: string;
  /** 호출 1건당 받을 총액(atomic). USDC 6dp 기준 $1 = `'1000000'`. 수수료는 여기서 차감된다. */
  amount: string;
  /** 생략 시 API 키 모드의 기본 자산(현재 Base / Base Sepolia). */
  network?: string;
  /** 기본 `'USDC'`. */
  asset?: string;
  description?: string;
  mimeType?: string;
  /** payer 가 서명을 만들어 재요청하기까지 주는 시간(초). 기본 300. */
  maxTimeoutSeconds?: number;
  baseUrl?: string;
  /** BitPal API 호출 타임아웃(ms). settle 은 영수증까지 기다리므로 기본 60초. */
  timeout?: number;
  /** 다중 인스턴스 배포라면 공유 store 를 넘긴다. 기본은 프로세스 메모리. */
  replayStore?: X402ReplayStore;
}

export interface X402SettledPayment {
  paymentId: string;
  txHash: string | null;
  network: string;
  /** payer 주소(merchant authorization 의 from). */
  payer: string;
  amount: string;
}

export type X402GateResult =
  /** 결제가 없거나 유효하지 않다 — 402 와 결제 조건을 그대로 내려준다. */
  | { kind: 'payment_required'; status: 402; body: X402Requirements & { error?: string } }
  /** 이 authorization 으로는 이미 리소스를 내줬다 — 재사용 거부. */
  | { kind: 'already_used'; status: 409; body: { error: string; message: string } }
  /** 자금이 움직였는지 아직 확정 못 했다 — **같은** `X-PAYMENT` 로 재시도해야 한다(재서명 금지). */
  | { kind: 'unconfirmed'; status: 503; body: { error: string; message: string; paymentId?: string } }
  /** 정산 확정 — 리소스를 내주면 된다. */
  | { kind: 'settled'; status: 200; payment: X402SettledPayment; paymentResponseHeader: string };

/**
 * 프레임워크에 묶이지 않은 x402 게이트.
 *
 * Express 는 아래 `x402()` 어댑터를 쓰면 되고, Hono/Fastify/Next 등 다른 런타임은 이 클래스를 직접
 * 감싸면 된다 — 헤더 하나와 resource URL 만 넘기면 "402 를 내려라 / 리소스를 내줘라" 를 돌려준다.
 */
export class X402Gate {
  private readonly opts: X402GateOptions;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly store: X402ReplayStore;
  private readonly maxTimeoutSeconds: number;

  constructor(opts: X402GateOptions) {
    if (!opts.apiKey) throw new Error('[BitPal] x402: apiKey is required.');
    if (!/^0x[a-fA-F0-9]{40}$/.test(opts.payTo)) {
      throw new Error('[BitPal] x402: payTo must be a 0x EVM address (your registered payout wallet).');
    }
    if (!/^\d+$/.test(opts.amount)) {
      throw new Error('[BitPal] x402: amount must be an atomic integer string (USDC 6dp, $1 = "1000000").');
    }
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    this.store = opts.replayStore ?? createMemoryReplayStore();
    this.maxTimeoutSeconds = opts.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  }

  /** 이 리소스의 402 바디를 서버에서 받아온다(수수료 분해 포함). */
  async requirements(resource: string): Promise<X402Requirements> {
    return this.request<X402Requirements>('POST', '/v1/x402/requirements', {
      payTo: this.opts.payTo,
      amount: this.opts.amount,
      resource,
      ...(this.opts.network ? { network: this.opts.network } : {}),
      ...(this.opts.asset ? { asset: this.opts.asset } : {}),
      ...(this.opts.description ? { description: this.opts.description } : {}),
      ...(this.opts.mimeType ? { mimeType: this.opts.mimeType } : {}),
      maxTimeoutSeconds: this.maxTimeoutSeconds,
    });
  }

  /**
   * `X-PAYMENT` 헤더 1건을 처리한다. 헤더가 없거나 깨졌으면 402, 정산까지 끝나면 `settled`.
   *
   * 순서가 중요하다: **점유 → verify → settle → 소진 기록**. 점유를 verify 앞에 두어야 같은
   * authorization 을 동시에 밀어 넣어도 한 요청만 리소스를 받는다.
   */
  async collect(input: { header?: string | null; resource: string }): Promise<X402GateResult> {
    const { header, resource } = input;
    if (!header) return this.paymentRequired(resource);

    let payload: X402PaymentPayload;
    try {
      payload = decodePaymentHeader(header);
    } catch {
      return this.paymentRequired(resource, 'MALFORMED_PAYMENT_HEADER');
    }

    const merchant = payload?.payload?.merchant;
    if (!merchant?.from || !merchant?.nonce) {
      return this.paymentRequired(resource, 'MALFORMED_PAYMENT_HEADER');
    }

    // 키 스코프는 EIP-3009 의 온체인 유일성 스코프와 같다(network + from + nonce).
    const key = `${payload.network}:${merchant.from.toLowerCase()}:${merchant.nonce.toLowerCase()}`;
    const claim = await this.store.claim(key, this.maxTimeoutSeconds);
    if (claim === 'used') {
      return {
        kind: 'already_used',
        status: 409,
        body: {
          error: 'PAYMENT_ALREADY_USED',
          message: 'This payment has already been redeemed. One payment unlocks one response.',
        },
      };
    }
    if (claim === 'inflight') {
      return {
        kind: 'unconfirmed',
        status: 503,
        body: {
          error: 'PAYMENT_IN_PROGRESS',
          message: 'This payment is still being settled. Retry with the same X-PAYMENT header.',
        },
      };
    }

    // 결제 조건은 우리가 다시 만든다 — payer 가 보내온 값을 그대로 믿으면 금액/수신처를 바꿔치기할 수 있다.
    let accept: X402Accept;
    try {
      accept = await this.firstAccept(resource);
    } catch (err) {
      await this.store.release(key);
      throw err;
    }

    const body = {
      x402Version: 1 as const,
      paymentPayload: {
        scheme: 'exact' as const,
        network: payload.network,
        payload: payload.payload,
      },
      paymentRequirements: {
        asset: accept.asset,
        payTo: accept.payTo,
        maxAmountRequired: accept.maxAmountRequired,
        resource: accept.resource,
      },
    };

    try {
      await this.request<{ valid: boolean; payment_id: string; status: string }>('POST', '/v1/x402/verify', body);
    } catch (err) {
      await this.store.release(key);
      // 4xx = 서명/금액/자산이 조건과 안 맞는다. payer 는 다시 서명해야 하므로 402 로 돌려준다.
      if (err instanceof BitPalError && err.statusCode < 500) {
        return this.paymentRequired(resource, err.message, accept);
      }
      throw err;
    }

    let settled: {
      success: boolean;
      payment_id: string;
      status: string;
      tx_hash: string | null;
      network: string;
    };
    try {
      settled = await this.request('POST', '/v1/x402/settle', body);
    } catch (err) {
      if (err instanceof BitPalError && err.statusCode < 500) {
        // 체인에서 거부됨(reverted 등) — 자금은 안 움직였으니 새 결제를 받아야 한다.
        await this.store.release(key);
        return this.paymentRequired(resource, err.message, accept);
      }
      // 확정 못 함. 여기서 새 402 를 주면 payer 가 **다시 서명해 이중 지불**할 수 있다.
      //   점유만 풀고 같은 헤더로 재시도하게 한다 — /settle 은 멱등이라 재시도가 안전하다.
      await this.store.release(key);
      return {
        kind: 'unconfirmed',
        status: 503,
        body: {
          error: 'SETTLEMENT_UNCONFIRMED',
          message:
            'Payment settlement is not confirmed yet. Retry this request with the same X-PAYMENT header — settlement is idempotent.',
        },
      };
    }

    // HTTP 200 이어도 종결 상태가 confirmed 가 아닐 수 있다(이미 reverted 로 끝난 건의 재요청 등).
    if (settled.status !== 'confirmed') {
      await this.store.release(key);
      return this.paymentRequired(resource, `PAYMENT_NOT_CONFIRMED (${settled.status})`, accept);
    }

    await this.store.commit(key);

    return {
      kind: 'settled',
      status: 200,
      payment: {
        paymentId: settled.payment_id,
        txHash: settled.tx_hash,
        network: settled.network,
        payer: merchant.from,
        amount: accept.maxAmountRequired,
      },
      paymentResponseHeader: encodeBase64Json({
        success: true,
        transaction: settled.tx_hash,
        network: settled.network,
        payer: merchant.from,
        paymentId: settled.payment_id,
      }),
    };
  }

  /* ─── 내부 ─── */

  private async firstAccept(resource: string): Promise<X402Accept> {
    const requirements = await this.requirements(resource);
    const accept = requirements.accepts[0];
    if (!accept) {
      throw new BitPalError('[BitPal] x402: no payment option available for this API key mode.', 500);
    }
    return accept;
  }

  private async paymentRequired(
    resource: string,
    error?: string,
    known?: X402Accept,
  ): Promise<X402GateResult> {
    const requirements = known
      ? { x402Version: 1 as const, accepts: [known] }
      : await this.requirements(resource);
    return {
      kind: 'payment_required',
      status: 402,
      body: error ? { ...requirements, error } : requirements,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const json = (await res.json()) as ApiResponse<T> & { error?: unknown };
      if (!res.ok) {
        throw new BitPalError(String(json.error ?? `HTTP ${res.status}`), res.status);
      }
      return json.data as T;
    } catch (err) {
      // 타임아웃/네트워크 단절은 5xx 로 취급 — settle 이면 "확정 못 함" 경로로 가야 한다.
      if (err instanceof BitPalError) throw err;
      throw new BitPalError(err instanceof Error ? err.message : String(err), 599);
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ─── Express 어댑터 ─── */

/** Express 요청에서 이 미들웨어가 실제로 읽는 필드만 추린 구조적 타입. */
export interface X402Request {
  headers: Record<string, string | string[] | undefined>;
  protocol?: string;
  baseUrl?: string;
  path?: string;
  url?: string;
  originalUrl?: string;
  get?(name: string): string | undefined;
  /** 정산 정보를 핸들러에서 쓸 수 있게 여기에 붙여준다. */
  x402Payment?: X402SettledPayment;
}

/** Express 응답에서 이 미들웨어가 실제로 쓰는 메서드만 추린 구조적 타입. */
export interface X402Response {
  status(code: number): X402Response;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
}

export interface X402MiddlewareOptions extends X402GateOptions {
  /**
   * 이 결제가 묶일 리소스 URL. 기본값은 요청의 절대 URL(쿼리 제외).
   * 결제는 이 값에 묶이므로 402 와 재요청에서 같은 값이 나와야 한다.
   */
  resource?: string | ((req: X402Request) => string);
  /** 정산 확정 직후(핸들러 실행 전) 호출 — 로깅/사용량 집계용. */
  onSettled?: (payment: X402SettledPayment, req: X402Request) => void | Promise<void>;
}

/**
 * Express 라우트를 호출당 과금으로 감싼다.
 *
 * @example
 * ```ts
 * import { x402 } from '@bitpal/checkout';
 *
 * // 호출 1건당 $1.00 USDC
 * app.get('/report', x402({
 *   apiKey: process.env.BITPAL_API_KEY!,
 *   payTo: '0xYourPayoutWallet',
 *   network: 'base',
 *   amount: '1000000',
 * }), (req, res) => {
 *   res.json({ report: '…' });
 * });
 * ```
 */
export function x402(options: X402MiddlewareOptions) {
  const gate = new X402Gate(options);

  return async function x402Middleware(
    req: X402Request,
    res: X402Response,
    next: (err?: unknown) => void,
  ): Promise<void> {
    try {
      const result = await gate.collect({
        header: readHeader(req, X402_PAYMENT_HEADER),
        resource: resolveResource(req, options.resource),
      });

      if (result.kind !== 'settled') {
        res.status(result.status).json(result.body);
        return;
      }

      res.setHeader(X402_PAYMENT_RESPONSE_HEADER, result.paymentResponseHeader);
      req.x402Payment = result.payment;
      if (options.onSettled) await options.onSettled(result.payment, req);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/* ─── 헬퍼 ─── */

function readHeader(req: X402Request, name: string): string | undefined {
  const direct = req.headers?.[name] ?? req.headers?.[name.toUpperCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  if (value) return value;
  return req.get?.(name);
}

function resolveResource(req: X402Request, override: X402MiddlewareOptions['resource']): string {
  if (typeof override === 'function') return override(req);
  if (override) return override;

  const host = req.get?.('host') ?? readHeader(req, 'host') ?? 'localhost';
  const protocol = req.protocol ?? 'https';
  // Express 는 마운트 경로(baseUrl)와 라우트 경로(path)가 나뉘어 있다. 둘 다 없으면 raw URL.
  const raw = req.path != null ? `${req.baseUrl ?? ''}${req.path}` : (req.originalUrl ?? req.url ?? '/');
  // 쿼리는 뺀다 — 같은 엔드포인트가 쿼리마다 다른 리소스로 갈라지면 402 와 재요청이 어긋난다.
  const path = raw.split('?')[0] || '/';
  return `${protocol}://${host}${path}`;
}

/** base64(JSON) 이 표준이지만, 평문 JSON 을 보내는 클라이언트도 받아준다. */
export function decodePaymentHeader(header: string): X402PaymentPayload {
  const trimmed = header.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as X402PaymentPayload;
  return JSON.parse(decodeBase64(trimmed)) as X402PaymentPayload;
}

/** payer 헬퍼가 만든 payload 를 `X-PAYMENT` 헤더 값으로 인코딩한다. */
export function encodePaymentHeader(payload: X402PaymentPayload): string {
  return encodeBase64Json(payload);
}

function encodeBase64Json(value: unknown): string {
  const json = JSON.stringify(value);
  const g = globalThis as { btoa?: (s: string) => string };
  if (typeof g.btoa === 'function') {
    // btoa 는 latin1 만 받는다 — UTF-8 을 바이트 단위로 펴서 넘긴다.
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return g.btoa(binary);
  }
  return bufferFrom(json, 'utf8').toString('base64');
}

function decodeBase64(value: string): string {
  const g = globalThis as { atob?: (s: string) => string };
  if (typeof g.atob === 'function') {
    const binary = g.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return bufferFrom(value, 'base64').toString('utf8');
}

/** Node 전용 fallback — 브라우저 번들에 Buffer 타입을 끌어들이지 않으려고 좁게 감싼다. */
function bufferFrom(value: string, encoding: string): { toString(enc: string): string } {
  const g = globalThis as { Buffer?: { from(v: string, e: string): { toString(enc: string): string } } };
  if (!g.Buffer) throw new Error('[BitPal] x402: no base64 implementation available in this runtime.');
  return g.Buffer.from(value, encoding);
}
