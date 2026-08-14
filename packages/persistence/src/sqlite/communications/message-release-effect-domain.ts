import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  applyPreparedChangesetSynchronous,
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  prepareChangesetCommitSynchronous,
  type ChangesetCommitTransaction,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition,
  type ChangesetPlanningSnapshot,
  type ChangesetReadPortKey,
  type ChangesetTransactionPortKey,
  type ChangesetValidationPortKey
} from '@jooevents/changesets';
import {
  COMMIT_CHANGESET_OPERATION,
  appendChangesetDraftSynchronous,
  commitStoredChangeset,
  parseChangesetCommitTerminalReceipt,
  proposeStoredChangeset,
  validateStoredChangesetCommit,
  type ChangesetCommitTerminalReceipt,
  type ChangesetLifecycleOwnerResolution,
  type ChangesetLifecycleOwnerResolutionSource,
  type ChangesetLifecycleStore,
  type StoredChangesetCommitLink,
  type StoredChangesetRecord
} from '@jooevents/changeset-operations';
import {
  parseCommunicationMessageRelease,
  type CommunicationMessageRelease
} from '@jooevents/communications';
import {
  SEND_MESSAGES_APPROVAL_POLICY,
  SEND_MESSAGES_CHANGESET_KIND,
  SEND_MESSAGES_CHANGESET_OWNER_ID,
  SEND_MESSAGES_CHANGESET_VERSION,
  sendMessagesAuthorInputSchema,
  sendMessagesPlanSchema,
  sendMessagesPreviewGuardId,
  sendMessagesResult,
  sendMessagesResultSchema,
  sendMessagesSafeDiff,
  sendMessagesSafeDiffSchema,
  type SendMessagesAuthorInput,
  type SendMessagesPlan,
  type SendMessagesResult
} from '@jooevents/communication-operations';
import {
  outboundEmailDeliveryWorkInputSchema,
  type OutboundEmailDeliveryWorkInput,
  type StructuredOutcome
} from '@jooevents/contracts';
import {
  organizerMessagePreviewIdentitySchema,
  organizerMessagePreviewSummarySchema,
  type OrganizerMessagePreviewIdentity,
  type OrganizerMessagePreviewSummary
} from '@jooevents/contracts/communications/organizer';
import { canonicalJsonText, encodeCanonicalJson } from '@jooevents/kernel';
import type { SQLiteOperatorSubjectRelationshipSource } from '../operator-authority-repositories';
import { createSQLiteOrdinaryChangesetLifecycleStore } from '../program-vocabulary-changeset-effect-domain';
import {
  insertOutboundEmailDeliveryRegistration,
  linkOutboundEmailDeliveryReceipt
} from '../outbound-email-delivery';
import type { SQLiteCommunicationMessageReleaseStore } from './message-releases';

/** Additive receipt/audit tables for the send-wave changeset owner. */
export const SQLITE_COMMUNICATION_RELEASE_CHANGESET_SQL = `
CREATE TABLE communication_release_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('draft', 'propose', 'commit')),
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  record_digest_sha256 TEXT NOT NULL CHECK(length(record_digest_sha256) = 64),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000)
) STRICT;

CREATE TABLE communication_release_effect_specs (
  spec_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  work_digest_sha256 TEXT NOT NULL CHECK(length(work_digest_sha256) = 64),
  UNIQUE(batch_id, release_id),
  UNIQUE(delivery_id)
) STRICT;

CREATE TRIGGER communication_release_receipt_links_no_update
BEFORE UPDATE ON communication_release_receipt_links
BEGIN SELECT RAISE(ABORT, 'communication release receipt links are immutable'); END;
CREATE TRIGGER communication_release_receipt_links_no_delete
BEFORE DELETE ON communication_release_receipt_links
BEGIN SELECT RAISE(ABORT, 'communication release receipt links are immutable'); END;
CREATE TRIGGER communication_release_effect_specs_no_update
BEFORE UPDATE ON communication_release_effect_specs
BEGIN SELECT RAISE(ABORT, 'communication release effect specs are immutable'); END;
CREATE TRIGGER communication_release_effect_specs_no_delete
BEFORE DELETE ON communication_release_effect_specs
BEGIN SELECT RAISE(ABORT, 'communication release effect specs are immutable'); END;
`;

export function installCommunicationReleaseChangesetSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('communication_release_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_COMMUNICATION_RELEASE_CHANGESET_SQL)).immediate();
}

export type CommunicationReleasePlanningErrorCode =
  | 'preview_not_found'
  | 'preview_changed'
  | 'release_batch_mismatch'
  | 'delivery_identity_changed';

export class CommunicationReleasePlanningError extends Error {
  constructor(readonly code: CommunicationReleasePlanningErrorCode) {
    super(code);
    this.name = 'CommunicationReleasePlanningError';
  }
}

/**
 * The adopted preview snapshot as commit evidence: the immutable row's exact
 * identity, the review digests its stored summary attested, and a live
 * currency verdict recomputed from current domain state at read time. A pin
 * is never a mirror of the plan — its evidence half comes from the stored
 * summary and its currency half from re-resolving the domain now.
 */
export interface CommunicationPreviewPin {
  readonly identity: OrganizerMessagePreviewIdentity;
  readonly membershipDigestSha256: string;
  readonly evidenceDigestSha256: string;
  readonly sourceVersions: readonly OrganizerMessagePreviewSummary['sourceVersions'][number][];
  readonly currency: 'current' | 'stale';
}

export interface CommunicationReleaseChangesetReadPort {
  readPreviewPin(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly audienceSpecId: string;
  }): CommunicationPreviewPin | undefined;
}

/**
 * Live currency authority over adopted previews. The audience-preview
 * repository satisfies this with `checkAdoptedPreviewCurrency`, which
 * re-reads the draft binding and re-resolves the audience and address-policy
 * state, comparing the recomputation against the adopted guard digest.
 */
export interface CommunicationAdoptedPreviewCurrencySource {
  checkAdoptedPreviewCurrency(input: {
    readonly scope: { readonly workspaceId: string; readonly eventId: string };
    /** A full preview identity; implementations parse before trusting it. */
    readonly identity: unknown;
  }): 'current' | 'stale' | 'not_found';
}

export interface CommunicationReleaseChangesetTransactionPort {
  commitReleaseBatch(plan: SendMessagesPlan): SendMessagesResult;
}

export const communicationReleaseReadPort =
  defineChangesetReadPort<CommunicationReleaseChangesetReadPort>('communication_release.read', 1);
export const communicationReleaseValidationPort =
  defineChangesetValidationPort<CommunicationReleaseChangesetReadPort>(
    'communication_release.validation', 1
  );
export const communicationReleaseTransactionPort =
  defineChangesetTransactionPort<CommunicationReleaseChangesetTransactionPort>(
    'communication_release.transaction', 1
  );

const authorInputSchema = defineChangesetSchema({
  key: 'communication.send_messages.author_input', version: 1,
  schema: sendMessagesAuthorInputSchema
});
const planSchema = defineChangesetSchema({
  key: 'communication.send_messages.plan', version: 1, schema: sendMessagesPlanSchema
});
const diffSchema = defineChangesetSchema({
  key: 'communication.send_messages.safe_diff', version: 1, schema: sendMessagesSafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'communication.send_messages.result', version: 1, schema: sendMessagesResultSchema
});

type SendMessagesDefinition = ChangesetOperationDefinition<
  SendMessagesAuthorInput,
  SendMessagesPlan,
  ReturnType<typeof sendMessagesSafeDiff>,
  SendMessagesPlan,
  SendMessagesResult
>;

export interface CommunicationReleaseChangesetBundle {
  readonly definition: SendMessagesDefinition;
  readonly registry: ChangesetDefinitionRegistry;
}

function previewGuardRefusal(plan: SendMessagesPlan) {
  // The detail must parse against the declared outcome schema (the safe
  // diff), or the engine rejects the emission as an undeclared outcome. The
  // canonical-JSON round trip is a type-level projection onto the structured
  // outcome's JSON detail type; the value is byte-identical (the safe diff
  // never carries an `undefined` member — optional keys are simply absent).
  const detail: StructuredOutcome['detail'] =
    JSON.parse(canonicalJsonText(sendMessagesSafeDiff(plan)));
  return Object.freeze({
    class: 'stale_revision' as const,
    kind: 'communication.preview_changed',
    retryable: false,
    subjects: [{ type: 'communication_preview', id: plan.preview.identity.audienceSpecId }],
    detail,
    detailSchemaVersion: 1
  });
}

/**
 * The plan's pinned identity AND its carried review evidence must equal the
 * adopted snapshot's stored summary — a plan attesting membership or evidence
 * digests, or source versions, that never belonged to the adopted preview is
 * a mismatch, not merely unusual input. Both sides schema-enforce canonical
 * source-version ordering, so the comparisons are exact.
 */
function pinMatches(
  pin: CommunicationPreviewPin | undefined,
  plan: SendMessagesPlan
): pin is CommunicationPreviewPin {
  return pin !== undefined
    && canonicalJsonText(pin.identity) === canonicalJsonText(plan.preview.identity)
    && pin.membershipDigestSha256 === plan.preview.membershipDigestSha256
    && pin.evidenceDigestSha256 === plan.preview.evidenceDigestSha256
    && canonicalJsonText(pin.sourceVersions) === canonicalJsonText(plan.preview.sourceVersions);
}

/**
 * The one `communication.send_messages` changeset. Its commit is the only path
 * that turns a reviewed preview into effective sends: immutable per-recipient
 * releases plus their outbound-delivery registrations, all inside the hosting
 * unit of work. Nothing here awaits a provider, and no engagement write rides
 * this transaction (recorded BLOCKED-1 boundary).
 */
export function createCommunicationReleaseChangesetBundle(): CommunicationReleaseChangesetBundle {
  const definition: SendMessagesDefinition = {
    kind: SEND_MESSAGES_CHANGESET_KIND,
    version: SEND_MESSAGES_CHANGESET_VERSION,
    schemas: {
      authorInput: authorInputSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [communicationReleaseReadPort],
    validationPorts: [communicationReleaseValidationPort],
    transactionPorts: [communicationReleaseTransactionPort],
    allowedAggregateKinds: ['communication_release_batch'],
    allowedGuardKinds: ['communication_preview'],
    allowedRisks: ['consequential'],
    allowedConsequences: ['communication_release_committed'],
    allowedOutcomes: [{
      class: 'stale_revision', kind: 'communication.preview_changed', retryable: false,
      detailSchema: diffSchema.reference
    }],
    allowedFacts: [{ kind: 'communication_release_committed', version: 1 }],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const plan = sendMessagesPlanSchema.parse(authorInput);
      const pin = snapshot.getPort(communicationReleaseReadPort).readPreviewPin({
        workspaceId: plan.scope.workspaceId,
        eventId: plan.scope.eventId,
        audienceSpecId: plan.preview.identity.audienceSpecId
      });
      if (pin === undefined) throw new CommunicationReleasePlanningError('preview_not_found');
      if (!pinMatches(pin, plan)) throw new CommunicationReleasePlanningError('preview_changed');
      // Currency is deliberately not required at plan time: a legitimately
      // drifted domain must surface at commit as the declared typed
      // `communication.preview_changed` refusal from validateWithin, never as
      // a planning exception. plan() rejects only absent or mismatched pins.
      return {
        plan,
        aggregateRefs: [],
        guardRefs: [{
          id: sendMessagesPreviewGuardId(plan.preview.identity.audienceSpecId),
          version: plan.preview.identity.previewGeneration,
          digest: plan.preview.identity.previewDigestSha256
        }],
        riskTier: 'consequential',
        consequences: ['communication_release_committed']
      };
    },
    projectDiff(plan) {
      return {
        diff: sendMessagesSafeDiff(plan),
        representedConsequences: ['communication_release_committed']
      };
    },
    validateWithin(plan, validation) {
      // The commit-time gate, inside the hosting transaction: the adopted row
      // must still match the plan's pinned identity and review evidence, AND
      // the pin's live currency recomputation must still reproduce what was
      // adopted. A re-decide, a superseding draft revision, or an address or
      // policy change between adoption and commit refuses here, typed.
      const pin = validation.getPort(communicationReleaseValidationPort).readPreviewPin({
        workspaceId: plan.scope.workspaceId,
        eventId: plan.scope.eventId,
        audienceSpecId: plan.preview.identity.audienceSpecId
      });
      return pinMatches(pin, plan) && pin.currency === 'current'
        ? { kind: 'ready', validated: plan }
        : { kind: 'outcome', outcome: previewGuardRefusal(plan) };
    },
    applyWithin(plan, transaction) {
      const result = transaction
        .getPort(communicationReleaseTransactionPort)
        .commitReleaseBatch(plan);
      return {
        result,
        facts: [{ kind: 'communication_release_committed', version: 1, payload: result }],
        effects: []
      };
    },
    deriveCompensation() {
      // An accepted provider handoff cannot be recalled; compensation is a
      // human follow-up communication, never an automatic reversal.
      return { kind: 'blocked', reasonKey: 'communication.send_irreversible' };
    }
  };
  return Object.freeze({
    definition,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorInputSchema, planSchema, diffSchema, resultSchema],
      definitions: [definition]
    })
  });
}

function digestHex(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

export interface SQLiteCommunicationReleaseCommitIds {
  newChangesetId(): string;
  newRevisionId(): string;
  newApprovalId(): string;
  newCorrectionAttemptId(): string;
  newEvidenceId(): string;
}

function workInputFor(
  plan: SendMessagesPlan,
  spec: SendMessagesPlan['releases'][number]
): OutboundEmailDeliveryWorkInput {
  return outboundEmailDeliveryWorkInputSchema.parse({
    contractVersion: 1,
    deliveryId: spec.deliveryId,
    releaseId: spec.releaseId,
    dispatchGeneration: 1,
    reviewedMessageDigestSha256: spec.reviewedMessageDigestSha256,
    reviewedEnvelopeDigestSha256: spec.reviewedEnvelopeDigestSha256,
    recipientRefId: spec.recipientRefId,
    templateRevisionRefId: spec.templateRevisionRefId,
    contentRefId: spec.contentRefId,
    providerConnectionRevisionId: spec.providerConnectionRevisionId,
    externalDeliveryKey: spec.externalDeliveryKey,
    senderProfileRevisionId: spec.senderProfileRevisionId,
    senderPresentationContractKey: spec.senderPresentationContractKey,
    senderPresentationContractVersion: spec.senderPresentationContractVersion,
    senderPresentationDigestSha256: spec.senderPresentationDigestSha256,
    channelAddressId: spec.channelAddressId,
    channelAddressVersion: spec.channelAddressVersion,
    addressLookupFingerprintProfile: spec.addressLookupFingerprintProfile,
    addressLookupFingerprintVersion: spec.addressLookupFingerprintVersion,
    addressLookupFingerprintSha256: spec.addressLookupFingerprintSha256
  });
}

/**
 * Reads the adopted preview snapshot row this commit must stay pinned to,
 * pairing the row's stored review evidence with a live currency verdict. The
 * immutable row alone can never witness domain drift — its generation and
 * digest are frozen at adoption — so every pin read consults the currency
 * source, which recomputes the adopted guard digest from current decision
 * heads, draft binding, and address-policy state.
 */
export function createSQLiteCommunicationPreviewPinSource(input: {
  readonly sqlite: Database;
  readonly currency: CommunicationAdoptedPreviewCurrencySource;
}): CommunicationReleaseChangesetReadPort {
  return Object.freeze({
    readPreviewPin({ workspaceId, eventId, audienceSpecId }: {
      readonly workspaceId: string;
      readonly eventId: string;
      readonly audienceSpecId: string;
    }): CommunicationPreviewPin | undefined {
      const rows = input.sqlite.query<{
        readonly audience_spec_id: string;
        readonly draft_id: string;
        readonly draft_version: number;
        readonly preview_generation: number;
        readonly preview_digest_profile: string;
        readonly preview_digest_version: number;
        readonly preview_digest_sha256: string;
        readonly summary_json: string;
      }, [string, string, string]>(`
        SELECT audience_spec_id, draft_id, draft_version, preview_generation,
               preview_digest_profile, preview_digest_version, preview_digest_sha256,
               summary_json
          FROM communication_message_preview_snapshots
         WHERE workspace_id = ? AND event_id = ? AND audience_spec_id = ? LIMIT 2
      `).all(workspaceId, eventId, audienceSpecId);
      if (rows.length > 1) throw new TypeError('communication_release_preview_pin_corrupt');
      const row = rows[0];
      if (row === undefined) return undefined;
      let summary: OrganizerMessagePreviewSummary;
      try {
        summary = organizerMessagePreviewSummarySchema.parse(JSON.parse(row.summary_json));
      } catch {
        throw new TypeError('communication_release_preview_pin_corrupt');
      }
      const identity = organizerMessagePreviewIdentitySchema.parse(summary.identity);
      if (canonicalJsonText(summary) !== row.summary_json
          || identity.audienceSpecId !== row.audience_spec_id
          || identity.draftId !== row.draft_id
          || identity.draftVersion !== row.draft_version
          || identity.previewGeneration !== row.preview_generation
          || identity.previewDigestProfile !== row.preview_digest_profile
          || identity.previewDigestVersion !== row.preview_digest_version
          || identity.previewDigestSha256 !== row.preview_digest_sha256) {
        throw new TypeError('communication_release_preview_pin_corrupt');
      }
      const verdict = input.currency.checkAdoptedPreviewCurrency({
        scope: { workspaceId, eventId },
        identity
      });
      if (verdict === 'not_found') {
        // The row is visible in this transaction; a currency source that
        // cannot see it is miswired, and that must surface loudly.
        throw new TypeError('communication_release_preview_currency_unreachable');
      }
      if (verdict !== 'current' && verdict !== 'stale') {
        throw new TypeError('communication_release_preview_currency_invalid');
      }
      return Object.freeze({
        identity: Object.freeze(identity),
        membershipDigestSha256: summary.membershipDigestSha256,
        evidenceDigestSha256: summary.evidenceDigestSha256,
        sourceVersions: Object.freeze(summary.sourceVersions.map((source) => Object.freeze(source))),
        currency: verdict
      });
    }
  });
}

export interface CommitSendMessagesInput {
  readonly sqlite: Database;
  readonly releases: SQLiteCommunicationMessageReleaseStore;
  /**
   * Live currency authority for the pinned preview — the audience-preview
   * repository in composed runtimes. Required: without it the commit could
   * only compare the plan against the immutable snapshot row, which is a
   * mirror of itself and can never witness a re-decide.
   */
  readonly previewCurrency: CommunicationAdoptedPreviewCurrencySource;
  readonly lifecycleStore?: ChangesetLifecycleStore;
  readonly ids: SQLiteCommunicationReleaseCommitIds;
  readonly context: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly principalKey: string;
    readonly authorityPrincipalKey: string;
    readonly evaluatedAt: string;
  };
  readonly authorInput: SendMessagesAuthorInput;
  /** Materialized reviewed envelopes, one per plan release spec, digest-bound. */
  readonly materializedReleases: readonly CommunicationMessageRelease[];
  readonly receiptExpectation: {
    readonly surface: ChangesetCommitTerminalReceipt['identity']['surface'];
    readonly scopePartitionKey: string;
    readonly requestHashSha256: string;
  };
  /**
   * Builds the commit's terminal receipt once the changeset identity is known.
   * The runtime adapter derives it from the real operation receipt; tests
   * synthesize an equivalent one.
   */
  readonly terminalReceipt: (binding: {
    readonly changesetId: string;
    readonly expectedHeadVersion: number;
    readonly committedHeadVersion: number;
    readonly revisionId: string;
    readonly revisionDigest: string;
  }) => ChangesetCommitTerminalReceipt;
}

export interface CommitSendMessagesCommitted {
  readonly kind: 'committed';
  readonly record: StoredChangesetRecord;
  readonly link: StoredChangesetCommitLink;
  readonly result: SendMessagesResult;
}

export type CommitSendMessagesOutcome =
  | CommitSendMessagesCommitted
  | { readonly kind: 'refused'; readonly refusal: unknown };

/**
 * The one-transaction send commit: changeset draft + proposal + exact-commit
 * validation + commit link, the immutable per-recipient releases, the
 * per-recipient effect specs, the outbound-delivery ledger registrations with
 * their root fact/outbox/history evidence, and the receipt link — all against
 * the caller's already-open SQLite transaction. It never awaits a provider and
 * never touches engagement state.
 */
export function commitSendMessagesChangeset(input: CommitSendMessagesInput): CommitSendMessagesOutcome {
  if (!input.sqlite.inTransaction) {
    throw new TypeError('communication_release_commit_transaction_required');
  }
  const bundle = createCommunicationReleaseChangesetBundle();
  const store = input.lifecycleStore ?? createSQLiteOrdinaryChangesetLifecycleStore(input.sqlite);
  const pinSource = createSQLiteCommunicationPreviewPinSource({
    sqlite: input.sqlite,
    currency: input.previewCurrency
  });
  const authorInput = sendMessagesAuthorInputSchema.parse(input.authorInput);
  if (authorInput.scope.workspaceId !== input.context.workspaceId
      || authorInput.scope.eventId !== input.context.eventId) {
    throw new TypeError('communication_release_commit_scope_mismatch');
  }
  const materializedByReleaseId = new Map<string, CommunicationMessageRelease>();
  for (const candidate of input.materializedReleases) {
    const release = parseCommunicationMessageRelease(candidate);
    if (materializedByReleaseId.has(release.releaseId)) {
      throw new CommunicationReleasePlanningError('release_batch_mismatch');
    }
    materializedByReleaseId.set(release.releaseId, release);
  }

  const snapshot: ChangesetPlanningSnapshot = Object.freeze({
    getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
      if ((key as unknown) !== communicationReleaseReadPort) {
        throw new TypeError('communication_release_undeclared_read_port');
      }
      return pinSource as unknown as Port;
    }
  });

  let builtReceipt: ChangesetCommitTerminalReceipt | undefined;
  const commitReleaseBatch = (plan: SendMessagesPlan): SendMessagesResult => {
    if (builtReceipt === undefined) {
      throw new TypeError('communication_release_commit_receipt_unbound');
    }
    const receiptId = builtReceipt.ref.id;
    if (plan.releases.length !== materializedByReleaseId.size) {
      throw new CommunicationReleasePlanningError('release_batch_mismatch');
    }
    for (const spec of plan.releases) {
      const release = materializedByReleaseId.get(spec.releaseId);
      if (release === undefined
          || release.workspaceId !== plan.scope.workspaceId
          || release.eventId !== plan.scope.eventId
          || release.batchId !== plan.batchId
          || release.recipientRefId !== spec.recipientRefId
          || release.personRefId !== spec.personRefId
          || release.contactRefId !== spec.contactRefId
          || release.templateRevisionRefId !== spec.templateRevisionRefId
          || release.contentRefId !== spec.contentRefId
          || release.reviewedMessageDigestSha256 !== spec.reviewedMessageDigestSha256
          || release.reviewedEnvelopeDigestSha256 !== spec.reviewedEnvelopeDigestSha256) {
        throw new CommunicationReleasePlanningError('release_batch_mismatch');
      }
      const work = workInputFor(plan, spec);
      const existing = input.sqlite.query<{ readonly release_id: string }, [string]>(`
        SELECT release_id FROM communication_outbound_delivery_heads WHERE delivery_id = ? LIMIT 1
      `).get(work.deliveryId);
      if (existing !== null && existing !== undefined) {
        throw new CommunicationReleasePlanningError('delivery_identity_changed');
      }
      input.releases.put(release);
      insertOutboundEmailDeliveryRegistration({
        sqlite: input.sqlite,
        workspaceId: plan.scope.workspaceId,
        eventId: plan.scope.eventId,
        work,
        evidence: {
          rootFactId: input.ids.newEvidenceId(),
          rootPointerId: input.ids.newEvidenceId(),
          historyThreadId: input.ids.newEvidenceId(),
          rootHistoryId: input.ids.newEvidenceId()
        },
        createdAt: input.context.evaluatedAt
      });
      const head = input.sqlite.query<{
        readonly root_fact_id: string;
        readonly root_outbox_pointer_id: string;
        readonly history_thread_id: string;
        readonly root_history_id: string;
      }, [string]>(`
        SELECT root_fact_id, root_outbox_pointer_id, history_thread_id, root_history_id
          FROM communication_outbound_delivery_heads WHERE delivery_id = ?
      `).get(work.deliveryId);
      if (!head) throw new TypeError('communication_release_registration_missing');
      const occurredAtMs = Date.parse(input.context.evaluatedAt);
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_facts (
          fact_id, receipt_id, workspace_id, event_id, delivery_id,
          fact_kind, fact_version, payload_json, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'outbound_email_delivery_requested', 1, ?, ?)
      `).run(
        head.root_fact_id, receiptId, plan.scope.workspaceId, plan.scope.eventId,
        work.deliveryId,
        canonicalJsonText({
          contractVersion: 1,
          releaseId: work.releaseId,
          reviewedMessageDigestSha256: work.reviewedMessageDigestSha256,
          reviewedEnvelopeDigestSha256: work.reviewedEnvelopeDigestSha256,
          recipientRefId: work.recipientRefId,
          templateRevisionRefId: work.templateRevisionRefId,
          contentRefId: work.contentRefId
        }),
        occurredAtMs
      );
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_outbox (
          pointer_id, receipt_id, fact_id, delivery_id, purpose, created_at_ms
        ) VALUES (?, ?, ?, ?, 'communication.outbound-email.dispatch', ?)
      `).run(
        head.root_outbox_pointer_id, receiptId, head.root_fact_id, work.deliveryId, occurredAtMs
      );
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_history (
          history_id, thread_id, sequence, receipt_id, fact_id, delivery_id,
          attempt_id, parent_history_id, summary_code, occurred_at_ms
        ) VALUES (?, ?, 0, ?, ?, ?, NULL, NULL, 'communication.outbound-email.requested', ?)
      `).run(
        head.root_history_id, head.history_thread_id, receiptId, head.root_fact_id,
        work.deliveryId, occurredAtMs
      );
      linkOutboundEmailDeliveryReceipt({
        sqlite: input.sqlite,
        deliveryId: work.deliveryId,
        receiptId
      });
      input.sqlite.query(`
        INSERT INTO communication_release_effect_specs (
          spec_id, receipt_id, workspace_id, event_id, batch_id, release_id, delivery_id,
          work_digest_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.ids.newEvidenceId(), receiptId, plan.scope.workspaceId, plan.scope.eventId,
        plan.batchId, spec.releaseId, spec.deliveryId, digestHex(work)
      );
    }
    return sendMessagesResult(plan);
  };

  const transaction: ChangesetCommitTransaction = Object.freeze({
    getPort<Port>(key: ChangesetValidationPortKey<Port> | ChangesetTransactionPortKey<Port>): Port {
      if ((key as unknown) === communicationReleaseValidationPort) {
        return pinSource as unknown as Port;
      }
      if ((key as unknown) === communicationReleaseTransactionPort) {
        return Object.freeze({ commitReleaseBatch }) as unknown as Port;
      }
      throw new TypeError('communication_release_undeclared_transaction_port');
    }
  });

  const actorContext = Object.freeze({
    workspaceId: input.context.workspaceId,
    eventId: input.context.eventId,
    principalKey: input.context.principalKey,
    authorityPrincipalKey: input.context.authorityPrincipalKey,
    evaluatedAt: input.context.evaluatedAt
  });
  const lifecycleIds = Object.freeze({
    newChangesetId: () => input.ids.newChangesetId(),
    newRevisionId: () => input.ids.newRevisionId(),
    newApprovalId: () => input.ids.newApprovalId(),
    newCorrectionAttemptId: () => input.ids.newCorrectionAttemptId()
  });

  const drafted = appendChangesetDraftSynchronous({
    store,
    registry: bundle.registry,
    snapshot,
    ids: lifecycleIds,
    context: actorContext,
    operations: [{
      kind: SEND_MESSAGES_CHANGESET_KIND,
      version: SEND_MESSAGES_CHANGESET_VERSION,
      dependencyGroup: 'send',
      authorInput
    }],
    dependencyGroups: [{ key: 'send', dependsOn: [] }],
    approvalPolicy: SEND_MESSAGES_APPROVAL_POLICY,
    origin: 'human_ui'
  });
  if (drafted.kind === 'refused') return Object.freeze({ kind: 'refused', refusal: drafted.refusal });
  const record = drafted.record;
  const revision = record.revisions.at(-1)!.revision;

  const proposed = proposeStoredChangeset({
    store,
    context: actorContext,
    changesetId: record.head.id,
    expectedHeadVersion: record.head.version,
    revisionId: revision.id,
    revisionDigest: revision.digest
  });
  if (proposed.kind === 'refused') {
    return Object.freeze({ kind: 'refused', refusal: proposed.refusal });
  }

  // The lifecycle guard maps attest the immutable adopted row's identity;
  // live domain currency is enforced by validateWithin inside this same
  // transaction so drift surfaces as the declared typed
  // `communication.preview_changed` refusal, not a lifecycle guard conflict.
  const pin = pinSource.readPreviewPin({
    workspaceId: authorInput.scope.workspaceId,
    eventId: authorInput.scope.eventId,
    audienceSpecId: authorInput.preview.identity.audienceSpecId
  });
  const guardId = sendMessagesPreviewGuardId(authorInput.preview.identity.audienceSpecId);
  const guardVersions = new Map<string, number>();
  const guardDigests = new Map<string, string>();
  if (pin !== undefined) {
    guardVersions.set(guardId, pin.identity.previewGeneration);
    guardDigests.set(guardId, pin.identity.previewDigestSha256);
  }
  const validated = validateStoredChangesetCommit({
    store,
    context: actorContext,
    changesetId: proposed.record.head.id,
    expectedHeadVersion: proposed.record.head.version,
    revisionId: revision.id,
    revisionDigest: revision.digest,
    currentApprovalPolicy: SEND_MESSAGES_APPROVAL_POLICY,
    currentAggregateVersions: new Map(),
    currentGuardVersions: guardVersions,
    currentGuardDigests: guardDigests,
    approverCurrentlyAuthorized: () => false,
    receiptExpectation: {
      operation: COMMIT_CHANGESET_OPERATION,
      surface: input.receiptExpectation.surface,
      scopePartitionKey: input.receiptExpectation.scopePartitionKey,
      authorityPrincipalKey: input.context.authorityPrincipalKey,
      requestHashSha256: input.receiptExpectation.requestHashSha256
    }
  });
  if (validated.kind === 'refused') {
    return Object.freeze({ kind: 'refused', refusal: validated.refusal });
  }
  builtReceipt = parseChangesetCommitTerminalReceipt(input.terminalReceipt({
    changesetId: proposed.record.head.id,
    expectedHeadVersion: proposed.record.head.version,
    committedHeadVersion: proposed.record.head.version + 1,
    revisionId: revision.id,
    revisionDigest: revision.digest
  }));

  const prepared = prepareChangesetCommitSynchronous({
    registry: bundle.registry,
    authorization: validated.commit.authorization,
    transaction
  });
  if (prepared.kind === 'outcome') {
    return Object.freeze({ kind: 'refused', refusal: prepared.outcome });
  }
  const applied = applyPreparedChangesetSynchronous(prepared.prepared);
  const contribution = applied[0];
  if (applied.length !== 1 || contribution === undefined
      || contribution.facts.length !== 1
      || contribution.facts[0]!.kind !== 'communication_release_committed') {
    throw new TypeError('communication_release_contribution_invalid');
  }
  const result = sendMessagesResultSchema.parse(contribution.result);

  const committed = commitStoredChangeset({
    store,
    commit: validated.commit,
    terminalReceipt: builtReceipt
  });
  input.sqlite.query(`
    INSERT INTO communication_release_receipt_links (
      receipt_id, action, workspace_id, event_id, changeset_id, revision_id, batch_id,
      record_digest_sha256, occurred_at_ms
    ) VALUES (?, 'commit', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    builtReceipt.ref.id, input.context.workspaceId, input.context.eventId,
    committed.record.head.id, revision.id, authorInput.batchId,
    committed.record.recordDigestSha256, Date.parse(input.context.evaluatedAt)
  );

  return Object.freeze({ kind: 'committed', record: committed.record, link: committed.link, result });
}

function ownsSendMessagesChangeset(
  bundle: CommunicationReleaseChangesetBundle,
  record: StoredChangesetRecord
): boolean {
  if (record.head.eventId === undefined) return false;
  for (const revision of record.revisions) {
    for (const operation of revision.revision.operations) {
      if (operation.kind !== SEND_MESSAGES_CHANGESET_KIND
          || operation.version !== SEND_MESSAGES_CHANGESET_VERSION) return false;
      const schema = bundle.registry.getSchema(operation.planSchema);
      const plan = schema?.schema.safeParse(operation.plan);
      if (!plan?.success) return false;
      const parsed = plan.data as SendMessagesPlan;
      if (parsed.scope.workspaceId !== record.head.workspaceId
          || parsed.scope.eventId !== record.head.eventId) return false;
    }
  }
  return true;
}

/**
 * Changeset-lifecycle owner registration for the send-wave changeset. The
 * shared lifecycle router mounts it under `SEND_MESSAGES_CHANGESET_OWNER_ID`;
 * the runtime effect adapter (J-RT-2) drives `commitSendMessagesChangeset`
 * against the same registry and store.
 */
export function createSQLiteCommunicationReleaseChangesetOwnerRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: string;
}): Readonly<{
  ownerId: typeof SEND_MESSAGES_CHANGESET_OWNER_ID;
  bundle: CommunicationReleaseChangesetBundle;
  lifecycleStore: ChangesetLifecycleStore;
  ownerResolution: ChangesetLifecycleOwnerResolutionSource;
  subjectRelationships: SQLiteOperatorSubjectRelationshipSource;
}> {
  const bundle = createCommunicationReleaseChangesetBundle();
  const lifecycleStore = createSQLiteOrdinaryChangesetLifecycleStore(input.sqlite);
  const ownerResolution: ChangesetLifecycleOwnerResolutionSource = Object.freeze({
    resolveOwner(record: StoredChangesetRecord): ChangesetLifecycleOwnerResolution | undefined {
      if (!ownsSendMessagesChangeset(bundle, record)) return undefined;
      return Object.freeze({
        id: SEND_MESSAGES_CHANGESET_OWNER_ID,
        evidenceIds: Object.freeze([
          `communication-release-definition:${bundle.registry.registryDigestSha256}`
        ])
      });
    }
  });
  const subjectRelationships: SQLiteOperatorSubjectRelationshipSource = Object.freeze({
    validateSubject({ sqlite, workspaceId, eventId, subject }:
      Parameters<SQLiteOperatorSubjectRelationshipSource['validateSubject']>[0]) {
      if (sqlite !== input.sqlite
          || workspaceId !== input.workspaceId
          || eventId === undefined
          || subject.kind !== 'domain'
          || subject.domain !== 'changeset'
          || subject.entity !== 'owner'
          || subject.id !== SEND_MESSAGES_CHANGESET_OWNER_ID
          || subject.version !== undefined) {
        return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }
      const rows = sqlite.query<{ readonly event_id: string }, [string, string]>(`
        SELECT event_id FROM event_spine_scope_roots
         WHERE workspace_id = ? AND event_id = ? LIMIT 2
      `).all(workspaceId, eventId);
      return rows.length === 1 && rows[0]?.event_id === eventId
        ? Object.freeze({
            kind: 'valid' as const,
            evidenceIds: Object.freeze([
              `changeset-owner:communication_release:${eventId}:${bundle.registry.registryDigestSha256}`
            ])
          })
        : Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
    }
  });
  return Object.freeze({
    ownerId: SEND_MESSAGES_CHANGESET_OWNER_ID,
    bundle,
    lifecycleStore,
    ownerResolution,
    subjectRelationships
  });
}
