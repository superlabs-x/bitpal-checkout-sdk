/**
 * SDK webhook 정합 테스트.
 *
 * BitPal backend의 canonical contract와 round-trip 검증.
 * 본 테스트가 통과하지 않으면 머천트가 SDK로 webhook을 검증할 수 없다.
 *
 * v0.4 breaking: 서명 = HMAC(`${X-Webhook-Timestamp}.${body}`) (replay 방어). verify 는
 * timestamp(ISO)를 필수로 받고 freshness(tolerance)를 검사한다.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyWebhookSignature,
  parseWebhookEvent,
  CHECKOUT_WEBHOOK_EVENTS,
  WEBHOOK_HEADERS,
  type WebhookPayload,
} from './webhook.js';

const SECRET = 'whsec_test_canonical_2026';
const PREFIX = 'sha256=';

/** 서버와 동일: HMAC(`${timestamp}.${body}`). */
function signCanonical(body: string, secret: string, timestamp: string): string {
  const hex = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `${PREFIX}${hex}`;
}
const freshTs = () => new Date().toISOString();

describe('@bitpal/checkout — CHECKOUT_WEBHOOK_EVENTS canonical names', () => {
  it('all events use checkout. prefix (matches backend)', () => {
    for (const evt of CHECKOUT_WEBHOOK_EVENTS) {
      expect(evt.startsWith('checkout.')).toBe(true);
    }
  });

  it('이벤트 7종 정확 일치 (backend 계약과 drift 없음)', () => {
    expect([...CHECKOUT_WEBHOOK_EVENTS].sort()).toEqual([
      'checkout.refund.recorded',
      'checkout.session.created',
      'checkout.session.deposit_detected',
      'checkout.session.expired',
      'checkout.session.paid',
      'checkout.session.settled',
      'checkout.session.unresolved',
    ]);
  });

  it('escrow/dispute-era dead 이벤트는 없다', () => {
    const set = new Set<string>(CHECKOUT_WEBHOOK_EVENTS);
    for (const dead of [
      'checkout.session.release_deferred',
      'checkout.payment.failed',
      'checkout.payment.finalized',
      'checkout.payment.revoked',
      'checkout.refund.completed',
      'checkout.refund.partial',
      'checkout.dispute.opened',
    ]) {
      expect(set.has(dead)).toBe(false);
    }
  });
});

describe('@bitpal/checkout — WEBHOOK_HEADERS canonical', () => {
  it('signature header name matches backend', () => {
    expect(WEBHOOK_HEADERS.signature).toBe('X-Webhook-Signature-256');
  });
  it('event/id/timestamp/delivery header names match backend', () => {
    expect(WEBHOOK_HEADERS.timestamp).toBe('X-Webhook-Timestamp');
    expect(WEBHOOK_HEADERS.event).toBe('X-Webhook-Event');
    expect(WEBHOOK_HEADERS.eventId).toBe('X-Webhook-Id');
    expect(WEBHOOK_HEADERS.deliveryId).toBe('X-Webhook-Delivery-Id');
  });
});

describe('@bitpal/checkout — verifyWebhookSignature (timestamped)', () => {
  const body = JSON.stringify({
    id: 'evt_001',
    event: 'checkout.session.paid',
    created_at: '2026-05-08T12:00:00.000Z',
    data: { session_id: 'cs_test_123', amount: '1000000' },
  });

  it('올바른 서명 + fresh timestamp → true', async () => {
    const ts = freshTs();
    const sig = signCanonical(body, SECRET, ts);
    expect(await verifyWebhookSignature(body, sig, SECRET, { timestamp: ts })).toBe(true);
  });

  it('timestamp 없으면 → false (replay 방어; body-only 폐기)', async () => {
    const ts = freshTs();
    const sig = signCanonical(body, SECRET, ts);
    expect(await verifyWebhookSignature(body, sig, SECRET)).toBe(false);
  });

  it('stale timestamp(tolerance 초과) → false (replay 차단)', async () => {
    const stale = new Date(Date.now() - 3600_000).toISOString(); // 1시간 전
    const sig = signCanonical(body, SECRET, stale);
    expect(await verifyWebhookSignature(body, sig, SECRET, { timestamp: stale })).toBe(false);
    // tolerance 를 넉넉히 주면 통과 (서명 자체는 유효)
    expect(await verifyWebhookSignature(body, sig, SECRET, { timestamp: stale, toleranceSec: 7200 })).toBe(true);
  });

  it('invalid/non-canonical timestamp → false', async () => {
    const ts = freshTs();
    const sig = signCanonical(body, SECRET, ts);
    expect(await verifyWebhookSignature(body, sig, SECRET, { timestamp: 'not-a-date' })).toBe(false);
    // 서명은 canonical ISO 로 했는데 verify 에 비-canonical 형식 전달 → false
    expect(await verifyWebhookSignature(body, sig, SECRET, { timestamp: '2026-05-08 12:00:00' })).toBe(false);
  });

  it('payload 변조 → false', async () => {
    const ts = freshTs();
    const sig = signCanonical(body, SECRET, ts);
    const tampered = body.replace('1000000', '9999999');
    expect(await verifyWebhookSignature(tampered, sig, SECRET, { timestamp: ts })).toBe(false);
  });

  it('잘못된 secret → false', async () => {
    const ts = freshTs();
    const sig = signCanonical(body, 'wrong_secret', ts);
    expect(await verifyWebhookSignature(body, sig, SECRET, { timestamp: ts })).toBe(false);
  });

  it('sha256= prefix 없는 raw hex → false (canonical 강제)', async () => {
    const ts = freshTs();
    const hex = createHmac('sha256', SECRET).update(`${ts}.${body}`, 'utf8').digest('hex');
    expect(await verifyWebhookSignature(body, hex, SECRET, { timestamp: ts })).toBe(false);
  });

  it('signature가 hex가 아닌 형식 → false', async () => {
    expect(await verifyWebhookSignature(body, 'sha256=NOT-HEX', SECRET, { timestamp: freshTs() })).toBe(false);
  });

  it('signature 길이 mismatch(64 hex 아님) → false', async () => {
    expect(await verifyWebhookSignature(body, 'sha256=ab12', SECRET, { timestamp: freshTs() })).toBe(false);
  });

  it('빈 payload/signature/secret → false', async () => {
    const ts = freshTs();
    const sig = signCanonical(body, SECRET, ts);
    expect(await verifyWebhookSignature('', sig, SECRET, { timestamp: ts })).toBe(false);
    expect(await verifyWebhookSignature(body, '', SECRET, { timestamp: ts })).toBe(false);
    expect(await verifyWebhookSignature(body, sig, '', { timestamp: ts })).toBe(false);
  });
});

describe('@bitpal/checkout — parseWebhookEvent', () => {
  it('valid envelope 파싱', () => {
    const body = JSON.stringify({
      id: 'evt_001',
      event: 'checkout.session.paid',
      created_at: '2026-05-08T12:00:00.000Z',
      data: { session_id: 'cs_test_123' },
    });
    const ev: WebhookPayload = parseWebhookEvent(body);
    expect(ev.id).toBe('evt_001');
    expect(ev.event).toBe('checkout.session.paid');
    expect(ev.data.session_id).toBe('cs_test_123');
  });

  it('필드 누락 시 throw', () => {
    expect(() => parseWebhookEvent('{}')).toThrow(/Invalid webhook envelope/);
    expect(() =>
      parseWebhookEvent(JSON.stringify({ id: 'x', event: 'y', data: {} })),
    ).toThrow(/Invalid webhook envelope/);
  });
});

describe('@bitpal/checkout — backend round-trip simulation', () => {
  it('backend가 만든 (envelope + timestamped signature)을 SDK가 검증', async () => {
    // backend buildCanonicalWebhookRequest 흉내: envelope.created_at(이벤트시각) ≠ signedAt(전송시각)
    const envelope = {
      id: 'evt_round_trip',
      event: 'checkout.session.paid' as const,
      created_at: new Date('2026-05-08T13:00:00.000Z').toISOString(),
      data: { session_id: 'cs_test_456', amount: '500000' },
    };
    const body = JSON.stringify(envelope);
    const signedAt = freshTs(); // X-Webhook-Timestamp = 전송 시각(fresh)
    const sig = signCanonical(body, SECRET, signedAt);

    // 머천트 측 SDK 검증 (X-Webhook-Timestamp 헤더값 전달)
    expect(await verifyWebhookSignature(body, sig, SECRET, { timestamp: signedAt })).toBe(true);
    const parsed = parseWebhookEvent(body);
    expect(parsed.event).toBe('checkout.session.paid');
    expect(parsed.data.amount).toBe('500000');
    // dedup 은 서명된 body 의 id 로 (헤더 X-Webhook-Id 는 미서명 → 위조 가능)
    expect(parsed.id).toBe('evt_round_trip');
  });
});
