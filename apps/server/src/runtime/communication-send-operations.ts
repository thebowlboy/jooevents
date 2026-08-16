import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult,
  type TerminalEffectReceipt
} from '@jooevents/application';
import type {
  SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  COMMUNICATION_SEND_LANE_HANDLER_CAPABILITY_BY_OPERATION,
  communicationSendLaneContributionSchema,
  communicationSendLaneDomainContributionSchema,
  sealCommunicationSendLanePreparation,
  type CommunicationPreviewAdoptionPreparer,
  type CommunicationSendLaneOperationName,
  type CommunicationSendLanePreparedContribution
} from '@jooevents/communication-operations';
import {
  organizerPrepareMessagePreviewResultSchema,
  organizerPreviewMessageBatchInputSchema,
  organizerPreviewMessageBatchResultSchema,
  organizerSendMessagesInputSchema,
  organizerSendMessagesResultSchema,
  structuredOutcomeSchema,
  type StructuredOutcome
} from '@jooevents/contracts';
import {
  canonicalJsonText,
  parseEventId,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  SQLiteOrganizerAudiencePreviewError,
  type SQLiteOrganizerAudiencePreviewRepository,
  type SQLiteOrganizerPreparedPreview
} from '@jooevents/persistence/organizer-audience-preview';
import type {
  SQLiteCommunicationMessageReleaseStore
} from '@jooevents/persistence/message-releases';
import {
  CommunicationReleasePlanningError,
  commitSendMessagesRelease
} from '@jooevents/persistence/message-release-effect-domain';
import type {
  SQLiteEffectDomainAdapterRegistration
} from '@jooevents/persistence/sqlite-effect-unit-of-work';
import {
  buildDecisionSendAuthorInput,
  materializeDecisionSendBatch,
  openAdoptedDecisionSnapshot,
  type CommunicationDeliveryRoute
} from './communication-send-lane';

/**
 * Runtime seam for the operator send lane (`prepare_message_batch_preview`,
 * `preview_message_batch`, `send_messages`).
 *
 * The module in `@jooevents/communication-operations` compiles the operations;
 * this file supplies what only the composed runtime owns: the adoption
 * preparer behind the compute-only prepare read (asynchronous audience
 * resolution and per-recipient render, no writes, parked per draft revision)
 * and the two Foundation effect-domain adapters whose sealed synchronous
 * steps run inside the one unit-of-work transaction — adopting the parked
 * preparation, or committing the owner-native release and delivery records.
 *
 * Refusal discipline: the send step runs under a savepoint; a typed refusal
 * rolls back to the savepoint and surfaces as the operation's declared outcome
 * while the hosting unit of work commits nothing but its own audit evidence.
 */

const SEND_SAVEPOINT = 'communication_send_operation';

type Scope = { readonly workspaceId: WorkspaceId; readonly eventId: EventId };

interface ParkedAdoption {
  readonly scope: Scope;
  readonly ownerKey: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly preparation: SQLiteOrganizerPreparedPreview;
}

function outcome(input: {
  readonly class: StructuredOutcome['class'];
  readonly kind: string;
  readonly retryable: boolean;
  readonly subjects?: readonly { readonly type: string; readonly id: string }[];
  readonly detail?: StructuredOutcome['detail'];
}): StructuredOutcome {
  return structuredOutcomeSchema.parse({
    class: input.class,
    kind: input.kind,
    retryable: input.retryable,
    subjects: input.subjects ?? [],
    detail: input.detail ?? null,
    detailSchemaVersion: 1
  });
}

function eventRequired(): StructuredOutcome {
  return outcome({ class: 'conflict', kind: 'communication.event_required', retryable: false });
}

function notFound(): StructuredOutcome {
  return outcome({ class: 'conflict', kind: 'communication.not_found', retryable: false });
}

function previewInvalid(): StructuredOutcome {
  return outcome({
    class: 'policy_violation',
    kind: 'communication.preview_invalid',
    retryable: false
  });
}

function revisionChanged(): StructuredOutcome {
  return outcome({
    class: 'stale_revision',
    kind: 'communication.revision_changed',
    retryable: false
  });
}

/**
 * Maps a preview-repository refusal onto the operation's declared outcomes.
 * Corruption is never mapped: it aborts the unit of work loudly.
 */
function adoptionRefusalOutcome(error: SQLiteOrganizerAudiencePreviewError): StructuredOutcome {
  switch (error.code) {
    case 'not_found':
      return notFound();
    case 'invalid_input':
      return previewInvalid();
    case 'stale_revision':
    case 'preview_conflict':
    case 'preparation_expired':
    case 'preparation_spent':
    case 'preparation_scope_mismatch':
      // All of these mean "the draft revision's preview state moved between
      // your read and this adoption"; the remedy is one fresh re-read.
      return revisionChanged();
    default:
      throw error;
  }
}

function refusalContribution(refused: StructuredOutcome): CommunicationSendLanePreparedContribution {
  return Object.freeze({
    result: Object.freeze({ kind: 'outcome' as const, outcome: refused }),
    domain: null,
    effectContributions: Object.freeze([])
  });
}

/** The one send refusal the operation declares with its reviewed safe diff. */
function isDeclaredSendRefusal(candidate: StructuredOutcome): boolean {
  return candidate.class === 'stale_revision'
    && candidate.kind === 'communication.preview_changed';
}

export interface CommunicationSendOperationRuntimeInput {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly previewRepository: SQLiteOrganizerAudiencePreviewRepository;
  readonly classifiedStore: SynchronousClassifiedPayloadStore;
  readonly releases: SQLiteCommunicationMessageReleaseStore;
  readonly clock: { now(): string };
  /**
   * Runs one outbound dispatch pass after a send commit has durably landed.
   * Provider I/O stays strictly outside the unit-of-work transaction; the
   * committed batch is receipt-recoverable if this pass faults, and with only
   * the deterministic fake composed every attempt still lands terminally
   * not-delivered (recorder default BLOCKED-2).
   */
  readonly dispatchAfterCommit: () => Promise<void>;
  /**
   * Route to the activated outbound provider connection. Absent (the default)
   * the send specs keep the inert-provider posture: sentinel connection
   * revision, unconfigured `.invalid` sender, non-scenario external key.
   */
  readonly deliveryRoute?: CommunicationDeliveryRoute;
}

export interface CommunicationSendOperationRuntime {
  readonly adoptionPreparer: CommunicationPreviewAdoptionPreparer;
  readonly effectDomains: readonly SQLiteEffectDomainAdapterRegistration[];
}

export function createCommunicationSendOperationRuntime(
  input: CommunicationSendOperationRuntimeInput
): CommunicationSendOperationRuntime {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  /**
   * Parked, one-shot prepared previews keyed by exact draft revision.
   * Latest-wins per key (the replaced handle is disposed so its plaintext
   * zeroizes early); the repository additionally TTLs every handle, and the
   * adopting transaction re-verifies draft version and audience guard state,
   * so a parked entry grants nothing by itself.
   */
  const parked = new Map<string, ParkedAdoption>();

  function parkKey(scope: Scope, draftId: string, draftVersion: number): string {
    return [scope.workspaceId, scope.eventId, draftId, String(draftVersion)].join('\u0000');
  }

  function requireOperatorAttribution(
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult,
    operationName: CommunicationSendLaneOperationName,
    effect: 'draft' | 'commit'
  ): { readonly principalKey: string } {
    if (context.operation.name !== operationName
        || context.operation.version !== 1
        || context.operation.effect !== effect
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== workspaceId) {
      throw new TypeError('communication_send_operation_binding_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    if (context.provenance.kind !== 'operator'
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || context.actor.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || authority.actor.userId !== context.actor.userId) {
      throw new TypeError('communication_send_operation_authority_mismatch');
    }
    return Object.freeze({ principalKey: `workspace_user:${authority.principal.userId}` });
  }

  function requireScope(context: EffectInvocationContext): Scope | undefined {
    if (context.scope.eventId === undefined) return undefined;
    return Object.freeze({
      workspaceId: parseWorkspaceId(context.scope.workspaceId),
      eventId: parseEventId(context.scope.eventId)
    });
  }

  function park(entry: ParkedAdoption): void {
    const key = parkKey(entry.scope, entry.draftId, entry.draftVersion);
    const replaced = parked.get(key);
    if (replaced !== undefined) {
      // One-shot handles: dispose the superseded preparation so its plaintext
      // zeroizes now instead of waiting out the repository TTL.
      try {
        input.previewRepository.disposePreparedPreview(replaced.preparation);
      } catch {
        // Already spent or expired; the repository owns that lifecycle.
      }
    }
    parked.set(key, entry);
  }

  function takeParked(
    scope: Scope,
    draftId: string,
    draftVersion: number
  ): ParkedAdoption | undefined {
    const key = parkKey(scope, draftId, draftVersion);
    const entry = parked.get(key);
    parked.delete(key);
    return entry;
  }

  const adoptionPreparer: CommunicationPreviewAdoptionPreparer = Object.freeze({
    async prepareAdoption({ scope, businessInput }: {
      readonly scope: Scope;
      readonly businessInput: unknown;
    }) {
      const parsed = organizerPreviewMessageBatchInputSchema.safeParse(businessInput);
      if (!parsed.success) {
        return Object.freeze({ kind: 'outcome' as const, outcome: previewInvalid() });
      }
      const drafts = input.sqlite.query<{ readonly owner_key: string }, [string, string, string]>(`
        SELECT owner_key FROM communication_drafts
         WHERE workspace_id = ? AND event_id = ? AND draft_id = ? LIMIT 2
      `).all(scope.workspaceId, scope.eventId, parsed.data.draftId);
      if (drafts.length !== 1) {
        return Object.freeze({ kind: 'outcome' as const, outcome: notFound() });
      }
      const ownerKey = drafts[0]!.owner_key;
      try {
        const preparation = await input.previewRepository.preparePreview({
          scope,
          ownerKey,
          draftId: parsed.data.draftId,
          expectedDraftVersion: parsed.data.expectedDraftVersion,
          now: input.clock.now()
        });
        park(Object.freeze({
          scope,
          ownerKey,
          draftId: parsed.data.draftId,
          draftVersion: parsed.data.expectedDraftVersion,
          preparation
        }));
        return Object.freeze({
          kind: 'success' as const,
          data: organizerPrepareMessagePreviewResultSchema.parse({
            schemaVersion: 1,
            draftId: parsed.data.draftId,
            draftVersion: parsed.data.expectedDraftVersion,
            state: 'prepared'
          })
        });
      } catch (error) {
        if (error instanceof SQLiteOrganizerAudiencePreviewError) {
          return Object.freeze({
            kind: 'outcome' as const,
            outcome: adoptionRefusalOutcome(error)
          });
        }
        throw error;
      }
    }
  });

  interface PreparedApplication {
    readonly context: EffectInvocationContext;
    readonly domainCanonical: string;
    phase: 'prepared' | 'applied';
  }

  function createAdapter(operationName: CommunicationSendLaneOperationName, run: (state: {
    readonly context: EffectInvocationContext;
    readonly principalKey: string;
    readonly scope: Scope;
    readonly businessInput: unknown;
    readonly remember: (domain: unknown) => void;
  }) => CommunicationSendLanePreparedContribution) {
    const capability = COMMUNICATION_SEND_LANE_HANDLER_CAPABILITY_BY_OPERATION[operationName];
    const effect = operationName === 'send_messages' ? 'commit' as const : 'draft' as const;
    let prepared: PreparedApplication | undefined;
    let applied: PreparedApplication | undefined;
    const adapter = {
      openHandlerSnapshot(
        openedCapability: { readonly key: string; readonly version: number },
        context: EffectInvocationContext,
        authorityRecheck: SealedEffectAuthorityRecheckResult
      ): EffectHandlerSnapshot {
        if (!input.sqlite.inTransaction) {
          throw new TypeError('communication_send_operation_transaction_required');
        }
        if (openedCapability.key !== capability.key
            || openedCapability.version !== capability.version) {
          throw new TypeError('communication_send_operation_capability_mismatch');
        }
        const attribution = requireOperatorAttribution(
          context, authorityRecheck, operationName, effect
        );
        prepared = undefined;
        applied = undefined;
        return sealCommunicationSendLanePreparation({
          capability,
          context,
          operationName,
          preparation: {
            prepare: ({ operationName: receivedOperation, businessInput, context: received }) => {
              if (!input.sqlite.inTransaction
                  || received !== context
                  || receivedOperation !== operationName
                  || prepared !== undefined
                  || applied !== undefined) {
                throw new TypeError('communication_send_operation_context_substitution');
              }
              const scope = requireScope(context);
              if (scope === undefined) {
                return refusalContribution(eventRequired());
              }
              const contribution = communicationSendLaneContributionSchema.parse(run({
                context,
                principalKey: attribution.principalKey,
                scope,
                businessInput,
                remember: (domain: unknown) => {
                  prepared = {
                    context,
                    domainCanonical: canonicalJsonText(
                      communicationSendLaneDomainContributionSchema.parse(domain)
                    ),
                    phase: 'prepared'
                  };
                }
              }));
              if (contribution.result.kind === 'success' && prepared === undefined) {
                throw new TypeError('communication_send_operation_contribution_unbound');
              }
              return contribution;
            }
          }
        });
      },
      applyDomainContribution(contribution: unknown): void {
        if (!input.sqlite.inTransaction) {
          throw new TypeError('communication_send_operation_transaction_required');
        }
        const parsed = communicationSendLaneDomainContributionSchema.parse(contribution);
        const current = prepared;
        if (!current || current.phase !== 'prepared'
            || canonicalJsonText(parsed) !== current.domainCanonical) {
          throw new TypeError('communication_send_operation_contribution_mismatch');
        }
        prepared = undefined;
        current.phase = 'applied';
        applied = current;
      },
      afterOperationLogInserted(receipt: TerminalEffectReceipt): void {
        const current = applied;
        if (!input.sqlite.inTransaction
            || !current
            || current.phase !== 'applied'
            || receipt.ref.operationName !== operationName
            || receipt.ref.operationVersion !== 1
            || receipt.requestHash !== current.context.requestBinding.requestHashSha256) {
          throw new TypeError('communication_send_operation_receipt_mismatch');
        }
      },
      afterUnitOfWorkFinished(): void {
        prepared = undefined;
        applied = undefined;
      }
    };
    if (operationName !== 'send_messages') {
      return Object.freeze({ capability, adapter });
    }
    return Object.freeze({
      capability,
      adapter: Object.freeze({
        ...adapter,
        async afterUnitOfWorkCommitted(): Promise<void> {
          // The commit is durable before any provider work starts; a fault
          // here surfaces loudly while the committed batch stays
          // receipt-recoverable and every delivery keeps its honest state.
          if (applied !== undefined) {
            await input.dispatchAfterCommit();
          }
        },
        afterUnitOfWorkFinished(): void {
          adapter.afterUnitOfWorkFinished();
        }
      })
    });
  }

  const previewDomain = createAdapter(
    'preview_message_batch',
    ({ context, scope, businessInput, remember }) => {
      const parsed = organizerPreviewMessageBatchInputSchema.safeParse(businessInput);
      if (!parsed.success) {
        return refusalContribution(previewInvalid());
      }
      const preparationState = takeParked(
        scope,
        parsed.data.draftId,
        parsed.data.expectedDraftVersion
      );
      if (preparationState === undefined) {
        // No live preparation for this exact draft revision: the prepare read
        // was skipped, superseded, or timed out. One fresh prepare resolves
        // it, so this is the ordinary stale-read refusal, not a fault.
        return refusalContribution(revisionChanged());
      }
      try {
        const summary = input.previewRepository.adoptPreparedPreview({
          preparation: preparationState.preparation,
          scope,
          ownerKey: preparationState.ownerKey,
          now: input.clock.now()
        });
        const data = organizerPreviewMessageBatchResultSchema.parse(summary);
        const domain = Object.freeze({
          kind: 'communication_preview_adopted' as const,
          workspaceId: scope.workspaceId,
          eventId: scope.eventId,
          audienceSpecId: data.identity.audienceSpecId,
          draftId: data.identity.draftId,
          draftVersion: data.identity.draftVersion,
          previewGeneration: data.identity.previewGeneration,
          occurredAt: context.receivedAt
        });
        remember(domain);
        return Object.freeze({
          result: Object.freeze({ kind: 'success' as const, data }),
          domain,
          effectContributions: Object.freeze([])
        });
      } catch (error) {
        if (error instanceof SQLiteOrganizerAudiencePreviewError) {
          // `adoptPreparedPreview` rolled back its own savepoint; nothing of
          // the adoption survives in this still-open unit of work.
          return refusalContribution(adoptionRefusalOutcome(error));
        }
        throw error;
      }
    }
  );

  const sendDomain = createAdapter(
    'send_messages',
    ({ context, principalKey, scope, businessInput, remember }) => {
      const parsed = organizerSendMessagesInputSchema.safeParse(businessInput);
      if (!parsed.success) {
        return refusalContribution(previewInvalid());
      }
      const now = input.clock.now();
      const snapshot = openAdoptedDecisionSnapshot({
        sqlite: input.sqlite,
        classifiedStore: input.classifiedStore,
        scope,
        audienceSpecId: parsed.data.audienceSpecId
      });
      if (snapshot === undefined) {
        return refusalContribution(notFound());
      }
      const batch = materializeDecisionSendBatch({
        scope,
        snapshot,
        batchId: parsed.data.batchId,
        now,
        ...(input.deliveryRoute === undefined ? {} : { route: input.deliveryRoute })
      });
      const authorInput = buildDecisionSendAuthorInput({
        scope,
        snapshot,
        batch,
        batchId: parsed.data.batchId,
        subject: parsed.data.subject,
        audienceLabel: parsed.data.audienceLabel,
        now
      });
      // The ceremony writes draft and proposal rows before it can refuse, so
      // it runs under a savepoint inside the Foundation transaction: a typed
      // refusal rolls those rows back while the unit of work itself commits
      // only its own audit evidence.
      input.sqlite.exec(`SAVEPOINT ${SEND_SAVEPOINT}`);
      let savepointOpen = true;
      try {
        const committed = commitSendMessagesRelease({
          sqlite: input.sqlite,
          releases: input.releases,
          // The live currency authority is the composed preview repository
          // (Track B repair): a re-decide between adoption and this commit
          // refuses typed, never a mirror comparison.
          previewCurrency: input.previewRepository,
          ids: { newEvidenceId: () => crypto.randomUUID() },
          context: {
            workspaceId: scope.workspaceId,
            eventId: scope.eventId,
            principalKey,
            authorityPrincipalKey: context.authorityPrincipalKey,
            evaluatedAt: now
          },
          authorInput,
          materializedReleases: batch.materialized
        });
        if (committed.kind === 'refused') {
          input.sqlite.exec(`ROLLBACK TO ${SEND_SAVEPOINT}`);
          input.sqlite.exec(`RELEASE ${SEND_SAVEPOINT}`);
          savepointOpen = false;
          const refusal = structuredOutcomeSchema.parse(committed.refusal);
          if (!isDeclaredSendRefusal(refusal)) {
            // A fresh single-operation ceremony can only refuse through the
            // declared preview-drift outcome; anything else is a composition
            // fault and must abort the unit of work loudly.
            throw new TypeError('communication_send_operation_refusal_undeclared');
          }
          return refusalContribution(refusal);
        }
        input.sqlite.exec(`RELEASE ${SEND_SAVEPOINT}`);
        savepointOpen = false;
        const data = organizerSendMessagesResultSchema.parse({
          schemaVersion: 1,
          batchId: committed.result.batchId,
          releaseCommitId: committed.releaseCommitId,
          dispatchGeneration: committed.result.dispatchGeneration,
          releaseCount: committed.result.releaseCount,
          deliveryCount: committed.result.deliveryIds.length
        });
        const domain = Object.freeze({
          kind: 'communication_send_committed' as const,
          workspaceId: scope.workspaceId,
          eventId: scope.eventId,
          batchId: data.batchId,
          releaseCommitId: data.releaseCommitId,
          releaseCount: data.releaseCount,
          deliveryCount: data.deliveryCount,
          occurredAt: context.receivedAt
        });
        remember(domain);
        return Object.freeze({
          result: Object.freeze({ kind: 'success' as const, data }),
          domain,
          effectContributions: Object.freeze([])
        });
      } catch (error) {
        if (savepointOpen) {
          input.sqlite.exec(`ROLLBACK TO ${SEND_SAVEPOINT}`);
          input.sqlite.exec(`RELEASE ${SEND_SAVEPOINT}`);
          savepointOpen = false;
        }
        if (error instanceof CommunicationReleasePlanningError
            && error.code === 'preview_not_found') {
          return refusalContribution(notFound());
        }
        throw error;
      }
    }
  );

  return Object.freeze({
    adoptionPreparer,
    effectDomains: Object.freeze([previewDomain, sendDomain])
  });
}
