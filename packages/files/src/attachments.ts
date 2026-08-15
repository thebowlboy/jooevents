import {
  fileAttachInputSchema,
  fileDetachInputSchema,
  fileLinkAttachInputSchema,
  type FileAttachInput,
  type FileAttachmentChangedFactPayload,
  type FileAttachmentDto,
  type FileAttachmentSubjectDto,
  type FileDetachInput,
  type FileLinkAttachInput,
  type FileScopeDto,
  type FileUploaderPrincipalDto
} from '@jooevents/contracts/files';
import type { FileAssetWritePort } from './upload';
import {
  deepFreeze,
  parseFileAttachment,
  sameFileScope,
  type FilesFact
} from './model';

export interface FileAttachmentRepository {
  readAttachment(scope: FileScopeDto, attachmentId: string): FileAttachmentDto | undefined;
  listAttachmentsForSubject(
    scope: FileScopeDto,
    subject: FileAttachmentSubjectDto
  ): readonly FileAttachmentDto[];
  /** Live (`attached`) attachments referencing one asset — the D7 refcount source. */
  countLiveAssetReferences(scope: FileScopeDto, assetId: string): number;
  createAttachment(attachment: FileAttachmentDto): void;
  /** Replaces exactly the expected current image; must refuse on any drift. */
  transitionAttachment(input: {
    readonly expected: FileAttachmentDto;
    readonly next: FileAttachmentDto;
  }): void;
}

/**
 * Subject existence stays a port: engagement/submission/session heads belong
 * to their own aggregates. Files never guesses — an unresolvable subject is a
 * refusal.
 */
export interface FileAttachmentSubjectSource {
  subjectExists(scope: FileScopeDto, subject: FileAttachmentSubjectDto): boolean;
}

export type AttachResult =
  | {
      readonly kind: 'attached';
      readonly attachment: FileAttachmentDto;
      readonly idempotent: boolean;
      readonly facts: readonly FilesFact<FileAttachmentChangedFactPayload>[];
    }
  | {
      readonly kind: 'refused';
      readonly code:
        | 'attachment_id_collision'
        | 'subject_missing'
        | 'asset_missing'
        | 'asset_not_available'
        | 'asset_blocked';
    };

/** Attaches one confirmed, released asset to a subject. Receipts ride the facts. */
export function attachFileAsset(input: {
  readonly scope: FileScopeDto;
  readonly attach: FileAttachInput;
  readonly actor: FileUploaderPrincipalDto;
  readonly attachments: FileAttachmentRepository;
  readonly assets: Pick<FileAssetWritePort, 'readAsset'>;
  readonly subjects: FileAttachmentSubjectSource;
  readonly now: string;
}): AttachResult {
  const attach = fileAttachInputSchema.parse(input.attach);
  const existing = input.attachments.readAttachment(input.scope, attach.attachmentId);
  if (existing) {
    const identical = existing.content.kind === 'asset'
      && existing.content.assetId === attach.assetId
      && sameSubject(existing.subject, attach.subject)
      && existing.state === 'attached';
    return identical
      ? deepFreeze({ kind: 'attached', attachment: existing, idempotent: true, facts: [] })
      : deepFreeze({ kind: 'refused', code: 'attachment_id_collision' });
  }
  if (!input.subjects.subjectExists(input.scope, attach.subject)) {
    return deepFreeze({ kind: 'refused', code: 'subject_missing' });
  }
  const asset = input.assets.readAsset(input.scope, attach.assetId);
  if (!asset || !sameFileScope(asset.scope, input.scope)) {
    return deepFreeze({ kind: 'refused', code: 'asset_missing' });
  }
  if (asset.lifecycle === 'blocked') {
    return deepFreeze({ kind: 'refused', code: 'asset_blocked' });
  }
  if (asset.lifecycle !== 'available') {
    return deepFreeze({ kind: 'refused', code: 'asset_not_available' });
  }
  const attachment = parseFileAttachment({
    schemaVersion: 1,
    id: attach.attachmentId,
    scope: input.scope,
    subject: attach.subject,
    content: { kind: 'asset', assetId: attach.assetId },
    attachedBy: input.actor,
    state: 'attached',
    version: 1,
    attachedAt: input.now,
    detachedAt: null
  });
  input.attachments.createAttachment(attachment);
  return deepFreeze({
    kind: 'attached',
    attachment,
    idempotent: false,
    facts: [attachmentFact('attach', attachment)]
  });
}

export type LinkAttachResult =
  | {
      readonly kind: 'attached';
      readonly attachment: FileAttachmentDto;
      readonly idempotent: boolean;
      readonly facts: readonly FilesFact<FileAttachmentChangedFactPayload>[];
    }
  | {
      readonly kind: 'refused';
      readonly code: 'attachment_id_collision' | 'subject_missing';
    };

/**
 * D6 link-attach: a typed https link with a caller-titled label. The server
 * performs zero fetches against the URL — there is deliberately no metadata
 * enrichment path in v1, so no SSRF surface exists.
 */
export function attachFileLink(input: {
  readonly scope: FileScopeDto;
  readonly attach: FileLinkAttachInput;
  readonly actor: FileUploaderPrincipalDto;
  readonly attachments: FileAttachmentRepository;
  readonly subjects: FileAttachmentSubjectSource;
  readonly now: string;
}): LinkAttachResult {
  const attach = fileLinkAttachInputSchema.parse(input.attach);
  const existing = input.attachments.readAttachment(input.scope, attach.attachmentId);
  if (existing) {
    const identical = existing.content.kind === 'link'
      && existing.content.link.url === attach.link.url
      && existing.content.link.provider === attach.link.provider
      && existing.content.link.label === attach.link.label
      && sameSubject(existing.subject, attach.subject)
      && existing.state === 'attached';
    return identical
      ? deepFreeze({ kind: 'attached', attachment: existing, idempotent: true, facts: [] })
      : deepFreeze({ kind: 'refused', code: 'attachment_id_collision' });
  }
  if (!input.subjects.subjectExists(input.scope, attach.subject)) {
    return deepFreeze({ kind: 'refused', code: 'subject_missing' });
  }
  const attachment = parseFileAttachment({
    schemaVersion: 1,
    id: attach.attachmentId,
    scope: input.scope,
    subject: attach.subject,
    content: { kind: 'link', link: attach.link },
    attachedBy: input.actor,
    state: 'attached',
    version: 1,
    attachedAt: input.now,
    detachedAt: null
  });
  input.attachments.createAttachment(attachment);
  return deepFreeze({
    kind: 'attached',
    attachment,
    idempotent: false,
    facts: [attachmentFact('link_attach', attachment)]
  });
}

export type DetachResult =
  | {
      readonly kind: 'detached';
      readonly attachment: FileAttachmentDto;
      readonly facts: readonly FilesFact<FileAttachmentChangedFactPayload>[];
    }
  | {
      readonly kind: 'refused';
      readonly code: 'attachment_missing' | 'already_detached' | 'stale_attachment';
    };

/**
 * Detach is the compensation of attach. It never destroys bytes: the blob
 * stays refcounted and the D7 orphan sweep collects it only after the grace
 * window with zero live references.
 */
export function detachFileAttachment(input: {
  readonly scope: FileScopeDto;
  readonly detach: FileDetachInput;
  readonly attachments: FileAttachmentRepository;
  readonly now: string;
}): DetachResult {
  const detach = fileDetachInputSchema.parse(input.detach);
  const current = input.attachments.readAttachment(input.scope, detach.attachmentId);
  if (!current) return deepFreeze({ kind: 'refused', code: 'attachment_missing' });
  if (current.state === 'detached') {
    return deepFreeze({ kind: 'refused', code: 'already_detached' });
  }
  if (current.version !== detach.expectedVersion) {
    return deepFreeze({ kind: 'refused', code: 'stale_attachment' });
  }
  const next = parseFileAttachment({
    ...current,
    state: 'detached',
    version: current.version + 1,
    detachedAt: input.now
  });
  input.attachments.transitionAttachment({ expected: current, next });
  return deepFreeze({
    kind: 'detached',
    attachment: next,
    facts: [attachmentFact('detach', next)]
  });
}

export function sameSubject(
  left: FileAttachmentSubjectDto,
  right: FileAttachmentSubjectDto
): boolean {
  return subjectKey(left) === subjectKey(right);
}

export function subjectKey(subject: FileAttachmentSubjectDto): string {
  switch (subject.kind) {
    case 'engagement': return `engagement:${subject.engagementId}`;
    case 'submission': return `submission:${subject.submissionId}`;
    case 'session': return `session:${subject.sessionId}`;
    case 'resource_share': return `resource_share:${subject.resourceShareId}`;
  }
}

function attachmentFact(
  action: FileAttachmentChangedFactPayload['action'],
  attachment: FileAttachmentDto
): FilesFact<FileAttachmentChangedFactPayload> {
  return deepFreeze({
    kind: 'file_attachment_changed',
    version: 1 as const,
    payload: {
      action,
      attachmentId: attachment.id,
      subject: attachment.subject,
      assetId: attachment.content.kind === 'asset' ? attachment.content.assetId : null,
      version: attachment.version
    }
  });
}
