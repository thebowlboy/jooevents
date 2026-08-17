import { Hono } from 'hono';

const CALLBACK_REF = /^[A-Za-z0-9_-]{32,160}$/;
const CONTENT_MAC = /^hmac-sha256=[0-9a-fA-F]{64}$/;

export type AirtableWebhookIntakeResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'deferred'; readonly retryAfterSeconds?: number };

export interface AirtableWebhookIngressRuntime {
  readonly maximumRawBodyBytes: number;
  intake(input: Readonly<{
    callbackRef: string;
    rawBody: Uint8Array;
    contentMac: string;
  }>): Promise<AirtableWebhookIntakeResult>;
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array | undefined> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    return undefined;
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel('airtable_webhook_body_too_large');
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** HTTP-only adapter. Verification, durable intake, and wake creation stay behind the runtime. */
export function createAirtableWebhookHttpAdapter(runtime: AirtableWebhookIngressRuntime) {
  if (!Number.isSafeInteger(runtime.maximumRawBodyBytes)
    || runtime.maximumRawBodyBytes < 256 || runtime.maximumRawBodyBytes > 64 * 1024) {
    throw new TypeError('airtable_webhook_body_limit_invalid');
  }
  const app = new Hono();
  app.post('/webhooks/airtable/:callbackRef', async (context) => {
    context.header('cache-control', 'no-store, max-age=0');
    const callbackRef = context.req.param('callbackRef');
    const contentMac = context.req.header('x-airtable-content-mac') ?? '';
    if (!CALLBACK_REF.test(callbackRef) || !CONTENT_MAC.test(contentMac)) {
      return context.body(null, 401);
    }
    const rawBody = await readBoundedBody(context.req.raw, runtime.maximumRawBodyBytes);
    if (!rawBody) return context.body(null, 413);
    const result = await runtime.intake({ callbackRef, rawBody, contentMac });
    if (result.kind === 'accepted') return context.body(null, 204);
    if (result.kind === 'rejected') return context.body(null, 401);
    if (result.retryAfterSeconds !== undefined) {
      context.header('retry-after', String(Math.max(1, Math.min(300, result.retryAfterSeconds))));
    }
    return context.body(null, 503);
  });
  return app;
}
