import type { Database } from 'bun:sqlite';
import { createHash, createHmac } from 'node:crypto';
import {
  CALENDAR_NOTICE_PURPOSE_KEY,
  CALENDAR_NOTICE_STANDING_POLICY,
  CALENDAR_NOTICE_TEMPLATE_REVISION_REF_ID,
  buildCommunicationMessageRelease,
  composeCommunicationSenderPresentation,
  createEventCommunicationPurposeSeedPlan,
  renderCalendarNoticeMessage,
  type MailSenderPresentationResolver
} from '@jooevents/communications';
import {
  buildIcalendarTimezoneDefinition,
  renderIcalendarBatch,
  type IcalendarEventInput
} from '@jooevents/calendar';
import type { OrganizerCommunicationPurposeRevisionRef } from '@jooevents/contracts';
import { outboundEmailDeliveryWorkInputSchema } from '@jooevents/contracts';
import { canonicalJsonText, encodeCanonicalJson } from '@jooevents/kernel';
import type { SubmissionTriageSourcePort } from '@jooevents/submission-triage';
import {
  parseCalendarNoticeReleasePlan,
  type CalendarNoticeReleasePlan
} from '../../calendar-notice-release-plan';
import type { SQLiteIntakeRepository } from '../intake';
import {
  insertOutboundEmailDeliveryRegistration,
  linkOutboundEmailDeliveryReceipt
} from '../outbound-email-delivery';
import {
  SQLiteCalendarCanonicalStateRepository,
  type CalendarNoticeGenerationItemRecord,
  type CalendarNoticeGenerationSummary
} from '../calendar-canonical-state';
import type { SQLiteCalendarNoticeArtifactStore } from '../calendar-artifacts';
import type { SQLiteCommunicationMessageReleaseStore } from './message-releases';

const SENDER_PROFILE_REVISION_ID = 'sender.profile.calendar-notice.v1';
const SENDER_PRESENTATION_CONTRACT_KEY = 'sender.presentation.email-v1';
const SENDER_PRESENTATION_CONTRACT_VERSION = 1;
const ADDRESS_FINGERPRINT_PROFILE = 'communication.address-fingerprint.hmac-sha256';

function digest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function deterministicUuid(namespace: string, material: unknown): string {
  const value = digest({ namespace, material });
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}`
    + `-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export function seedCalendarNoticePurpose(input: {
  readonly sqlite: Database;
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
}): OrganizerCommunicationPurposeRevisionRef {
  if (!input.sqlite.inTransaction) throw new TypeError('calendar_notice_seed_transaction_required');
  const seed = createEventCommunicationPurposeSeedPlan(input.scope).calendarNoticePurpose;
  const { purposeRevision } = seed;
  const rows = input.sqlite.query<{ purpose_key: string }, [string, string, string]>(`
    SELECT purpose_key FROM communication_purposes
     WHERE workspace_id=? AND event_id=? AND purpose_id=? LIMIT 2
  `).all(input.scope.workspaceId, input.scope.eventId, purposeRevision.purposeId);
  if (rows.length === 0) {
    input.sqlite.query(`
      INSERT INTO communication_purposes(
        workspace_id,event_id,purpose_id,purpose_key,lifecycle,current_revision_id
      ) VALUES (?,?,?,?,'active',?)
    `).run(input.scope.workspaceId, input.scope.eventId, purposeRevision.purposeId,
      purposeRevision.purposeKey, purposeRevision.revisionId);
    input.sqlite.query(`
      INSERT INTO communication_purpose_revisions(
        workspace_id,event_id,purpose_id,purpose_key,revision_id,revision_number,
        digest_sha256,label,communication_class,policy_digest_sha256,description,
        allowed_audience_sources_json
      ) VALUES (?,?,?,?,?,1,?,?,'transactional',?,?, '[]')
    `).run(input.scope.workspaceId, input.scope.eventId, purposeRevision.purposeId,
      purposeRevision.purposeKey, purposeRevision.revisionId, purposeRevision.digestSha256,
      seed.label, seed.policyDigestSha256, seed.description);
  } else if (rows.length !== 1 || rows[0]!.purpose_key !== CALENDAR_NOTICE_PURPOSE_KEY) {
    throw new TypeError('calendar_notice_seed_collision');
  }
  return purposeRevision;
}

export type CalendarNoticeProductionOutcome = Readonly<{
  kind: 'registered' | 'already_registered' | 'no_op' | 'policy_inactive'
    | 'provider_not_ready' | 'recipient_unavailable' | 'sequence_regression';
  generationId: string;
  deliveryId?: string;
}>;

export type CalendarNoticeProductionReadiness = Readonly<{
  kind: 'ready' | 'no_op' | 'policy_inactive' | 'provider_not_ready'
    | 'recipient_unavailable' | 'sequence_regression';
  generationId: string;
}>;

interface ResolvedRecipient {
  readonly submissionId: string;
  readonly personId: string;
  readonly email: string;
  readonly name: string;
}

function resolveRecipient(input: {
  readonly sqlite: Database;
  readonly generation: CalendarNoticeGenerationSummary;
  readonly items: readonly CalendarNoticeGenerationItemRecord[];
  readonly intake: Pick<SQLiteIntakeRepository, 'readSubmissionContact'>;
  readonly submissions: Pick<SubmissionTriageSourcePort, 'readSourceRow'>;
}): ResolvedRecipient | undefined {
  const submissionIds = new Set<string>();
  for (const item of input.items) {
    const source = input.sqlite.query<{ head_json: string }, [string, string, string]>(`
      SELECT head_json FROM calendar_commitment_source_heads
       WHERE workspace_id=? AND event_id=? AND source_kind='session' AND source_id=?
    `).get(
      input.generation.scope.workspaceId,
      input.generation.scope.eventId,
      item.commitment.sessionId
    );
    const session = source == null ? undefined : JSON.parse(source.head_json) as {
      roster?: { participants?: Array<{
        personId?: string; source?: { kind?: string; id?: string };
      }> };
    };
    for (const participant of session?.roster?.participants ?? []) {
      if (participant.personId === input.generation.personId
          && participant.source?.kind === 'submission' && participant.source.id) {
        submissionIds.add(participant.source.id);
      }
    }
  }
  const engagementRows = input.sqlite.query<{ head_json: string }, [string, string, string]>(`
    SELECT head_json FROM calendar_commitment_source_heads
     WHERE workspace_id=? AND event_id=? AND source_kind='engagement' AND person_id=?
     ORDER BY source_id
  `).all(
    input.generation.scope.workspaceId,
    input.generation.scope.eventId,
    input.generation.personId
  );
  for (const row of engagementRows) {
    const engagement = JSON.parse(row.head_json) as { submissionId?: string | null };
    if (engagement.submissionId) submissionIds.add(engagement.submissionId);
  }
  const candidates = [...submissionIds].sort().flatMap((submissionId) => {
    const contact = input.intake.readSubmissionContact(input.generation.scope, submissionId);
    const source = input.submissions.readSourceRow(input.generation.scope, submissionId);
    if (!contact || contact.personId !== input.generation.personId) return [];
    return [{
      submissionId,
      personId: contact.personId,
      email: contact.email,
      name: source?.summary.primaryParticipantName ?? 'Speaker'
    }];
  });
  if (candidates.length === 0) return undefined;
  const address = candidates[0]!.email.trim().toLowerCase();
  if (candidates.some((candidate) => candidate.email.trim().toLowerCase() !== address)) {
    return undefined;
  }
  return Object.freeze(candidates[0]!);
}

function hasSequenceRegression(input: {
  readonly sqlite: Database;
  readonly generationId: string;
  readonly items: readonly CalendarNoticeGenerationItemRecord[];
}): boolean {
  for (const item of input.items) {
    if (item.netMethod === 'NONE') continue;
    const prior = input.sqlite.query<{ maximum_sequence: number | null }, [string, string]>(`
      SELECT max(prior_item.after_sequence) AS maximum_sequence
        FROM calendar_notice_generation_items prior_item
        JOIN calendar_notice_generations prior_generation USING(generation_id)
       WHERE prior_item.commitment_id=? AND prior_generation.state='released'
         AND prior_generation.generation_id<>?
    `).get(item.commitment.id, input.generationId)?.maximum_sequence;
    if (prior !== null && prior !== undefined && prior > item.afterSequence) return true;
  }
  return false;
}

export function createSQLiteCalendarNoticeProducer(input: {
  readonly sqlite: Database;
  readonly calendar: SQLiteCalendarCanonicalStateRepository;
  readonly intake: Pick<SQLiteIntakeRepository, 'readSubmissionContact'>;
  readonly submissions: Pick<SubmissionTriageSourcePort, 'readSourceRow'>;
  readonly releases: SQLiteCommunicationMessageReleaseStore;
  readonly artifacts: SQLiteCalendarNoticeArtifactStore;
  readonly senderResolver: MailSenderPresentationResolver;
  readonly purposeRevision: (scope: {
    readonly workspaceId: string; readonly eventId: string;
  }) => OrganizerCommunicationPurposeRevisionRef;
  readonly addressFingerprint: { readonly keyBytes: Uint8Array; readonly version: number };
  readonly policyActive: boolean;
  readonly portalOrigin: string;
  readonly providerRoute?: {
    readonly providerConnectionRevisionId: string;
    readonly calendarMimeReady: boolean;
    readonly attachmentsReady: boolean;
  };
}) {
  const fingerprintKey = Uint8Array.from(input.addressFingerprint.keyBytes);
  if (fingerprintKey.byteLength < 32 || input.addressFingerprint.version < 1) {
    throw new TypeError('calendar_notice_address_fingerprint_invalid');
  }
  return Object.freeze({
    inspectGeneration(candidate: {
      readonly scope: { readonly workspaceId: string; readonly eventId: string };
      readonly generationId: string;
    }): CalendarNoticeProductionReadiness {
      const generation = input.calendar.listNoticeGenerations(candidate.scope)
        .find((item) => item.generationId === candidate.generationId);
      if (!generation || generation.state !== 'sealed') {
        throw new TypeError('calendar_notice_generation_not_sealed');
      }
      const items = input.calendar.readNoticeGenerationItems(generation.generationId);
      const base = { generationId: generation.generationId };
      if (items.every((item) => item.netMethod === 'NONE')) {
        return Object.freeze({ kind: 'no_op' as const, ...base });
      }
      if (!input.policyActive) {
        return Object.freeze({ kind: 'policy_inactive' as const, ...base });
      }
      if (!input.providerRoute?.calendarMimeReady || !input.providerRoute.attachmentsReady) {
        return Object.freeze({ kind: 'provider_not_ready' as const, ...base });
      }
      if (hasSequenceRegression({ sqlite: input.sqlite, generationId: generation.generationId, items })) {
        return Object.freeze({ kind: 'sequence_regression' as const, ...base });
      }
      if (!resolveRecipient({
        sqlite: input.sqlite, generation, items, intake: input.intake, submissions: input.submissions
      })) {
        return Object.freeze({ kind: 'recipient_unavailable' as const, ...base });
      }
      return Object.freeze({ kind: 'ready' as const, ...base });
    },
    processWithinTransaction(candidate: {
      readonly scope: { readonly workspaceId: string; readonly eventId: string };
      readonly generationId: string;
    }): CalendarNoticeProductionOutcome {
      if (!input.sqlite.inTransaction) throw new TypeError('calendar_notice_transaction_required');
      const generation = input.calendar.listNoticeGenerations(candidate.scope)
        .find((item) => item.generationId === candidate.generationId);
      if (!generation || (generation.state !== 'sealed' && generation.state !== 'released')) {
        throw new TypeError('calendar_notice_generation_not_sealed');
      }
      const batchId = `calendar-notice.${generation.generationId}`;
      const existing = input.sqlite.query<{ plan_json: string }, [string, string, string]>(`
        SELECT plan_json FROM communication_release_commits
         WHERE workspace_id=? AND event_id=? AND batch_id=? LIMIT 2
      `).all(candidate.scope.workspaceId, candidate.scope.eventId, batchId);
      if (existing.length > 1) throw new TypeError('calendar_notice_commit_corrupt');
      if (existing.length === 1) {
        const prior = parseCalendarNoticeReleasePlan(JSON.parse(existing[0]!.plan_json));
        if (prior.generationId !== generation.generationId) {
          throw new TypeError('calendar_notice_commit_conflict');
        }
        return Object.freeze({
          kind: 'already_registered' as const,
          generationId: generation.generationId,
          ...(prior.release.deliveryId === null ? {} : { deliveryId: prior.release.deliveryId })
        });
      }
      const items = input.calendar.readNoticeGenerationItems(generation.generationId);
      const netItems = items.filter((item) => item.netMethod !== 'NONE');
      const material = Object.freeze({
        workspaceId: candidate.scope.workspaceId,
        eventId: candidate.scope.eventId,
        generationId: generation.generationId,
        generationNumber: generation.generationNumber
      });
      const releaseId = deterministicUuid('calendar-notice.release', material);
      const releaseCommitId = deterministicUuid('calendar-notice.commit', material);
      const purposeRevision = input.purposeRevision(candidate.scope);
      if (purposeRevision.purposeKey !== CALENDAR_NOTICE_PURPOSE_KEY) {
        throw new TypeError('calendar_notice_purpose_mismatch');
      }
      if (netItems.length === 0) {
        const plan = parseCalendarNoticeReleasePlan({
          schemaVersion: 1, kind: 'calendar_notice', scope: candidate.scope, batchId,
          generationId: generation.generationId, generationNumber: generation.generationNumber,
          personId: generation.personId, purposeRevision,
          policy: {
            key: CALENDAR_NOTICE_STANDING_POLICY.key,
            version: CALENDAR_NOTICE_STANDING_POLICY.version,
            authorizedAt: generation.sealedAt,
            switchDefault: 'off'
          },
          templateRevisionRefId: CALENDAR_NOTICE_TEMPLATE_REVISION_REF_ID,
          purposeKey: CALENDAR_NOTICE_PURPOSE_KEY,
          mode: input.calendar.effectivePreference(candidate.scope, generation.personId).mode,
          noOp: true, artifacts: [],
          release: {
            releaseId, deliveryId: null,
            recipientRefId: `calendar-person:${generation.personId}`,
            personRefId: generation.personId, contactRefId: null
          }
        });
        input.sqlite.query(`
          INSERT INTO communication_release_commits(
            commit_id,workspace_id,event_id,batch_id,plan_digest_sha256,plan_json,occurred_at_ms
          ) VALUES (?,?,?,?,?,?,?)
        `).run(releaseCommitId, candidate.scope.workspaceId, candidate.scope.eventId,
          batchId, digest(plan), canonicalJsonText(plan), Date.parse(generation.sealedAt!));
        input.calendar.releaseGeneration(generation.generationId, generation.version, releaseId);
        return Object.freeze({ kind: 'no_op' as const, generationId: generation.generationId });
      }
      if (!input.policyActive) {
        return Object.freeze({ kind: 'policy_inactive' as const, generationId: generation.generationId });
      }
      if (!input.providerRoute?.calendarMimeReady || !input.providerRoute.attachmentsReady) {
        return Object.freeze({ kind: 'provider_not_ready' as const, generationId: generation.generationId });
      }
      if (hasSequenceRegression({ sqlite: input.sqlite, generationId: generation.generationId, items })) {
        return Object.freeze({ kind: 'sequence_regression' as const, generationId: generation.generationId });
      }
      const recipient = resolveRecipient({
        sqlite: input.sqlite, generation, items, intake: input.intake, submissions: input.submissions
      });
      if (!recipient) {
        return Object.freeze({ kind: 'recipient_unavailable' as const, generationId: generation.generationId });
      }
      const eventRows = input.sqlite.query<{
        name: string; timezone: string;
      }, [string, string]>(`
        SELECT name,timezone FROM event_spine_heads WHERE workspace_id=? AND id=? LIMIT 2
      `).all(candidate.scope.workspaceId, candidate.scope.eventId);
      if (eventRows.length !== 1) throw new TypeError('calendar_notice_event_missing');
      const event = eventRows[0]!;
      const { sender, senderPresentationDigestSha256 } = composeCommunicationSenderPresentation({
        resolver: input.senderResolver,
        senderProfileRevisionId: SENDER_PROFILE_REVISION_ID,
        senderPresentationContractKey: SENDER_PRESENTATION_CONTRACT_KEY,
        senderPresentationContractVersion: SENDER_PRESENTATION_CONTRACT_VERSION
      });
      const preference = input.calendar.effectivePreference(candidate.scope, generation.personId);
      const ordered = [...netItems].sort((left, right) =>
        left.netMethod.localeCompare(right.netMethod)
        || left.commitment.startAt.localeCompare(right.commitment.startAt)
        || left.commitment.id.localeCompare(right.commitment.id));
      const message = renderCalendarNoticeMessage({
        eventName: event.name,
        changes: ordered.map((item) => ({
          method: item.netMethod as 'REQUEST' | 'CANCEL',
          sessionTitle: item.commitment.sessionTitle,
          startsAt: item.commitment.startAt,
          roomName: item.commitment.roomName
        })),
        portalUrl: new URL('/portal/sign-in', input.portalOrigin).toString()
      });
      const artifactRecords = preference.mode === 'feed_primary'
        ? []
        : (['REQUEST', 'CANCEL'] as const).flatMap((method) => {
            const selected = ordered.filter((item) => item.netMethod === method);
            if (selected.length === 0) return [];
            const earliest = selected.reduce((value, item) =>
              item.commitment.startAt < value ? item.commitment.startAt : value,
            selected[0]!.commitment.startAt);
            const latest = selected.reduce((value, item) =>
              item.commitment.endAt > value ? item.commitment.endAt : value,
            selected[0]!.commitment.endAt);
            const timezone = buildIcalendarTimezoneDefinition({
              timeZone: event.timezone, startAt: earliest, endAt: latest
            });
            const calendarEvents: IcalendarEventInput[] = selected.map((item) => ({
              method,
              uid: item.commitment.uid,
              sequence: item.afterSequence,
              dtstamp: item.commitment.lastDtstamp,
              summary: item.commitment.sessionTitle,
              description: `Speaking at ${event.name}`,
              location: item.commitment.roomName ?? '',
              organizer: {
                email: sender.fromAddress,
                commonName: sender.fromDisplayName ?? event.name
              },
              attendee: { email: recipient.email, commonName: recipient.name },
              timing: 'timed',
              startAt: item.commitment.startAt,
              endAt: item.commitment.endAt,
              timezone
            }));
            const bytes = renderIcalendarBatch({ method, events: calendarEvents });
            const artifact = input.artifacts.put({
              payloadRefId: deterministicUuid(`calendar-notice.artifact.${method.toLowerCase()}`, material),
              workspaceId: candidate.scope.workspaceId,
              eventId: candidate.scope.eventId,
              generationId: generation.generationId,
              method,
              bytes,
              createdAt: generation.sealedAt!
            });
            return [{
              artifact,
              sequences: selected.map((item) => ({
                commitmentId: item.commitment.id,
                uid: item.commitment.uid,
                sequence: item.afterSequence
              }))
            }];
          });
      const primary = artifactRecords.find((item) => item.artifact.method === 'REQUEST')
        ?? artifactRecords[0];
      const attachments = artifactRecords.map(({ artifact }) => ({
        contentBytesRef: artifact.contentBytesRef,
        filename: artifact.filename,
        mediaType: 'text/calendar',
        byteLength: artifact.byteLength,
        contentSha256: artifact.contentSha256,
        disposition: 'attachment' as const
      }));
      const deliveryId = deterministicUuid('calendar-notice.delivery', material);
      const recipientRefId = `calendar-person:${generation.personId}`;
      const contactRefId = `submission-contact:${recipient.submissionId}`;
      const contentRefId = `calendar-generation:${generation.generationId}`;
      const release = buildCommunicationMessageRelease({
        workspaceId: candidate.scope.workspaceId,
        eventId: candidate.scope.eventId,
        releaseId,
        batchId,
        recipientRefId,
        personRefId: generation.personId,
        contactRefId,
        templateRevisionRefId: CALENDAR_NOTICE_TEMPLATE_REVISION_REF_ID,
        contentRefId,
        purposeKey: CALENDAR_NOTICE_PURPOSE_KEY,
        reviewedMessageDigestSha256: digest({
          schemaVersion: 1,
          subject: message.subject,
          textBody: message.textBody,
          htmlBody: message.htmlBody,
          artifacts: artifactRecords.map((item) => item.artifact)
        }),
        sender,
        toAddress: recipient.email,
        subject: message.subject,
        textBody: message.textBody,
        htmlBody: message.htmlBody,
        attachments,
        ...(primary === undefined ? {} : { calendarPart: primary.artifact }),
        createdAt: generation.sealedAt!
      });
      const work = outboundEmailDeliveryWorkInputSchema.parse({
        contractVersion: 1,
        deliveryId,
        releaseId,
        dispatchGeneration: 1,
        reviewedMessageDigestSha256: release.reviewedMessageDigestSha256,
        reviewedEnvelopeDigestSha256: release.reviewedEnvelopeDigestSha256,
        recipientRefId,
        templateRevisionRefId: CALENDAR_NOTICE_TEMPLATE_REVISION_REF_ID,
        contentRefId,
        providerConnectionRevisionId: input.providerRoute.providerConnectionRevisionId,
        externalDeliveryKey: `calendar-notice.${generation.generationId}`,
        senderProfileRevisionId: SENDER_PROFILE_REVISION_ID,
        senderPresentationContractKey: SENDER_PRESENTATION_CONTRACT_KEY,
        senderPresentationContractVersion: SENDER_PRESENTATION_CONTRACT_VERSION,
        senderPresentationDigestSha256,
        channelAddressId: `channel-address.calendar:${recipient.submissionId}`,
        channelAddressVersion: 1,
        addressLookupFingerprintProfile: ADDRESS_FINGERPRINT_PROFILE,
        addressLookupFingerprintVersion: input.addressFingerprint.version,
        addressLookupFingerprintSha256: createHmac('sha256', fingerprintKey)
          .update(recipient.email.trim().toLowerCase(), 'utf8').digest('hex')
      });
      const plan: CalendarNoticeReleasePlan = parseCalendarNoticeReleasePlan({
        schemaVersion: 1, kind: 'calendar_notice', scope: candidate.scope, batchId,
        generationId: generation.generationId, generationNumber: generation.generationNumber,
        personId: generation.personId, purposeRevision,
        policy: {
          key: CALENDAR_NOTICE_STANDING_POLICY.key,
          version: CALENDAR_NOTICE_STANDING_POLICY.version,
          authorizedAt: generation.sealedAt,
          switchDefault: 'off'
        },
        templateRevisionRefId: CALENDAR_NOTICE_TEMPLATE_REVISION_REF_ID,
        purposeKey: CALENDAR_NOTICE_PURPOSE_KEY,
        mode: preference.mode,
        noOp: false,
        artifacts: artifactRecords.map(({ artifact, sequences }) => ({
          method: artifact.method,
          contentBytesRef: artifact.contentBytesRef,
          byteLength: artifact.byteLength,
          contentSha256: artifact.contentSha256,
          sequences
        })),
        release: {
          releaseId, deliveryId, recipientRefId, personRefId: generation.personId, contactRefId
        }
      });
      input.releases.put(release);
      input.sqlite.query(`
        INSERT INTO communication_release_commits(
          commit_id,workspace_id,event_id,batch_id,plan_digest_sha256,plan_json,occurred_at_ms
        ) VALUES (?,?,?,?,?,?,?)
      `).run(releaseCommitId, candidate.scope.workspaceId, candidate.scope.eventId,
        batchId, digest(plan), canonicalJsonText(plan), Date.parse(generation.sealedAt!));
      const evidence = {
        rootFactId: deterministicUuid('calendar-notice.fact', material),
        rootPointerId: deterministicUuid('calendar-notice.pointer', material),
        historyThreadId: deterministicUuid('calendar-notice.history-thread', material),
        rootHistoryId: deterministicUuid('calendar-notice.history', material)
      };
      insertOutboundEmailDeliveryRegistration({
        sqlite: input.sqlite,
        workspaceId: candidate.scope.workspaceId,
        eventId: candidate.scope.eventId,
        work,
        evidence,
        createdAt: generation.sealedAt!
      });
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_facts(
          fact_id,receipt_id,workspace_id,event_id,delivery_id,fact_kind,fact_version,
          payload_json,occurred_at_ms
        ) VALUES (?,?,?,?,?,'outbound_email_delivery_requested',1,?,?)
      `).run(evidence.rootFactId, releaseCommitId, candidate.scope.workspaceId,
        candidate.scope.eventId, deliveryId, canonicalJsonText({
          contractVersion: 1,
          purpose: CALENDAR_NOTICE_PURPOSE_KEY,
          generationId: generation.generationId,
          releaseId,
          reviewedMessageDigestSha256: work.reviewedMessageDigestSha256,
          reviewedEnvelopeDigestSha256: work.reviewedEnvelopeDigestSha256,
          recipientRefId,
          templateRevisionRefId: CALENDAR_NOTICE_TEMPLATE_REVISION_REF_ID,
          contentRefId
        }), Date.parse(generation.sealedAt!));
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_outbox(
          pointer_id,receipt_id,fact_id,delivery_id,purpose,created_at_ms
        ) VALUES (?,?,?,?,'communication.outbound-email.dispatch',?)
      `).run(evidence.rootPointerId, releaseCommitId, evidence.rootFactId,
        deliveryId, Date.parse(generation.sealedAt!));
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_history(
          history_id,thread_id,sequence,receipt_id,fact_id,delivery_id,attempt_id,
          parent_history_id,summary_code,occurred_at_ms
        ) VALUES (?,?,0,?,?,?,NULL,NULL,'communication.outbound-email.requested',?)
      `).run(evidence.rootHistoryId, evidence.historyThreadId, releaseCommitId,
        evidence.rootFactId, deliveryId, Date.parse(generation.sealedAt!));
      linkOutboundEmailDeliveryReceipt({ sqlite: input.sqlite, deliveryId, receiptId: releaseCommitId });
      input.sqlite.query(`
        INSERT INTO communication_release_effect_specs(
          spec_id,receipt_id,workspace_id,event_id,batch_id,release_id,delivery_id,work_digest_sha256
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(deterministicUuid('calendar-notice.effect-spec', material), releaseCommitId,
        candidate.scope.workspaceId, candidate.scope.eventId, batchId, releaseId,
        deliveryId, digest(work));
      input.calendar.releaseGeneration(generation.generationId, generation.version, releaseId);
      return Object.freeze({
        kind: 'registered' as const, generationId: generation.generationId, deliveryId
      });
    }
  });
}
