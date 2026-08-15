import type { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';
import {
  fileAttachInputSchema,
  fileLinkAttachInputSchema,
  fileRequestFulfillInputSchema,
  fileUploadConfirmInputSchema,
  fileUploadIntentRegisterInputSchema,
  type FileAttachmentDto,
  type FileAttachmentViewDto,
  type FilePurpose,
  type FileScopeDto,
  type FileUploadLimitsDto,
  type FileUploaderPrincipalDto
} from '@jooevents/contracts/files';
import type { DeadlineReferenceResolver } from '@jooevents/deadline';
import {
  attachFileAsset,
  attachFileLink,
  confirmFileUpload,
  createFileRequest,
  createFilesystemFileBlobStore,
  createResourceShare,
  detachFileAttachment,
  fulfillFileRequest,
  NONE_SCAN_PROVIDER,
  parseFileUploadLimits,
  registerFileUploadIntent,
  revokeResourceShare,
  sweepExpiredUploadIntents,
  sweepOrphanFileBlobs,
  withdrawFileRequest,
  type FileBlobStreamingStore,
  type FileOrphanSweepPort,
  type ExpiredIntentSweepPort,
  type ExpiredIntentSweepReport,
  type FileScanProvider,
  type FileUploadIntentRepository,
  type FilesFact,
  type OrphanSweepReport,
  type ResourceShareAudienceSource
} from '@jooevents/files';
import {
  FILES_COMMAND_ACTIONS,
  FILES_COMMAND_HANDLER_CAPABILITY,
  FILES_PORTAL_COMMAND_ACTIONS,
  filesCommandContributionSchema,
  filesCommandDomainContributionSchema,
  sealFilesCommandPreparation,
  type FilesCommandAction,
  type FilesCommandPreparedContribution,
  type FilesOrganizerReadPort,
  type FilesPortalReadPort
} from '@jooevents/files-operations';
import { canonicalJsonText, type WorkspaceId } from '@jooevents/kernel';
import { SQLiteDeadlineRepository } from '@jooevents/persistence/deadline';
import { SQLiteFilesRepository } from '@jooevents/persistence/files';
import type { SQLiteEffectDomainAdapter } from '@jooevents/persistence/sqlite-effect-unit-of-work';
import type { SQLiteEventSpineRepository } from '@jooevents/persistence/event-spine';

/**
 * Files v1 runtime composition for the ephemeral live server: D4 limits from
 * env-shaped configuration, the filesystem blob driver behind the D1 streaming
 * seam, the D5 `none` scan provider (release immediately; serving stays inert
 * regardless), the SQLite files repository, both read projections, the one
 * files-command effect-domain adapter, and the D7 orphan sweep as a callable
 * seam — deliberately not a timer.
 */

type FilesCommandRefusalCode =
  | 'content_type_refused' | 'video_refused_use_link' | 'file_too_large'
  | 'event_quota_exceeded' | 'display_filename_invalid' | 'intent_id_collision'
  | 'intent_not_pending' | 'intent_expired' | 'byte_cap_exceeded' | 'empty_stream'
  | 'image_reencoder_unavailable' | 'image_decode_failed' | 'image_reencode_invalid'
  | 'intent_not_stored' | 'hash_mismatch' | 'asset_id_collision'
  | 'attachment_id_collision' | 'subject_missing' | 'asset_missing'
  | 'asset_not_available' | 'asset_blocked' | 'attachment_missing'
  | 'already_detached' | 'stale_attachment' | 'share_id_collision' | 'track_missing'
  | 'engagement_missing' | 'stale_share' | 'already_revoked' | 'share_missing'
  | 'request_id_collision' | 'engagement_cancelled' | 'deadline_unavailable'
  | 'request_missing' | 'request_not_open' | 'stale_request' | 'attachment_detached'
  | 'attachment_subject_mismatch' | 'portal_not_related';

interface FilesCommandSuccess {
  readonly data: Record<string, unknown>;
  readonly recordId: string;
  readonly recordVersion: number;
  readonly facts: readonly FilesFact<unknown>[];
}

type FilesCommandDispatch =
  | { readonly kind: 'success'; readonly success: FilesCommandSuccess }
  | { readonly kind: 'refused'; readonly code: FilesCommandRefusalCode };

/** The participant lane may register bytes only for its own material asks. */
const PORTAL_UPLOAD_PURPOSES: ReadonlySet<FilePurpose> = new Set([
  'engagement_material',
  'request_fulfillment'
]);

const FILES_COMMAND_OPERATION_NAMES: ReadonlySet<string> = new Set(
  FILES_COMMAND_ACTIONS.map((action) => `file.${action}`)
);

const contributionSchemasByAction = new Map(
  FILES_COMMAND_ACTIONS.map((action) => [action, filesCommandContributionSchema(action)] as const)
);

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

function engagementIdsFromGrants(grants: readonly unknown[]): readonly string[] {
  const ids: string[] = [];
  for (const grant of grants) {
    if (grant !== null && typeof grant === 'object'
        && (grant as { readonly kind?: unknown }).kind === 'participant_relationship'
        && typeof (grant as { readonly key?: unknown }).key === 'string') {
      const key = (grant as { readonly key: string }).key;
      if (key.startsWith('engagement:')) ids.push(key.slice('engagement:'.length));
    }
  }
  return Object.freeze(ids);
}

interface FilesCommandActor {
  readonly principal: FileUploaderPrincipalDto;
  /** Present exactly on the operator lane. */
  readonly operatorUserId: string | undefined;
  /** Present exactly on the participant lane: freshly recheck-proved relationship. */
  readonly freshEngagementIds: readonly string[] | undefined;
}

/**
 * The single files-command effect-domain adapter (capability
 * `capability.file.command@1`), shared by the operator and participant lanes.
 * All canonical writes happen synchronously inside the caller's unit-of-work
 * transaction through the `@jooevents/files` domain functions over the SQLite
 * repository; `applyDomainContribution` verifies the exact prepared evidence.
 * Participant-lane record-level scoping (own intents, own assets, own
 * engagements' requests, portal-permitted purposes) is enforced here against
 * the in-transaction authority recheck, never against build-time state alone.
 */
export class SQLiteFilesCommandEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #prepared = new Map<string, unknown>();
  readonly #issuedIds = new Set<string>();

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly repository: SQLiteFilesRepository;
    readonly limits: FileUploadLimitsDto;
    readonly storageProvider: string;
    readonly scanProvider: FileScanProvider;
    readonly deadlines: DeadlineReferenceResolver;
    readonly audiences: ResourceShareAudienceSource;
    readonly ids: {
      newPreparationHandle(): string;
      newFactId(): string;
    };
  }) {
    for (const method of ['newPreparationHandle', 'newFactId'] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('files_command_id_factory_invalid');
      }
    }
  }

  openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('files_command_transaction_required');
    }
    if (!sameReference(capability, FILES_COMMAND_HANDLER_CAPABILITY)) {
      throw new TypeError('files_command_capability_mismatch');
    }
    if (context.operation.effect !== 'commit'
        || !FILES_COMMAND_OPERATION_NAMES.has(context.operation.name)
        || (context.surface !== 'operator_http' && context.surface !== 'participant_http')) {
      throw new TypeError('files_command_operation_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const occurredAt: string = resolveEffectInvocationCurrentAuthorityRecheckTime(
      context, authorityRecheck
    );
    const actor = this.resolveActor(context.surface, authority);
    const preparation = Object.freeze({
      prepare: ({ action, businessInput, context: receivedContext, portalRelationship }: {
        readonly action: FilesCommandAction;
        readonly businessInput: unknown;
        readonly context: EffectInvocationContext;
        readonly portalRelationship: { readonly engagementIds: readonly string[] } | null;
      }): FilesCommandPreparedContribution => {
        if (receivedContext !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('files_command_context_substitution');
        }
        if (context.operation.name !== `file.${action}`) {
          throw new TypeError('files_command_action_mismatch');
        }
        const participantLane = context.surface === 'participant_http';
        if (participantLane !== (portalRelationship !== null)
            || participantLane !== (actor.freshEngagementIds !== undefined)) {
          throw new TypeError('files_command_lane_relationship_mismatch');
        }
        if (participantLane
            && !(FILES_PORTAL_COMMAND_ACTIONS as readonly FilesCommandAction[]).includes(action)) {
          throw new TypeError('files_command_action_not_portal');
        }
        if (context.scope.workspaceId !== this.input.workspaceId) {
          throw new TypeError('files_command_workspace_mismatch');
        }
        const eventId = context.scope.eventId;
        if (eventId === undefined) {
          return Object.freeze({
            result: Object.freeze({
              kind: 'outcome' as const,
              outcome: Object.freeze({
                class: 'conflict' as const,
                kind: 'file.event_required',
                retryable: false,
                subjects: [],
                detail: null,
                detailSchemaVersion: 1
              })
            }),
            domain: null,
            receiptChildren: Object.freeze([])
          });
        }
        const scope: FileScopeDto = { workspaceId: context.scope.workspaceId, eventId };
        const dispatched = this.dispatch({ action, businessInput, scope, actor, occurredAt });
        if (dispatched.kind === 'refused') {
          return Object.freeze({
            result: Object.freeze({
              kind: 'outcome' as const,
              outcome: Object.freeze({
                class: 'policy_violation' as const,
                kind: 'file.command_refused',
                retryable: false,
                subjects: [],
                detail: Object.freeze({ action, code: dispatched.code }),
                detailSchemaVersion: 1
              })
            }),
            domain: null,
            receiptChildren: Object.freeze([])
          });
        }
        const handle = this.nextId('newPreparationHandle');
        const contribution = {
          result: { kind: 'success' as const, data: dispatched.success.data },
          domain: {
            kind: 'files_command' as const,
            preparationHandle: handle,
            action,
            workspaceId: scope.workspaceId,
            eventId: scope.eventId,
            recordId: dispatched.success.recordId,
            recordVersion: dispatched.success.recordVersion,
            occurredAt
          },
          receiptChildren: dispatched.success.facts.map((fact) => ({
            kind: 'domain_fact' as const,
            factId: this.nextId('newFactId'),
            factKind: fact.kind,
            payload: fact.payload,
            occurredAt
          }))
        };
        const schema = contributionSchemasByAction.get(action);
        if (!schema) throw new TypeError('files_command_action_unknown');
        const parsed = schema.parse(contribution);
        if (parsed.domain === null) throw new TypeError('files_command_evidence_missing');
        this.#prepared.set(handle, parsed.domain);
        return parsed;
      }
    });
    return sealFilesCommandPreparation({
      capability: FILES_COMMAND_HANDLER_CAPABILITY,
      context,
      preparation
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('files_command_transaction_required');
    }
    const parsed = filesCommandDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (prepared === undefined
        || canonicalJsonText(parsed) !== canonicalJsonText(prepared)) {
      throw new TypeError('files_command_preparation_invalid');
    }
    this.#prepared.delete(parsed.preparationHandle);
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared.clear();
  }

  private resolveActor(
    surface: 'operator_http' | 'participant_http',
    authority: {
      readonly actor: { readonly kind: string };
      readonly grants: readonly unknown[];
    }
  ): FilesCommandActor {
    if (surface === 'operator_http') {
      const actor = authority.actor as { readonly kind: string; readonly userId?: unknown };
      if (actor.kind !== 'workspace_user' || typeof actor.userId !== 'string') {
        throw new TypeError('files_command_operator_actor_invalid');
      }
      return Object.freeze({
        principal: Object.freeze({ kind: 'operator_user' as const, userId: actor.userId }),
        operatorUserId: actor.userId,
        freshEngagementIds: undefined
      });
    }
    const actor = authority.actor as {
      readonly kind: string;
      readonly participantIdentityId?: unknown;
    };
    if (actor.kind !== 'participant' || typeof actor.participantIdentityId !== 'string') {
      throw new TypeError('files_command_participant_actor_invalid');
    }
    return Object.freeze({
      principal: Object.freeze({
        kind: 'participant' as const,
        participantIdentityId: actor.participantIdentityId
      }),
      operatorUserId: undefined,
      freshEngagementIds: engagementIdsFromGrants(authority.grants)
    });
  }

  private dispatch(input: {
    readonly action: FilesCommandAction;
    readonly businessInput: unknown;
    readonly scope: FileScopeDto;
    readonly actor: FilesCommandActor;
    readonly occurredAt: string;
  }): FilesCommandDispatch {
    const { repository } = this.input;
    const { scope, actor, occurredAt } = input;
    const participant = actor.freshEngagementIds !== undefined;
    const refuse = (code: FilesCommandRefusalCode): FilesCommandDispatch =>
      Object.freeze({ kind: 'refused' as const, code });
    const succeed = (success: FilesCommandSuccess): FilesCommandDispatch =>
      Object.freeze({ kind: 'success' as const, success });
    switch (input.action) {
      case 'upload.intent': {
        const registration = fileUploadIntentRegisterInputSchema.parse(input.businessInput);
        if (participant && !PORTAL_UPLOAD_PURPOSES.has(registration.purpose)) {
          return refuse('portal_not_related');
        }
        const result = registerFileUploadIntent({
          scope,
          uploader: actor.principal,
          registration,
          limits: this.input.limits,
          usage: repository,
          intents: repository,
          storageProvider: this.input.storageProvider,
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
        if (!this.ownsIntent(actor, intent.uploader)) return refuse('portal_not_related');
        const result = confirmFileUpload({
          intents: repository,
          assets: repository,
          scanProvider: this.input.scanProvider,
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
          // The module guard scoped the subject at authorization time; the
          // recheck-proved relationship re-scopes it here so a grant that
          // changed between authorization and this transaction cannot be
          // ridden (and a participant may only attach material they
          // uploaded).
          if (!this.participantOwnsSubject(actor, attach.subject)) {
            return refuse('portal_not_related');
          }
          const asset = repository.readAsset(scope, attach.assetId);
          if (asset && !this.ownsIntent(actor, asset.uploader)) {
            return refuse('portal_not_related');
          }
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
        if (participant && !this.participantOwnsSubject(actor, link.subject)) {
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
          audiences: this.input.audiences,
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
          deadlines: this.input.deadlines,
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

  /**
   * Participant subject scope, proved against the in-transaction recheck's
   * grants — the only subject a portal actor may attach to is an engagement
   * the recheck still relates them to.
   */
  private participantOwnsSubject(
    actor: FilesCommandActor,
    subject: { readonly kind: string; readonly engagementId?: string }
  ): boolean {
    return subject.kind === 'engagement'
      && typeof subject.engagementId === 'string'
      && (actor.freshEngagementIds ?? []).includes(subject.engagementId);
  }

  private ownsIntent(actor: FilesCommandActor, uploader: FileUploaderPrincipalDto): boolean {
    if (actor.freshEngagementIds !== undefined) {
      return actor.principal.kind === 'participant'
        && uploader.kind === 'participant'
        && uploader.participantIdentityId === actor.principal.participantIdentityId;
    }
    // Operator lane: operator material only. Cross-user confirm/attach stays
    // permitted inside the event.manage-gated team; participant material is not.
    return uploader.kind === 'operator_user';
  }

  private nextId(method: 'newPreparationHandle' | 'newFactId'): string {
    const value = this.input.ids[method]();
    if (typeof value !== 'string' || value.length === 0 || this.#issuedIds.has(value)) {
      throw new TypeError('files_command_ids_not_unique');
    }
    this.#issuedIds.add(value);
    return value;
  }
}

export interface FilesLiveComposition {
  readonly limits: FileUploadLimitsDto;
  readonly blobs: FileBlobStreamingStore;
  readonly repository: SQLiteFilesRepository;
  readonly scanProvider: FileScanProvider;
  readonly deadlines: DeadlineReferenceResolver;
  readonly organizerRead: FilesOrganizerReadPort;
  readonly portalRead: FilesPortalReadPort;
  readonly effectDomain: {
    readonly capability: VersionedDefinitionRef;
    readonly adapter: SQLiteEffectDomainAdapter;
  };
  /**
   * Intent repository whose writes open their own IMMEDIATE transaction, for
   * the streaming byte transport that must run OUTSIDE the shared unit of
   * work (blob I/O never holds a database transaction open).
   */
  readonly transactionalIntents: FileUploadIntentRepository;
  /** The D7 orphan sweep as a callable seam; record deletion is transactional. */
  sweepOrphanBlobs(options?: {
    readonly now?: string;
    readonly graceMs?: number;
    readonly limit?: number;
  }): Promise<OrphanSweepReport>;
  /** Reclaims expired never-confirmed intents (records + stranded blobs). */
  sweepExpiredIntents(options?: {
    readonly now?: string;
    readonly limit?: number;
  }): Promise<ExpiredIntentSweepReport>;
}

export function createFilesLiveComposition(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly blobRootDirectory: string;
  readonly events: Pick<SQLiteEventSpineRepository, 'readEventHead'>;
  trackExists(scope: FileScopeDto, trackId: string): boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): FilesLiveComposition {
  const limits = parseFileUploadLimits(input.env);
  mkdirSync(input.blobRootDirectory, { recursive: true, mode: 0o700 });
  const blobs = createFilesystemFileBlobStore({ rootDirectory: input.blobRootDirectory });
  const repository = new SQLiteFilesRepository(input.sqlite);
  const scanProvider = NONE_SCAN_PROVIDER;
  const deadlines = new SQLiteDeadlineRepository(input.sqlite, input.events);
  const audiences: ResourceShareAudienceSource = Object.freeze({
    trackExists: (scope: FileScopeDto, trackId: string) => input.trackExists(scope, trackId),
    engagementExists: (scope: FileScopeDto, engagementId: string) =>
      repository.subjectExists(scope, { kind: 'engagement', engagementId })
  });
  const adapter = new SQLiteFilesCommandEffectDomainAdapter({
    sqlite: input.sqlite,
    workspaceId: input.workspaceId,
    repository,
    limits,
    storageProvider: blobs.provider,
    scanProvider,
    deadlines,
    audiences,
    ids: Object.freeze({
      newPreparationHandle: () => crypto.randomUUID(),
      newFactId: () => crypto.randomUUID()
    })
  });

  const scopeRootExists = (scope: FileScopeDto): boolean =>
    (input.sqlite.query<{ readonly count: number }, [string, string]>(`
      SELECT count(*) AS count FROM event_spine_scope_roots
       WHERE workspace_id = ? AND event_id = ?
    `).get(scope.workspaceId, scope.eventId)?.count ?? 0) === 1;

  const attachmentView = (
    scope: FileScopeDto,
    attachment: FileAttachmentDto
  ): FileAttachmentViewDto => Object.freeze({
    attachment,
    asset: attachment.content.kind === 'asset'
      ? repository.readAsset(scope, attachment.content.assetId) ?? null
      : null
  });

  const organizerRead: FilesOrganizerReadPort = Object.freeze({
    readOrganizerFileOverview(scope: FileScopeDto) {
      if (!scopeRootExists(scope)) return undefined;
      return Object.freeze({
        schemaVersion: 1 as const,
        scope,
        attachments: repository.listAttachmentsForEvent(scope)
          .map((attachment) => attachmentView(scope, attachment)),
        shares: [...repository.listResourceShares(scope)],
        requests: [...repository.listFileRequestsForEvent(scope)]
      });
    }
  });

  const portalRead: FilesPortalReadPort = Object.freeze({
    readPortalEngagementFiles(scope: FileScopeDto, engagementId: string) {
      if (!repository.subjectExists(scope, { kind: 'engagement', engagementId })) {
        return undefined;
      }
      return Object.freeze({
        schemaVersion: 1 as const,
        engagementId,
        // The portal serves live material only; detach history is an
        // organizer/audit concern, never a participant surface.
        attachments: repository
          .listAttachmentsForSubject(scope, { kind: 'engagement', engagementId })
          .filter((attachment) => attachment.state === 'attached')
          .map((attachment) => attachmentView(scope, attachment)),
        requests: [...repository.listFileRequestsForEngagement(scope, engagementId)]
      });
    }
  });

  const inImmediateTransaction = <Value>(work: () => Value): Value => {
    if (input.sqlite.inTransaction) {
      throw new TypeError('files_transaction_already_open');
    }
    let began = false;
    try {
      input.sqlite.exec('BEGIN IMMEDIATE;');
      began = true;
      const value = work();
      input.sqlite.exec('COMMIT;');
      return value;
    } catch (error) {
      if (began && input.sqlite.inTransaction) input.sqlite.exec('ROLLBACK;');
      throw error;
    }
  };

  const transactionalIntents: FileUploadIntentRepository = Object.freeze({
    readIntent: (scope: FileScopeDto, intentId: string) =>
      repository.readIntent(scope, intentId),
    createIntent: (intent: Parameters<SQLiteFilesRepository['createIntent']>[0]) => {
      inImmediateTransaction(() => repository.createIntent(intent));
    },
    transitionIntent: (change: Parameters<SQLiteFilesRepository['transitionIntent']>[0]) => {
      inImmediateTransaction(() => repository.transitionIntent(change));
    }
  });

  const expiredIntentPort: ExpiredIntentSweepPort = Object.freeze({
    listExpiredOpenIntents: (query: Parameters<ExpiredIntentSweepPort['listExpiredOpenIntents']>[0]) =>
      repository.listExpiredOpenIntents(query),
    transitionIntent: (change: Parameters<ExpiredIntentSweepPort['transitionIntent']>[0]) => {
      inImmediateTransaction(() => repository.transitionIntent(change));
    }
  });

  const sweepPort: FileOrphanSweepPort = Object.freeze({
    listCollectableAssets: (query: Parameters<FileOrphanSweepPort['listCollectableAssets']>[0]) =>
      repository.listCollectableAssets(query),
    deleteAssetRecord: (query: Parameters<FileOrphanSweepPort['deleteAssetRecord']>[0]) =>
      inImmediateTransaction(() => repository.deleteAssetRecord(query))
  });

  return Object.freeze({
    limits,
    blobs,
    repository,
    scanProvider,
    deadlines,
    organizerRead,
    portalRead,
    effectDomain: Object.freeze({ capability: FILES_COMMAND_HANDLER_CAPABILITY, adapter }),
    transactionalIntents,
    sweepOrphanBlobs: (options?: {
      readonly now?: string;
      readonly graceMs?: number;
      readonly limit?: number;
    }) => sweepOrphanFileBlobs({
      port: sweepPort,
      blobs,
      now: options?.now ?? new Date().toISOString(),
      ...(options?.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {})
    }),
    sweepExpiredIntents: (options?: {
      readonly now?: string;
      readonly limit?: number;
    }) => sweepExpiredUploadIntents({
      port: expiredIntentPort,
      blobs,
      now: options?.now ?? new Date().toISOString(),
      ...(options?.limit !== undefined ? { limit: options.limit } : {})
    })
  });
}
