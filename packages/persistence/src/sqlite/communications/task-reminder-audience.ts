import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  OrganizerAudienceResolutionError,
  TASK_REMINDER_PURPOSE_KEY,
  organizerAudienceCandidateSchema,
  type OrganizerAudienceCandidate,
  type OrganizerMergeValueSource
} from '@jooevents/communications';
import {
  organizerCommunicationPurposeRevisionRefSchema,
  organizerMessagePreviewSourceVersionSchema,
  type OrganizerCommunicationPurposeRevisionRef
} from '@jooevents/contracts/communications/organizer';
import { canonicalJsonText } from '@jooevents/kernel';
import type { SubmissionTriageSourcePort } from '@jooevents/submission-triage';
import { SQLiteEngagementRepository } from '../engagement';
import { SQLiteTaskRepository } from '../tasks';
import type { SQLiteRegisteredAudienceSourceDelegate } from './audience-preview';

export const TASK_REMINDER_CONTACT_REF_PREFIX = 'task-engagement:' as const;

const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJsonText(value), 'utf8').digest('hex');

function deterministicUuid(namespace: string, material: unknown): string {
  const value = digest({ namespace, material });
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}`
    + `-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

/** Installs the transactional purpose; message content remains organizer-authored. */
export function seedTaskReminderPurpose(input: {
  readonly sqlite: Database;
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
}): OrganizerCommunicationPurposeRevisionRef {
  if (!input.sqlite.inTransaction) throw new TypeError('task_reminder_seed_transaction_required');
  const purposeId = deterministicUuid('communication.purpose.task-reminder', input.scope);
  const revisionId = deterministicUuid('communication.purpose-revision.task-reminder', input.scope);
  const policyDigestSha256 = digest({
    schemaVersion: 1, purposeKey: TASK_REMINDER_PURPOSE_KEY,
    communicationClass: 'transactional', consent: 'not_required',
    audience: 'explicit_task_engagements@1'
  });
  const purposeRevision = organizerCommunicationPurposeRevisionRefSchema.parse({
    purposeId, purposeKey: TASK_REMINDER_PURPOSE_KEY, revisionId, revisionNumber: 1,
    digestSha256: digest({
      schemaVersion: 1, purposeId, purposeKey: TASK_REMINDER_PURPOSE_KEY,
      revisionId, revisionNumber: 1, policyDigestSha256
    })
  });
  const exists = input.sqlite.query<{ purpose_key: string }, [string, string, string]>(`
    SELECT purpose_key FROM communication_purposes
     WHERE workspace_id=? AND event_id=? AND purpose_id=? LIMIT 2
  `).all(input.scope.workspaceId, input.scope.eventId, purposeId);
  if (exists.length === 0) {
    input.sqlite.query(`
      INSERT INTO communication_purposes(
        workspace_id,event_id,purpose_id,purpose_key,lifecycle,current_revision_id
      ) VALUES (?,?,?,?,'active',?)
    `).run(input.scope.workspaceId, input.scope.eventId, purposeId, TASK_REMINDER_PURPOSE_KEY, revisionId);
    input.sqlite.query(`
      INSERT INTO communication_purpose_revisions(
        workspace_id,event_id,purpose_id,purpose_key,revision_id,revision_number,
        digest_sha256,label,communication_class,policy_digest_sha256,description,
        allowed_audience_sources_json
      ) VALUES (?,?,?,?,?,1,?,?,'transactional',?,?,?)
    `).run(
      input.scope.workspaceId, input.scope.eventId, purposeId, TASK_REMINDER_PURPOSE_KEY,
      revisionId, purposeRevision.digestSha256, 'Speaker task reminders', policyDigestSha256,
      'Organizer-reviewed reminders for currently incomplete speaker tasks.', '[]'
    );
  } else if (exists.length !== 1 || exists[0]!.purpose_key !== TASK_REMINDER_PURPOSE_KEY) {
    throw new TypeError('task_reminder_seed_collision');
  }
  return purposeRevision;
}

/**
 * Live explicit-contact delegate. Eligibility is recalculated for every
 * preview and send currency check; completed or non-confirmed subjects simply
 * disappear from the current snapshot and therefore cannot be mailed stale.
 */
export function createSQLiteTaskReminderAudienceSource(input: {
  readonly sqlite: Database;
  readonly tasks: SQLiteTaskRepository;
  readonly engagements: SQLiteEngagementRepository;
  readonly submissions: SubmissionTriageSourcePort;
  readonly submissionAddresses: Pick<
    SQLiteRegisteredAudienceSourceDelegate & OrganizerMergeValueSource,
    'resolveEmail' | 'resolveMergeValues'
  >;
}): SQLiteRegisteredAudienceSourceDelegate & OrganizerMergeValueSource {
  const delegate: SQLiteRegisteredAudienceSourceDelegate & OrganizerMergeValueSource = {
    sourceDefinitionKey: 'audience-source.communication.task-reminder.explicit',
    ownsContactRef: (contactRefId: string) => contactRefId.startsWith(TASK_REMINDER_CONTACT_REF_PREFIX),
    resolveCurrentSnapshot() {
      throw new OrganizerAudienceResolutionError('source_contract_mismatch');
    },
    resolveExplicitContacts({ scope, audience, contactRefIds }) {
      if (audience.purposeRevision.purposeKey !== TASK_REMINDER_PURPOSE_KEY) {
        throw new OrganizerAudienceResolutionError('source_contract_mismatch');
      }
      const board = input.tasks.readTaskBoard(scope);
      const candidates: OrganizerAudienceCandidate[] = [];
      for (const contactRefId of contactRefIds) {
        const engagementId = contactRefId.slice(TASK_REMINDER_CONTACT_REF_PREFIX.length);
        const engagement = input.engagements.readEngagementHead(scope, engagementId);
        const assignments = board?.assignments.filter((assignment) =>
          assignment.engagementId === engagementId && assignment.state === 'pending'
        ) ?? [];
        if (!engagement || engagement.state !== 'confirmed' || assignments.length === 0
            || engagement.submissionId === null) continue;
        const source = input.submissions.readSourceRow(scope, engagement.submissionId);
        if (!source) continue;
        candidates.push(organizerAudienceCandidateSchema.parse({
          subjectRefId: `task-reminder:${engagementId}`,
          subjectVersion: engagement.version + assignments.reduce((sum, item) => sum + item.version, 0),
          personRefId: engagement.personId,
          contactRefId,
          safeLabel: source.summary.primaryParticipantName ?? 'Speaker',
          membershipEvidence: {
            evidenceRefId: `evi1_${digest({ engagement, assignments }).slice(0, 40)}`,
            evidenceVersion: 1,
            evidenceDigestSha256: digest({ engagement, assignments })
          }
        }));
      }
      return Object.freeze({
        source: audience.source,
        candidates: Object.freeze(candidates),
        sourceVersions: Object.freeze([organizerMessagePreviewSourceVersionSchema.parse({
          sourceKey: 'task-reminder.current',
          sourceVersion: 1 + candidates.reduce((sum, candidate) => sum + candidate.subjectVersion, 0),
          digestSha256: digest({ candidates })
        })])
      });
    },
    resolveEmail({ scope, purposeRevision, candidate, asOf }) {
      const engagementId = candidate.contactRefId.slice(TASK_REMINDER_CONTACT_REF_PREFIX.length);
      const engagement = input.engagements.readEngagementHead(scope, engagementId);
      if (!engagement || engagement.personId !== candidate.personRefId || engagement.submissionId === null) {
        throw new OrganizerAudienceResolutionError('address_evidence_invalid');
      }
      const submissionContactRef = `submission-contact:${engagement.submissionId}`;
      const resolution = input.submissionAddresses.resolveEmail({
        scope, purposeRevision,
        candidate: { ...candidate, contactRefId: submissionContactRef },
        asOf
      });
      return resolution.kind === 'evaluated'
        ? { ...resolution, address: { ...resolution.address, contactRefId: candidate.contactRefId } }
        : resolution;
    },
    resolveMergeValues({ scope, candidate, fieldKeys }) {
      const engagementId = candidate.contactRefId.slice(TASK_REMINDER_CONTACT_REF_PREFIX.length);
      const engagement = input.engagements.readEngagementHead(scope, engagementId);
      if (!engagement || engagement.personId !== candidate.personRefId || engagement.submissionId === null) {
        throw new OrganizerAudienceResolutionError('address_evidence_invalid');
      }
      return input.submissionAddresses.resolveMergeValues({
        scope,
        candidate: { ...candidate, contactRefId: `submission-contact:${engagement.submissionId}` },
        fieldKeys
      });
    }
  };
  return Object.freeze(delegate);
}
