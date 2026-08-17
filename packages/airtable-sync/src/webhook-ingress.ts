export interface AirtableVerifiedInboxIntake {
  intake(input: Readonly<{
    rawEnvelope: Uint8Array;
    protocolEvidence: { readonly contentMac: string };
  }>): Promise<
    | { readonly kind: 'intake' }
    | { readonly kind: 'rejected' }
    | { readonly kind: 'deferred' }
    | { readonly kind: 'requires_attention' }
  >;
}

export interface AirtableWebhookIntakeResolver {
  resolve(callbackRef: string): Promise<AirtableVerifiedInboxIntake | undefined>;
}

export type AirtableWebhookIngressResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'deferred'; readonly retryAfterSeconds: number };

/** Maps an opaque callback reference to the existing verified-inbox intake runner. */
export function createAirtableWebhookIngress(input: Readonly<{
  intakes: AirtableWebhookIntakeResolver;
  retryAfterSeconds?: number;
}>) {
  const retryAfterSeconds = input.retryAfterSeconds ?? 5;
  if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 300) {
    throw new TypeError('airtable_webhook_retry_after_invalid');
  }
  return Object.freeze({
    maximumRawBodyBytes: 16 * 1024,
    async intake(request: Readonly<{
      callbackRef: string;
      rawBody: Uint8Array;
      contentMac: string;
    }>): Promise<AirtableWebhookIngressResult> {
      const runner = await input.intakes.resolve(request.callbackRef);
      if (!runner) return { kind: 'rejected' };
      const result = await runner.intake({
        rawEnvelope: request.rawBody,
        protocolEvidence: { contentMac: request.contentMac }
      });
      if (result.kind === 'intake') return { kind: 'accepted' };
      if (result.kind === 'rejected') return { kind: 'rejected' };
      return { kind: 'deferred', retryAfterSeconds };
    }
  });
}
