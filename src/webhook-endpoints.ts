/**
 * webhook-endpoints.ts — webhook endpoint management (`/v1/webhooks`).
 *
 * **Test mode only with an API key**: a `bp_test_…` key can create, list, update and rotate test-mode endpoints
 * and resend past events (handy for CI, or local development behind a tunnel). A `bp_live_…` key gets 403 —
 * live endpoints are managed in Console → Developers → Webhooks.
 *
 * ```ts
 * const bitpal = new BitPal({ apiKey: process.env.BITPAL_TEST_KEY! });
 * const { data: endpoint } = await bitpal.checkout.webhooks.create({
 *   endpoint_url: 'https://abc.ngrok.app/webhooks/bitpal',
 *   subscribed_events: ['*'],
 * });
 * process.env.BITPAL_WEBHOOK_SECRET = endpoint.secret; // shown only once
 * ```
 *
 * To verify deliveries, use `verifyWebhookSignature` / `parseWebhookEvent`.
 */
import type {
  ApiResponse,
  IdempotencyOptions,
  ListResponse,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  CreateWebhookEndpointParams,
  UpdateWebhookEndpointParams,
  ListWebhookEndpointsParams,
  RotateWebhookSecretParams,
  WebhookDelivery,
} from './types.js';
import type { CatalogRequester } from './catalog.js';

function pageQuery(params?: ListWebhookEndpointsParams): string {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set('limit', String(params.limit));
  if (params?.offset !== undefined) qs.set('offset', String(params.offset));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export class WebhookEndpointsResource {
  constructor(private readonly request: CatalogRequester) {}

  /** POST /v1/webhooks — the response carries the `whsec_…` secret, shown only once. Supports options.idempotencyKey. */
  create(params: CreateWebhookEndpointParams, options?: IdempotencyOptions): Promise<ApiResponse<WebhookEndpointWithSecret>> {
    return this.request('POST', '/v1/webhooks', params, options);
  }

  /** GET /v1/webhooks — endpoints of the key's mode, newest first. */
  list(params?: ListWebhookEndpointsParams): Promise<ListResponse<WebhookEndpoint>> {
    return this.request('GET', `/v1/webhooks${pageQuery(params)}`);
  }

  /** PATCH /v1/webhooks/:id — `status: 'disabled'` removes the endpoint (`reason_code` optional with a test key). */
  update(webhookId: string, params: UpdateWebhookEndpointParams): Promise<ApiResponse<WebhookEndpoint>> {
    return this.request('PATCH', `/v1/webhooks/${encodeURIComponent(webhookId)}`, params);
  }

  /**
   * POST /v1/webhooks/:id/rotate-secret — the old secret stops working immediately; the new one is returned once.
   * Supports options.idempotencyKey.
   */
  rotateSecret(
    webhookId: string,
    params: RotateWebhookSecretParams = {},
    options?: IdempotencyOptions,
  ): Promise<ApiResponse<WebhookEndpointWithSecret>> {
    return this.request('POST', `/v1/webhooks/${encodeURIComponent(webhookId)}/rotate-secret`, params, options);
  }

  /**
   * POST /v1/webhooks/:id/replay — resend one past event (by its envelope `id`) to this endpoint, including events
   * from before the endpoint existed. Supports options.idempotencyKey.
   */
  replay(webhookId: string, eventId: string, options?: IdempotencyOptions): Promise<ApiResponse<WebhookDelivery>> {
    return this.request('POST', `/v1/webhooks/${encodeURIComponent(webhookId)}/replay`, { event_id: eventId }, options);
  }
}
