import type { VersionedAccessPolicyRef } from '@jooevents/identity-access';
import { parseContractVersion } from '@jooevents/kernel';
import { canonicalJsonSha256 } from '@jooevents/changesets';
import { intakeStableKeySchema, intakeVersionSchema } from '@jooevents/contracts';
import type { SubmissionTriageAction } from '@jooevents/contracts/submission-triage';
import { z } from 'zod';

/** Current-authority policy required for organizer submission-triage drafts. */
export const SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.submission.triage-manage',
  version: parseContractVersion(1)
});

export const SUBMISSION_TRIAGE_OPERATOR_READ_ACCESS_POLICY: VersionedAccessPolicyRef =
  Object.freeze({
    key: 'authority.submission.triage-read',
    version: parseContractVersion(1)
  });

export const SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.submission.triage-mcp-read',
  version: parseContractVersion(1)
});

export type SubmissionTriageApprovalRequirement = 'none' | 'distinct_current_human';

export interface SubmissionTriageChangesetPolicyInput {
  readonly key: string;
  readonly version: number;
  readonly approval: {
    readonly ordinary: SubmissionTriageApprovalRequirement;
    readonly discardRecoverable: SubmissionTriageApprovalRequirement;
  };
}

export interface SubmissionTriageChangesetPolicy extends SubmissionTriageChangesetPolicyInput {
  readonly activation: 'submission_triage';
  readonly definitionDigestSha256: string;
}

export interface SubmissionTriageCapturedApprovalPolicy {
  readonly reference: { readonly key: string; readonly version: number };
  readonly definitionDigestSha256: string;
  readonly requirement: SubmissionTriageApprovalRequirement;
}

const triagePolicyInputSchema = z.strictObject({
  key: intakeStableKeySchema,
  version: intakeVersionSchema,
  approval: z.strictObject({
    ordinary: z.enum(['none', 'distinct_current_human']),
    discardRecoverable: z.enum(['none', 'distinct_current_human'])
  })
});

export const submissionTriageChangesetPolicySchema:
z.ZodType<SubmissionTriageChangesetPolicy> = triagePolicyInputSchema.extend({
  activation: z.literal('submission_triage'),
  definitionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/)
}).superRefine((policy, context) => {
  if (submissionTriagePolicyDigest(policy) !== policy.definitionDigestSha256) {
    context.addIssue({
      code: 'custom', path: ['definitionDigestSha256'],
      message: 'submission triage policy definition digest changed'
    });
  }
});

const issuedPolicies = new WeakSet<object>();

export function issueSubmissionTriageChangesetPolicy(
  candidate: SubmissionTriageChangesetPolicyInput
): SubmissionTriageChangesetPolicy {
  const input = triagePolicyInputSchema.parse(candidate);
  const approval = Object.freeze({ ...input.approval });
  const policy: SubmissionTriageChangesetPolicy = Object.freeze({
    activation: 'submission_triage',
    key: input.key,
    version: input.version,
    approval,
    definitionDigestSha256: submissionTriagePolicyDigest({ ...input, approval })
  });
  issuedPolicies.add(policy);
  return policy;
}

export function assertSubmissionTriageChangesetPolicy(
  policy: SubmissionTriageChangesetPolicy
): void {
  if (!issuedPolicies.has(policy)) throw new TypeError('invalid_submission_triage_changeset_policy');
  submissionTriageChangesetPolicySchema.parse(policy);
}

export function captureSubmissionTriageApprovalPolicy(input: {
  readonly policy: SubmissionTriageChangesetPolicy;
  readonly action: SubmissionTriageAction | 'restore_exact';
}): SubmissionTriageCapturedApprovalPolicy {
  assertSubmissionTriageChangesetPolicy(input.policy);
  return Object.freeze({
    reference: Object.freeze({ key: input.policy.key, version: input.policy.version }),
    definitionDigestSha256: input.policy.definitionDigestSha256,
    requirement: input.action === 'discard_recoverable'
      ? input.policy.approval.discardRecoverable
      : input.policy.approval.ordinary
  });
}

function submissionTriagePolicyDigest(
  policy: SubmissionTriageChangesetPolicyInput | SubmissionTriageChangesetPolicy
): string {
  return canonicalJsonSha256({
    activation: 'submission_triage',
    key: policy.key,
    version: policy.version,
    approval: policy.approval
  });
}
