import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  parseCommunicationMessageRelease,
  type CommunicationMessageRelease
} from '@jooevents/communications';
import {
  sendMessagesPlanSchema,
  sendMessagesResult,
  sendMessagesResultSchema,
  sendMessagesSafeDiff,
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
import {
  insertOutboundEmailDeliveryRegistration,
  linkOutboundEmailDeliveryReceipt
} from '../outbound-email-delivery';
import type { SQLiteCommunicationMessageReleaseStore } from './message-releases';

/** Owner-native release audit and delivery-effect tables. */
export const SQLITE_COMMUNICATION_RELEASE_SQL = `
CREATE TABLE communication_release_commits (
  commit_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  plan_digest_sha256 TEXT NOT NULL CHECK(length(plan_digest_sha256) = 64),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  UNIQUE(workspace_id, event_id, batch_id)
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

CREATE TRIGGER communication_release_effect_specs_no_update
BEFORE UPDATE ON communication_release_effect_specs
BEGIN SELECT RAISE(ABORT, 'communication release effect specs are immutable'); END;
CREATE TRIGGER communication_release_effect_specs_no_delete
BEFORE DELETE ON communication_release_effect_specs
BEGIN SELECT RAISE(ABORT, 'communication release effect specs are immutable'); END;
CREATE TRIGGER communication_release_commits_no_update
BEFORE UPDATE ON communication_release_commits
BEGIN SELECT RAISE(ABORT, 'communication release commits are immutable'); END;
CREATE TRIGGER communication_release_commits_no_delete
BEFORE DELETE ON communication_release_commits
BEGIN SELECT RAISE(ABORT, 'communication release commits are immutable'); END;
`;

export function installCommunicationReleaseSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('communication_release_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_COMMUNICATION_RELEASE_SQL)).immediate();
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

export interface CommunicationReleasePreviewReadPort {
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

function digestHex(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
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
}): CommunicationReleasePreviewReadPort {
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
  readonly previewCurrency: CommunicationAdoptedPreviewCurrencySource;
  readonly ids: { newEvidenceId(): string };
  readonly context: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly principalKey: string;
    readonly authorityPrincipalKey: string;
    readonly evaluatedAt: string;
  };
  readonly authorInput: SendMessagesAuthorInput;
  readonly materializedReleases: readonly CommunicationMessageRelease[];
}

export interface CommitSendMessagesCommitted {
  readonly kind: 'committed';
  readonly releaseCommitId: string;
  readonly result: SendMessagesResult;
}

export type CommitSendMessagesOutcome =
  | CommitSendMessagesCommitted
  | { readonly kind: 'refused'; readonly refusal: unknown };

/** Commits one adopted, reviewed preview through the Communications owner. */
export function commitSendMessagesRelease(input: CommitSendMessagesInput): CommitSendMessagesOutcome {
  if (!input.sqlite.inTransaction) {
    throw new TypeError('communication_release_commit_transaction_required');
  }
  const plan = sendMessagesPlanSchema.parse(input.authorInput);
  if (plan.scope.workspaceId !== input.context.workspaceId
      || plan.scope.eventId !== input.context.eventId) {
    throw new TypeError('communication_release_commit_scope_mismatch');
  }
  const pin = createSQLiteCommunicationPreviewPinSource({
    sqlite: input.sqlite,
    currency: input.previewCurrency
  }).readPreviewPin({
    workspaceId: plan.scope.workspaceId,
    eventId: plan.scope.eventId,
    audienceSpecId: plan.preview.identity.audienceSpecId
  });
  if (pin === undefined) throw new CommunicationReleasePlanningError('preview_not_found');
  if (!pinMatches(pin, plan)) throw new CommunicationReleasePlanningError('preview_changed');
  if (pin.currency !== 'current') {
    return Object.freeze({ kind: 'refused', refusal: previewGuardRefusal(plan) });
  }
  const materializedByReleaseId = new Map<string, CommunicationMessageRelease>();
  for (const candidate of input.materializedReleases) {
    const release = parseCommunicationMessageRelease(candidate);
    if (materializedByReleaseId.has(release.releaseId)) {
      throw new CommunicationReleasePlanningError('release_batch_mismatch');
    }
    materializedByReleaseId.set(release.releaseId, release);
  }
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
    const existing = input.sqlite.query<{ readonly release_id: string }, [string]>(`
      SELECT release_id FROM communication_outbound_delivery_heads WHERE delivery_id = ? LIMIT 1
    `).get(spec.deliveryId);
    if (existing !== null && existing !== undefined) {
      throw new CommunicationReleasePlanningError('delivery_identity_changed');
    }
  }
  const releaseCommitId = input.ids.newEvidenceId();
  input.sqlite.query(`
    INSERT INTO communication_release_commits (
      commit_id, workspace_id, event_id, batch_id, plan_digest_sha256, plan_json, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    releaseCommitId, plan.scope.workspaceId, plan.scope.eventId, plan.batchId,
    digestHex(plan), canonicalJsonText(plan), Date.parse(input.context.evaluatedAt)
  );
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
      head.root_fact_id, releaseCommitId, plan.scope.workspaceId, plan.scope.eventId,
      work.deliveryId,
      canonicalJsonText({
        contractVersion: 1, releaseId: work.releaseId,
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
      head.root_outbox_pointer_id, releaseCommitId, head.root_fact_id, work.deliveryId, occurredAtMs
    );
    input.sqlite.query(`
      INSERT INTO communication_outbound_delivery_history (
        history_id, thread_id, sequence, receipt_id, fact_id, delivery_id,
        attempt_id, parent_history_id, summary_code, occurred_at_ms
      ) VALUES (?, ?, 0, ?, ?, ?, NULL, NULL, 'communication.outbound-email.requested', ?)
    `).run(
      head.root_history_id, head.history_thread_id, releaseCommitId, head.root_fact_id,
      work.deliveryId, occurredAtMs
    );
    linkOutboundEmailDeliveryReceipt({
      sqlite: input.sqlite, deliveryId: work.deliveryId, receiptId: releaseCommitId
    });
    input.sqlite.query(`
      INSERT INTO communication_release_effect_specs (
        spec_id, receipt_id, workspace_id, event_id, batch_id, release_id, delivery_id,
        work_digest_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.ids.newEvidenceId(), releaseCommitId, plan.scope.workspaceId, plan.scope.eventId,
      plan.batchId, spec.releaseId, spec.deliveryId, digestHex(work)
    );
  }
  return Object.freeze({
    kind: 'committed',
    releaseCommitId,
    result: sendMessagesResultSchema.parse(sendMessagesResult(plan))
  });
}
