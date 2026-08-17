import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  acceptSenderDisplayName,
  acceptSenderReplyToAddress,
  resolveMailSenderPresentation,
  type InstallationMailSenderIdentity
} from '@jooevents/communications';
import {
  WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY,
  WORKSPACE_SENDER_IDENTITY_PERMISSION_ID,
  WORKSPACE_SENDER_IDENTITY_UPDATE_HANDLER_CAPABILITY,
  WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION,
  sealWorkspaceSenderIdentityPreparation,
  workspaceSenderIdentityContributionSchema,
  workspaceSenderIdentityDomainContributionSchema,
  type WorkspaceSenderIdentityPreparedContribution,
  type WorkspaceSenderIdentityReadPort
} from '@jooevents/communication-operations';
import {
  workspaceSenderIdentitySchema,
  workspaceSenderIdentityUpdateInputSchema,
  type VersionedDefinitionRef,
  type WorkspaceSenderIdentityDto,
  type WorkspaceSenderIdentityRefusalCode
} from '@jooevents/contracts';
import {
  canonicalJsonText,
  parseInstant,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';

const INITIAL_HEAD_VERSION = 1;

interface HeadRow {
  readonly head_version: number;
  readonly display_name: string | null;
  readonly reply_to_address: string | null;
  readonly updated_at: string;
}

interface SenderHead {
  readonly workspaceId: string;
  readonly headVersion: number;
  readonly displayName: string | null;
  readonly replyToAddress: string | null;
  readonly updatedAt: string | null;
}

function unedited(workspaceId: WorkspaceId): SenderHead {
  return Object.freeze({
    workspaceId,
    headVersion: INITIAL_HEAD_VERSION,
    displayName: null,
    replyToAddress: null,
    updatedAt: null
  });
}

async function readHead(
  source: Pick<D1Database, 'prepare'> | Pick<D1DatabaseSession, 'prepare'>,
  workspaceId: WorkspaceId
): Promise<SenderHead> {
  const row = await source.prepare(`SELECT head_version,display_name,reply_to_address,updated_at
    FROM workspace_mail_sender_identity WHERE workspace_id = ?`
  ).bind(workspaceId).first<HeadRow>();
  return row ? Object.freeze({
    workspaceId,
    headVersion: row.head_version,
    displayName: row.display_name,
    replyToAddress: row.reply_to_address,
    updatedAt: parseInstant(row.updated_at)
  }) : unedited(workspaceId);
}

function projectIdentity(input: {
  readonly head: SenderHead;
  readonly installation: InstallationMailSenderIdentity;
}): WorkspaceSenderIdentityDto {
  const effective = resolveMailSenderPresentation({
    installation: input.installation,
    workspace: Object.freeze({
      displayName: input.head.displayName,
      replyToAddress: input.head.replyToAddress
    })
  });
  return workspaceSenderIdentitySchema.parse({
    schemaVersion: 1,
    workspaceId: input.head.workspaceId,
    headVersion: input.head.headVersion,
    displayName: input.head.displayName,
    replyToAddress: input.head.replyToAddress,
    effective: {
      fromAddress: effective.fromAddress,
      fromDisplayName: effective.fromDisplayName ?? null,
      replyToAddress: effective.replyToAddress ?? null,
      source: effective.source
    },
    updatedAt: input.head.updatedAt
  });
}

function refusal(
  field: 'display_name' | 'reply_to_address',
  code: WorkspaceSenderIdentityRefusalCode
): WorkspaceSenderIdentityPreparedContribution {
  return Object.freeze({
    result: Object.freeze({
      kind: 'outcome' as const,
      outcome: Object.freeze({
        class: 'policy_violation' as const,
        kind: 'communication.sender_identity_refused',
        retryable: false,
        subjects: [],
        detail: Object.freeze({ field, code }),
        detailSchemaVersion: 1
      })
    }),
    domain: null,
    effectContributions: Object.freeze([])
  });
}

function staleRefusal(headVersion: number): WorkspaceSenderIdentityPreparedContribution {
  return Object.freeze({
    result: Object.freeze({
      kind: 'outcome' as const,
      outcome: Object.freeze({
        class: 'stale_revision' as const,
        kind: 'communication.sender_identity_changed',
        retryable: false,
        subjects: [],
        detail: Object.freeze({ code: 'head_version_changed' as const, headVersion }),
        detailSchemaVersion: 1
      })
    }),
    domain: null,
    effectContributions: Object.freeze([])
  });
}

interface PreparedUpdate {
  readonly contribution: Exclude<WorkspaceSenderIdentityPreparedContribution['domain'], null>;
  phase: 'prepared' | 'applied';
}

class D1WorkspaceSenderIdentityEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  #prepared: PreparedUpdate | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly installation: InstallationMailSenderIdentity;
    readonly ids: { newPreparationHandle(): string; newFactId(): string };
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    if (capability.key !== WORKSPACE_SENDER_IDENTITY_UPDATE_HANDLER_CAPABILITY.key
        || capability.version !== WORKSPACE_SENDER_IDENTITY_UPDATE_HANDLER_CAPABILITY.version) {
      throw new TypeError('d1_workspace_sender_identity_capability_mismatch');
    }
    if (context.operation.name !== WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION.name
        || context.operation.version !== WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || context.scope.eventId !== undefined) {
      throw new TypeError('d1_workspace_sender_identity_operation_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const occurredAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.policy.key !== WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY.key
        || authority.lane.policy.version !== WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === WORKSPACE_SENDER_IDENTITY_PERMISSION_ID)) {
      throw new TypeError('d1_workspace_sender_identity_authority_mismatch');
    }
    const userId = authority.actor.userId;
    const current = await readHead(this.input.unitOfWork.readSession, this.#workspaceId);
    if (current.updatedAt === null) {
      this.input.unitOfWork.assertCurrent(
        'NOT EXISTS (SELECT 1 FROM workspace_mail_sender_identity WHERE workspace_id = ?)',
        [this.#workspaceId]
      );
    } else {
      this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM workspace_mail_sender_identity
        WHERE workspace_id = ? AND head_version = ? AND display_name IS ?
          AND reply_to_address IS ? AND updated_at = ?)`, [
        this.#workspaceId,
        current.headVersion,
        current.displayName,
        current.replyToAddress,
        current.updatedAt
      ]);
    }
    return sealWorkspaceSenderIdentityPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context) {
            throw new TypeError('d1_workspace_sender_identity_context_substitution');
          }
          const request = workspaceSenderIdentityUpdateInputSchema.parse(businessInput);
          let displayName: string | null = null;
          if (request.displayName !== null) {
            const accepted = acceptSenderDisplayName(request.displayName);
            if (accepted.kind === 'refused') return refusal('display_name', accepted.code);
            displayName = accepted.value;
          }
          let replyToAddress: string | null = null;
          if (request.replyToAddress !== null) {
            const accepted = acceptSenderReplyToAddress(request.replyToAddress);
            if (accepted.kind === 'refused') return refusal('reply_to_address', accepted.code);
            replyToAddress = accepted.value;
          }
          if (request.expectedHeadVersion !== current.headVersion) {
            return staleRefusal(current.headVersion);
          }
          const next: SenderHead = Object.freeze({
            workspaceId: this.#workspaceId,
            headVersion: current.headVersion + 1,
            displayName,
            replyToAddress,
            updatedAt: parseInstant(occurredAt)
          });
          if (current.updatedAt === null) {
            this.input.unitOfWork.write(`INSERT INTO workspace_mail_sender_identity (
              workspace_id,head_version,display_name,reply_to_address,updated_at,
              updated_by_actor_key,updated_by_user_id
            ) VALUES (?,?,?,?,?,?,?)`, [
              this.#workspaceId,
              next.headVersion,
              next.displayName,
              next.replyToAddress,
              next.updatedAt,
              `workspace_user:${userId}`,
              userId
            ]);
          } else {
            this.input.unitOfWork.write(`UPDATE workspace_mail_sender_identity
              SET head_version = ?,display_name = ?,reply_to_address = ?,updated_at = ?,
                  updated_by_actor_key = ?,updated_by_user_id = ?
              WHERE workspace_id = ? AND head_version = ?`, [
              next.headVersion,
              next.displayName,
              next.replyToAddress,
              next.updatedAt,
              `workspace_user:${userId}`,
              userId,
              this.#workspaceId,
              current.headVersion
            ]);
          }
          const contribution = workspaceSenderIdentityContributionSchema.parse({
            result: {
              kind: 'success',
              data: projectIdentity({ head: next, installation: this.input.installation })
            },
            domain: {
              kind: 'workspace_sender_identity_update',
              preparationHandle: this.input.ids.newPreparationHandle(),
              workspaceId: this.#workspaceId,
              headVersion: next.headVersion,
              occurredAt
            },
            effectContributions: [{
              kind: 'domain_fact',
              factId: this.input.ids.newFactId(),
              factKind: 'workspace_sender_identity_changed',
              payload: {
                headVersion: next.headVersion,
                displayNameSet: next.displayName !== null,
                replyToAddressSet: next.replyToAddress !== null
              },
              occurredAt
            }]
          });
          if (contribution.domain === null) {
            throw new TypeError('d1_workspace_sender_identity_evidence_missing');
          }
          this.#prepared = { contribution: contribution.domain, phase: 'prepared' };
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    const parsed = workspaceSenderIdentityDomainContributionSchema.parse(contribution);
    if (!this.#prepared || this.#prepared.phase !== 'prepared'
        || canonicalJsonText(parsed) !== canonicalJsonText(this.#prepared.contribution)) {
      throw new TypeError('d1_workspace_sender_identity_preparation_invalid');
    }
    this.#prepared.phase = 'applied';
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared = undefined;
  }
}

export function createD1WorkspaceSenderIdentityReadPort(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
  readonly installation: InstallationMailSenderIdentity;
}): WorkspaceSenderIdentityReadPort {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const installation = Object.freeze({ ...input.installation });
  // Validate installation-owned header values at composition time.
  resolveMailSenderPresentation({
    installation,
    workspace: Object.freeze({ displayName: null, replyToAddress: null })
  });
  return Object.freeze({
    async readSenderIdentity(requestedWorkspaceId: WorkspaceId) {
      if (parseWorkspaceId(requestedWorkspaceId) !== workspaceId) {
        throw new TypeError('d1_workspace_sender_identity_read_workspace_mismatch');
      }
      return projectIdentity({
        head: await readHead(input.database.withSession('first-primary'), workspaceId),
        installation
      });
    }
  });
}

export function createD1WorkspaceSenderIdentityEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly installation: InstallationMailSenderIdentity;
}): D1EffectDomainAdapterRegistration {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const installation = Object.freeze({ ...input.installation });
  return Object.freeze({
    capability: WORKSPACE_SENDER_IDENTITY_UPDATE_HANDLER_CAPABILITY,
    create: (unitOfWork: D1BufferedUnitOfWork) =>
      new D1WorkspaceSenderIdentityEffectDomainAdapter({
        unitOfWork,
        workspaceId,
        installation,
        ids: Object.freeze({
          newPreparationHandle: () => crypto.randomUUID(),
          newFactId: () => crypto.randomUUID()
        })
      })
  });
}
