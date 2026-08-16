import { canonicalJsonSha256 } from '@jooevents/kernel';
import {
  templateArtifactDocumentSchema,
  templateArtifactHeadSchema,
  templateArtifactMutationInputSchema,
  templateArtifactMutationPlanSchema,
  templateArtifactRevisionSchema,
  templateArtifactScopeSchema,
  templateArtifactSnapshotSchema,
  type TemplateArtifactDocumentDto,
  type TemplateArtifactMutationInputDto,
  type TemplateArtifactMutationPlanDto,
  type TemplateArtifactRevisionDto,
  type TemplateArtifactScopeDto,
  type TemplateArtifactSnapshotDto
} from '@jooevents/contracts';

export type TemplateArtifactPlanningErrorCode =
  | 'wrong_scope'
  | 'artifact_missing'
  | 'artifact_kind_changed'
  | 'stale_revision'
  | 'revision_missing'
  | 'no_changes'
  | 'invalid_plan';

export class TemplateArtifactPlanningError extends Error {
  constructor(readonly code: TemplateArtifactPlanningErrorCode) {
    super(code);
    this.name = 'TemplateArtifactPlanningError';
  }
}

export interface TemplateArtifactReadPort {
  readArtifact(
    scope: TemplateArtifactScopeDto,
    artifactId: string
  ): TemplateArtifactSnapshotDto | undefined;
}

export interface TemplateArtifactTransactionPort extends TemplateArtifactReadPort {
  applyMutation(plan: TemplateArtifactMutationPlanDto): TemplateArtifactSnapshotDto;
}

function canonical<T>(value: T): T {
  return structuredClone(value);
}

function sameScope(left: TemplateArtifactScopeDto, right: TemplateArtifactScopeDto): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

function unsignedRevision(input: {
  readonly scope: TemplateArtifactScopeDto;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly number: number;
  readonly predecessor: TemplateArtifactRevisionDto['predecessor'];
  readonly document: TemplateArtifactDocumentDto;
  readonly author: TemplateArtifactRevisionDto['author'];
  readonly note: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}) {
  return {
    schemaVersion: 1 as const,
    scope: input.scope,
    artifactId: input.artifactId,
    revisionId: input.revisionId,
    number: input.number,
    predecessor: input.predecessor,
    document: input.document,
    author: input.author,
    note: input.note,
    createdByUserId: input.createdByUserId,
    createdAt: input.createdAt
  };
}

export function createTemplateArtifactRevision(input: {
  readonly scope: TemplateArtifactScopeDto;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly number: number;
  readonly predecessor: TemplateArtifactRevisionDto['predecessor'];
  readonly document: TemplateArtifactDocumentDto;
  readonly author: TemplateArtifactRevisionDto['author'];
  readonly note: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}): TemplateArtifactRevisionDto {
  const unsigned = unsignedRevision({
    ...input,
    scope: templateArtifactScopeSchema.parse(input.scope),
    document: templateArtifactDocumentSchema.parse(input.document)
  });
  return templateArtifactRevisionSchema.parse({
    ...unsigned,
    digestSha256: canonicalJsonSha256(unsigned)
  });
}

export function parseTemplateArtifactRevision(value: unknown): TemplateArtifactRevisionDto {
  const revision = templateArtifactRevisionSchema.parse(value);
  const { digestSha256, ...unsigned } = revision;
  if (canonicalJsonSha256(unsigned) !== digestSha256) {
    throw new TypeError('template_artifact_revision_digest_mismatch');
  }
  return revision;
}

export function parseTemplateArtifactSnapshot(value: unknown): TemplateArtifactSnapshotDto {
  const snapshot = templateArtifactSnapshotSchema.parse(value);
  const history = snapshot.history.map(parseTemplateArtifactRevision);
  for (const [index, revision] of history.entries()) {
    if (revision.scope.workspaceId !== snapshot.head.scope.workspaceId
        || revision.scope.eventId !== snapshot.head.scope.eventId
        || revision.artifactId !== snapshot.head.artifactId
        || revision.document.kind !== snapshot.head.artifactKind
        || revision.number !== index + 1) {
      throw new TypeError('template_artifact_history_incoherent');
    }
    const previous = history[index - 1];
    const coherentPredecessor = previous === undefined
      ? revision.predecessor === null
      : revision.predecessor?.revisionId === previous.revisionId
        && revision.predecessor.digestSha256 === previous.digestSha256;
    if (!coherentPredecessor) throw new TypeError('template_artifact_chain_broken');
  }
  if (snapshot.head.version !== snapshot.head.currentRevisionNumber) {
    throw new TypeError('template_artifact_head_version_incoherent');
  }
  return {
    head: snapshot.head,
    current: history.at(-1)!,
    history
  };
}

export function createInitialTemplateArtifact(input: {
  readonly scope: TemplateArtifactScopeDto;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly document: TemplateArtifactDocumentDto;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly note?: string;
}): TemplateArtifactSnapshotDto {
  const revision = createTemplateArtifactRevision({
    scope: input.scope,
    artifactId: input.artifactId,
    revisionId: input.revisionId,
    number: 1,
    predecessor: null,
    document: input.document,
    author: 'system',
    note: input.note ?? 'Starter',
    createdByUserId: input.createdByUserId,
    createdAt: input.createdAt
  });
  return parseTemplateArtifactSnapshot({
    head: templateArtifactHeadSchema.parse({
      schemaVersion: 1,
      scope: revision.scope,
      artifactId: revision.artifactId,
      artifactKind: revision.document.kind,
      currentRevisionId: revision.revisionId,
      currentRevisionNumber: 1,
      version: 1
    }),
    current: revision,
    history: [revision]
  });
}

export function planTemplateArtifactMutation(input: {
  readonly scope: TemplateArtifactScopeDto;
  readonly current: TemplateArtifactSnapshotDto;
  readonly mutation: TemplateArtifactMutationInputDto;
  readonly revisionId: string;
  readonly actorUserId: string;
  readonly occurredAt: string;
}): TemplateArtifactMutationPlanDto {
  let current: TemplateArtifactSnapshotDto;
  let scope: TemplateArtifactScopeDto;
  let mutation: TemplateArtifactMutationInputDto;
  try {
    current = parseTemplateArtifactSnapshot(input.current);
    scope = templateArtifactScopeSchema.parse(input.scope);
    mutation = templateArtifactMutationInputSchema.parse(input.mutation);
  } catch (error) {
    if (error instanceof TemplateArtifactPlanningError) throw error;
    throw new TemplateArtifactPlanningError('invalid_plan');
  }
  if (!sameScope(scope, current.head.scope)) throw new TemplateArtifactPlanningError('wrong_scope');
  if (mutation.artifactId !== current.head.artifactId) {
    throw new TemplateArtifactPlanningError('artifact_missing');
  }
  if (mutation.expectedRevisionNumber !== current.current.number) {
    throw new TemplateArtifactPlanningError('stale_revision');
  }
  let document: TemplateArtifactDocumentDto;
  let author: 'organizer' | 'agent';
  let note: string;
  let restoredFromRevisionNumber: number | null;
  if (mutation.action === 'replace') {
    document = mutation.document;
    author = mutation.author;
    note = mutation.note;
    restoredFromRevisionNumber = null;
    if (document.kind !== current.head.artifactKind) {
      throw new TemplateArtifactPlanningError('artifact_kind_changed');
    }
    if (canonicalJsonSha256(document) === canonicalJsonSha256(current.current.document)) {
      throw new TemplateArtifactPlanningError('no_changes');
    }
  } else {
    const target = current.history.find((revision) => revision.number === mutation.targetRevisionNumber);
    if (!target) throw new TemplateArtifactPlanningError('revision_missing');
    if (target.number === current.current.number
        || canonicalJsonSha256(target.document) === canonicalJsonSha256(current.current.document)) {
      throw new TemplateArtifactPlanningError('no_changes');
    }
    document = target.document;
    author = 'organizer';
    note = `Reverted to revision ${target.number}`;
    restoredFromRevisionNumber = target.number;
  }
  const after = createTemplateArtifactRevision({
    scope,
    artifactId: current.head.artifactId,
    revisionId: input.revisionId,
    number: current.current.number + 1,
    predecessor: {
      revisionId: current.current.revisionId,
      digestSha256: current.current.digestSha256
    },
    document,
    author,
    note,
    createdByUserId: input.actorUserId,
    createdAt: input.occurredAt
  });
  return templateArtifactMutationPlanSchema.parse({
    action: mutation.action,
    scope,
    artifactId: current.head.artifactId,
    expectedHeadVersion: current.head.version,
    before: current.current,
    after,
    restoredFromRevisionNumber
  });
}

export function validateTemplateArtifactMutation(input: {
  readonly plan: TemplateArtifactMutationPlanDto;
  readonly read: TemplateArtifactReadPort;
}): TemplateArtifactPlanningErrorCode | undefined {
  let plan: TemplateArtifactMutationPlanDto;
  try {
    plan = templateArtifactMutationPlanSchema.parse(input.plan);
    const current = input.read.readArtifact(plan.scope, plan.artifactId);
    if (!current) return 'artifact_missing';
    const verified = parseTemplateArtifactSnapshot(current);
    if (verified.head.version !== plan.expectedHeadVersion
        || verified.current.revisionId !== plan.before.revisionId
        || verified.current.digestSha256 !== plan.before.digestSha256) return 'stale_revision';
    if (plan.after.number !== plan.before.number + 1
        || plan.after.predecessor?.revisionId !== plan.before.revisionId
        || plan.after.predecessor.digestSha256 !== plan.before.digestSha256
        || plan.after.scope.workspaceId !== plan.scope.workspaceId
        || plan.after.scope.eventId !== plan.scope.eventId
        || plan.after.artifactId !== plan.artifactId) return 'invalid_plan';
    parseTemplateArtifactRevision(plan.before);
    parseTemplateArtifactRevision(plan.after);
    return undefined;
  } catch {
    return 'invalid_plan';
  }
}

export function applyTemplateArtifactMutation(input: {
  readonly plan: TemplateArtifactMutationPlanDto;
  readonly transaction: TemplateArtifactTransactionPort;
}): TemplateArtifactSnapshotDto {
  const invalid = validateTemplateArtifactMutation({ plan: input.plan, read: input.transaction });
  if (invalid !== undefined) throw new TemplateArtifactPlanningError(invalid);
  return parseTemplateArtifactSnapshot(input.transaction.applyMutation(canonical(input.plan)));
}
