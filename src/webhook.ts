/**
 * @bitpal/checkout — Webhook 서명 검증 + 이벤트 타입
 *
 * BitPal 이 보내는 canonical webhook contract(envelope/서명/헤더)와 1:1 정합한다.
 */

/**
 * BitPal 이 발송하는 webhook 이벤트 타입 전체 목록.
 */
export const CHECKOUT_WEBHOOK_EVENTS = [
  'checkout.session.created',
  'checkout.session.deposit_detected',
  'checkout.session.paid',
  'checkout.session.settled',
  'checkout.session.expired',
  'checkout.session.unresolved',
  'checkout.refund.recorded',
] as const;

export type CheckoutWebhookEvent = (typeof CHECKOUT_WEBHOOK_EVENTS)[number];

/**
 * Canonical envelope (HTTP body).
 * Backend `CanonicalWebhookEnvelope`와 동일 shape.
 */
export interface WebhookPayload {
  /** event_id (replay 시 원본 보존) */
  id: string;
  /** canonical event name */
  event: CheckoutWebhookEvent;
  /** envelope 생성 시각 (ISO) */
  created_at: string;
  /** 이벤트별 payload */
  data: Record<string, unknown>;
}

/** Backend가 보내는 canonical 헤더 이름 */
export const WEBHOOK_HEADERS = {
  signature: 'X-Webhook-Signature-256',
  timestamp: 'X-Webhook-Timestamp',
  event: 'X-Webhook-Event',
  eventId: 'X-Webhook-Id',
  deliveryId: 'X-Webhook-Delivery-Id',
} as const;

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Webhook signature 검증.
 *
 * Contract:
 *  - Backend는 `X-Webhook-Signature-256: sha256=<hex>` 형식으로 보냄
 *  - 서명 대상은 raw HTTP body (envelope JSON string, byte 단위 동일)
 *  - HMAC-SHA256(body, secret) hex와 timing-safe compare
 *
 * 본 함수는 두 형식 모두 허용하지 않고 canonical(`sha256=<hex>`)만 처리한다.
 * raw hex만 받는 형식은 폐기됨 (backend 단일 contract).
 *
 * @param payload - HTTP request raw body (string)
 * @param signature - `X-Webhook-Signature-256` 헤더 값 (`sha256=<hex>`)
 * @param secret - webhook 등록 시 1회 노출된 raw secret (`whsec_...`)
 * @returns true if signature matches
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { verifyWebhookSignature, parseWebhookEvent, WEBHOOK_HEADERS } from '@bitpal/checkout';
 *
 * app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
 *   const raw = req.body.toString('utf8'); // raw body — parse/re-serialize 하면 서명 깨짐
 *   const ok = await verifyWebhookSignature(
 *     raw,
 *     req.header(WEBHOOK_HEADERS.signature) ?? '',
 *     process.env.BITPAL_WEBHOOK_SECRET!,
 *     { timestamp: req.header(WEBHOOK_HEADERS.timestamp) ?? '' }, // replay 방어 — 필수
 *   );
 *   if (!ok) return res.status(400).send('invalid signature');
 *   const event = parseWebhookEvent(raw);
 *   // dedup 은 서명된 body 의 event.id 로 (헤더 X-Webhook-Id 는 미서명)
 *   if (await alreadyProcessed(event.id)) return res.status(200).send('dup');
 *   if (event.event === 'checkout.session.paid') { ... }
 *   res.status(200).send('ok');
 * });
 * ```
 */
export interface VerifyWebhookOptions {
  /** `X-Webhook-Timestamp` 헤더 값(ISO UTC). 서명 대상에 포함되며 freshness 검사에 쓰인다. 필수. */
  timestamp: string;
  /** freshness 허용 오차(초). 기본 300(5분). |now - timestamp| 초과 시 replay 로 간주해 거부. */
  toleranceSec?: number;
}

export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  opts?: VerifyWebhookOptions,
): Promise<boolean> {
  if (!payload || !signature || !secret) return false;
  if (!signature.startsWith(SIGNATURE_PREFIX)) return false;

  // replay 방어: X-Webhook-Timestamp 없이는 검증 불가(v0.4 breaking — body-only 폐기).
  const timestamp = opts?.timestamp;
  if (!timestamp) return false;

  // 유효 timestamp 만 — Date.parse 실패(NaN)를 명시 거부하고, canonical ISO UTC 만 허용.
  const parsedMs = Date.parse(timestamp);
  if (!Number.isFinite(parsedMs)) return false;
  if (new Date(parsedMs).toISOString() !== timestamp) return false;
  const toleranceMs = (opts?.toleranceSec ?? 300) * 1000;
  if (Math.abs(Date.now() - parsedMs) > toleranceMs) return false;

  const sigHex = signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return false;

  try {
    const crypto = await import('node:crypto');
    const expectedHex = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`, 'utf8') // 서버와 동일: HMAC(`${timestamp}.${body}`)
      .digest('hex');

    if (sigHex.length !== expectedHex.length) return false;

    return crypto.timingSafeEqual(
      Buffer.from(sigHex, 'hex'),
      Buffer.from(expectedHex, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * Webhook envelope 파싱.
 * 형식 검증 후 `WebhookPayload` 타입으로 캐스팅.
 *
 * @throws Error 형식이 envelope이 아닐 때
 */
export function parseWebhookEvent(body: string): WebhookPayload {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (
    typeof parsed.id !== 'string' ||
    typeof parsed.event !== 'string' ||
    typeof parsed.created_at !== 'string' ||
    typeof parsed.data !== 'object' ||
    parsed.data === null
  ) {
    throw new Error('Invalid webhook envelope — expected {id, event, created_at, data}');
  }
  return parsed as unknown as WebhookPayload;
}
