import {
  canonicalJsonSha256,
  canonicalJsonValue,
  changesetHeadIntegrityMatches,
  type ApprovalReceipt,
  type ChangesetHead,
  type ChangesetRevision,
  type ChangesetSchemaRef,
  type CompensationBlocker,
  type CompensationConflict,
  type CompensationLineage,
  type CompensationNote,
  type CompensationOperationEvidence,
  type CompensationRemediation,
  type FrozenChangesetOperation
} from '@jooevents/changesets';
import {
  isApplicationId,
  parseApprovalId,
  parseChangesetId,
  parseChangesetRevisionId,
  parseEventId,
  parseOperationReceiptId,
  parseInstant,
  parseWorkspaceId
} from '@jooevents/kernel';
import type { OperationSurface } from '@jooevents/kernel';
import { z } from 'zod';

const stableKey = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const positiveInteger = z.number().int().positive();
const nonnegativeInteger = z.number().int().nonnegative();
export const changesetRecordApplicationIdSchema = z.string().refine(isApplicationId, {
  message: 'Application IDs must be canonical lowercase UUIDv4 or UUIDv7 values.'
});
const applicationId = changesetRecordApplicationIdSchema;
const principalKey = z.string().trim().min(1).max(512);
export const changesetRecordCanonicalInstantSchema = z.string().refine((value) => {
  try {
    return parseInstant(value) === value;
  } catch {
    return false;
  }
}, { message: 'Expected a canonical UTC instant.' });
const canonicalInstant = changesetRecordCanonicalInstantSchema;
const canonicalJson = z.json();

export const changesetDefinitionRefSchema = z.strictObject({
  key: stableKey,
  version: positiveInteger
});

export const changesetSchemaRefSchema: z.ZodType<ChangesetSchemaRef> = z.strictObject({
  key: stableKey,
  version: positiveInteger,
  digestSha256: sha256
});

const versionRefSchema = z.strictObject({ id: z.string().trim().min(1).max(512), version: positiveInteger });
const guardRefSchema = versionRefSchema.extend({ digest: sha256 });
const lineageSchema = z.strictObject({
  sourceRevisionId: z.string().trim().min(1).max(512),
  sourceRevisionDigest: sha256,
  sourceOperationIndex: nonnegativeInteger,
  sourceOperationKind: z.string().trim().min(1).max(256),
  sourceOperationVersion: positiveInteger,
  sourceDependencyGroup: stableKey
});

const frozenChangesetOperationFields = {
  kind: z.string().trim().min(1).max(256),
  version: positiveInteger,
  riskTier: z.enum(['low', 'normal', 'consequential']),
  dependencyGroup: stableKey,
  planSchema: changesetSchemaRefSchema,
  diffSchema: changesetSchemaRefSchema,
  resultSchema: changesetSchemaRefSchema,
  aggregateRefs: z.array(versionRefSchema),
  guardRefs: z.array(guardRefSchema),
  plan: canonicalJson,
  safeDiff: canonicalJson,
  consequences: z.array(z.string().trim().min(1).max(256))
} as const;

export const frozenChangesetOperationSchema: z.ZodType<FrozenChangesetOperation> = z.union([
  z.strictObject(frozenChangesetOperationFields),
  z.strictObject({ ...frozenChangesetOperationFields, compensationLineage: lineageSchema })
]);

const dependencyGroupSchema = z.strictObject({
  key: stableKey,
  dependsOn: z.array(stableKey)
});

const changesetRevisionFields = {
  id: applicationId,
  number: positiveInteger,
  createdAt: canonicalInstant,
  proposerPrincipalKey: principalKey,
  origin: z.enum(['human_ui', 'agent', 'import', 'integration', 'system']),
  operations: z.array(frozenChangesetOperationSchema).min(1),
  dependencyGroups: z.array(dependencyGroupSchema).min(1),
  riskTier: z.enum(['low', 'normal', 'consequential']),
  approvalPolicy: changesetDefinitionRefSchema,
  canonicalization: z.strictObject({
    key: z.literal('jooevents.canonical_json'),
    version: z.literal(1)
  }),
  digest: sha256
} as const;

export const changesetRevisionSchema: z.ZodType<ChangesetRevision> = z.union([
  z.strictObject(changesetRevisionFields),
  z.strictObject({ ...changesetRevisionFields, originProvenance: canonicalJson })
]);

const changesetHeadFields = {
  id: applicationId,
  workspaceId: applicationId,
  version: positiveInteger,
  status: z.enum(['draft', 'proposed', 'committed', 'discarded']),
  currentRevisionNumber: positiveInteger,
  revisions: z.array(changesetRevisionSchema).min(1)
} as const;

export const changesetHeadSchema: z.ZodType<ChangesetHead> = z.union([
  z.strictObject(changesetHeadFields),
  z.strictObject({ ...changesetHeadFields, eventId: applicationId })
]);

export interface StoredChangesetAuthorIntent {
  readonly operationIndex: number;
  readonly kind: string;
  readonly version: number;
  readonly dependencyGroup: string;
  readonly authorInputSchema: ChangesetSchemaRef;
  readonly authorInput: ReturnType<typeof canonicalJsonValue>;
}

export const storedChangesetAuthorIntentSchema: z.ZodType<StoredChangesetAuthorIntent> = z.strictObject({
  operationIndex: nonnegativeInteger,
  kind: z.string().trim().min(1).max(256),
  version: positiveInteger,
  dependencyGroup: stableKey,
  authorInputSchema: changesetSchemaRefSchema,
  authorInput: canonicalJson
});

export interface CapturedChangesetApprovalPolicy {
  readonly reference: { readonly key: string; readonly version: number };
  readonly definitionDigestSha256: string;
  /** Frozen threshold decision for this revision; not inferred later from risk tier. */
  readonly requirement: 'none' | 'distinct_current_human';
}

export const capturedChangesetApprovalPolicySchema: z.ZodType<CapturedChangesetApprovalPolicy> =
  z.strictObject({
    reference: changesetDefinitionRefSchema,
    definitionDigestSha256: sha256,
    requirement: z.enum(['none', 'distinct_current_human'])
  });

export interface StoredChangesetRevisionRecord {
  readonly schemaVersion: 1;
  readonly revision: ChangesetRevision;
  readonly authorIntents: readonly StoredChangesetAuthorIntent[];
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
  readonly recordDigestSha256: string;
}

function revisionRecordDigest(input: Omit<StoredChangesetRevisionRecord, 'recordDigestSha256'>): string {
  return canonicalJsonSha256(input);
}

export const storedChangesetRevisionRecordSchema: z.ZodType<StoredChangesetRevisionRecord> =
  z.strictObject({
    schemaVersion: z.literal(1),
    revision: changesetRevisionSchema,
    authorIntents: z.array(storedChangesetAuthorIntentSchema),
    approvalPolicy: capturedChangesetApprovalPolicySchema,
    recordDigestSha256: sha256
  }).superRefine((record, context) => {
    if (record.authorIntents.length !== record.revision.operations.length) {
      context.addIssue({ code: 'custom', message: 'Every operation requires one exact author intent.' });
    }
    for (const [index, operation] of record.revision.operations.entries()) {
      const intent = record.authorIntents[index];
      if (!intent || intent.operationIndex !== index || intent.kind !== operation.kind
        || intent.version !== operation.version || intent.dependencyGroup !== operation.dependencyGroup) {
        context.addIssue({ code: 'custom', path: ['authorIntents', index], message: 'Author intent does not bind its operation.' });
      }
    }
    if (record.approvalPolicy.reference.key !== record.revision.approvalPolicy.key
      || record.approvalPolicy.reference.version !== record.revision.approvalPolicy.version) {
      context.addIssue({ code: 'custom', path: ['approvalPolicy'], message: 'Captured policy does not bind the revision.' });
    }
    const { recordDigestSha256, ...digestInput } = record;
    if (revisionRecordDigest(digestInput) !== recordDigestSha256) {
      context.addIssue({ code: 'custom', path: ['recordDigestSha256'], message: 'Revision record digest changed.' });
    }
  });

export interface StoredChangesetRecord {
  readonly schemaVersion: 1;
  readonly head: ChangesetHead;
  readonly revisions: readonly StoredChangesetRevisionRecord[];
  readonly headDigestSha256: string;
  readonly recordDigestSha256: string;
}

function changesetRecordDigest(input: Omit<StoredChangesetRecord, 'recordDigestSha256'>): string {
  return canonicalJsonSha256(input);
}

export const storedChangesetRecordSchema: z.ZodType<StoredChangesetRecord> = z.strictObject({
  schemaVersion: z.literal(1),
  head: changesetHeadSchema,
  revisions: z.array(storedChangesetRevisionRecordSchema).min(1),
  headDigestSha256: sha256,
  recordDigestSha256: sha256
}).superRefine((record, context) => {
  if (!changesetHeadIntegrityMatches(record.head)) {
    context.addIssue({ code: 'custom', path: ['head'], message: 'Changeset revision-chain integrity failed.' });
  }
  if (canonicalJsonSha256(record.head) !== record.headDigestSha256) {
    context.addIssue({ code: 'custom', path: ['headDigestSha256'], message: 'Changeset head digest changed.' });
  }
  if (record.revisions.length !== record.head.revisions.length) {
    context.addIssue({ code: 'custom', path: ['revisions'], message: 'Stored revisions do not cover the head.' });
  }
  for (const [index, revision] of record.head.revisions.entries()) {
    const stored = record.revisions[index];
    if (!stored || canonicalJsonSha256(stored.revision) !== canonicalJsonSha256(revision)) {
      context.addIssue({ code: 'custom', path: ['revisions', index], message: 'Stored revision bytes do not match the head.' });
    }
  }
  const { recordDigestSha256, ...digestInput } = record;
  if (changesetRecordDigest(digestInput) !== recordDigestSha256) {
    context.addIssue({ code: 'custom', path: ['recordDigestSha256'], message: 'Changeset record digest changed.' });
  }
});

const approvalReceiptSchema: z.ZodType<ApprovalReceipt> = z.strictObject({
  id: applicationId,
  revisionId: applicationId,
  revisionDigest: sha256,
  policy: changesetDefinitionRefSchema,
  scopeKey: z.string().trim().min(1).max(1024),
  approverPrincipalKey: principalKey,
  issuedAt: canonicalInstant,
  expiresAt: canonicalInstant
}).superRefine((receipt, context) => {
  if (Date.parse(receipt.issuedAt) >= Date.parse(receipt.expiresAt)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Approval must expire after it is issued.' });
  }
});

export interface StoredChangesetApproval {
  readonly schemaVersion: 1;
  readonly changesetId: string;
  readonly receipt: ApprovalReceipt;
  readonly recordDigestSha256: string;
}

export const storedChangesetApprovalSchema: z.ZodType<StoredChangesetApproval> = z.strictObject({
  schemaVersion: z.literal(1),
  changesetId: applicationId,
  receipt: approvalReceiptSchema,
  recordDigestSha256: sha256
}).superRefine((record, context) => {
  const { recordDigestSha256, ...input } = record;
  if (canonicalJsonSha256(input) !== recordDigestSha256) {
    context.addIssue({ code: 'custom', path: ['recordDigestSha256'], message: 'Approval record digest changed.' });
  }
});

export interface StoredChangesetCommitLink {
  readonly schemaVersion: 1;
  readonly changesetId: string;
  readonly committedHeadVersion: number;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly commitReceiptId: string;
  readonly terminalReceiptBinding: {
    readonly operation: { readonly name: string; readonly version: number };
    readonly surface: OperationSurface;
    readonly scopePartitionKey: string;
    readonly authorityPrincipalKey: string;
    readonly requestHashSha256: string;
    readonly terminalReceiptDigestSha256: string;
  };
  readonly committedAt: string;
  readonly committerPrincipalKey: string;
  readonly approvalId?: string;
  readonly recordDigestSha256: string;
}

export interface ChangesetCommitTerminalReceipt {
  readonly ref: {
    readonly id: string;
    readonly operationName: string;
    readonly operationVersion: number;
  };
  readonly identity: {
    readonly scopePartitionKey: string;
    readonly authorityPrincipalKey: string;
    readonly operationName: string;
    readonly operationVersion: number;
    readonly surface: OperationSurface;
    readonly idempotencyVerifierProfile: { readonly key: string; readonly version: number };
    readonly idempotencyKeyVerifier: string;
  };
  readonly requestHash: string;
  readonly result: {
    readonly kind: 'success';
    readonly data: {
      readonly schemaVersion: 1;
      readonly action: 'commit';
      readonly changesetId: string;
      readonly expectedHeadVersion: number;
      readonly committedHeadVersion: number;
      readonly revisionId: string;
      readonly revisionDigest: string;
    };
    readonly receipt: {
      readonly id: string;
      readonly operationName: string;
      readonly operationVersion: number;
    };
    readonly correlationId: string;
  };
}

const operationReceiptRefSchema = z.strictObject({
  id: applicationId,
  operationName: stableKey.max(160),
  operationVersion: positiveInteger
});

export const changesetCommitTerminalReceiptSchema: z.ZodType<ChangesetCommitTerminalReceipt> =
  z.strictObject({
    ref: operationReceiptRefSchema,
    identity: z.strictObject({
      scopePartitionKey: sha256,
      authorityPrincipalKey: sha256,
      operationName: stableKey.max(160),
      operationVersion: positiveInteger,
      surface: z.enum([
        'operator_http',
        'participant_http',
        'public_http',
        'external_mcp',
        'app_model',
        'application_job',
        'provider_ingress'
      ]),
      idempotencyVerifierProfile: z.strictObject({ key: stableKey, version: positiveInteger }),
      idempotencyKeyVerifier: sha256
    }),
    requestHash: sha256,
    result: z.strictObject({
      kind: z.literal('success'),
      data: z.strictObject({
        schemaVersion: z.literal(1),
        action: z.literal('commit'),
        changesetId: applicationId,
        expectedHeadVersion: positiveInteger,
        committedHeadVersion: positiveInteger,
        revisionId: applicationId,
        revisionDigest: sha256
      }),
      receipt: operationReceiptRefSchema,
      correlationId: applicationId
    })
  }).superRefine((receipt, context) => {
    if (receipt.ref.operationName !== receipt.identity.operationName
      || receipt.ref.operationVersion !== receipt.identity.operationVersion
      || receipt.ref.id !== receipt.result.receipt.id
      || receipt.ref.operationName !== receipt.result.receipt.operationName
      || receipt.ref.operationVersion !== receipt.result.receipt.operationVersion) {
      context.addIssue({ code: 'custom', message: 'Terminal receipt operation identity changed.' });
    }
    if (receipt.result.data.committedHeadVersion !== receipt.result.data.expectedHeadVersion + 1) {
      context.addIssue({ code: 'custom', path: ['result', 'data'], message: 'Committed head version is not the exact successor.' });
    }
  });

const changesetCommitLinkFields = {
  schemaVersion: z.literal(1),
  changesetId: applicationId,
  committedHeadVersion: positiveInteger,
  revisionId: applicationId,
  revisionDigest: sha256,
  commitReceiptId: applicationId,
  terminalReceiptBinding: z.strictObject({
    operation: z.strictObject({ name: stableKey.max(160), version: positiveInteger }),
    surface: z.enum([
      'operator_http',
      'participant_http',
      'public_http',
      'external_mcp',
      'app_model',
      'application_job',
      'provider_ingress'
    ]),
    scopePartitionKey: sha256,
    authorityPrincipalKey: sha256,
    requestHashSha256: sha256,
    terminalReceiptDigestSha256: sha256
  }),
  committedAt: canonicalInstant,
  committerPrincipalKey: principalKey,
  recordDigestSha256: sha256
} as const;

export const storedChangesetCommitLinkSchema: z.ZodType<StoredChangesetCommitLink> = z.union([
  z.strictObject(changesetCommitLinkFields),
  z.strictObject({ ...changesetCommitLinkFields, approvalId: applicationId })
]).superRefine((record, context) => {
  const { recordDigestSha256, ...input } = record;
  if (canonicalJsonSha256(input) !== recordDigestSha256) {
    context.addIssue({ code: 'custom', path: ['recordDigestSha256'], message: 'Commit link digest changed.' });
  }
});

export interface StoredChangesetRebuildLink {
  readonly schemaVersion: 1;
  readonly changesetId: string;
  readonly sourceRevisionId: string;
  readonly sourceRevisionDigest: string;
  readonly targetRevisionId: string;
  readonly targetRevisionDigest: string;
  readonly replannedGroups: readonly string[];
  readonly rebuiltAt: string;
  readonly rebuiltByPrincipalKey: string;
  readonly recordDigestSha256: string;
}

export const storedChangesetRebuildLinkSchema: z.ZodType<StoredChangesetRebuildLink> = z.strictObject({
  schemaVersion: z.literal(1),
  changesetId: applicationId,
  sourceRevisionId: applicationId,
  sourceRevisionDigest: sha256,
  targetRevisionId: applicationId,
  targetRevisionDigest: sha256,
  replannedGroups: z.array(stableKey).min(1),
  rebuiltAt: canonicalInstant,
  rebuiltByPrincipalKey: principalKey,
  recordDigestSha256: sha256
}).superRefine((record, context) => {
  const canonicalGroups = [...new Set(record.replannedGroups)].sort();
  if (canonicalGroups.length !== record.replannedGroups.length
    || canonicalGroups.some((group, index) => group !== record.replannedGroups[index])) {
    context.addIssue({ code: 'custom', path: ['replannedGroups'], message: 'Replanned groups must be sorted and unique.' });
  }
  const { recordDigestSha256, ...input } = record;
  if (canonicalJsonSha256(input) !== recordDigestSha256) {
    context.addIssue({ code: 'custom', path: ['recordDigestSha256'], message: 'Rebuild link digest changed.' });
  }
});

export type ChangesetCorrectionResultKind = 'exact' | 'semantic' | 'partial' | 'blocked' | 'irreversible';

const detailKeys = z.array(stableKey).min(1).superRefine((keys, context) => {
  const sorted = [...new Set(keys)].sort();
  if (sorted.length !== keys.length || sorted.some((key, index) => key !== keys[index])) {
    context.addIssue({ code: 'custom', message: 'Detail keys must be sorted and unique.' });
  }
});

const compensationNoteSchema: z.ZodType<CompensationNote> = z.strictObject({
  lineage: lineageSchema,
  noteKey: stableKey
});
const compensationConflictSchema: z.ZodType<CompensationConflict> = z.strictObject({
  lineage: lineageSchema,
  conflictKeys: detailKeys
});
const compensationBlockerSchema: z.ZodType<CompensationBlocker> = z.strictObject({
  lineage: lineageSchema,
  reasonKey: stableKey
});
const compensationRemediationSchema: z.ZodType<CompensationRemediation> = z.strictObject({
  lineage: lineageSchema,
  remediationKey: stableKey
});

const compensationOperationEvidenceSchema: z.ZodType<CompensationOperationEvidence> =
  z.discriminatedUnion('kind', [
    z.strictObject({ lineage: lineageSchema, kind: z.literal('exact'), draftable: z.literal(true) }),
    z.strictObject({
      lineage: lineageSchema,
      kind: z.literal('semantic'),
      draftable: z.literal(true),
      noteKey: stableKey
    }),
    z.strictObject({
      lineage: lineageSchema,
      kind: z.literal('partial'),
      draftable: z.literal(true),
      conflictKeys: detailKeys
    }),
    z.strictObject({
      lineage: lineageSchema,
      kind: z.literal('blocked'),
      draftable: z.literal(false),
      reasonKey: stableKey
    }),
    z.strictObject({
      lineage: lineageSchema,
      kind: z.literal('irreversible'),
      draftable: z.boolean(),
      remediationKey: stableKey
    })
  ]);

export type StoredChangesetCorrectionEvidence =
  | { readonly kind: 'exact'; readonly operations: readonly CompensationOperationEvidence[] }
  | {
      readonly kind: 'semantic';
      readonly notes: readonly CompensationNote[];
      readonly operations: readonly CompensationOperationEvidence[];
    }
  | {
      readonly kind: 'partial';
      readonly conflicts: readonly CompensationConflict[];
      readonly notes: readonly CompensationNote[];
      readonly operations: readonly CompensationOperationEvidence[];
    }
  | {
      readonly kind: 'blocked';
      readonly blockers: readonly CompensationBlocker[];
      readonly remediations: readonly CompensationRemediation[];
      readonly conflicts: readonly CompensationConflict[];
      readonly notes: readonly CompensationNote[];
      readonly operations: readonly CompensationOperationEvidence[];
    }
  | {
      readonly kind: 'irreversible';
      readonly remediations: readonly CompensationRemediation[];
      readonly conflicts: readonly CompensationConflict[];
      readonly notes: readonly CompensationNote[];
      readonly operations: readonly CompensationOperationEvidence[];
    };

interface StoredChangesetCorrectionLinkBase {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceChangesetId: string;
  readonly sourceRevisionId: string;
  readonly sourceRevisionDigest: string;
  readonly sourceCommitReceiptId: string;
  readonly draftedAt: string;
  readonly draftedByPrincipalKey: string;
  readonly recordDigestSha256: string;
}

export type StoredChangesetCorrectionLink = StoredChangesetCorrectionLinkBase & (
  | {
      readonly resultKind: 'exact';
      readonly target: {
        readonly changesetId: string;
        readonly revisionId: string;
        readonly revisionDigest: string;
      };
      readonly evidence: Extract<StoredChangesetCorrectionEvidence, { readonly kind: 'exact' }>;
    }
  | {
      readonly resultKind: 'semantic';
      readonly target: {
        readonly changesetId: string;
        readonly revisionId: string;
        readonly revisionDigest: string;
      };
      readonly evidence: Extract<StoredChangesetCorrectionEvidence, { readonly kind: 'semantic' }>;
    }
  | {
      readonly resultKind: 'partial';
      readonly target: {
        readonly changesetId: string;
        readonly revisionId: string;
        readonly revisionDigest: string;
      };
      readonly evidence: Extract<StoredChangesetCorrectionEvidence, { readonly kind: 'partial' }>;
    }
  | {
      readonly resultKind: 'blocked';
      readonly target: null;
      readonly evidence: Extract<StoredChangesetCorrectionEvidence, { readonly kind: 'blocked' }>;
    }
  | {
      readonly resultKind: 'irreversible';
      readonly target: {
        readonly changesetId: string;
        readonly revisionId: string;
        readonly revisionDigest: string;
      } | null;
      readonly evidence: Extract<StoredChangesetCorrectionEvidence, { readonly kind: 'irreversible' }>;
    }
);

const correctionLinkBase = {
  schemaVersion: z.literal(1),
  id: applicationId,
  sourceChangesetId: applicationId,
  sourceRevisionId: applicationId,
  sourceRevisionDigest: sha256,
  sourceCommitReceiptId: applicationId,
  draftedAt: canonicalInstant,
  draftedByPrincipalKey: principalKey,
  recordDigestSha256: sha256
} as const;

const correctionTargetSchema = z.strictObject({
  changesetId: applicationId,
  revisionId: applicationId,
  revisionDigest: sha256
});

const correctionEvidenceSchemas = {
  exact: z.strictObject({
    kind: z.literal('exact'),
    operations: z.array(compensationOperationEvidenceSchema).min(1)
  }),
  semantic: z.strictObject({
    kind: z.literal('semantic'),
    notes: z.array(compensationNoteSchema).min(1),
    operations: z.array(compensationOperationEvidenceSchema).min(1)
  }),
  partial: z.strictObject({
    kind: z.literal('partial'),
    conflicts: z.array(compensationConflictSchema).min(1),
    notes: z.array(compensationNoteSchema),
    operations: z.array(compensationOperationEvidenceSchema).min(1)
  }),
  blocked: z.strictObject({
    kind: z.literal('blocked'),
    blockers: z.array(compensationBlockerSchema).min(1),
    remediations: z.array(compensationRemediationSchema),
    conflicts: z.array(compensationConflictSchema),
    notes: z.array(compensationNoteSchema),
    operations: z.array(compensationOperationEvidenceSchema).min(1)
  }),
  irreversible: z.strictObject({
    kind: z.literal('irreversible'),
    remediations: z.array(compensationRemediationSchema).min(1),
    conflicts: z.array(compensationConflictSchema),
    notes: z.array(compensationNoteSchema),
    operations: z.array(compensationOperationEvidenceSchema).min(1)
  })
} as const;

export const storedChangesetCorrectionLinkSchema: z.ZodType<StoredChangesetCorrectionLink> = z.union([
  z.strictObject({
    ...correctionLinkBase,
    resultKind: z.literal('exact'),
    target: correctionTargetSchema,
    evidence: correctionEvidenceSchemas.exact
  }),
  z.strictObject({
    ...correctionLinkBase,
    resultKind: z.literal('semantic'),
    target: correctionTargetSchema,
    evidence: correctionEvidenceSchemas.semantic
  }),
  z.strictObject({
    ...correctionLinkBase,
    resultKind: z.literal('partial'),
    target: correctionTargetSchema,
    evidence: correctionEvidenceSchemas.partial
  }),
  z.strictObject({
    ...correctionLinkBase,
    resultKind: z.literal('blocked'),
    target: z.null(),
    evidence: correctionEvidenceSchemas.blocked
  }),
  z.strictObject({
    ...correctionLinkBase,
    resultKind: z.literal('irreversible'),
    target: z.union([correctionTargetSchema, z.null()]),
    evidence: correctionEvidenceSchemas.irreversible
  })
]).superRefine((record, context) => {
  const { recordDigestSha256, ...input } = record;
  if (canonicalJsonSha256(input) !== recordDigestSha256) {
    context.addIssue({ code: 'custom', path: ['recordDigestSha256'], message: 'Correction link digest changed.' });
  }
});

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function parsed<Value>(schema: z.ZodType<Value>, value: unknown): Value {
  return deepFreeze(schema.parse(value));
}

export function parseStoredChangesetRecord(value: unknown): StoredChangesetRecord {
  const record = parsed(storedChangesetRecordSchema, value);
  parseChangesetId(record.head.id);
  parseWorkspaceId(record.head.workspaceId);
  if (record.head.eventId !== undefined) parseEventId(record.head.eventId);
  for (const revision of record.head.revisions) parseChangesetRevisionId(revision.id);
  return record;
}

export function parseChangesetHead(value: unknown): ChangesetHead {
  const head = parsed(changesetHeadSchema, value);
  parseChangesetId(head.id);
  parseWorkspaceId(head.workspaceId);
  if (head.eventId !== undefined) parseEventId(head.eventId);
  for (const revision of head.revisions) parseChangesetRevisionId(revision.id);
  if (!changesetHeadIntegrityMatches(head)) throw new TypeError('changeset_head_integrity_failed');
  return head;
}

export function createStoredChangesetRevisionRecord(input: {
  readonly revision: ChangesetRevision;
  readonly authorIntents: readonly StoredChangesetAuthorIntent[];
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
}): StoredChangesetRevisionRecord {
  const base = {
    schemaVersion: 1 as const,
    revision: input.revision,
    authorIntents: input.authorIntents,
    approvalPolicy: input.approvalPolicy
  };
  return parsed(storedChangesetRevisionRecordSchema, {
    ...base,
    recordDigestSha256: revisionRecordDigest(base)
  });
}

export function parseStoredChangesetRevisionRecord(value: unknown): StoredChangesetRevisionRecord {
  const record = parsed(storedChangesetRevisionRecordSchema, value);
  parseChangesetRevisionId(record.revision.id);
  return record;
}

export function createStoredChangesetRecord(input: {
  readonly head: ChangesetHead;
  readonly revisions: readonly StoredChangesetRevisionRecord[];
}): StoredChangesetRecord {
  const withoutRecordDigest = {
    schemaVersion: 1 as const,
    head: input.head,
    revisions: input.revisions,
    headDigestSha256: canonicalJsonSha256(input.head)
  };
  return parseStoredChangesetRecord({
    ...withoutRecordDigest,
    recordDigestSha256: changesetRecordDigest(withoutRecordDigest)
  });
}

export function parseStoredChangesetApproval(value: unknown): StoredChangesetApproval {
  const record = parsed(storedChangesetApprovalSchema, value);
  parseChangesetId(record.changesetId);
  parseApprovalId(record.receipt.id);
  parseChangesetRevisionId(record.receipt.revisionId);
  return record;
}

export function createStoredChangesetApproval(input: {
  readonly changesetId: string;
  readonly receipt: ApprovalReceipt;
}): StoredChangesetApproval {
  const base = { schemaVersion: 1 as const, ...input };
  return parseStoredChangesetApproval({ ...base, recordDigestSha256: canonicalJsonSha256(base) });
}

export function parseStoredChangesetCommitLink(value: unknown): StoredChangesetCommitLink {
  const record = parsed(storedChangesetCommitLinkSchema, value);
  parseChangesetId(record.changesetId);
  parseChangesetRevisionId(record.revisionId);
  parseOperationReceiptId(record.commitReceiptId);
  if (record.approvalId !== undefined) parseApprovalId(record.approvalId);
  return record;
}

export function parseChangesetCommitTerminalReceipt(value: unknown): ChangesetCommitTerminalReceipt {
  const receipt = parsed(changesetCommitTerminalReceiptSchema, value);
  parseOperationReceiptId(receipt.ref.id);
  parseChangesetId(receipt.result.data.changesetId);
  parseChangesetRevisionId(receipt.result.data.revisionId);
  return receipt;
}

export function changesetCommitTerminalReceiptDigest(receipt: ChangesetCommitTerminalReceipt): string {
  return canonicalJsonSha256(parseChangesetCommitTerminalReceipt(receipt));
}

export function createStoredChangesetCommitLink(
  input: Omit<StoredChangesetCommitLink, 'schemaVersion' | 'recordDigestSha256'>
): StoredChangesetCommitLink {
  const base = { schemaVersion: 1 as const, ...input };
  return parseStoredChangesetCommitLink({ ...base, recordDigestSha256: canonicalJsonSha256(base) });
}

export function parseStoredChangesetRebuildLink(value: unknown): StoredChangesetRebuildLink {
  const record = parsed(storedChangesetRebuildLinkSchema, value);
  parseChangesetId(record.changesetId);
  parseChangesetRevisionId(record.sourceRevisionId);
  parseChangesetRevisionId(record.targetRevisionId);
  return record;
}

export function createStoredChangesetRebuildLink(
  input: Omit<StoredChangesetRebuildLink, 'schemaVersion' | 'recordDigestSha256'>
): StoredChangesetRebuildLink {
  const base = { schemaVersion: 1 as const, ...input };
  return parseStoredChangesetRebuildLink({ ...base, recordDigestSha256: canonicalJsonSha256(base) });
}

export function parseStoredChangesetCorrectionLink(value: unknown): StoredChangesetCorrectionLink {
  const record = parsed(storedChangesetCorrectionLinkSchema, value);
  parseChangesetId(record.sourceChangesetId);
  parseChangesetRevisionId(record.sourceRevisionId);
  parseOperationReceiptId(record.sourceCommitReceiptId);
  if (record.target !== null) {
    parseChangesetId(record.target.changesetId);
    parseChangesetRevisionId(record.target.revisionId);
  }
  return record;
}

export function createStoredChangesetCorrectionLink(
  input: Omit<StoredChangesetCorrectionLinkBase, 'schemaVersion' | 'recordDigestSha256'> & {
    readonly resultKind: ChangesetCorrectionResultKind;
    readonly target: {
      readonly changesetId: string;
      readonly revisionId: string;
      readonly revisionDigest: string;
    } | null;
    readonly evidence: StoredChangesetCorrectionEvidence;
  }
): StoredChangesetCorrectionLink {
  const base = { schemaVersion: 1 as const, ...input };
  return parseStoredChangesetCorrectionLink({ ...base, recordDigestSha256: canonicalJsonSha256(base) });
}

export interface StoredChangesetDiff {
  readonly changesetId: string;
  readonly headVersion: number;
  readonly status: ChangesetHead['status'];
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly revisionDigest: string;
  readonly riskTier: ChangesetRevision['riskTier'];
  readonly approvalPolicy: CapturedChangesetApprovalPolicy;
  readonly operations: readonly {
    readonly kind: string;
    readonly version: number;
    readonly riskTier: FrozenChangesetOperation['riskTier'];
    readonly dependencyGroup: string;
    readonly safeDiff: ReturnType<typeof canonicalJsonValue>;
    readonly consequences: readonly string[];
  }[];
}

export function projectStoredChangesetDiff(
  record: StoredChangesetRecord,
  revisionId: string,
  revisionDigest: string
): StoredChangesetDiff | undefined {
  const revisionRecord = record.revisions.find((candidate) =>
    candidate.revision.id === revisionId && candidate.revision.digest === revisionDigest
  );
  if (!revisionRecord) return undefined;
  const revision = revisionRecord.revision;
  return deepFreeze({
    changesetId: record.head.id,
    headVersion: record.head.version,
    status: record.head.status,
    revisionId: revision.id,
    revisionNumber: revision.number,
    revisionDigest: revision.digest,
    riskTier: revision.riskTier,
    approvalPolicy: structuredClone(revisionRecord.approvalPolicy),
    operations: revision.operations.map((operation) => ({
      kind: operation.kind,
      version: operation.version,
      riskTier: operation.riskTier,
      dependencyGroup: operation.dependencyGroup,
      safeDiff: canonicalJsonValue(operation.safeDiff),
      consequences: [...operation.consequences]
    }))
  });
}
