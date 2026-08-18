import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { createClassifiedPayloadProfileRef } from '@jooevents/application';
import type {
  SynchronousClassifiedPayloadBinding,
  SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  DECISION_NOTIFICATION_PURPOSE_KEY,
  buildCommunicationMessageRelease,
  organizerAudienceCandidateSchema,
  organizerClassifiedEmailAddressSchema,
  type CommunicationMessageRelease
} from '@jooevents/communications';
import {
  SEND_MESSAGES_RECIPIENT_LIMIT,
  sendMessagesAuthorInputSchema
} from '@jooevents/communication-operations';
import {
  organizerMessagePreviewSummarySchema,
  organizerServerRenderedEmailSchema
} from '@jooevents/contracts/communications/organizer';
import {
  canonicalJsonText,
  createPayloadRef,
  encodeCanonicalJson,
  parseEventId,
  parsePayloadRefId,
  parseWorkspaceId
} from '@jooevents/kernel';
import type {
  SQLiteOrganizerAudiencePreviewRepository
} from '@jooevents/persistence/organizer-audience-preview';
import { SQLiteOrganizerAudiencePreviewError } from '@jooevents/persistence/organizer-audience-preview';
import type {
  SQLiteCommunicationMessageReleaseStore
} from '@jooevents/persistence/message-releases';
import {
  commitSendMessagesRelease,
  type CommitSendMessagesOutcome
} from '@jooevents/persistence/message-release-effect-domain';
import { z } from 'zod';

/**
 * Composed decision-notification send lane over the mounted preview
 * repository, release store, and outbound-delivery ledger schema.
 *
 * This is deliberately a server-internal composition seam, not an operation
 * module. The owner-native release commit and delivery registrations run in
 * one transaction. The J-WEB-2 (P8) HTTP mounting consumes exactly this seam;
 * every call requires explicit operator attribution from the invoking
 * operation so the release remains auditable.
 */

/** Explicit operator attribution for the owner-native release commit. */
export interface CommunicationSendAttribution {
  readonly scopePartitionKey: string;
  readonly authorityPrincipalKey: string;
  readonly principalKey: string;
}

export interface AdoptDecisionPreviewInput {
  readonly draftId: string;
  readonly expectedDraftVersion: number;
}

export type AdoptDecisionPreviewOutcome =
  | { readonly kind: 'adopted'; readonly summary: z.infer<typeof organizerMessagePreviewSummarySchema> }
  | { readonly kind: 'refused'; readonly code: string };

export interface SendDecisionMessagesInput {
  readonly audienceSpecId: string;
  readonly batchId: string;
  readonly subject: string;
  readonly audienceLabel: string;
  readonly attribution: CommunicationSendAttribution;
}

export type SendDecisionMessagesOutcome =
  | {
      readonly kind: 'committed';
      readonly releaseCommitId: string;
      readonly result: {
        readonly batchId: string;
        readonly dispatchGeneration: 1;
        readonly releaseCount: number;
        readonly deliveryIds: readonly string[];
      };
    }
  | { readonly kind: 'refused'; readonly refusal: unknown };

export interface CommunicationSendLane {
  adoptDecisionPreview(input: AdoptDecisionPreviewInput): Promise<AdoptDecisionPreviewOutcome>;
  sendDecisionMessages(input: SendDecisionMessagesInput): SendDecisionMessagesOutcome;
}

/**
 * No outbound provider is activated in this runtime (recorder default
 * BLOCKED-2): the sender presentation is an explicit unconfigured profile on a
 * reserved `.invalid` host, and the external delivery key is not a fake
 * scenario key, so the deterministic fake terminally rejects every attempt and
 * each delivery lands honestly not-delivered.
 */
const UNCONFIGURED_PROVIDER_CONNECTION_REVISION_ID = 'provider.connection.not-activated';
const UNCONFIGURED_EXTERNAL_DELIVERY_KEY = 'provider.not-activated';

function digest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

const UNCONFIGURED_SENDER = (() => {
  const presentation = Object.freeze({
    fromAddress: 'no-reply@unconfigured.invalid',
    fromDisplayName: 'JooEvents (no outbound provider activated)',
    senderProfileRevisionId: 'sender.profile.not-activated',
    senderPresentationContractKey: 'sender.presentation.email-v1',
    senderPresentationContractVersion: 1
  });
  return Object.freeze({
    ...presentation,
    senderPresentationDigestSha256: digest({ schemaVersion: 1, presentation })
  });
})();

export type CommunicationSenderPresentation = Readonly<{
  fromAddress: string;
  fromDisplayName?: string;
  replyToAddress?: string;
  senderProfileRevisionId: string;
  senderPresentationContractKey: string;
  senderPresentationContractVersion: number;
  senderPresentationDigestSha256: string;
}>;

/**
 * Digest-pinned sender presentation for the per-installation deployment
 * sender identity (`JOOEVENTS_MAIL_*`). Same contract key and digest recipe as
 * the unconfigured profile, so releases stay verifiable either way.
 */
export function buildDeploymentSenderPresentation(sender: Readonly<{
  fromAddress: string;
  fromDisplayName?: string;
  replyToAddress?: string;
}>): CommunicationSenderPresentation {
  const presentation = Object.freeze({
    fromAddress: sender.fromAddress,
    ...(sender.fromDisplayName === undefined
      ? {}
      : { fromDisplayName: sender.fromDisplayName }),
    ...(sender.replyToAddress === undefined
      ? {}
      : { replyToAddress: sender.replyToAddress }),
    senderProfileRevisionId: 'sender.profile.deployment-env.v1',
    senderPresentationContractKey: 'sender.presentation.email-v1',
    senderPresentationContractVersion: 1
  });
  return Object.freeze({
    ...presentation,
    senderPresentationDigestSha256: digest({ schemaVersion: 1, presentation })
  });
}

/**
 * Route to the one activated outbound provider connection. Absent (the
 * default), the lane keeps the inert-provider posture above byte for byte:
 * unconfigured `.invalid` sender, sentinel connection revision, and the
 * non-scenario external key the deterministic fake terminally rejects.
 */
export type CommunicationDeliveryRoute = Readonly<{
  providerConnectionRevisionId: string;
  sender: CommunicationSenderPresentation;
}>;

/**
 * Mirror of the audience-preview repository's private classified binding for
 * adopted snapshots (`profiles('preview')` + `previewBinding` in
 * `@jooevents/persistence/organizer-audience-preview`). The binding is pure
 * data; any drift there fails this read loudly and the joined runtime test
 * pins the round trip.
 */
export function adoptedPreviewBinding(input: {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly ownerKey: string;
  readonly audienceSpecId: string;
}): SynchronousClassifiedPayloadBinding {
  return Object.freeze({
    profiles: Object.freeze({
      classification: createClassifiedPayloadProfileRef(
        'classification', 'classification.communication.preview.exact', 1
      ),
      schema: createClassifiedPayloadProfileRef('schema', 'schema.communication.preview.exact', 1),
      content: createClassifiedPayloadProfileRef('content', 'content.communication.preview.exact', 1),
      integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
      descriptorAuth: createClassifiedPayloadProfileRef(
        'descriptor_auth', 'descriptor_auth.communication.audience-preview', 1
      )
    }),
    scopeBinding: canonicalJsonText({
      workspaceId: input.workspaceId,
      eventId: input.eventId,
      ownerKey: input.ownerKey,
      audienceSpecId: input.audienceSpecId
    }),
    contentType: 'application/json'
  });
}

export const adoptedSnapshotSchema = z.looseObject({
  summary: organizerMessagePreviewSummarySchema,
  rows: z.array(z.discriminatedUnion('state', [
    z.looseObject({
      state: z.literal('included'),
      recipientResolutionId: z.string().min(1),
      candidate: organizerAudienceCandidateSchema,
      address: organizerClassifiedEmailAddressSchema.optional(),
      releaseId: z.string().min(1),
      releaseDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      render: organizerServerRenderedEmailSchema
    }),
    z.looseObject({ state: z.literal('excluded') }),
    z.looseObject({ state: z.literal('blocked') })
  ])).max(SEND_MESSAGES_RECIPIENT_LIMIT)
});

export type AdoptedDecisionSnapshot = z.infer<typeof adoptedSnapshotSchema>;

interface AdoptedSnapshotRow {
  readonly owner_key: string;
  readonly summary_json: string;
  readonly snapshot_payload_ref_id: string;
  readonly snapshot_byte_size: number;
  readonly snapshot_digest_sha256: string;
}

function deterministicUuid(namespace: string, material: unknown): string {
  const hex = digest({ namespace, material });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Opens one adopted preview snapshot, digest- and binding-verified. */
export function openAdoptedDecisionSnapshot(input: {
  readonly sqlite: Database;
  readonly classifiedStore: SynchronousClassifiedPayloadStore;
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
  readonly audienceSpecId: string;
}): AdoptedDecisionSnapshot | undefined {
  const rows = input.sqlite.query<AdoptedSnapshotRow, [string, string, string]>(`
    SELECT owner_key, summary_json, snapshot_payload_ref_id, snapshot_byte_size,
           snapshot_digest_sha256
      FROM communication_message_preview_snapshots
     WHERE workspace_id = ? AND event_id = ? AND audience_spec_id = ? LIMIT 2
  `).all(input.scope.workspaceId, input.scope.eventId, input.audienceSpecId);
  if (rows.length !== 1) return undefined;
  const row = rows[0]!;
  const bytes = input.classifiedStore.read({
    payloadRef: createPayloadRef(parsePayloadRefId(row.snapshot_payload_ref_id)),
    expectedBinding: adoptedPreviewBinding({
      workspaceId: input.scope.workspaceId,
      eventId: input.scope.eventId,
      ownerKey: row.owner_key,
      audienceSpecId: input.audienceSpecId
    }),
    purpose: 'communication.preview.exact'
  });
  try {
    if (bytes.byteLength !== row.snapshot_byte_size
        || createHash('sha256').update(bytes).digest('hex') !== row.snapshot_digest_sha256) {
      throw new TypeError('communication_send_lane_snapshot_corrupt');
    }
    const snapshot = adoptedSnapshotSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    );
    if (canonicalJsonText(snapshot.summary) !== row.summary_json) {
      throw new TypeError('communication_send_lane_snapshot_corrupt');
    }
    return snapshot;
  } finally {
    bytes.fill(0);
  }
}

export interface MaterializedDecisionSendBatch {
  readonly materialized: readonly CommunicationMessageRelease[];
  readonly specs: readonly ReturnType<typeof releaseSpec>[];
}

function releaseSpec(release: CommunicationMessageRelease, row: {
  readonly address: NonNullable<
    Extract<AdoptedDecisionSnapshot['rows'][number], { state: 'included' }>['address']
  >;
}, batchId: string, route: CommunicationDeliveryRoute | undefined) {
  const sender = route?.sender ?? UNCONFIGURED_SENDER;
  return {
    releaseId: release.releaseId,
    deliveryId: deterministicUuid('communication.send.delivery', {
      batchId,
      releaseId: release.releaseId
    }),
    recipientRefId: release.recipientRefId,
    personRefId: release.personRefId,
    contactRefId: release.contactRefId,
    templateRevisionRefId: release.templateRevisionRefId,
    contentRefId: release.contentRefId,
    reviewedMessageDigestSha256: release.reviewedMessageDigestSha256,
    reviewedEnvelopeDigestSha256: release.reviewedEnvelopeDigestSha256,
    providerConnectionRevisionId:
      route?.providerConnectionRevisionId ?? UNCONFIGURED_PROVIDER_CONNECTION_REVISION_ID,
    externalDeliveryKey: route === undefined
      ? UNCONFIGURED_EXTERNAL_DELIVERY_KEY
      : deterministicUuid('communication.send.external-delivery', {
          batchId,
          releaseId: release.releaseId
        }),
    senderProfileRevisionId: sender.senderProfileRevisionId,
    senderPresentationContractKey: sender.senderPresentationContractKey,
    senderPresentationContractVersion: sender.senderPresentationContractVersion,
    senderPresentationDigestSha256: sender.senderPresentationDigestSha256,
    channelAddressId: row.address.addressRefId,
    channelAddressVersion: row.address.addressVersion,
    addressLookupFingerprintProfile: row.address.lookupFingerprint.profile,
    addressLookupFingerprintVersion: row.address.lookupFingerprint.version,
    addressLookupFingerprintSha256: row.address.lookupFingerprint.keyedValue
  };
}

/**
 * Materializes the reviewed, digest-pinned releases for one adopted snapshot:
 * one immutable release and one deterministic delivery spec per included
 * recipient. Without a delivery route (the default) the sender stays the
 * explicit unconfigured `.invalid` profile and the deterministic fake
 * terminally rejects every attempt (BLOCKED-2); with the activated provider's
 * route, specs cite the active connection revision, the configured deployment
 * sender, and a deterministic per-delivery external key.
 */
export function materializeDecisionSendBatch(input: {
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
  readonly snapshot: AdoptedDecisionSnapshot;
  readonly batchId: string;
  readonly now: string;
  readonly route?: CommunicationDeliveryRoute;
}): MaterializedDecisionSendBatch {
  const summary = input.snapshot.summary;
  const contentRefId = deterministicUuid('communication.send.reviewed-content', {
    draftId: summary.identity.draftId,
    draftVersion: summary.identity.draftVersion
  });
  const templateRevisionRefId = summary.templateRevision?.templateRevisionId
    ?? deterministicUuid('communication.send.message-content', {
      draftId: summary.identity.draftId,
      draftVersion: summary.identity.draftVersion
    });
  const materialized: CommunicationMessageRelease[] = [];
  const specs = [];
  for (const row of input.snapshot.rows) {
    if (row.state !== 'included') continue;
    if (row.address === undefined || row.address.contactRefId !== row.candidate.contactRefId) {
      throw new TypeError('communication_send_lane_included_row_address_invalid');
    }
    const release = buildCommunicationMessageRelease({
      workspaceId: input.scope.workspaceId,
      eventId: input.scope.eventId,
      releaseId: row.releaseId,
      batchId: input.batchId,
      recipientRefId: row.recipientResolutionId,
      personRefId: row.candidate.personRefId,
      contactRefId: row.candidate.contactRefId,
      templateRevisionRefId,
      contentRefId,
      purposeKey: DECISION_NOTIFICATION_PURPOSE_KEY,
      // The reviewed message digest is the reviewed render's output digest,
      // so "send exactly what was reviewed" is digest-pinned per recipient.
      reviewedMessageDigestSha256: row.render.outputDigestSha256,
      sender: input.route?.sender ?? UNCONFIGURED_SENDER,
      toAddress: row.address.classifiedValue.value,
      subject: row.render.subject,
      textBody: row.render.plainText,
      htmlBody: row.render.sanitizedHtml,
      attachments: row.render.attachments.map((attachment) => Object.freeze({
        contentBytesRef: attachment.contentBytesRef,
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        byteLength: attachment.byteLength,
        contentSha256: attachment.contentSha256,
        disposition: attachment.disposition,
        ...(attachment.contentId === undefined ? {} : { contentId: attachment.contentId })
      })),
      createdAt: input.now
    });
    materialized.push(release);
    specs.push(releaseSpec(release, { address: row.address }, input.batchId, input.route));
  }
  specs.sort((left, right) => (left.releaseId < right.releaseId ? -1 : 1));
  return Object.freeze({ materialized: Object.freeze(materialized), specs: Object.freeze(specs) });
}

/** The reviewed batch as the owner-native release commit input. */
export function buildDecisionSendAuthorInput(input: {
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
  readonly snapshot: AdoptedDecisionSnapshot;
  readonly batch: MaterializedDecisionSendBatch;
  readonly batchId: string;
  readonly subject: string;
  readonly audienceLabel: string;
  readonly now: string;
}) {
  const summary = input.snapshot.summary;
  return sendMessagesAuthorInputSchema.parse({
    schemaVersion: 1,
    action: 'send',
    scope: input.scope,
    batchId: input.batchId,
    purposeRevision: summary.purposeRevision,
    ...(summary.templateRevision === undefined
      ? {}
      : { templateRevision: summary.templateRevision }),
    subject: input.subject,
    audienceLabel: input.audienceLabel,
    preview: {
      identity: summary.identity,
      membershipDigestSha256: summary.membershipDigestSha256,
      evidenceDigestSha256: summary.evidenceDigestSha256,
      sourceVersions: summary.sourceVersions
    },
    releases: input.batch.specs,
    requestedAt: input.now
  });
}

export function decisionSendRequestHash(input: {
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
  readonly audienceSpecId: string;
  readonly batchId: string;
}): string {
  return digest({
    lane: 'communication.send-lane',
    operation: 'send_messages',
    scope: input.scope,
    audienceSpecId: input.audienceSpecId,
    batchId: input.batchId
  });
}
export function createCommunicationSendLane(input: {
  readonly sqlite: Database;
  readonly workspaceId: string;
  readonly currentEventId: () => string;
  readonly previewRepository: SQLiteOrganizerAudiencePreviewRepository;
  readonly classifiedStore: SynchronousClassifiedPayloadStore;
  readonly releases: SQLiteCommunicationMessageReleaseStore;
  readonly clock: { now(): string };
  readonly deliveryRoute?: CommunicationDeliveryRoute;
}): CommunicationSendLane {
  function transaction<Value>(work: () => Value): Value {
    if (input.sqlite.inTransaction) {
      throw new TypeError('communication_send_lane_requires_own_transaction');
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
  }

  function draftOwnerKey(scope: { workspaceId: string; eventId: string }, draftId: string): string {
    const rows = input.sqlite.query<{ readonly owner_key: string }, [string, string, string]>(`
      SELECT owner_key FROM communication_drafts
       WHERE workspace_id = ? AND event_id = ? AND draft_id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId, draftId);
    if (rows.length !== 1) throw new TypeError('communication_send_lane_draft_missing');
    return rows[0]!.owner_key;
  }

  function adoptedSnapshot(scope: { workspaceId: string; eventId: string }, audienceSpecId: string) {
    return openAdoptedDecisionSnapshot({
      sqlite: input.sqlite,
      classifiedStore: input.classifiedStore,
      scope,
      audienceSpecId
    });
  }

  return Object.freeze({
    async adoptDecisionPreview(
      request: AdoptDecisionPreviewInput
    ): Promise<AdoptDecisionPreviewOutcome> {
      const scope = {
        workspaceId: parseWorkspaceId(input.workspaceId),
        eventId: parseEventId(input.currentEventId())
      };
      try {
        const ownerKey = draftOwnerKey(scope, request.draftId);
        const preparation = await input.previewRepository.preparePreview({
          scope,
          ownerKey,
          draftId: request.draftId,
          expectedDraftVersion: request.expectedDraftVersion,
          now: input.clock.now()
        });
        const summary = transaction(() => input.previewRepository.adoptPreparedPreview({
          preparation,
          scope,
          ownerKey,
          now: input.clock.now()
        }));
        return Object.freeze({ kind: 'adopted', summary });
      } catch (error) {
        if (error instanceof SQLiteOrganizerAudiencePreviewError) {
          return Object.freeze({ kind: 'refused', code: error.code });
        }
        throw error;
      }
    },

    sendDecisionMessages(request: SendDecisionMessagesInput): SendDecisionMessagesOutcome {
      const scope = {
        workspaceId: parseWorkspaceId(input.workspaceId),
        eventId: parseEventId(input.currentEventId())
      };
      const now = input.clock.now();
      const snapshot = adoptedSnapshot(scope, request.audienceSpecId);
      if (snapshot === undefined) {
        return Object.freeze({
          kind: 'refused',
          refusal: Object.freeze({
            class: 'conflict',
            kind: 'communication.not_found',
            retryable: false,
            subjects: [],
            detail: null,
            detailSchemaVersion: 1
          })
        });
      }
      const batch = materializeDecisionSendBatch({
        scope,
        snapshot,
        batchId: request.batchId,
        now,
        ...(input.deliveryRoute === undefined ? {} : { route: input.deliveryRoute })
      });
      const authorInput = buildDecisionSendAuthorInput({
        scope,
        snapshot,
        batch,
        batchId: request.batchId,
        subject: request.subject,
        audienceLabel: request.audienceLabel,
        now
      });
      const outcome = ((): CommitSendMessagesOutcome => {
        let began = false;
        try {
          input.sqlite.exec('BEGIN IMMEDIATE;');
          began = true;
          const committed = commitSendMessagesRelease({
            sqlite: input.sqlite,
            releases: input.releases,
            // The live currency authority is the composed preview repository
            // itself (Track B repair): a re-decide between adoption and this
            // commit refuses typed, never a mirror comparison.
            previewCurrency: input.previewRepository,
            ids: { newEvidenceId: () => crypto.randomUUID() },
            context: {
              workspaceId: scope.workspaceId,
              eventId: scope.eventId,
              principalKey: request.attribution.principalKey,
              authorityPrincipalKey: request.attribution.authorityPrincipalKey,
              evaluatedAt: now
            },
            authorInput,
            materializedReleases: batch.materialized
          });
          if (committed.kind === 'committed') {
            input.sqlite.exec('COMMIT;');
          } else {
            // Typed refusal: the hosting unit of work rolls back, so the
            // ceremony draft rows and the derived receipt vanish with it.
            input.sqlite.exec('ROLLBACK;');
          }
          began = false;
          return committed;
        } catch (error) {
          if (began && input.sqlite.inTransaction) input.sqlite.exec('ROLLBACK;');
          throw error;
        }
      })();

      if (outcome.kind === 'refused') {
        return Object.freeze({ kind: 'refused', refusal: outcome.refusal });
      }
      return Object.freeze({
        kind: 'committed',
        releaseCommitId: outcome.releaseCommitId,
        result: outcome.result
      });
    }
  });
}
