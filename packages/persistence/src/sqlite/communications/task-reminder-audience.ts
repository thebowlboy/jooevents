import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  OrganizerAudienceResolutionError,
  TASK_REMINDER_PURPOSE_KEY,
  createEventCommunicationPurposeSeedPlan,
  organizerAudienceCandidateSchema,
  type OrganizerAudienceCandidate,
  type OrganizerMergeValueSource
} from '@jooevents/communications';
import {
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

/** Installs the transactional purpose; message content remains organizer-authored. */
export function seedTaskReminderPurpose(input: {
  readonly sqlite: Database;
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
}): OrganizerCommunicationPurposeRevisionRef {
  if (!input.sqlite.inTransaction) throw new TypeError('task_reminder_seed_transaction_required');
  const seed = createEventCommunicationPurposeSeedPlan(input.scope).taskReminderPurpose;
  const { purposeRevision } = seed;
  const exists = input.sqlite.query<{ purpose_key: string }, [string, string, string]>(`
    SELECT purpose_key FROM communication_purposes
     WHERE workspace_id=? AND event_id=? AND purpose_id=? LIMIT 2
  `).all(input.scope.workspaceId, input.scope.eventId, purposeRevision.purposeId);
  if (exists.length === 0) {
    input.sqlite.query(`
      INSERT INTO communication_purposes(
        workspace_id,event_id,purpose_id,purpose_key,lifecycle,current_revision_id
      ) VALUES (?,?,?,?,'active',?)
    `).run(
      input.scope.workspaceId, input.scope.eventId, purposeRevision.purposeId,
      purposeRevision.purposeKey, purposeRevision.revisionId
    );
    input.sqlite.query(`
      INSERT INTO communication_purpose_revisions(
        workspace_id,event_id,purpose_id,purpose_key,revision_id,revision_number,
        digest_sha256,label,communication_class,policy_digest_sha256,description,
        allowed_audience_sources_json
      ) VALUES (?,?,?,?,?,1,?,?,'transactional',?,?,?)
    `).run(
      input.scope.workspaceId, input.scope.eventId, purposeRevision.purposeId,
      purposeRevision.purposeKey, purposeRevision.revisionId,
      purposeRevision.digestSha256, seed.label, seed.policyDigestSha256,
      seed.description, canonicalJsonText(seed.allowedAudienceSources)
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
