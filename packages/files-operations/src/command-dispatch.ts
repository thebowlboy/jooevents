import type {
  FileScopeDto,
  FileUploadLimitsDto,
  FileUploaderPrincipalDto
} from '@jooevents/contracts/files';
import {
  fileAttachInputSchema,
  fileLinkAttachInputSchema,
  fileRequestFulfillInputSchema,
  fileUploadConfirmInputSchema,
  fileUploadIntentRegisterInputSchema
} from '@jooevents/contracts/files';
import type { DeadlineReferenceResolver } from '@jooevents/deadline';
import {
  attachFileAsset,
  attachFileLink,
  confirmFileUpload,
  createFileRequest,
  createResourceShare,
  detachFileAttachment,
  fulfillFileRequest,
  registerFileUploadIntent,
  revokeResourceShare,
  withdrawFileRequest,
  type FileAssetWritePort,
  type FileAttachmentRepository,
  type FileAttachmentSubjectSource,
  type FileRequestEngagementSource,
  type FileRequestRepository,
  type FileScanProvider,
  type FilesFact,
  type FileUploadIntentRepository,
  type FileUploaderUsageSource,
  type ResourceShareAudienceSource,
  type ResourceShareRepository
} from '@jooevents/files/commands';
import {
  FILES_PORTAL_COMMAND_ACTIONS,
  type FilesCommandAction,
  type FilesCommandRefusalCode
} from './command-module';

/** All synchronous canonical ports used by the reviewed Files command family. */
export type FilesCommandRepository =
  & FileUploadIntentRepository
  & FileAssetWritePort
  & FileUploaderUsageSource
  & FileAttachmentRepository
  & FileAttachmentSubjectSource
  & ResourceShareRepository
  & FileRequestRepository
  & FileRequestEngagementSource;

export interface FilesCommandActor {
  readonly principal: FileUploaderPrincipalDto;
  /** Present exactly on the operator lane. */
  readonly operatorUserId: string | undefined;
  /** Present exactly on the participant lane: freshly recheck-proved relationship. */
  readonly freshEngagementIds: readonly string[] | undefined;
}

export interface FilesCommandSuccess {
  readonly data: Record<string, unknown>;
  readonly recordId: string;
  readonly recordVersion: number;
  readonly facts: readonly FilesFact<unknown>[];
}

export type FilesCommandDispatch =
  | { readonly kind: 'success'; readonly success: FilesCommandSuccess }
  | { readonly kind: 'refused'; readonly code: FilesCommandRefusalCode };

/** Participant uploads are restricted to material that can satisfy their own asks. */
const PORTAL_UPLOAD_PURPOSES = new Set([
  'engagement_material',
  'request_fulfillment'
] as const);

function ownsIntent(actor: FilesCommandActor, uploader: FileUploaderPrincipalDto): boolean {
  if (actor.freshEngagementIds !== undefined) {
    return actor.principal.kind === 'participant'
      && uploader.kind === 'participant'
      && uploader.participantIdentityId === actor.principal.participantIdentityId;
  }
  return uploader.kind === 'operator_user';
}

function participantOwnsSubject(
  actor: FilesCommandActor,
  subject: { readonly kind: string; readonly engagementId?: string }
): boolean {
  return subject.kind === 'engagement'
    && typeof subject.engagementId === 'string'
    && (actor.freshEngagementIds ?? []).includes(subject.engagementId);
}

/**
 * Runs one Files command over synchronous, caller-owned repository ports.
 * Persistence adapters own snapshotting and atomicity; this function owns the
 * one domain dispatch shared by SQLite and D1.
 */
export function dispatchFilesCommand(input: {
  readonly action: FilesCommandAction;
  readonly businessInput: unknown;
  readonly scope: FileScopeDto;
  readonly actor: FilesCommandActor;
  readonly occurredAt: string;
  readonly repository: FilesCommandRepository;
  readonly limits: FileUploadLimitsDto;
  readonly storageProvider: string;
  readonly scanProvider: FileScanProvider;
  readonly deadlines: DeadlineReferenceResolver;
  readonly audiences: ResourceShareAudienceSource;
}): FilesCommandDispatch {
  const { repository, scope, actor, occurredAt } = input;
  const participant = actor.freshEngagementIds !== undefined;
  if (participant
      && !(FILES_PORTAL_COMMAND_ACTIONS as readonly FilesCommandAction[]).includes(input.action)) {
    throw new TypeError('files_command_action_not_portal');
  }
  const refuse = (code: FilesCommandRefusalCode): FilesCommandDispatch =>
    Object.freeze({ kind: 'refused' as const, code });
  const succeed = (success: FilesCommandSuccess): FilesCommandDispatch =>
    Object.freeze({ kind: 'success' as const, success });

  switch (input.action) {
    case 'upload.intent': {
      const registration = fileUploadIntentRegisterInputSchema.parse(input.businessInput);
      if (participant && !PORTAL_UPLOAD_PURPOSES.has(registration.purpose as never)) {
        return refuse('portal_not_related');
      }
      const result = registerFileUploadIntent({
        scope,
        uploader: actor.principal,
        registration,
        limits: input.limits,
        usage: repository,
        intents: repository,
        storageProvider: input.storageProvider,
        now: occurredAt
      });
      if (result.kind === 'refused') return refuse(result.code);
      return succeed({
        data: { action: 'upload.intent', intent: result.intent, idempotent: result.idempotent },
        recordId: result.intent.id,
        recordVersion: 1,
        facts: []
      });
    }
    case 'upload.confirm': {
      const confirmation = fileUploadConfirmInputSchema.parse(input.businessInput);
      const intent = repository.readIntent(scope, confirmation.intentId);
      if (!intent) return refuse('intent_not_stored');
      if (!ownsIntent(actor, intent.uploader)) return refuse('portal_not_related');
      const result = confirmFileUpload({
        intents: repository,
        assets: repository,
        scanProvider: input.scanProvider,
        intent,
        confirmation,
        now: occurredAt
      });
      if (result.kind === 'refused') return refuse(result.code);
      return succeed({
        data: { action: 'upload.confirm', asset: result.asset, idempotent: result.idempotent },
        recordId: result.asset.id,
        recordVersion: result.asset.version,
        facts: result.facts
      });
    }
    case 'attachment.attach': {
      const attach = fileAttachInputSchema.parse(input.businessInput);
      if (participant) {
        if (!participantOwnsSubject(actor, attach.subject)) return refuse('portal_not_related');
        const asset = repository.readAsset(scope, attach.assetId);
        if (asset && !ownsIntent(actor, asset.uploader)) return refuse('portal_not_related');
      }
      const result = attachFileAsset({
        scope,
        attach,
        actor: actor.principal,
        attachments: repository,
        assets: repository,
        subjects: repository,
        now: occurredAt
      });
      if (result.kind === 'refused') return refuse(result.code);
      return succeed({
        data: {
          action: 'attachment.attach',
          attachment: result.attachment,
          idempotent: result.idempotent
        },
        recordId: result.attachment.id,
        recordVersion: result.attachment.version,
        facts: result.facts
      });
    }
    case 'attachment.link': {
      const link = fileLinkAttachInputSchema.parse(input.businessInput);
      if (participant && !participantOwnsSubject(actor, link.subject)) {
        return refuse('portal_not_related');
      }
      const result = attachFileLink({
        scope,
        attach: input.businessInput as never,
        actor: actor.principal,
        attachments: repository,
        subjects: repository,
        now: occurredAt
      });
      if (result.kind === 'refused') return refuse(result.code);
      return succeed({
        data: {
          action: 'attachment.link',
          attachment: result.attachment,
          idempotent: result.idempotent
        },
        recordId: result.attachment.id,
        recordVersion: result.attachment.version,
        facts: result.facts
      });
    }
    case 'attachment.detach': {
      const result = detachFileAttachment({
        scope,
        detach: input.businessInput as never,
        attachments: repository,
        now: occurredAt
      });
      if (result.kind === 'refused') return refuse(result.code);
      return succeed({
        data: { action: 'attachment.detach', attachment: result.attachment },
        recordId: result.attachment.id,
        recordVersion: result.attachment.version,
        facts: result.facts
      });
    }
    case 'share.create': {
      if (actor.operatorUserId === undefined) {
        throw new TypeError('files_command_share_requires_operator');
      }
      const result = createResourceShare({
        scope,
        create: input.businessInput as never,
        createdByUserId: actor.operatorUserId,
        shares: repository,
        audiences: input.audiences,
        now: occurredAt
      });
      if (result.kind === 'refused') return refuse(result.code);
      return succeed({
        data: { action: 'share.create', share: result.share, idempotent: result.idempotent },
        recordId: result.share.id,
        recordVersion: result.share.version,
        facts: result.facts
      });
    }
    case 'share.revoke': {
      const result = revokeResourceShare({
        scope,
        revoke: input.businessInput as never,
        shares: repository,
        now: occurredAt
      });
      if (result.kind === 'refused') return refuse(result.code);
      return succeed({
        data: { action: 'share.revoke', share: result.share },
        recordId: result.share.id,
        recordVersion: result.share.version,
        facts: result.facts
      });
    }
    case 'request.create': {
      if (actor.operatorUserId === undefined) {
        throw new TypeError('files_command_request_requires_operator');
      }
      const result = createFileRequest({
        scope,
        create: input.businessInput as never,
        createdByUserId: actor.operatorUserId,
        requests: repository,
        engagements: repository,
        deadlines: input.deadlines,
        now: occurredAt
      });
      if (result.kind === 'refused') return refuse(result.code);
      return succeed({
        data: {
          action: 'request.create',
          request: result.request,
          deadline: result.deadline,
          idempotent: result.idempotent
        },
        recordId: result.request.id,
        recordVersion: result.request.version,
        facts: result.facts
      });
    }
    case 'request.withdraw': {
      const result = withdrawFileRequest({
        scope,
        withdraw: input.businessInput as never,
        requests: repository,
        now: occurredAt
      });
      if (result.kind === 'refused') return refuse(result.code);
      return succeed({
        data: { action: 'request.withdraw', request: result.request },
        recordId: result.request.id,
        recordVersion: result.request.version,
        facts: result.facts
      });
    }
    case 'request.fulfill': {
      const fulfill = fileRequestFulfillInputSchema.parse(input.businessInput);
      if (participant) {
        const request = repository.readFileRequest(scope, fulfill.requestId);
        if (request && !(actor.freshEngagementIds ?? []).includes(request.engagementId)) {
          return refuse('portal_not_related');
        }
      }
      const result = fulfillFileRequest({
        scope,
        fulfill,
        requests: repository,
        attachments: repository,
        now: occurredAt
      });
      if (result.kind === 'refused') return refuse(result.code);
      return succeed({
        data: { action: 'request.fulfill', request: result.request },
        recordId: result.request.id,
        recordVersion: result.request.version,
        facts: result.facts
      });
    }
  }
}
