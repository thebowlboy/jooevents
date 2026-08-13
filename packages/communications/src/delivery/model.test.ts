import { describe, expect, test } from 'bun:test';
import { createSafeEvidence, createSafeEvidenceCatalog } from '../providers/outcomes';
import { normalizeProviderSubmissionOutcome, outboundEmailFollowUp } from './model';

const catalog = createSafeEvidenceCatalog({
  facts: [],
  codes: [{ code: 'delivery.accepted', allowedFactKeys: [] }]
});
const evidence = createSafeEvidence(catalog, {
  code: 'delivery.accepted',
  correlationId: 'corr1_12345678'
});

describe('outbound delivery normalization', () => {
  test('keeps provider evidence safe and exact', () => {
    expect(normalizeProviderSubmissionOutcome({
      contractVersion: 1,
      kind: 'accepted',
      providerMessageId: 'msg-1',
      evidence
    })).toEqual({
      state: 'accepted',
      providerMessageId: 'msg-1',
      providerOutcomeReason: null,
      safeEvidence: evidence
    });
  });

  test('blocks automatic retry for acceptance unknown without provider support', () => {
    expect(outboundEmailFollowUp(
      { state: 'acceptance_unknown' },
      { idempotency: 'none', reconciliation: 'none', callbacks: [], inboundReplies: false }
    )).toBe('manual_resolution_required');
    expect(outboundEmailFollowUp(
      { state: 'known_rejected_safe_retryable' },
      { idempotency: 'none', reconciliation: 'none', callbacks: [], inboundReplies: false }
    )).toBe('safe_retry');
  });
});

