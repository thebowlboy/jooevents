import { describe, expect, test } from 'bun:test';
import { createSafeEvidence, createSafeEvidenceCatalog } from '../providers/outcomes';
import {
  normalizeProviderSubmissionOutcome,
  outboundEmailFollowUp,
  requiredOutboundEmailAttemptKind
} from './model';

import type { ProviderCapabilities } from '@jooevents/contracts';

const noRecovery: ProviderCapabilities = {
  idempotency: 'none',
  reconciliation: 'none',
  callbacks: [],
  inboundReplies: false
};

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

  test('requires manual resolution for acceptance unknown when no resend availability is stated', () => {
    expect(outboundEmailFollowUp({ state: 'acceptance_unknown' }, noRecovery))
      .toBe('manual_resolution_required');
    expect(outboundEmailFollowUp({ state: 'known_rejected_safe_retryable' }, noRecovery))
      .toBe('safe_retry');
  });

  test('grants exactly one marked resend for acceptance unknown without provider support', () => {
    expect(outboundEmailFollowUp(
      { state: 'acceptance_unknown' },
      noRecovery,
      { markedResendExhausted: false }
    )).toBe('marked_resend');
    expect(outboundEmailFollowUp(
      { state: 'acceptance_unknown' },
      noRecovery,
      { markedResendExhausted: true }
    )).toBe('manual_resolution_required');
  });

  test('provider recovery capabilities outrank the marked resend', () => {
    expect(outboundEmailFollowUp(
      { state: 'acceptance_unknown' },
      { idempotency: 'native_key', reconciliation: 'none', callbacks: [], inboundReplies: false },
      { markedResendExhausted: false }
    )).toBe('safe_retry');
    expect(outboundEmailFollowUp(
      { state: 'acceptance_unknown' },
      { idempotency: 'provider_lookup', reconciliation: 'lookup', callbacks: [], inboundReplies: false },
      { markedResendExhausted: false }
    )).toBe('reconcile');
    expect(outboundEmailFollowUp(
      { state: 'acceptance_unknown' },
      { idempotency: 'none', reconciliation: 'callback_only', callbacks: ['bounce'], inboundReplies: false },
      { markedResendExhausted: false }
    )).toBe('await_callback');
  });

  test('requires the marked resend kind once ambiguity exists, except under native idempotency', () => {
    expect(requiredOutboundEmailAttemptKind({ unknownAttemptCount: 0 }, { idempotency: 'none' }))
      .toBe('original');
    expect(requiredOutboundEmailAttemptKind({ unknownAttemptCount: 1 }, { idempotency: 'none' }))
      .toBe('marked_resend');
    expect(requiredOutboundEmailAttemptKind({ unknownAttemptCount: 2 }, { idempotency: 'provider_lookup' }))
      .toBe('marked_resend');
    expect(requiredOutboundEmailAttemptKind({ unknownAttemptCount: 1 }, { idempotency: 'native_key' }))
      .toBe('original');
  });
});

