/**
 * store.mjs — 머천트 백엔드의 in-memory 데이터 store (예제 단순화).
 *
 * 실제 production에서는 Postgres/MySQL/Redis 등 영구 저장소를 써야 한다.
 *
 * 핵심 두 store:
 *   - processedEvents: webhook idempotency dedup 키 저장 (서명된 event.id 기준)
 *   - orders: 결제 세션 → 머천트 주문 매핑
 *
 * 둘 다 atomic하게 (같은 트랜잭션 안에서) update해야 webhook race에서 안전하다.
 */

const processedEvents = new Map();   // event_id → { processedAt: Date }
const orders = new Map();            // session_id → { status, amount, paid_at, settled_at, refunds }

/**
 * Idempotency check + 처리 기록을 묶어서 처리.
 *
 * @param {string} eventId - X-Webhook-Id 헤더 값
 * @param {() => Promise<void>} apply - 비즈니스 로직 (DB write 등)
 * @returns {Promise<{ processed: boolean }>} processed=false면 이미 처리됨
 *
 * 실제 production에서는 단일 DB 트랜잭션 안에서:
 *   BEGIN;
 *   INSERT INTO webhook_events (event_id) ON CONFLICT DO NOTHING RETURNING event_id;
 *   if no row → SELECT만 → COMMIT, return processed=false
 *   else → 비즈니스 로직 + COMMIT
 */
export async function withIdempotency(eventId, apply) {
  if (!eventId) {
    throw new Error('event_id required for idempotency');
  }
  if (processedEvents.has(eventId)) {
    return { processed: false };
  }
  await apply();
  processedEvents.set(eventId, { processedAt: new Date() });
  return { processed: true };
}

export function upsertOrder(sessionId, fields) {
  const existing = orders.get(sessionId) ?? { refunds: [] };
  const merged = { ...existing, ...fields };
  orders.set(sessionId, merged);
  return merged;
}

export function getOrder(sessionId) {
  return orders.get(sessionId);
}

export function appendRefund(sessionId, refund) {
  const existing = orders.get(sessionId);
  if (!existing) return null;
  existing.refunds = [...(existing.refunds ?? []), refund];
  orders.set(sessionId, existing);
  return existing;
}
