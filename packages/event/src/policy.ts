import { canonicalJsonSha256 } from '@jooevents/kernel';
import { z } from 'zod';

type EventOrdinaryRiskTier = 'low' | 'normal';

const stablePolicyKeySchema = z.string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

export type EventOrdinaryApprovalRequirement = 'none' | 'distinct_current_human';

export interface EventOrdinaryPolicy {
  readonly activation: 'ordinary';
  readonly key: string;
  readonly version: number;
  readonly risk: EventOrdinaryRiskTier;
  readonly approval: EventOrdinaryApprovalRequirement;
  readonly definitionDigestSha256: string;
}

export interface EventOrdinaryPolicyInput {
  readonly key: string;
  readonly version: number;
  readonly risk: EventOrdinaryRiskTier;
  readonly approval: EventOrdinaryApprovalRequirement;
}

export interface EventCapturedApprovalPolicy {
  readonly reference: { readonly key: string; readonly version: number };
  readonly definitionDigestSha256: string;
  readonly requirement: EventOrdinaryApprovalRequirement;
}

const inputSchema = z.strictObject({
  key: stablePolicyKeySchema,
  version: z.number().int().positive(),
  risk: z.enum(['low', 'normal']),
  approval: z.enum(['none', 'distinct_current_human'])
});

const policySchema: z.ZodType<EventOrdinaryPolicy> = inputSchema.extend({
  activation: z.literal('ordinary'),
  definitionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/)
}).superRefine((policy, context) => {
  if (eventOrdinaryPolicyDigest(policy) !== policy.definitionDigestSha256) {
    context.addIssue({
      code: 'custom',
      path: ['definitionDigestSha256'],
      message: 'Event policy definition digest changed.'
    });
  }
});

const issuedPolicies = new WeakSet<object>();

function eventOrdinaryPolicyDigest(
  policy: EventOrdinaryPolicyInput | EventOrdinaryPolicy
): string {
  return canonicalJsonSha256({
    activation: 'ordinary',
    key: policy.key,
    version: policy.version,
    risk: policy.risk,
    approval: policy.approval
  });
}

/** Issues immutable code-owned policy evidence for the ordinary Event composition. */
export function issueEventOrdinaryPolicy(
  candidate: EventOrdinaryPolicyInput
): EventOrdinaryPolicy {
  const input = inputSchema.parse(candidate);
  const policy: EventOrdinaryPolicy = Object.freeze({
    activation: 'ordinary',
    ...input,
    definitionDigestSha256: eventOrdinaryPolicyDigest(input)
  });
  issuedPolicies.add(policy);
  return policy;
}

/** Rejects copied, parsed, or structurally forged policy values. */
export function assertEventOrdinaryPolicy(candidate: EventOrdinaryPolicy): void {
  if (!issuedPolicies.has(candidate)) throw new TypeError('invalid_event_ordinary_policy');
  policySchema.parse(candidate);
}

export function captureEventOrdinaryApprovalPolicy(input: {
  readonly policy: EventOrdinaryPolicy;
}): EventCapturedApprovalPolicy {
  assertEventOrdinaryPolicy(input.policy);
  return Object.freeze({
    reference: Object.freeze({ key: input.policy.key, version: input.policy.version }),
    definitionDigestSha256: input.policy.definitionDigestSha256,
    requirement: input.policy.approval
  });
}

export const eventOrdinaryPolicySchema = policySchema;
