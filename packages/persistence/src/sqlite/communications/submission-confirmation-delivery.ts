import type { Database } from 'bun:sqlite';
import { createHash, createHmac } from 'node:crypto';
import {
  buildCommunicationMessageRelease,
  composeCommunicationSenderPresentation,
  createEventCommunicationPurposeSeedPlan,
  renderSubmissionConfirmationMessage,
  SUBMISSION_CONFIRMATION_PURPOSE_KEY,
  SUBMISSION_CONFIRMATION_STANDING_POLICY,
  SUBMISSION_CONFIRMATION_TEMPLATE_REVISION_REF_ID,
  type MailSenderPresentationResolver
} from '@jooevents/communications';
import type { OrganizerCommunicationPurposeRevisionRef } from
  '@jooevents/contracts/communications/organizer';
import { outboundEmailDeliveryWorkInputSchema } from '@jooevents/contracts';
import { canonicalJsonText, encodeCanonicalJson } from '@jooevents/kernel';
import type { SubmissionTriageSourcePort } from '@jooevents/submission-triage';
import {
  parseSubmissionConfirmationReleasePlan,
  type SubmissionConfirmationReleasePlan
} from '../../submission-confirmation-release-plan';
import type { SQLiteIntakeRepository } from '../intake';
import {
  insertOutboundEmailDeliveryRegistration,
  linkOutboundEmailDeliveryReceipt
} from '../outbound-email-delivery';
import type { SQLiteCommunicationMessageReleaseStore } from './message-releases';

export { SUBMISSION_CONFIRMATION_STANDING_POLICY } from '@jooevents/communications';

export const SUBMISSION_CONFIRMATION_UNCONFIGURED_PROVIDER_CONNECTION_REVISION_ID =
  'provider.connection.not-activated';
export const SUBMISSION_CONFIRMATION_UNCONFIGURED_EXTERNAL_DELIVERY_KEY =
  'provider.not-activated';

const SENDER_PROFILE_REVISION_ID = 'sender.profile.submission-confirmation.v1';
const SENDER_PRESENTATION_CONTRACT_KEY = 'sender.presentation.email-v1';
const SENDER_PRESENTATION_CONTRACT_VERSION = 1;
const ADDRESS_FINGERPRINT_PROFILE = 'communication.address-fingerprint.hmac-sha256';

export {
  parseSubmissionConfirmationReleasePlan,
  type SubmissionConfirmationReleasePlan
} from '../../submission-confirmation-release-plan';

function digest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function deterministicUuid(namespace: string, material: unknown): string {
  const value = digest({ namespace, material });
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}`
    + `-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function policyDigest(): string {
  return digest({
    ...SUBMISSION_CONFIRMATION_STANDING_POLICY,
    purposeKey: SUBMISSION_CONFIRMATION_PURPOSE_KEY,
    templateRevisionRefId: SUBMISSION_CONFIRMATION_TEMPLATE_REVISION_REF_ID,
    consent: 'not_required_requested_transaction',
    suppression: 'requested_transaction_receipt_not_suppressed'
  });
}

export function seedSubmissionConfirmationPurpose(input: {
  readonly sqlite: Database;
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
}): OrganizerCommunicationPurposeRevisionRef {
  if (!input.sqlite.inTransaction) {
    throw new TypeError('submission_confirmation_seed_transaction_required');
  }
  const seed = createEventCommunicationPurposeSeedPlan(input.scope)
    .submissionConfirmationPurpose;
  const { purposeRevision } = seed;
  const rows = input.sqlite.query<{ readonly purpose_key: string }, [string, string, string]>(`
    SELECT purpose_key FROM communication_purposes
     WHERE workspace_id = ? AND event_id = ? AND purpose_id = ? LIMIT 2
  `).all(input.scope.workspaceId, input.scope.eventId, purposeRevision.purposeId);
  if (rows.length === 0) {
    input.sqlite.query(`
      INSERT INTO communication_purposes (
        workspace_id, event_id, purpose_id, purpose_key, lifecycle, current_revision_id
      ) VALUES (?, ?, ?, ?, 'active', ?)
    `).run(
      input.scope.workspaceId, input.scope.eventId, purposeRevision.purposeId,
      purposeRevision.purposeKey, purposeRevision.revisionId
    );
    input.sqlite.query(`
      INSERT INTO communication_purpose_revisions (
        workspace_id, event_id, purpose_id, purpose_key, revision_id, revision_number,
        digest_sha256, label, communication_class, policy_digest_sha256, description,
        allowed_audience_sources_json
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'transactional', ?, ?, '[]')
    `).run(
      input.scope.workspaceId, input.scope.eventId, purposeRevision.purposeId,
      purposeRevision.purposeKey, purposeRevision.revisionId,
      purposeRevision.digestSha256, seed.label, seed.policyDigestSha256,
      seed.description
    );
  } else if (rows.length !== 1 || rows[0]!.purpose_key !== SUBMISSION_CONFIRMATION_PURPOSE_KEY) {
    throw new TypeError('submission_confirmation_seed_collision');
  }
  return purposeRevision;
}

export interface SubmissionConfirmationRegistrationPort {
  registerWithinTransaction(input: {
    readonly scope: { readonly workspaceId: string; readonly eventId: string };
    readonly submissionId: string;
    readonly causationFactId: string;
    readonly intakeReceiptId: string;
    readonly submittedAt: string;
  }): Readonly<{
    kind: 'registered' | 'already_registered' | 'policy_inactive';
    deliveryId?: string;
  }>;
}

export function createSQLiteSubmissionConfirmationRegistration(input: {
  readonly sqlite: Database;
  readonly intake: Pick<SQLiteIntakeRepository, 'readSubmissionContact'>;
  readonly submissions: Pick<SubmissionTriageSourcePort, 'readSourceRow'>;
  readonly releases: SQLiteCommunicationMessageReleaseStore;
  readonly senderResolver: MailSenderPresentationResolver;
  readonly portalOrigin: string;
  readonly purposeRevision: (input: {
    readonly workspaceId: string;
    readonly eventId: string;
  }) => OrganizerCommunicationPurposeRevisionRef;
  readonly addressFingerprint: {
    readonly keyBytes: Uint8Array;
    readonly version: number;
  };
  readonly policyActive: boolean;
  readonly providerRoute?: { readonly providerConnectionRevisionId: string };
}): SubmissionConfirmationRegistrationPort {
  if (!(input.addressFingerprint.keyBytes instanceof Uint8Array)
      || input.addressFingerprint.keyBytes.byteLength < 32
      || !Number.isSafeInteger(input.addressFingerprint.version)
      || input.addressFingerprint.version < 1) {
    throw new TypeError('submission_confirmation_address_fingerprint_invalid');
  }
  const fingerprintKey = Uint8Array.from(input.addressFingerprint.keyBytes);
  const portalUrl = new URL('/portal/sign-in', input.portalOrigin).toString();
  return Object.freeze({
    registerWithinTransaction(
      candidate: Parameters<SubmissionConfirmationRegistrationPort['registerWithinTransaction']>[0]
    ) {
      if (!input.sqlite.inTransaction) {
        throw new TypeError('submission_confirmation_transaction_required');
      }
      if (!input.policyActive) return Object.freeze({ kind: 'policy_inactive' as const });
      const material = Object.freeze({
        workspaceId: candidate.scope.workspaceId,
        eventId: candidate.scope.eventId,
        submissionId: candidate.submissionId,
        policyKey: SUBMISSION_CONFIRMATION_STANDING_POLICY.key,
        policyVersion: SUBMISSION_CONFIRMATION_STANDING_POLICY.version
      });
      const batchId = `submission-confirmation.${candidate.submissionId}`;
      const existing = input.sqlite.query<{
        readonly plan_json: string;
      }, [string, string, string]>(`
        SELECT plan_json FROM communication_release_commits
         WHERE workspace_id = ? AND event_id = ? AND batch_id = ? LIMIT 2
      `).all(candidate.scope.workspaceId, candidate.scope.eventId, batchId);
      if (existing.length > 1) throw new TypeError('submission_confirmation_commit_corrupt');
      if (existing.length === 1) {
        let prior: SubmissionConfirmationReleasePlan;
        try {
          prior = parseSubmissionConfirmationReleasePlan(JSON.parse(existing[0]!.plan_json));
        } catch (error) {
          throw new TypeError('submission_confirmation_commit_conflict', { cause: error });
        }
        if (prior.submissionId !== candidate.submissionId
            || prior.causationFactId !== candidate.causationFactId
            || prior.intakeReceiptId !== candidate.intakeReceiptId) {
          throw new TypeError('submission_confirmation_commit_conflict');
        }
        return Object.freeze({
          kind: 'already_registered' as const,
          deliveryId: prior.release.deliveryId
        });
      }

      const contact = input.intake.readSubmissionContact(candidate.scope, candidate.submissionId);
      const source = input.submissions.readSourceRow(candidate.scope, candidate.submissionId);
      const event = input.sqlite.query<{ readonly name: string }, [string, string]>(`
        SELECT name FROM event_spine_heads WHERE workspace_id = ? AND id = ? LIMIT 2
      `).all(candidate.scope.workspaceId, candidate.scope.eventId);
      if (!contact || !source || source.summary.id !== candidate.submissionId
          || source.summary.submittedAt !== candidate.submittedAt
          || event.length !== 1) {
        throw new TypeError('submission_confirmation_source_missing');
      }
      const purposeRevision = input.purposeRevision(candidate.scope);
      if (purposeRevision.purposeKey !== SUBMISSION_CONFIRMATION_PURPOSE_KEY) {
        throw new TypeError('submission_confirmation_purpose_mismatch');
      }
      const message = renderSubmissionConfirmationMessage({
        eventName: event[0]!.name,
        submissionTitle: source.summary.title ?? 'Your application',
        submittedAt: candidate.submittedAt,
        portalUrl
      });
      const { sender, senderPresentationDigestSha256 } =
        composeCommunicationSenderPresentation({
          resolver: input.senderResolver,
          senderProfileRevisionId: SENDER_PROFILE_REVISION_ID,
          senderPresentationContractKey: SENDER_PRESENTATION_CONTRACT_KEY,
          senderPresentationContractVersion: SENDER_PRESENTATION_CONTRACT_VERSION
        });
      const releaseId = deterministicUuid('submission-confirmation.release', material);
      const deliveryId = deterministicUuid('submission-confirmation.delivery', material);
      const releaseCommitId = deterministicUuid('submission-confirmation.commit', material);
      const recipientRefId = `submission:${candidate.submissionId}`;
      const contactRefId = `submission-contact:${candidate.submissionId}`;
      const contentRefId = `content.submission-confirmation:${candidate.submissionId}`;
      const release = buildCommunicationMessageRelease({
        workspaceId: candidate.scope.workspaceId,
        eventId: candidate.scope.eventId,
        releaseId,
        batchId,
        recipientRefId,
        personRefId: contact.personId,
        contactRefId,
        templateRevisionRefId: SUBMISSION_CONFIRMATION_TEMPLATE_REVISION_REF_ID,
        contentRefId,
        purposeKey: SUBMISSION_CONFIRMATION_PURPOSE_KEY,
        reviewedMessageDigestSha256: digest({
          schemaVersion: 1,
          subject: message.subject,
          textBody: message.textBody,
          htmlBody: message.htmlBody
        }),
        sender,
        toAddress: contact.email,
        subject: message.subject,
        textBody: message.textBody,
        htmlBody: message.htmlBody,
        createdAt: candidate.submittedAt
      });
      const work = outboundEmailDeliveryWorkInputSchema.parse({
        contractVersion: 1,
        deliveryId,
        releaseId,
        dispatchGeneration: 1,
        reviewedMessageDigestSha256: release.reviewedMessageDigestSha256,
        reviewedEnvelopeDigestSha256: release.reviewedEnvelopeDigestSha256,
        recipientRefId,
        templateRevisionRefId: SUBMISSION_CONFIRMATION_TEMPLATE_REVISION_REF_ID,
        contentRefId,
        providerConnectionRevisionId: input.providerRoute?.providerConnectionRevisionId
          ?? SUBMISSION_CONFIRMATION_UNCONFIGURED_PROVIDER_CONNECTION_REVISION_ID,
        externalDeliveryKey: input.providerRoute === undefined
          ? SUBMISSION_CONFIRMATION_UNCONFIGURED_EXTERNAL_DELIVERY_KEY
          : `submission-confirmation.${candidate.submissionId}`,
        senderProfileRevisionId: SENDER_PROFILE_REVISION_ID,
        senderPresentationContractKey: SENDER_PRESENTATION_CONTRACT_KEY,
        senderPresentationContractVersion: SENDER_PRESENTATION_CONTRACT_VERSION,
        senderPresentationDigestSha256,
        channelAddressId: `channel-address.submission:${candidate.submissionId}`,
        channelAddressVersion: 1,
        addressLookupFingerprintProfile: ADDRESS_FINGERPRINT_PROFILE,
        addressLookupFingerprintVersion: input.addressFingerprint.version,
        addressLookupFingerprintSha256: createHmac('sha256', fingerprintKey)
          .update(contact.email.trim().toLowerCase(), 'utf8').digest('hex')
      });
      const authorizedAtMs = Date.parse(candidate.submittedAt);
      const plan = parseSubmissionConfirmationReleasePlan({
        schemaVersion: 1,
        kind: 'submission_confirmation',
        scope: candidate.scope,
        batchId,
        submissionId: candidate.submissionId,
        causationFactId: candidate.causationFactId,
        intakeReceiptId: candidate.intakeReceiptId,
        purposeRevision,
        policy: {
          key: SUBMISSION_CONFIRMATION_STANDING_POLICY.key,
          version: SUBMISSION_CONFIRMATION_STANDING_POLICY.version,
          digestSha256: policyDigest(),
          authorizedAt: candidate.submittedAt,
          authorizationExpiresAt: new Date(
            authorizedAtMs + SUBMISSION_CONFIRMATION_STANDING_POLICY.producerAuthorizationLifetimeMs
          ).toISOString(),
          maximumRegistrationsPerSubmission: 1
        },
        templateRevisionRefId: SUBMISSION_CONFIRMATION_TEMPLATE_REVISION_REF_ID,
        subject: message.subject,
        audienceLabel: 'Applicant',
        release: {
          releaseId,
          deliveryId,
          recipientRefId,
          personRefId: contact.personId,
          contactRefId
        }
      });

      input.releases.put(release);
      input.sqlite.query(`
        INSERT INTO communication_release_commits (
          commit_id, workspace_id, event_id, batch_id, plan_digest_sha256,
          plan_json, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        releaseCommitId, candidate.scope.workspaceId, candidate.scope.eventId, batchId,
        digest(plan), canonicalJsonText(plan), authorizedAtMs
      );
      const evidence = Object.freeze({
        rootFactId: deterministicUuid('submission-confirmation.fact', material),
        rootPointerId: deterministicUuid('submission-confirmation.pointer', material),
        historyThreadId: deterministicUuid('submission-confirmation.history-thread', material),
        rootHistoryId: deterministicUuid('submission-confirmation.history', material)
      });
      insertOutboundEmailDeliveryRegistration({
        sqlite: input.sqlite,
        workspaceId: candidate.scope.workspaceId,
        eventId: candidate.scope.eventId,
        work,
        evidence,
        createdAt: candidate.submittedAt
      });
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_facts (
          fact_id, receipt_id, workspace_id, event_id, delivery_id,
          fact_kind, fact_version, payload_json, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'outbound_email_delivery_requested', 1, ?, ?)
      `).run(
        evidence.rootFactId, releaseCommitId, candidate.scope.workspaceId,
        candidate.scope.eventId, deliveryId,
        canonicalJsonText({
          contractVersion: 1,
          purpose: SUBMISSION_CONFIRMATION_PURPOSE_KEY,
          submissionId: candidate.submissionId,
          causationFactId: candidate.causationFactId,
          intakeReceiptId: candidate.intakeReceiptId,
          releaseId,
          reviewedMessageDigestSha256: work.reviewedMessageDigestSha256,
          reviewedEnvelopeDigestSha256: work.reviewedEnvelopeDigestSha256,
          recipientRefId,
          templateRevisionRefId: SUBMISSION_CONFIRMATION_TEMPLATE_REVISION_REF_ID,
          contentRefId
        }),
        authorizedAtMs
      );
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_outbox (
          pointer_id, receipt_id, fact_id, delivery_id, purpose, created_at_ms
        ) VALUES (?, ?, ?, ?, 'communication.outbound-email.dispatch', ?)
      `).run(
        evidence.rootPointerId, releaseCommitId, evidence.rootFactId, deliveryId, authorizedAtMs
      );
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_history (
          history_id, thread_id, sequence, receipt_id, fact_id, delivery_id,
          attempt_id, parent_history_id, summary_code, occurred_at_ms
        ) VALUES (?, ?, 0, ?, ?, ?, NULL, NULL, 'communication.outbound-email.requested', ?)
      `).run(
        evidence.rootHistoryId, evidence.historyThreadId, releaseCommitId,
        evidence.rootFactId, deliveryId, authorizedAtMs
      );
      linkOutboundEmailDeliveryReceipt({ sqlite: input.sqlite, deliveryId, receiptId: releaseCommitId });
      input.sqlite.query(`
        INSERT INTO communication_release_effect_specs (
          spec_id, receipt_id, workspace_id, event_id, batch_id, release_id,
          delivery_id, work_digest_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deterministicUuid('submission-confirmation.effect-spec', material),
        releaseCommitId, candidate.scope.workspaceId, candidate.scope.eventId,
        batchId, releaseId, deliveryId, digest(work)
      );
      return Object.freeze({ kind: 'registered' as const, deliveryId });
    }
  });
}
