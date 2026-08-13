import { canonicalJsonSha256, type RiskTier } from '@jooevents/changesets';
import { intakeStableKeySchema, intakeVersionSchema } from '@jooevents/contracts';
import { z } from 'zod';

export type FormOrdinaryApprovalRequirement = 'none' | 'distinct_current_human';
export type FormOrdinaryAction = 'create' | 'revise' | 'publish' | 'lifecycle' | 'closing';

export interface FormOrdinaryPolicyInput {
  readonly key: string;
  readonly version: number;
  readonly ordinaryRisk: Extract<RiskTier, 'low' | 'normal'>;
  readonly approval: { readonly ordinary: FormOrdinaryApprovalRequirement };
}

export interface FormOrdinaryPolicy extends FormOrdinaryPolicyInput {
  readonly activation: 'ordinary';
  readonly definitionDigestSha256: string;
}

export interface FormCapturedApprovalPolicy {
  readonly reference: { readonly key: string; readonly version: number };
  readonly definitionDigestSha256: string;
  readonly requirement: FormOrdinaryApprovalRequirement;
}

const inputSchema = z.strictObject({
  key: intakeStableKeySchema,
  version: intakeVersionSchema,
  ordinaryRisk: z.enum(['low', 'normal']),
  approval: z.strictObject({ ordinary: z.enum(['none', 'distinct_current_human']) })
});

export const formOrdinaryPolicySchema: z.ZodType<FormOrdinaryPolicy> = inputSchema.extend({
  activation: z.literal('ordinary'),
  definitionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/)
}).superRefine((policy, context) => {
  if (policyDigest(policy) !== policy.definitionDigestSha256) context.addIssue({
    code: 'custom',
    path: ['definitionDigestSha256'],
    message: 'Form policy definition digest changed.'
  });
});

const issuedPolicies = new WeakSet<object>();

export function issueFormOrdinaryPolicy(candidate: FormOrdinaryPolicyInput): FormOrdinaryPolicy {
  const input = inputSchema.parse(candidate);
  const approval = Object.freeze({ ...input.approval });
  const policy: FormOrdinaryPolicy = Object.freeze({
    activation: 'ordinary',
    key: input.key,
    version: input.version,
    ordinaryRisk: input.ordinaryRisk,
    approval,
    definitionDigestSha256: policyDigest({ ...input, approval })
  });
  issuedPolicies.add(policy);
  return policy;
}

export function assertFormOrdinaryPolicy(policy: FormOrdinaryPolicy): void {
  if (!issuedPolicies.has(policy)) throw new TypeError('invalid_form_ordinary_policy');
  formOrdinaryPolicySchema.parse(policy);
}

export function captureFormOrdinaryApprovalPolicy(input: {
  readonly policy: FormOrdinaryPolicy;
  readonly action: FormOrdinaryAction;
}): FormCapturedApprovalPolicy {
  assertFormOrdinaryPolicy(input.policy);
  formActionSchema.parse(input.action);
  return Object.freeze({
    reference: Object.freeze({ key: input.policy.key, version: input.policy.version }),
    definitionDigestSha256: input.policy.definitionDigestSha256,
    requirement: input.policy.approval.ordinary
  });
}

export const formActionSchema = z.enum(['create', 'revise', 'publish', 'lifecycle', 'closing']);

function policyDigest(policy: FormOrdinaryPolicyInput | FormOrdinaryPolicy): string {
  return canonicalJsonSha256({
    activation: 'ordinary',
    key: policy.key,
    version: policy.version,
    ordinaryRisk: policy.ordinaryRisk,
    approval: policy.approval
  });
}
