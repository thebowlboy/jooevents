import { encodeCanonicalJson, parseInstant } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema
} from '../operations';
import {
  organizerCommunicationSafeEvidenceRefSchema,
  organizerEmailReadinessProjectionSchema
} from './organizer';
import {
  emailSetupManifestSchema,
  providerOpaqueIdSchema,
  providerReadinessCapabilitySchema,
  providerSha256Schema,
  providerStableKeySchema,
  providerTimestampSchema
} from './provider';

const canonicalText = z.string().trim().min(1).max(240);
const instantSchema = z.string().refine((value) => {
  try { return parseInstant(value) === value; } catch { return false; }
}, { message: 'Expected a canonical UTC instant.' });

export const emailProviderConnectionLifecycleSchema = z.enum([
  'draft',
  'verifying',
  'active_outbound',
  'draining',
  'retired'
]);

export const emailProviderConfigurationRefSchema = z.strictObject({
  payloadRefId: providerOpaqueIdSchema,
  payloadRefVersion: z.number().int().positive().safe(),
  payloadKind: z.literal('email_provider_configuration'),
  schemaKey: providerStableKeySchema,
  schemaVersion: z.number().int().positive().safe(),
  classification: z.literal('restricted')
});

export const emailProviderSecretReferenceInputSchema = z.strictObject({
  key: providerStableKeySchema,
  secretStoreKey: providerStableKeySchema,
  secretReference: providerOpaqueIdSchema
});

export const emailProviderSecretRequirementProjectionSchema = z.strictObject({
  key: providerStableKeySchema,
  configured: z.boolean()
});

export const emailProviderConnectionRevisionCandidateSchema = z.strictObject({
  revisionId: providerOpaqueIdSchema,
  connectionId: providerOpaqueIdSchema,
  revisionNumber: z.number().int().positive().safe(),
  adapterKey: providerStableKeySchema,
  adapterVersion: providerStableKeySchema,
  setupManifestKey: providerStableKeySchema,
  setupManifestVersion: z.number().int().positive().safe(),
  setupManifestDigestSha256: providerSha256Schema,
  configSchemaVersion: z.number().int().positive().safe(),
  configRef: emailProviderConfigurationRefSchema,
  secretRequirements: z.array(emailProviderSecretRequirementProjectionSchema).max(16),
  configDigestSha256: providerSha256Schema,
  callbacks: z.strictObject({ state: z.literal('not_supported') }),
  inbound: z.strictObject({ state: z.literal('not_enabled') }),
  createdAt: instantSchema
}).superRefine((revision, context) => {
  const keys = revision.secretRequirements.map((item) => item.key);
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index - 1]! >= keys[index]!) {
      context.addIssue({
        code: 'custom',
        path: ['secretRequirements', index, 'key'],
        message: 'secret requirements must be unique and use canonical key order'
      });
    }
  }
});

export const emailProviderConnectionProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  connectionId: providerOpaqueIdSchema,
  workspaceId: providerOpaqueIdSchema,
  displayName: canonicalText,
  adapterKey: providerStableKeySchema,
  lifecycle: emailProviderConnectionLifecycleSchema,
  headVersion: z.number().int().positive().safe(),
  currentRevisionId: providerOpaqueIdSchema.nullable(),
  candidateRevisions: z.array(emailProviderConnectionRevisionCandidateSchema).max(100),
  createdAt: instantSchema,
  updatedAt: instantSchema
}).superRefine((connection, context) => {
  let previous = 0;
  const ids = new Set<string>();
  for (const [index, revision] of connection.candidateRevisions.entries()) {
    if (revision.connectionId !== connection.connectionId) {
      context.addIssue({ code: 'custom', path: ['candidateRevisions', index, 'connectionId'],
        message: 'connection revision belongs to another connection' });
    }
    if (revision.adapterKey !== connection.adapterKey) {
      context.addIssue({ code: 'custom', path: ['candidateRevisions', index, 'adapterKey'],
        message: 'connection revision uses another adapter' });
    }
    if (revision.revisionNumber <= previous || ids.has(revision.revisionId)) {
      context.addIssue({ code: 'custom', path: ['candidateRevisions', index],
        message: 'connection revisions must be unique and use ascending revision order' });
    }
    previous = revision.revisionNumber;
    ids.add(revision.revisionId);
  }
  if (
    connection.currentRevisionId !== null
    && !connection.candidateRevisions.some(
      (revision) => revision.revisionId === connection.currentRevisionId
    )
  ) {
    context.addIssue({ code: 'custom', path: ['currentRevisionId'],
      message: 'current revision must belong to the projected connection' });
  }
  if (connection.lifecycle === 'active_outbound' && connection.currentRevisionId === null) {
    context.addIssue({ code: 'custom', path: ['currentRevisionId'],
      message: 'active outbound connection requires a current revision' });
  }
});

const emailProviderConnectionDraftShape = {
  connectionId: providerOpaqueIdSchema,
  revisionId: providerOpaqueIdSchema,
  workspaceId: providerOpaqueIdSchema,
  displayName: canonicalText,
  adapterKey: providerStableKeySchema,
  adapterVersion: providerStableKeySchema,
  manifest: emailSetupManifestSchema,
  configSchemaVersion: z.number().int().positive().safe(),
  configRef: emailProviderConfigurationRefSchema,
  secretReferences: z.array(emailProviderSecretReferenceInputSchema).max(16),
  configDigestSha256: providerSha256Schema,
  createdAt: instantSchema
} as const;

function addProviderConnectionDraftIssues(
  draft: z.infer<ReturnType<typeof z.strictObject<typeof emailProviderConnectionDraftShape>>>,
  context: z.core.$RefinementCtx
): void {
  if (
    draft.manifest.adapterKey !== draft.adapterKey
    || draft.manifest.adapterVersion !== draft.adapterVersion
  ) {
    context.addIssue({ code: 'custom', path: ['manifest'],
      message: 'connection draft must cite the exact adapter manifest' });
  }
  if (
    draft.manifest.callbacks.kind !== 'disabled'
    || draft.manifest.capabilityStatus.delivery_callbacks !== 'not_supported'
    || draft.manifest.capabilityStatus.suppression_callbacks !== 'not_supported'
    || draft.manifest.capabilityStatus.inbound_replies !== 'not_enabled'
  ) {
    context.addIssue({ code: 'custom', path: ['manifest'],
      message: 'the first outbound rail requires callbacks unsupported and inbound disabled' });
  }
  const suppliedKeys = draft.secretReferences.map((item) => item.key);
  const requiredKeys = draft.manifest.requiredSecretReferences
    .filter((item) => item.required)
    .map((item) => item.key);
  if (
    new Set(suppliedKeys).size !== suppliedKeys.length
    || requiredKeys.some((key) => !suppliedKeys.includes(key))
    || suppliedKeys.some((key) => !draft.manifest.requiredSecretReferences.some(
      (requirement) => requirement.key === key
    ))
  ) {
    context.addIssue({ code: 'custom', path: ['secretReferences'],
      message: 'secret references must exactly satisfy declared adapter requirements' });
  }
}

export const emailProviderConnectionDraftInputSchema = z
  .strictObject(emailProviderConnectionDraftShape)
  .superRefine(addProviderConnectionDraftIssues);

export const emailProviderConnectionRevisionAppendInputSchema =
  z.strictObject({
    ...emailProviderConnectionDraftShape,
    expectedHeadVersion: z.number().int().positive().safe()
  }).superRefine(addProviderConnectionDraftIssues);

export const emailSenderProfileRevisionCandidateSchema = z.strictObject({
  revisionId: providerOpaqueIdSchema,
  senderProfileId: providerOpaqueIdSchema,
  revisionNumber: z.number().int().positive().safe(),
  fromName: canonicalText,
  fromAddressRef: emailProviderConfigurationRefSchema,
  replyModelKey: providerStableKeySchema,
  replyToRef: emailProviderConfigurationRefSchema.nullable(),
  presentationContractKey: providerStableKeySchema,
  presentationContractVersion: z.number().int().positive().safe(),
  presentationDigestSha256: providerSha256Schema,
  createdAt: instantSchema
});

export const emailSenderProfileProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  senderProfileId: providerOpaqueIdSchema,
  workspaceId: providerOpaqueIdSchema,
  profileKey: providerStableKeySchema,
  state: z.enum(['draft', 'active', 'archived']),
  headVersion: z.number().int().positive().safe(),
  currentRevisionId: providerOpaqueIdSchema.nullable(),
  candidateRevisions: z.array(emailSenderProfileRevisionCandidateSchema).max(100),
  createdAt: instantSchema,
  updatedAt: instantSchema
}).superRefine((profile, context) => {
  let previous = 0;
  const ids = new Set<string>();
  for (const [index, revision] of profile.candidateRevisions.entries()) {
    if (revision.senderProfileId !== profile.senderProfileId) {
      context.addIssue({ code: 'custom', path: ['candidateRevisions', index, 'senderProfileId'],
        message: 'sender revision belongs to another profile' });
    }
    if (revision.revisionNumber <= previous || ids.has(revision.revisionId)) {
      context.addIssue({ code: 'custom', path: ['candidateRevisions', index],
        message: 'sender revisions must be unique and use ascending revision order' });
    }
    previous = revision.revisionNumber;
    ids.add(revision.revisionId);
  }
  if (profile.currentRevisionId !== null && !ids.has(profile.currentRevisionId)) {
    context.addIssue({ code: 'custom', path: ['currentRevisionId'],
      message: 'current sender revision must belong to the projected profile' });
  }
  if (profile.state === 'active' && profile.currentRevisionId === null) {
    context.addIssue({ code: 'custom', path: ['currentRevisionId'],
      message: 'active sender profile requires a current revision' });
  }
});

export const emailSenderProfileDraftInputSchema = z.strictObject({
  senderProfileId: providerOpaqueIdSchema,
  revision: emailSenderProfileRevisionCandidateSchema,
  workspaceId: providerOpaqueIdSchema,
  profileKey: providerStableKeySchema,
  createdAt: instantSchema
}).superRefine((draft, context) => {
  if (
    draft.revision.senderProfileId !== draft.senderProfileId
    || draft.revision.revisionNumber !== 1
    || draft.revision.createdAt !== draft.createdAt
  ) context.addIssue({ code: 'custom', path: ['revision'],
    message: 'sender draft must carry revision one for the same profile and instant' });
});

export const emailSenderProfileRevisionAppendInputSchema = z.strictObject({
  senderProfileId: providerOpaqueIdSchema,
  revision: emailSenderProfileRevisionCandidateSchema,
  workspaceId: providerOpaqueIdSchema,
  profileKey: providerStableKeySchema,
  expectedHeadVersion: z.number().int().positive().safe(),
  appendedAt: instantSchema
}).superRefine((input, context) => {
  if (
    input.revision.senderProfileId !== input.senderProfileId
    || input.revision.revisionNumber !== input.expectedHeadVersion + 1
    || input.revision.createdAt !== input.appendedAt
  ) context.addIssue({ code: 'custom', path: ['revision'],
    message: 'sender append must carry the next revision for the same profile and instant' });
});

export const emailRoutingRuleCandidateSchema = z.strictObject({
  priority: z.number().int().nonnegative().safe(),
  purposeKey: providerStableKeySchema.nullable(),
  deliveryClassKey: providerStableKeySchema.nullable(),
  providerConnectionRevisionId: providerOpaqueIdSchema,
  senderProfileRevisionId: providerOpaqueIdSchema,
  noFallback: z.literal(true),
  ruleDigestSha256: providerSha256Schema
});

export const emailRoutingPolicyRevisionCandidateSchema = z.strictObject({
  revisionId: providerOpaqueIdSchema,
  routingPolicyId: providerOpaqueIdSchema,
  revisionNumber: z.number().int().positive().safe(),
  contractSchemaVersion: z.number().int().positive().safe(),
  digestSha256: providerSha256Schema,
  rules: z.array(emailRoutingRuleCandidateSchema).min(1).max(100),
  createdAt: instantSchema
}).superRefine((revision, context) => {
  for (let index = 0; index < revision.rules.length; index += 1) {
    if (revision.rules[index]!.priority !== index) {
      context.addIssue({ code: 'custom', path: ['rules', index, 'priority'],
        message: 'routing rules must use contiguous canonical priority order' });
    }
  }
});

export const emailRoutingPolicyProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  routingPolicyId: providerOpaqueIdSchema,
  workspaceId: providerOpaqueIdSchema,
  policyKey: providerStableKeySchema,
  state: z.enum(['draft', 'active', 'archived']),
  headVersion: z.number().int().positive().safe(),
  currentRevisionId: providerOpaqueIdSchema.nullable(),
  candidateRevisions: z.array(emailRoutingPolicyRevisionCandidateSchema).max(100),
  createdAt: instantSchema,
  updatedAt: instantSchema
}).superRefine((policy, context) => {
  let previous = 0;
  const ids = new Set<string>();
  for (const [index, revision] of policy.candidateRevisions.entries()) {
    if (revision.routingPolicyId !== policy.routingPolicyId) {
      context.addIssue({ code: 'custom', path: ['candidateRevisions', index, 'routingPolicyId'],
        message: 'routing revision belongs to another policy' });
    }
    if (revision.revisionNumber <= previous || ids.has(revision.revisionId)) {
      context.addIssue({ code: 'custom', path: ['candidateRevisions', index],
        message: 'routing revisions must be unique and use ascending revision order' });
    }
    previous = revision.revisionNumber;
    ids.add(revision.revisionId);
  }
  if (policy.currentRevisionId !== null && !ids.has(policy.currentRevisionId)) {
    context.addIssue({ code: 'custom', path: ['currentRevisionId'],
      message: 'current routing revision must belong to the projected policy' });
  }
  if (policy.state === 'active' && policy.currentRevisionId === null) {
    context.addIssue({ code: 'custom', path: ['currentRevisionId'],
      message: 'active routing policy requires a current revision' });
  }
});

export const emailRoutingPolicyDraftInputSchema = z.strictObject({
  routingPolicyId: providerOpaqueIdSchema,
  revision: emailRoutingPolicyRevisionCandidateSchema,
  workspaceId: providerOpaqueIdSchema,
  policyKey: providerStableKeySchema,
  createdAt: instantSchema
}).superRefine((draft, context) => {
  if (
    draft.revision.routingPolicyId !== draft.routingPolicyId
    || draft.revision.revisionNumber !== 1
    || draft.revision.createdAt !== draft.createdAt
  ) context.addIssue({ code: 'custom', path: ['revision'],
    message: 'routing draft must carry revision one for the same policy and instant' });
});

export const emailRoutingPolicyRevisionAppendInputSchema = z.strictObject({
  routingPolicyId: providerOpaqueIdSchema,
  revision: emailRoutingPolicyRevisionCandidateSchema,
  workspaceId: providerOpaqueIdSchema,
  policyKey: providerStableKeySchema,
  expectedHeadVersion: z.number().int().positive().safe(),
  appendedAt: instantSchema
}).superRefine((input, context) => {
  if (
    input.revision.routingPolicyId !== input.routingPolicyId
    || input.revision.revisionNumber !== input.expectedHeadVersion + 1
    || input.revision.createdAt !== input.appendedAt
  ) context.addIssue({ code: 'custom', path: ['revision'],
    message: 'routing append must carry the next revision for the same policy and instant' });
});

export const emailProviderConfigurationReadInputSchema = z.strictObject({
  connectionId: providerOpaqueIdSchema
});

export const emailProviderReadinessGetInputSchema = z.strictObject({
  connectionId: providerOpaqueIdSchema.optional()
});

export const emailProviderReadinessCheckInputSchema = z.strictObject({
  readinessCheckId: providerOpaqueIdSchema,
  connectionId: providerOpaqueIdSchema,
  connectionRevisionId: providerOpaqueIdSchema,
  expectedConfigDigestSha256: providerSha256Schema,
  capability: providerReadinessCapabilitySchema,
  checkKey: providerStableKeySchema,
  requestedValidUntil: providerTimestampSchema,
  requestDigestSha256: providerSha256Schema
}).superRefine((check, context) => {
  if (check.capability !== 'transactional_outbound') {
    context.addIssue({ code: 'custom', path: ['capability'],
      message: 'the first outbound rail runs only transactional outbound readiness checks' });
  }
});

export const emailProviderReadinessCheckProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  readinessCheckId: providerOpaqueIdSchema,
  connectionId: providerOpaqueIdSchema,
  connectionRevisionId: providerOpaqueIdSchema,
  capability: z.literal('transactional_outbound'),
  checkKey: providerStableKeySchema,
  state: z.enum(['checking', 'passed', 'failed']),
  readiness: z.enum(['ready', 'degraded', 'blocked']).nullable(),
  evidence: organizerCommunicationSafeEvidenceRefSchema.nullable(),
  validUntil: providerTimestampSchema.nullable(),
  startedAt: instantSchema,
  completedAt: instantSchema.nullable()
}).superRefine((check, context) => {
  if (check.state === 'checking') {
    if (check.readiness !== null || check.evidence !== null || check.validUntil !== null
      || check.completedAt !== null) {
      context.addIssue({ code: 'custom', message: 'checking readiness has no terminal evidence' });
    }
    return;
  }
  if (check.readiness === null || check.evidence === null || check.completedAt === null) {
    context.addIssue({ code: 'custom', message: 'terminal readiness requires evidence and completion' });
  }
  if (check.state === 'passed' && check.readiness === 'blocked') {
    context.addIssue({ code: 'custom', path: ['readiness'], message: 'passed readiness is not blocked' });
  }
  if (check.state === 'failed' && (check.readiness === 'ready' || check.readiness === 'degraded')) {
    context.addIssue({ code: 'custom', path: ['readiness'], message: 'failed readiness is blocked' });
  }
  if (check.readiness === 'ready' || check.readiness === 'degraded') {
    if (check.validUntil === null) context.addIssue({ code: 'custom', path: ['validUntil'],
      message: 'qualifying readiness requires an expiry' });
  } else if (check.validUntil !== null) {
    context.addIssue({ code: 'custom', path: ['validUntil'],
      message: 'blocked readiness has no qualifying validity' });
  }
});

export const emailProviderDiagnosticTestInputSchema = z.strictObject({
  diagnosticAttemptId: providerOpaqueIdSchema,
  connectionId: providerOpaqueIdSchema,
  connectionRevisionId: providerOpaqueIdSchema,
  expectedConfigDigestSha256: providerSha256Schema,
  senderProfileRevisionId: providerOpaqueIdSchema.optional(),
  approvedRecipientEvidenceRef: emailProviderConfigurationRefSchema,
  recipientFingerprintProfile: providerStableKeySchema,
  recipientFingerprintVersion: z.number().int().positive().safe(),
  recipientFingerprintSha256: providerSha256Schema,
  fixtureKey: providerStableKeySchema,
  fixtureVersion: z.number().int().positive().safe(),
  validUntil: providerTimestampSchema,
  maximumCostMinorUnits: z.number().int().nonnegative().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  requestDigestSha256: providerSha256Schema
});

export const emailProviderDiagnosticTestProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  diagnosticAttemptId: providerOpaqueIdSchema,
  connectionRevisionId: providerOpaqueIdSchema,
  state: z.enum(['not_enabled', 'accepted', 'known_failed', 'acceptance_unknown']),
  outcomeCode: providerStableKeySchema,
  evidence: organizerCommunicationSafeEvidenceRefSchema.nullable(),
  providerMessageRecorded: z.boolean(),
  cost: z.strictObject({
    minorUnits: z.number().int().nonnegative().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/)
  }).nullable(),
  observedAt: instantSchema
}).superRefine((diagnostic, context) => {
  if (diagnostic.state === 'not_enabled' && diagnostic.evidence !== null) {
    context.addIssue({ code: 'custom', path: ['evidence'],
      message: 'disabled diagnostics do not claim provider evidence' });
  }
  if (diagnostic.state !== 'accepted' && diagnostic.providerMessageRecorded) {
    context.addIssue({ code: 'custom', path: ['providerMessageRecorded'],
      message: 'only provider acceptance may record a provider message identity' });
  }
  if (diagnostic.state !== 'accepted' && diagnostic.cost !== null) {
    context.addIssue({ code: 'custom', path: ['cost'],
      message: 'only provider acceptance may record cost' });
  }
});

const dnsNameSchema = z.string().min(1).max(253)
  .regex(/^[a-z0-9_]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9_]([a-z0-9-]{0,62}[a-z0-9])?)+$/);

/**
 * Readiness reason codes that describe evidence currency rather than a defect:
 * passed evidence expires within minutes by design, so a healthy configured
 * install spends most of its life in one of these. Every surface deciding
 * "is this a problem or just an unchecked connection" consumes this one set —
 * a local copy is how two surfaces end up disagreeing about the same state.
 */
export const EMAIL_READINESS_CURRENCY_REASON_CODES = Object.freeze([
  'email_provider_readiness_expired',
  'email_provider_readiness_unknown',
  'email_provider_readiness_checking'
] as const);

/**
 * Advisory public-DNS deliverability diagnostics. These records are read over
 * public resolvers and never gate the send lane: the provider's own readiness
 * evidence stays authoritative, so every state here is a diagnosis to act on,
 * not an authorization.
 */
export const emailDeliverabilityRecordCheckSchema = z.strictObject({
  key: z.enum(['spf', 'dkim', 'dmarc']),
  recordName: dnsNameSchema,
  recordType: z.literal('TXT'),
  mustContain: z.array(z.string().min(1).max(200)).min(1).max(8),
  state: z.enum(['found', 'missing', 'mismatch', 'lookup_failed']),
  observedValues: z.array(z.string().max(512)).max(8)
});

export const emailDeliverabilityCheckProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  advisory: z.literal(true),
  domain: dnsNameSchema,
  resolverKey: providerStableKeySchema,
  records: z.array(emailDeliverabilityRecordCheckSchema).min(1).max(8),
  overall: z.enum(['pass', 'action_required', 'unknown']),
  checkedAt: instantSchema
}).superRefine((check, context) => {
  const states = check.records.map((record) => record.state);
  const expected = states.some((state) => state === 'missing' || state === 'mismatch')
    ? 'action_required'
    : states.some((state) => state === 'lookup_failed')
      ? 'unknown'
      : 'pass';
  if (check.overall !== expected) {
    context.addIssue({ code: 'custom', path: ['overall'],
      message: 'overall deliverability must aggregate the record states' });
  }
});

/** Non-secret, manifest-derived setup guidance for the configured provider. */
export const emailSetupGuideStepSchema = z.strictObject({
  key: providerStableKeySchema,
  title: z.string().min(1).max(120),
  instruction: z.string().min(1).max(500),
  officialLink: z.strictObject({
    label: z.string().min(1).max(120),
    href: z.url()
  }).nullable()
});

export const emailSetupGuideProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  provider: z.strictObject({
    adapterKey: providerStableKeySchema,
    displayName: canonicalText
  }),
  fromAddress: z.string().min(3).max(320),
  senderDomain: dnsNameSchema.nullable(),
  steps: z.array(emailSetupGuideStepSchema).max(32)
});

export const emailProviderConnectionCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: emailProviderConnectionProjectionSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const emailProviderReadinessCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: organizerEmailReadinessProjectionSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const emailProviderConfigurationReadOperationResultSchema =
  createReadOperationResultSchema(emailProviderConnectionProjectionSchema);
export const emailProviderReadinessReadOperationResultSchema =
  createReadOperationResultSchema(organizerEmailReadinessProjectionSchema);
export const emailProviderReadinessCheckOperationResultSchema =
  createEffectfulOperationResultSchema(emailProviderReadinessCheckProjectionSchema);
export const emailProviderDiagnosticTestOperationResultSchema =
  createEffectfulOperationResultSchema(emailProviderDiagnosticTestProjectionSchema);

export const EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS = Object.freeze({
  getConnection: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.provider.get-connection.input',
    inputSchema: emailProviderConfigurationReadInputSchema,
    resultKey: 'schema.communication.provider.get-connection.operator-result',
    resultSchema: emailProviderConfigurationReadOperationResultSchema
  }),
  getReadiness: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.provider.get-readiness.input',
    inputSchema: emailProviderReadinessGetInputSchema,
    resultKey: 'schema.communication.provider.get-readiness.operator-result',
    resultSchema: emailProviderReadinessReadOperationResultSchema
  }),
  runReadinessCheck: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.provider.run-readiness-check.input',
    inputSchema: emailProviderReadinessCheckInputSchema,
    resultKey: 'schema.communication.provider.run-readiness-check.operator-result',
    resultSchema: emailProviderReadinessCheckOperationResultSchema
  }),
  sendDiagnosticTest: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.provider.send-diagnostic-test.input',
    inputSchema: emailProviderDiagnosticTestInputSchema,
    resultKey: 'schema.communication.provider.send-diagnostic-test.operator-result',
    resultSchema: emailProviderDiagnosticTestOperationResultSchema
  })
});

export function computeEmailProviderConfigurationDigest(value: unknown): string {
  return bytesToHex(sha256(encodeCanonicalJson(value)));
}

export type EmailProviderConnectionDraftInput = z.infer<
  typeof emailProviderConnectionDraftInputSchema
>;
export type EmailProviderConnectionRevisionAppendInput = z.infer<
  typeof emailProviderConnectionRevisionAppendInputSchema
>;
export type EmailProviderConfigurationReadInput = z.infer<
  typeof emailProviderConfigurationReadInputSchema
>;
export type EmailProviderReadinessGetInput = z.infer<typeof emailProviderReadinessGetInputSchema>;
export type EmailProviderConnectionCanonicalResult = z.infer<
  typeof emailProviderConnectionCanonicalResultSchema
>;
export type EmailProviderReadinessCanonicalResult = z.infer<
  typeof emailProviderReadinessCanonicalResultSchema
>;
export type EmailProviderConnectionProjection = z.infer<
  typeof emailProviderConnectionProjectionSchema
>;
export type EmailProviderConnectionRevisionCandidate = z.infer<
  typeof emailProviderConnectionRevisionCandidateSchema
>;
export type EmailSenderProfileDraftInput = z.infer<typeof emailSenderProfileDraftInputSchema>;
export type EmailSenderProfileRevisionAppendInput = z.infer<
  typeof emailSenderProfileRevisionAppendInputSchema
>;
export type EmailSenderProfileProjection = z.infer<typeof emailSenderProfileProjectionSchema>;
export type EmailRoutingPolicyDraftInput = z.infer<typeof emailRoutingPolicyDraftInputSchema>;
export type EmailRoutingPolicyRevisionAppendInput = z.infer<
  typeof emailRoutingPolicyRevisionAppendInputSchema
>;
export type EmailRoutingPolicyProjection = z.infer<typeof emailRoutingPolicyProjectionSchema>;
export type EmailProviderReadinessCheckInput = z.infer<
  typeof emailProviderReadinessCheckInputSchema
>;
export type EmailProviderReadinessCheckProjection = z.infer<
  typeof emailProviderReadinessCheckProjectionSchema
>;
export type EmailProviderDiagnosticTestInput = z.infer<
  typeof emailProviderDiagnosticTestInputSchema
>;
export type EmailProviderDiagnosticTestProjection = z.infer<
  typeof emailProviderDiagnosticTestProjectionSchema
>;
export type EmailDeliverabilityRecordCheck = z.infer<typeof emailDeliverabilityRecordCheckSchema>;
export type EmailDeliverabilityCheckProjection = z.infer<
  typeof emailDeliverabilityCheckProjectionSchema
>;
export type EmailSetupGuideStep = z.infer<typeof emailSetupGuideStepSchema>;
export type EmailSetupGuideProjection = z.infer<typeof emailSetupGuideProjectionSchema>;
