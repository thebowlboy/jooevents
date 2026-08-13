import type { Database } from 'bun:sqlite';
import {
  effectOperationIdentitiesEqual,
  effectOperationIdentityMatchesContext,
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type EffectOperationIdentity,
  type SealedEffectAuthorityRecheckResult,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  outboundEmailDeliveryWorkInputSchema,
  outboundEmailDeliveryWorkOperationResultSchema,
  type OutboundEmailDeliveryWorkInput
} from '@jooevents/contracts';
import {
  DISPATCH_MESSAGE_RELEASE_OPERATION,
  OUTBOUND_EMAIL_DELIVERY_HANDLER_CAPABILITY,
  OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY,
  outboundEmailDeliveryContributionSchema,
  outboundEmailDeliveryDomainContributionSchema,
  outboundEmailDeliveryEvidenceChildSchema,
  outboundEmailDeliveryWorkDigest,
  sealOutboundEmailDeliveryPreparation,
  type OutboundEmailDeliveryContribution
} from '@jooevents/communication-operations';
import {
  canonicalJsonText,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { SQLiteEffectDomainAdapter } from './foundation-trial-uow';
import {
  insertOutboundEmailDeliveryRegistration,
  linkOutboundEmailDeliveryReceipt
} from './outbound-email-delivery';

export interface SQLiteOutboundEmailDeliveryEffectIds {
  newPreparationHandle(): string;
  newFactId(): string;
  newPointerId(): string;
  newHistoryThreadId(): string;
  newHistoryId(): string;
}

type EvidenceChild = OutboundEmailDeliveryContribution['receiptChildren'][number];
type RegistrationContribution = Extract<
  OutboundEmailDeliveryContribution,
  { readonly domain: { readonly kind: 'outbound_email_delivery_registration' } }
>;

interface PreparedRegistration {
  readonly handle: string;
  readonly context: EffectInvocationContext;
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
  readonly evaluatedAt: string;
  readonly work: OutboundEmailDeliveryWorkInput;
  readonly contribution: RegistrationContribution;
  phase: 'prepared' | 'applied' | 'parent_linked' | 'evidence_complete' | 'claim_released';
  nextChild: number;
  receiptId?: string;
}

interface PreparedNoop {
  readonly context: EffectInvocationContext;
  phase: 'prepared' | 'claim_released';
}

function exactCapability(value: { readonly key: string; readonly version: number }): boolean {
  return value.key === OUTBOUND_EMAIL_DELIVERY_HANDLER_CAPABILITY.key
    && value.version === OUTBOUND_EMAIL_DELIVERY_HANDLER_CAPABILITY.version;
}

function exactChild(value: unknown): EvidenceChild {
  return outboundEmailDeliveryEvidenceChildSchema.parse(value) as EvidenceChild;
}

function existingMatches(
  sqlite: Database,
  work: OutboundEmailDeliveryWorkInput,
  workspaceId: WorkspaceId,
  eventId: EventId
): boolean | undefined {
  const row = sqlite.query<{
    readonly workspace_id: string;
    readonly event_id: string;
    readonly work_json: string;
  }, [string]>(`
    SELECT workspace_id, event_id,
           json_object(
             'contractVersion', 1,
             'deliveryId', delivery_id,
             'releaseId', release_id,
             'dispatchGeneration', dispatch_generation,
             'reviewedMessageDigestSha256', reviewed_message_digest_sha256,
             'reviewedEnvelopeDigestSha256', reviewed_envelope_digest_sha256,
             'recipientRefId', recipient_ref_id,
             'templateRevisionRefId', template_revision_ref_id,
             'contentRefId', content_ref_id,
             'providerConnectionRevisionId', provider_connection_revision_id,
             'externalDeliveryKey', external_delivery_key,
             'senderProfileRevisionId', sender_profile_revision_id,
             'senderPresentationContractKey', sender_presentation_contract_key,
             'senderPresentationContractVersion', sender_presentation_contract_version,
             'senderPresentationDigestSha256', sender_presentation_digest_sha256,
             'channelAddressId', channel_address_id,
             'channelAddressVersion', channel_address_version,
             'addressLookupFingerprintProfile', address_lookup_fingerprint_profile,
             'addressLookupFingerprintVersion', address_lookup_fingerprint_version,
             'addressLookupFingerprintSha256', address_lookup_fingerprint_sha256
           ) AS work_json
      FROM communication_outbound_delivery_heads WHERE delivery_id = ?
  `).get(work.deliveryId);
  if (!row) return undefined;
  return row.workspace_id === workspaceId
    && row.event_id === eventId
    && canonicalJsonText(outboundEmailDeliveryWorkInputSchema.parse(JSON.parse(row.work_json)))
      === canonicalJsonText(work);
}

/** Registered-job domain adapter. It never invokes an email provider. */
export class SQLiteOutboundEmailDeliveryEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #ids: SQLiteOutboundEmailDeliveryEffectIds;
  readonly #prepared = new Map<string, PreparedRegistration>();
  #active: PreparedRegistration | PreparedNoop | undefined;
  #expectedIdentity: EffectOperationIdentity | undefined;

  public constructor(
    private readonly sqlite: Database,
    ids: SQLiteOutboundEmailDeliveryEffectIds
  ) {
    this.#ids = Object.freeze({
      newPreparationHandle: ids.newPreparationHandle.bind(ids),
      newFactId: ids.newFactId.bind(ids),
      newPointerId: ids.newPointerId.bind(ids),
      newHistoryThreadId: ids.newHistoryThreadId.bind(ids),
      newHistoryId: ids.newHistoryId.bind(ids)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.sqlite.inTransaction) throw new TypeError('outbound_delivery_effect_transaction_required');
    if (!exactCapability(capability)) throw new TypeError('outbound_delivery_effect_capability_mismatch');
    if (
      context.operation.name !== DISPATCH_MESSAGE_RELEASE_OPERATION.name
      || context.operation.version !== DISPATCH_MESSAGE_RELEASE_OPERATION.version
      || context.operation.effect !== 'commit'
      || context.surface !== 'application_job'
      || context.scope.eventId === undefined
    ) throw new TypeError('outbound_delivery_effect_scope_mismatch');
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (
      authority.actor.kind !== 'system_job'
      || authority.principal.kind !== 'registered_job'
      || context.actor.kind !== 'system_job'
      || authority.actor.jobId !== authority.principal.jobId
      || context.actor.jobId !== authority.actor.jobId
      || authority.lane.kind !== 'registered_job'
      || authority.lane.surface !== 'application_job'
      || authority.lane.policy.key !== OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY.key
      || authority.lane.policy.version !== OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY.version
    ) throw new TypeError('outbound_delivery_effect_authority_mismatch');
    const registeredCapabilityRevisionId = authority.principal.capabilityRevisionId;
    if (!authority.grants.some((grant) =>
      grant.kind === 'registered_capability'
      && grant.key === registeredCapabilityRevisionId
    )) throw new TypeError('outbound_delivery_effect_authority_mismatch');
    const workspaceId = parseWorkspaceId(context.scope.workspaceId);
    const eventId = parseEventId(context.scope.eventId);
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;

    return sealOutboundEmailDeliveryPreparation({
      capability,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.sqlite.inTransaction) {
            throw new TypeError('outbound_delivery_effect_context_substitution');
          }
          const work = outboundEmailDeliveryWorkInputSchema.parse(businessInput);
          const match = existingMatches(this.sqlite, work, workspaceId, eventId);
          if (match !== undefined) {
            const contribution = outboundEmailDeliveryContributionSchema.parse(match
              ? {
                  result: {
                    kind: 'success',
                    data: {
                      contractVersion: 1,
                      deliveryId: work.deliveryId,
                      releaseId: work.releaseId,
                      dispatchGeneration: work.dispatchGeneration,
                      workAnchorState: 'durable',
                      disposition: 'already_ready'
                    }
                  },
                  domain: null,
                  receiptChildren: []
                }
              : {
                  result: {
                    kind: 'outcome',
                    outcome: {
                      class: 'idempotency_conflict',
                      kind: 'communication.delivery_identity_changed',
                      retryable: false,
                      subjects: [],
                      detail: null,
                      detailSchemaVersion: 1
                    }
                  },
                  domain: null,
                  receiptChildren: []
                });
            this.#active = { context, phase: 'prepared' };
            return contribution;
          }

          const handle = this.#ids.newPreparationHandle();
          const factId = this.#ids.newFactId();
          const pointerId = this.#ids.newPointerId();
          const threadId = this.#ids.newHistoryThreadId();
          const historyId = this.#ids.newHistoryId();
          const contribution = outboundEmailDeliveryContributionSchema.parse({
            result: {
              kind: 'success',
              data: {
                contractVersion: 1,
                deliveryId: work.deliveryId,
                releaseId: work.releaseId,
                dispatchGeneration: work.dispatchGeneration,
                workAnchorState: 'durable',
                disposition: 'created'
              }
            },
            domain: {
              kind: 'outbound_email_delivery_registration',
              preparationHandle: handle,
              deliveryId: work.deliveryId,
              workDigestSha256: outboundEmailDeliveryWorkDigest(work)
            },
            receiptChildren: [{
              kind: 'domain_fact',
              factId,
              factKind: 'outbound_email_delivery_requested',
              factVersion: 1,
              deliveryId: work.deliveryId,
              releaseId: work.releaseId,
              reviewedMessageDigestSha256: work.reviewedMessageDigestSha256,
              reviewedEnvelopeDigestSha256: work.reviewedEnvelopeDigestSha256,
              occurredAt: evaluatedAt
            }, {
              kind: 'outbox_pointer',
              pointerId,
              sourceKind: 'domain_fact',
              factId,
              deliveryId: work.deliveryId,
              purpose: 'communication.outbound-email.dispatch'
            }, {
              kind: 'history',
              historyId,
              threadId,
              sourceKind: 'domain_fact',
              factId,
              deliveryId: work.deliveryId,
              summaryCode: 'communication.outbound-email.requested',
              occurredAt: evaluatedAt
            }]
          });
          if (contribution.domain === null) throw new TypeError('outbound_delivery_contribution_invalid');
          const prepared = {
            handle,
            context,
            workspaceId,
            eventId,
            evaluatedAt,
            work,
            contribution,
            phase: 'prepared' as const,
            nextChild: 0
          };
          this.#prepared.set(handle, prepared);
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.sqlite.inTransaction) throw new TypeError('outbound_delivery_effect_transaction_required');
    if (contribution === null) return;
    const parsed = outboundEmailDeliveryDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared.get(parsed.preparationHandle);
    if (
      !prepared
      || prepared.phase !== 'prepared'
      || parsed.deliveryId !== prepared.work.deliveryId
      || parsed.workDigestSha256 !== outboundEmailDeliveryWorkDigest(prepared.work)
      || canonicalJsonText(parsed) !== canonicalJsonText(prepared.contribution.domain)
    ) throw new TypeError('outbound_delivery_effect_preparation_invalid');
    const [fact, pointer, history] = prepared.contribution.receiptChildren;
    insertOutboundEmailDeliveryRegistration({
      sqlite: this.sqlite,
      workspaceId: prepared.workspaceId,
      eventId: prepared.eventId,
      work: prepared.work,
      evidence: {
        rootFactId: fact.factId,
        rootPointerId: pointer.pointerId,
        historyThreadId: history.threadId,
        rootHistoryId: history.historyId
      },
      createdAt: prepared.evaluatedAt
    });
    this.#prepared.delete(prepared.handle);
    prepared.phase = 'applied';
    this.#active = prepared;
  }

  afterReceiptParentInserted(receipt: TerminalEffectReceipt): void {
    if (!this.sqlite.inTransaction || !this.#active) {
      throw new TypeError('outbound_delivery_effect_receipt_parent_missing');
    }
    const result = outboundEmailDeliveryWorkOperationResultSchema.safeParse(receipt.result);
    if (
      !effectOperationIdentityMatchesContext(receipt.identity, this.#active.context)
      || receipt.ref.operationName !== DISPATCH_MESSAGE_RELEASE_OPERATION.name
      || receipt.ref.operationVersion !== DISPATCH_MESSAGE_RELEASE_OPERATION.version
      || !result.success
    ) throw new TypeError('outbound_delivery_effect_receipt_mismatch');
    this.#expectedIdentity = receipt.identity;
    if ('handle' in this.#active) {
      if (this.#active.phase !== 'applied') throw new TypeError('outbound_delivery_effect_incomplete');
      linkOutboundEmailDeliveryReceipt({
        sqlite: this.sqlite,
        deliveryId: this.#active.work.deliveryId,
        receiptId: receipt.ref.id
      });
      this.#active.receiptId = receipt.ref.id;
      this.#active.phase = 'parent_linked';
    } else {
      this.#active.phase = 'prepared';
    }
  }

  afterReceiptChildInserted(receiptId: string, contribution: unknown): void {
    const active = this.#active;
    if (!this.sqlite.inTransaction || !active || !('handle' in active)
      || active.phase !== 'parent_linked' || active.receiptId !== receiptId) {
      throw new TypeError('outbound_delivery_effect_receipt_parent_missing');
    }
    const expected = active.contribution.receiptChildren[active.nextChild];
    const child = exactChild(contribution);
    if (!expected || canonicalJsonText(expected) !== canonicalJsonText(child)) {
      throw new TypeError('outbound_delivery_effect_evidence_order_mismatch');
    }
    if (child.kind === 'domain_fact') {
      this.sqlite.query<never, [string, string, string, string, string, string, number, string, number]>(`
        INSERT INTO communication_outbound_delivery_facts (
          fact_id, receipt_id, workspace_id, event_id, delivery_id,
          fact_kind, fact_version, payload_json, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        child.factId, receiptId, active.workspaceId, active.eventId, child.deliveryId,
        child.factKind, child.factVersion,
        canonicalJsonText({
          contractVersion: 1,
          releaseId: child.releaseId,
          reviewedMessageDigestSha256: child.reviewedMessageDigestSha256,
          reviewedEnvelopeDigestSha256: child.reviewedEnvelopeDigestSha256,
          recipientRefId: active.work.recipientRefId,
          templateRevisionRefId: active.work.templateRevisionRefId,
          contentRefId: active.work.contentRefId
        }),
        Date.parse(parseInstant(child.occurredAt))
      );
    } else if (child.kind === 'outbox_pointer') {
      this.sqlite.query<never, [string, string, string, string, string, number]>(`
        INSERT INTO communication_outbound_delivery_outbox (
          pointer_id, receipt_id, fact_id, delivery_id, purpose, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        child.pointerId, receiptId, child.factId, child.deliveryId, child.purpose,
        Date.parse(parseInstant(active.evaluatedAt))
      );
    } else {
      this.sqlite.query<never, [string, string, number, string, string, string, null, null, string, number]>(`
        INSERT INTO communication_outbound_delivery_history (
          history_id, thread_id, sequence, receipt_id, fact_id, delivery_id,
          attempt_id, parent_history_id, summary_code, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        child.historyId, child.threadId, 0, receiptId, child.factId, child.deliveryId,
        null, null, child.summaryCode, Date.parse(parseInstant(child.occurredAt))
      );
    }
    active.nextChild += 1;
    if (active.nextChild === active.contribution.receiptChildren.length) {
      active.phase = 'evidence_complete';
    }
  }

  afterExecutionClaimReleased(identity: EffectOperationIdentity): void {
    if (!this.sqlite.inTransaction || !this.#active || !this.#expectedIdentity
      || !effectOperationIdentitiesEqual(identity, this.#expectedIdentity)) {
      throw new TypeError('outbound_delivery_effect_incomplete');
    }
    if ('handle' in this.#active) {
      if (this.#active.phase !== 'evidence_complete') {
        throw new TypeError('outbound_delivery_effect_incomplete');
      }
    } else if (this.#active.phase !== 'prepared') {
      throw new TypeError('outbound_delivery_effect_incomplete');
    }
    this.#active.phase = 'claim_released';
  }

  afterUnitOfWorkCommitted(): void {
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared.clear();
    this.#active = undefined;
    this.#expectedIdentity = undefined;
  }
}

export function createSQLiteOutboundEmailDeliveryEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly ids: SQLiteOutboundEmailDeliveryEffectIds;
}) {
  return Object.freeze({
    capability: OUTBOUND_EMAIL_DELIVERY_HANDLER_CAPABILITY,
    adapter: new SQLiteOutboundEmailDeliveryEffectDomainAdapter(input.sqlite, input.ids)
  });
}
