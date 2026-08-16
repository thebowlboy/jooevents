import type { Database } from 'bun:sqlite';
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
  type InstallationMailSenderIdentity,
  type MailSenderPresentationResolver
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
import { canonicalJsonText, type WorkspaceId } from '@jooevents/kernel';
import {
  createSQLiteMailSenderPresentationResolver,
  SQLiteWorkspaceSenderIdentityStore,
  type WorkspaceSenderIdentityHead
} from '@jooevents/persistence/workspace-sender-identity';
import type { SQLiteEffectDomainAdapter } from '@jooevents/persistence/sqlite-effect-unit-of-work';

/**
 * The workspace sender-identity composition: the read projection, the one
 * effect-domain adapter behind `capability.communication.sender-identity.update`,
 * and the per-send presentation resolver both security-mail deliveries hold.
 *
 * The update commits on the operator lane only; the actor-key column stays
 * general so a future non-user writer is recorded honestly rather than
 * borrowing some person's id.
 *
 * The from-address never appears in the write path. It is installation
 * configuration, so it enters here once as `installation` and leaves only
 * through the read projection and the resolver.
 */

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

function projectIdentity(input: {
  readonly head: WorkspaceSenderIdentityHead;
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

interface ActingPrincipal {
  readonly actorKey: string;
  readonly userId: string | null;
}

/**
 * The single sender-identity effect-domain adapter. The canonical write happens
 * synchronously inside the caller's unit-of-work transaction;
 * `applyDomainContribution` then verifies the exact prepared evidence.
 */
export class SQLiteWorkspaceSenderIdentityEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #prepared = new Map<string, unknown>();
  readonly #store: SQLiteWorkspaceSenderIdentityStore;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly installation: InstallationMailSenderIdentity;
    readonly ids: {
      newPreparationHandle(): string;
      newFactId(): string;
    };
  }) {
    for (const method of ['newPreparationHandle', 'newFactId'] as const) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('workspace_sender_identity_id_factory_invalid');
      }
    }
    this.#store = new SQLiteWorkspaceSenderIdentityStore(input.sqlite);
  }

  openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('workspace_sender_identity_transaction_required');
    }
    if (!sameReference(capability, WORKSPACE_SENDER_IDENTITY_UPDATE_HANDLER_CAPABILITY)) {
      throw new TypeError('workspace_sender_identity_capability_mismatch');
    }
    if (context.operation.name !== WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION.name
        || context.operation.version !== WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || context.scope.eventId !== undefined) {
      throw new TypeError('workspace_sender_identity_operation_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const occurredAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.lane.policy.key !== WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY.key
        || authority.lane.policy.version !== WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === WORKSPACE_SENDER_IDENTITY_PERMISSION_ID
        )) {
      throw new TypeError('workspace_sender_identity_authority_mismatch');
    }
    const principal = this.resolvePrincipal(authority.actor as { readonly kind: string });

    return sealWorkspaceSenderIdentityPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('workspace_sender_identity_context_substitution');
          }
          const request = workspaceSenderIdentityUpdateInputSchema.parse(businessInput);
          // Acceptance runs before any write: a header-injection attempt never
          // reaches the row, and the refusal names the field and the reason.
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
          const application = this.#store.apply({
            workspaceId: this.input.workspaceId,
            expectedHeadVersion: request.expectedHeadVersion,
            displayName,
            replyToAddress,
            updatedAt: occurredAt,
            updatedByActorKey: principal.actorKey,
            updatedByUserId: principal.userId
          });
          if (application.kind === 'stale') {
            return staleRefusal(application.head.headVersion);
          }
          const handle = this.input.ids.newPreparationHandle();
          const contribution = workspaceSenderIdentityContributionSchema.parse({
            result: {
              kind: 'success',
              data: projectIdentity({
                head: application.head,
                installation: this.input.installation
              })
            },
            domain: {
              kind: 'workspace_sender_identity_update',
              preparationHandle: handle,
              workspaceId: this.input.workspaceId,
              headVersion: application.head.headVersion,
              occurredAt
            },
            effectContributions: [{
              kind: 'domain_fact',
              factId: this.input.ids.newFactId(),
              factKind: 'workspace_sender_identity_changed',
              payload: {
                headVersion: application.head.headVersion,
                displayNameSet: application.head.displayName !== null,
                replyToAddressSet: application.head.replyToAddress !== null
              },
              occurredAt
            }]
          });
          if (contribution.domain === null) {
            throw new TypeError('workspace_sender_identity_evidence_missing');
          }
          this.#prepared.set(handle, contribution.domain);
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('workspace_sender_identity_transaction_required');
    }
    const parsed = workspaceSenderIdentityDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (prepared === undefined || canonicalJsonText(parsed) !== canonicalJsonText(prepared)) {
      throw new TypeError('workspace_sender_identity_preparation_invalid');
    }
    this.#prepared.delete(parsed.preparationHandle);
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared.clear();
  }

  private resolvePrincipal(actor: { readonly kind: string }): ActingPrincipal {
    if (actor.kind === 'workspace_user') {
      const userId = (actor as { readonly userId?: unknown }).userId;
      if (typeof userId !== 'string') {
        throw new TypeError('workspace_sender_identity_operator_actor_invalid');
      }
      return Object.freeze({ actorKey: `workspace_user:${userId}`, userId });
    }
    throw new TypeError('workspace_sender_identity_actor_unsupported');
  }
}

export interface WorkspaceSenderIdentityLiveComposition {
  readonly read: WorkspaceSenderIdentityReadPort;
  readonly effectDomain: {
    readonly capability: VersionedDefinitionRef;
    readonly adapter: SQLiteWorkspaceSenderIdentityEffectDomainAdapter;
  };
  /** Held by both security-mail deliveries; resolves on every send. */
  readonly senderResolver: MailSenderPresentationResolver;
}

export function createWorkspaceSenderIdentityComposition(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly installation: InstallationMailSenderIdentity;
}): WorkspaceSenderIdentityLiveComposition {
  const installation = Object.freeze({ ...input.installation });
  const store = new SQLiteWorkspaceSenderIdentityStore(input.sqlite);
  return Object.freeze({
    read: Object.freeze({
      readSenderIdentity: (workspaceId: WorkspaceId) => projectIdentity({
        head: store.read(workspaceId),
        installation
      })
    }),
    effectDomain: Object.freeze({
      capability: WORKSPACE_SENDER_IDENTITY_UPDATE_HANDLER_CAPABILITY,
      adapter: new SQLiteWorkspaceSenderIdentityEffectDomainAdapter({
        sqlite: input.sqlite,
        workspaceId: input.workspaceId,
        installation,
        ids: Object.freeze({
          newPreparationHandle: () => crypto.randomUUID(),
          newFactId: () => crypto.randomUUID()
        })
      })
    }),
    senderResolver: createSQLiteMailSenderPresentationResolver({
      sqlite: input.sqlite,
      workspaceId: input.workspaceId,
      installation
    })
  });
}
