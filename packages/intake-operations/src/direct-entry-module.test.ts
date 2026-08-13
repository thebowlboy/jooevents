import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { createHmacRequestHashSealer } from '@jooevents/application';
import { parseContractVersion, parseInvocationId, parseWorkspaceId } from '@jooevents/kernel';
import {
  SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY,
  SUBMISSION_DIRECT_ENTRY_DRAFT_HANDLER_CAPABILITY,
  SUBMISSION_DIRECT_ENTRY_DRAFT_OPERATION,
  SUBMISSION_DIRECT_ENTRY_DRAFT_REQUEST_HASH_PROFILE,
  SUBMISSION_DIRECT_ENTRY_HTTP_PATHS,
  createSubmissionDirectEntryDraftOperationModule,
  submissionDirectEntryDraftContributionSchema
} from './direct-entry-module';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const profile = Object.freeze({ key: 'direct-entry-test', version: parseContractVersion(1) });

function moduleInput(policy = SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY) {
  return {
    workspaceId,
    policy,
    currentAuthority: { resolve: () => ({ kind: 'denied' as const, reason: 'revoked' as const }) },
    currentEvent: { resolveCurrentEvent: () => ({ evidenceIds: [] as const }) },
    clock: { now: () => '2026-08-13T09:00:00.000Z' as never },
    ids: {
      newInvocationId: () => parseInvocationId('019c1df7-86b5-769b-bba4-5f7097bfa999')
    },
    crypto: {
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: createHmacRequestHashSealer({
        profile: SUBMISSION_DIRECT_ENTRY_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x11)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal(raw: string) {
          return {
            verifierProfile: profile,
            verifierSha256: createHash('sha256').update(raw).digest('hex')
          };
        }
      }
    }
  };
}

describe('direct entry draft operation module', () => {
  test('registers one operator draft operation bound to the direct-entry capability', () => {
    const module = createSubmissionDirectEntryDraftOperationModule(moduleInput());
    expect(module.id).toBe('submission-direct-entry.draft-operation');
    const operation = module.source.effectOperations?.[0];
    expect(operation).toMatchObject({
      name: SUBMISSION_DIRECT_ENTRY_DRAFT_OPERATION.name,
      version: 1,
      effect: 'draft',
      maxRisk: 'low',
      handlerCapability: SUBMISSION_DIRECT_ENTRY_DRAFT_HANDLER_CAPABILITY
    });
    expect(operation?.accessLanes).toEqual([{
      kind: 'operator',
      surface: 'operator_http',
      policy: SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY
    }]);
    expect(operation?.bindings).toMatchObject([{
      surface: 'operator_http',
      method: 'POST',
      path: SUBMISSION_DIRECT_ENTRY_HTTP_PATHS.draft
    }]);
    expect(module.source.effectHandlers?.length).toBe(1);
  });

  test('refuses a policy reference the catalog does not declare', () => {
    expect(() => createSubmissionDirectEntryDraftOperationModule(moduleInput({
      key: 'authority.other', version: parseContractVersion(1)
    }))).toThrow('submission_direct_entry_policy_catalog_mismatch');
  });

  test('contribution schema accepts typed refusals and rejects retryable or foreign outcomes', () => {
    const refusal = {
      result: { kind: 'outcome', outcome: {
        class: 'stale_revision', kind: 'submission_direct_entry.changed', retryable: false,
        subjects: [{ type: 'intake_form', id: '019c1df7-86b5-769b-bba4-5f7097bfa302' }],
        detail: {
          code: 'form_not_open',
          action: 'create',
          formId: '019c1df7-86b5-769b-bba4-5f7097bfa302'
        },
        detailSchemaVersion: 1
      } },
      domain: null,
      receiptChildren: []
    };
    expect(submissionDirectEntryDraftContributionSchema.parse(refusal)).toBeDefined();
    expect(submissionDirectEntryDraftContributionSchema.safeParse({
      ...refusal,
      result: { kind: 'outcome', outcome: {
        ...refusal.result.outcome, retryable: true
      } }
    }).success).toBe(false);
    expect(submissionDirectEntryDraftContributionSchema.safeParse({
      ...refusal,
      result: { kind: 'outcome', outcome: {
        ...refusal.result.outcome, kind: 'submission_triage.changed'
      } }
    }).success).toBe(false);
  });
});
