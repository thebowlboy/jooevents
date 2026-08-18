import type { BackgroundJobDefinition } from './background-supervisor';
import type { CommunicationsProviderActivation } from './communications-provider-activation';

const REFRESH_MARGIN_MAX_MS = 60_000;

/**
 * Keeps short-lived provider evidence current only for the explicit organizer
 * review entry mode. The provider activation executor remains authoritative:
 * this job merely schedules the same check an owner can run manually.
 */
export function createReviewEmailReadinessRefreshJob(input: Readonly<{
  reviewEntryMode: 'disabled' | 'organizer';
  providerActivation?: Pick<CommunicationsProviderActivation, 'runReadinessCheck'>;
  maximumValidityMs?: number;
  serializeWork<T>(work: () => T | Promise<T>): Promise<T>;
}>): BackgroundJobDefinition | undefined {
  if (
    input.reviewEntryMode !== 'organizer'
    || input.providerActivation === undefined
    || input.maximumValidityMs === undefined
  ) return undefined;
  if (!Number.isSafeInteger(input.maximumValidityMs) || input.maximumValidityMs <= 1) {
    throw new TypeError('review_email_readiness_validity_invalid');
  }
  const marginMs = Math.min(
    REFRESH_MARGIN_MAX_MS,
    Math.max(1, Math.floor(input.maximumValidityMs / 5))
  );
  return Object.freeze({
    name: 'review_email_readiness_refresh',
    intervalMs: input.maximumValidityMs - marginMs,
    runOnStart: true,
    async run() {
      // A blocked observation is intentionally not converted into success
      // evidence: runReadinessCheck persists the provider's truthful result.
      await input.serializeWork(() => input.providerActivation!.runReadinessCheck());
    }
  });
}
