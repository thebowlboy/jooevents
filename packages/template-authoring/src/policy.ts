import { canonicalJsonSha256, type RiskTier } from '@jooevents/changesets';
import { z } from 'zod';

const stablePolicyKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

export type TemplateAuthoringApprovalRequirement = 'none' | 'distinct_current_human';

export interface TemplateAuthoringPolicy {
  readonly activation: 'ordinary';
  readonly key: string;
  readonly version: number;
  readonly risk: Extract<RiskTier, 'low' | 'normal'>;
  readonly approval: TemplateAuthoringApprovalRequirement;
  readonly definitionDigestSha256: string;
}

export interface TemplateAuthoringPolicyInput {
  readonly key: string;
  readonly version: number;
  readonly risk: Extract<RiskTier, 'low' | 'normal'>;
  readonly approval: TemplateAuthoringApprovalRequirement;
}

const inputSchema = z.strictObject({
  key: stablePolicyKeySchema,
  version: z.number().int().positive(),
  risk: z.enum(['low', 'normal']),
  approval: z.enum(['none', 'distinct_current_human'])
});

function digest(policy: TemplateAuthoringPolicyInput | TemplateAuthoringPolicy): string {
  return canonicalJsonSha256({
    activation: 'ordinary', key: policy.key, version: policy.version,
    risk: policy.risk, approval: policy.approval
  });
}

export const templateAuthoringPolicySchema: z.ZodType<TemplateAuthoringPolicy> =
  inputSchema.extend({
    activation: z.literal('ordinary'),
    definitionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).superRefine((policy, context) => {
    if (digest(policy) !== policy.definitionDigestSha256) context.addIssue({
      code: 'custom', path: ['definitionDigestSha256'], message: 'policy digest changed'
    });
  });

const issued = new WeakSet<object>();

export function issueTemplateAuthoringPolicy(
  candidate: TemplateAuthoringPolicyInput
): TemplateAuthoringPolicy {
  const input = inputSchema.parse(candidate);
  const policy = Object.freeze({
    activation: 'ordinary' as const,
    ...input,
    definitionDigestSha256: digest(input)
  });
  issued.add(policy);
  return policy;
}

export function assertTemplateAuthoringPolicy(candidate: TemplateAuthoringPolicy): void {
  if (!issued.has(candidate)) throw new TypeError('invalid_template_authoring_policy');
  templateAuthoringPolicySchema.parse(candidate);
}

export function captureTemplateAuthoringApprovalPolicy(input: {
  readonly policy: TemplateAuthoringPolicy;
}) {
  assertTemplateAuthoringPolicy(input.policy);
  return Object.freeze({
    reference: Object.freeze({ key: input.policy.key, version: input.policy.version }),
    definitionDigestSha256: input.policy.definitionDigestSha256,
    requirement: input.policy.approval
  });
}
