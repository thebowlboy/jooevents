import { canonicalJsonSha256, type RiskTier } from '@jooevents/changesets';
import {
  programVocabularyDraftInputSchema,
  programVocabularyVersionSchema,
  type ProgramVocabularyDraftInput
} from '@jooevents/contracts';
import { z } from 'zod';

const stablePolicyKeySchema = z.string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

export type ProgramVocabularyOrdinaryApprovalRequirement =
  | 'none'
  | 'distinct_current_human';

export interface ProgramVocabularyOrdinaryPolicy {
  readonly activation: 'ordinary';
  readonly key: string;
  readonly version: number;
  readonly ordinaryRisk: Extract<RiskTier, 'low' | 'normal'>;
  readonly mergeRisk: Extract<RiskTier, 'normal' | 'consequential'>;
  readonly approval: {
    readonly ordinary: ProgramVocabularyOrdinaryApprovalRequirement;
    readonly merge: ProgramVocabularyOrdinaryApprovalRequirement;
  };
  readonly definitionDigestSha256: string;
}

export interface ProgramVocabularyOrdinaryPolicyInput {
  readonly key: string;
  readonly version: number;
  readonly ordinaryRisk: Extract<RiskTier, 'low' | 'normal'>;
  readonly mergeRisk: Extract<RiskTier, 'normal' | 'consequential'>;
  readonly approval: {
    readonly ordinary: ProgramVocabularyOrdinaryApprovalRequirement;
    readonly merge: ProgramVocabularyOrdinaryApprovalRequirement;
  };
}

export interface ProgramVocabularyCapturedApprovalPolicy {
  readonly reference: { readonly key: string; readonly version: number };
  readonly definitionDigestSha256: string;
  readonly requirement: ProgramVocabularyOrdinaryApprovalRequirement;
}

export type ProgramVocabularyOrdinaryAction = ProgramVocabularyDraftInput['action'];

const ordinaryPolicyInputSchema = z.strictObject({
  key: stablePolicyKeySchema,
  version: programVocabularyVersionSchema,
  ordinaryRisk: z.enum(['low', 'normal']),
  mergeRisk: z.enum(['normal', 'consequential']),
  approval: z.strictObject({
    ordinary: z.enum(['none', 'distinct_current_human']),
    merge: z.enum(['none', 'distinct_current_human'])
  })
});

const ordinaryPolicySchema: z.ZodType<ProgramVocabularyOrdinaryPolicy> =
  ordinaryPolicyInputSchema.extend({
    activation: z.literal('ordinary'),
    definitionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).superRefine((policy, context) => {
    if (ordinaryPolicyDigest(policy) !== policy.definitionDigestSha256) {
      context.addIssue({
        code: 'custom',
        path: ['definitionDigestSha256'],
        message: 'Program Vocabulary policy definition digest changed.'
      });
    }
  });

const issuedOrdinaryPolicies = new WeakSet<object>();

function ordinaryPolicyDigest(
  policy: ProgramVocabularyOrdinaryPolicyInput | ProgramVocabularyOrdinaryPolicy
): string {
  return canonicalJsonSha256({
    activation: 'ordinary',
    key: policy.key,
    version: policy.version,
    ordinaryRisk: policy.ordinaryRisk,
    mergeRisk: policy.mergeRisk,
    approval: {
      ordinary: policy.approval.ordinary,
      merge: policy.approval.merge
    }
  });
}

/** Issues immutable code-owned policy evidence for an ordinary composition. */
export function issueProgramVocabularyOrdinaryPolicy(
  candidate: ProgramVocabularyOrdinaryPolicyInput
): ProgramVocabularyOrdinaryPolicy {
  const input = ordinaryPolicyInputSchema.parse(candidate);
  const approval = Object.freeze({ ...input.approval });
  const policy: ProgramVocabularyOrdinaryPolicy = Object.freeze({
    activation: 'ordinary',
    key: input.key,
    version: input.version,
    ordinaryRisk: input.ordinaryRisk,
    mergeRisk: input.mergeRisk,
    approval,
    definitionDigestSha256: ordinaryPolicyDigest({ ...input, approval })
  });
  issuedOrdinaryPolicies.add(policy);
  return policy;
}

/** Rejects copied, parsed, or structurally forged ordinary policy values. */
export function assertProgramVocabularyOrdinaryPolicy(
  candidate: ProgramVocabularyOrdinaryPolicy
): void {
  if (!issuedOrdinaryPolicies.has(candidate)) {
    throw new TypeError('invalid_program_vocabulary_ordinary_policy');
  }
  ordinaryPolicySchema.parse(candidate);
}

/**
 * Captures the exact approval threshold separately from the risk label. A higher
 * risk label therefore cannot silently become a two-person rule, or vice versa.
 */
export function captureProgramVocabularyOrdinaryApprovalPolicy(input: {
  readonly policy: ProgramVocabularyOrdinaryPolicy;
  readonly action: ProgramVocabularyOrdinaryAction;
}): ProgramVocabularyCapturedApprovalPolicy {
  assertProgramVocabularyOrdinaryPolicy(input.policy);
  const requirement = input.action === 'merge'
    ? input.policy.approval.merge
    : input.policy.approval.ordinary;
  return Object.freeze({
    reference: Object.freeze({ key: input.policy.key, version: input.policy.version }),
    definitionDigestSha256: input.policy.definitionDigestSha256,
    requirement
  });
}

/** Parses only the six user-authorable operations; correction inputs are internal. */
export function parseProgramVocabularyOrdinaryAuthorInput(
  candidate: unknown
): ProgramVocabularyDraftInput {
  return programVocabularyDraftInputSchema.parse(candidate);
}
