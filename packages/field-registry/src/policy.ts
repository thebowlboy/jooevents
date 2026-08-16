import { canonicalJsonSha256 } from '@jooevents/kernel';
import { z } from 'zod';

const policyKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).max(160);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export interface FieldRegistryOrdinaryPolicy {
  readonly activation: 'ordinary';
  readonly key: string;
  readonly version: number;
  readonly ordinaryRisk: 'low' | 'normal';
  readonly approval: 'none' | 'distinct_current_human';
  readonly definitionDigestSha256: string;
}

const policySchema: z.ZodType<FieldRegistryOrdinaryPolicy> = z.strictObject({
  activation: z.literal('ordinary'),
  key: policyKeySchema,
  version: z.number().int().positive().safe(),
  ordinaryRisk: z.enum(['low', 'normal']),
  approval: z.enum(['none', 'distinct_current_human']),
  definitionDigestSha256: digestSchema
}).superRefine((policy, context) => {
  const digest = canonicalJsonSha256({
    activation: policy.activation,
    key: policy.key,
    version: policy.version,
    ordinaryRisk: policy.ordinaryRisk,
    approval: policy.approval
  });
  if (digest !== policy.definitionDigestSha256) {
    context.addIssue({
      code: 'custom', path: ['definitionDigestSha256'],
      message: 'Field registry policy digest changed.'
    });
  }
});

const issuedPolicies = new WeakSet<object>();

export function createFieldRegistryOrdinaryPolicy(input: {
  readonly key: string;
  readonly version: number;
  readonly ordinaryRisk?: 'low' | 'normal';
  readonly approval?: 'none' | 'distinct_current_human';
}): FieldRegistryOrdinaryPolicy {
  const definition = {
    activation: 'ordinary' as const,
    key: input.key,
    version: input.version,
    ordinaryRisk: input.ordinaryRisk ?? 'low',
    approval: input.approval ?? 'none'
  };
  const policy = Object.freeze(policySchema.parse({
    ...definition,
    definitionDigestSha256: canonicalJsonSha256(definition)
  }));
  issuedPolicies.add(policy);
  return policy;
}

export function assertFieldRegistryOrdinaryPolicy(
  candidate: FieldRegistryOrdinaryPolicy
): void {
  if (!issuedPolicies.has(candidate)) {
    throw new TypeError('invalid_field_registry_ordinary_policy');
  }
  policySchema.parse(candidate);
}

export function captureFieldRegistryApprovalPolicy(input: {
  readonly policy: FieldRegistryOrdinaryPolicy;
}) {
  assertFieldRegistryOrdinaryPolicy(input.policy);
  return Object.freeze({
    reference: Object.freeze({ key: input.policy.key, version: input.policy.version }),
    definitionDigestSha256: input.policy.definitionDigestSha256,
    requirement: input.policy.approval
  });
}
