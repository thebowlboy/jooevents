import type { Database } from 'bun:sqlite';
import { createHash, createHmac } from 'node:crypto';
import {
  OrganizerAudienceResolutionError,
  REVIEWER_REMINDER_PURPOSE_KEY,
  createEventCommunicationPurposeSeedPlan,
  organizerAddressPolicyResolutionSchema,
  organizerAudienceCandidateSchema,
  type OrganizerAddressPolicyResolution,
  type OrganizerAudienceCandidate,
  type OrganizerAudienceScope,
  type OrganizerMergeValueSource
} from '@jooevents/communications';
import {
  organizerCommunicationPurposeRevisionRefSchema,
  organizerMessagePreviewSourceVersionSchema,
  type OrganizerCommunicationPurposeRevisionRef
} from '@jooevents/contracts/communications/organizer';
import { canonicalJsonText } from '@jooevents/kernel';
import type { SQLiteReviewRepository } from '../review';
import type { SQLiteReviewerRosterRepository } from '../reviewer-roster';
import type { SQLiteRegisteredAudienceSourceDelegate } from './audience-preview';

export const REVIEWER_REMINDER_CONTACT_REF_PREFIX = 'reviewer:' as const;

const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJsonText(value), 'utf8').digest('hex');

function evidenceRef(namespace: string, material: unknown) {
  const bound = digest({ namespace, material });
  return Object.freeze({
    evidenceRefId: `evi1_${bound.slice(0, 40)}`,
    evidenceVersion: 1,
    evidenceDigestSha256: bound
  });
}

function deterministicUuid(namespace: string, material: unknown): string {
  const hex = digest({ namespace, material });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}`
    + `-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Installs the reviewer-reminder purpose beside the other deterministic event seeds. */
export function seedReviewerReminderPurpose(input: {
  readonly sqlite: Database;
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
}): OrganizerCommunicationPurposeRevisionRef {
  if (!input.sqlite.inTransaction) throw new TypeError('reviewer_reminder_seed_transaction_required');
  const seed = createEventCommunicationPurposeSeedPlan(input.scope).reviewerReminderPurpose;
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
  } else if (exists.length !== 1 || exists[0]!.purpose_key !== REVIEWER_REMINDER_PURPOSE_KEY) {
    throw new TypeError('reviewer_reminder_seed_collision');
  }
  return purposeRevision;
}

interface MembershipRow {
  readonly membership_id: string;
  readonly membership_version: number;
  readonly user_id: string;
  readonly membership_status: string;
  readonly user_status: string;
}

interface EmailRow {
  readonly id: string;
  readonly display_email: string;
  readonly verified: number;
  readonly verified_at: number | null;
  readonly revoked_at: number | null;
  readonly created_at: number;
}

/**
 * Reviewer-only explicit-contact source. It follows the roster's exact access
 * subject to current membership and User state; email is never a lookup key.
 */
export function createSQLiteReviewerReminderAudienceSource(input: {
  readonly sqlite: Database;
  readonly roster: Pick<SQLiteReviewerRosterRepository, 'readReviewerRoster' | 'readReviewerAuthority'>;
  readonly reviews: Pick<SQLiteReviewRepository, 'readCatalog' | 'listAssignments' | 'readReviewHead'>;
  readonly addressFingerprintKeyBytes: Uint8Array;
  readonly addressFingerprintProfile: { readonly key: string; readonly version: number };
}): SQLiteRegisteredAudienceSourceDelegate & OrganizerMergeValueSource {
  if (input.addressFingerprintKeyBytes.byteLength < 32) throw new TypeError('reviewer_reminder_key_invalid');
  const fingerprintKey = Uint8Array.from(input.addressFingerprintKeyBytes);

  function current(scope: OrganizerAudienceScope) {
    const roster = input.roster.readReviewerRoster(scope);
    const authority = input.roster.readReviewerAuthority(scope);
    const catalog = input.reviews.readCatalog(scope);
    if (!roster || !authority || !catalog) throw new OrganizerAudienceResolutionError('source_not_registered');
    const facts = new Map(authority.facts.map((fact) => [
      `${fact.rosterSubject.kind}\0${fact.rosterSubject.id}`,
      fact
    ]));
    const rounds = catalog.rounds.filter((round) => round.state !== 'discarded');
    const assignments = rounds.flatMap((round) => input.reviews.listAssignments(scope, round.id));
    return { roster, authority, facts, assignments };
  }

  function eligibleCandidate(
    scope: OrganizerAudienceScope,
    reviewerId: string,
    state = current(scope)
  ): OrganizerAudienceCandidate | undefined {
    const record = state.roster.reviewers.find((reviewer) => reviewer.reviewerId === reviewerId);
    if (!record || record.state !== 'included') return undefined;
    const fact = state.facts.get(`${record.accessSubject.kind}\0${record.accessSubject.id}`);
    if (!fact || fact.state !== 'active' || fact.currentSubject.kind !== 'workspace_membership') {
      return undefined;
    }
    const memberships = input.sqlite.query<MembershipRow, [string, string]>(`
      SELECT m.id membership_id, m.version membership_version, m.user_id,
             m.status membership_status, u.status user_status
        FROM workspace_memberships m
        JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? AND m.id = ? LIMIT 2
    `).all(scope.workspaceId, fact.currentSubject.id);
    if (memberships.length !== 1 || memberships[0]!.membership_status !== 'active'
        || memberships[0]!.user_status !== 'active') return undefined;
    const membership = memberships[0]!;
    const outstanding = state.assignments.filter((assignment) =>
      assignment.reviewerId === reviewerId
      && assignment.state === 'assigned'
      && input.reviews.readReviewHead(scope, assignment.id) === undefined
    );
    if (outstanding.length === 0) return undefined;
    const material = {
      roster: { version: state.roster.version, digestSha256: state.roster.digestSha256 },
      record: { reviewerId, version: record.version, state: record.state },
      authority: {
        version: state.authority.version,
        digestSha256: state.authority.digestSha256,
        fact
      },
      membership: {
        id: membership.membership_id,
        version: membership.membership_version,
        userId: membership.user_id,
        status: membership.membership_status,
        userStatus: membership.user_status
      },
      outstanding: outstanding.map((assignment) => ({
        id: assignment.id, roundId: assignment.roundId,
        submissionId: assignment.submissionId, version: assignment.version
      }))
    };
    return organizerAudienceCandidateSchema.parse({
      subjectRefId: `reviewer-subject:${reviewerId}`,
      subjectVersion: 1 + record.version + fact.version
        + outstanding.reduce((sum, assignment) => sum + assignment.version, 0),
      personRefId: `reviewer-user:${membership.user_id}`,
      contactRefId: `${REVIEWER_REMINDER_CONTACT_REF_PREFIX}${reviewerId}`,
      safeLabel: fact.displayName ?? `Reviewer ${reviewerId.slice(0, 8)}`,
      membershipEvidence: evidenceRef('reviewer-reminder.membership', material)
    });
  }

  function activeMembership(scope: OrganizerAudienceScope, reviewerId: string) {
    const state = current(scope);
    const candidate = eligibleCandidate(scope, reviewerId, state);
    if (!candidate) return undefined;
    const record = state.roster.reviewers.find((reviewer) => reviewer.reviewerId === reviewerId)!;
    const fact = state.facts.get(`${record.accessSubject.kind}\0${record.accessSubject.id}`)!;
    const currentSubject = fact.currentSubject;
    if (fact.state !== 'active' || !currentSubject
        || currentSubject.kind !== 'workspace_membership') return undefined;
    const rows = input.sqlite.query<MembershipRow, [string, string]>(`
      SELECT m.id membership_id, m.version membership_version, m.user_id,
             m.status membership_status, u.status user_status
        FROM workspace_memberships m
        JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? AND m.id = ? LIMIT 2
    `).all(scope.workspaceId, currentSubject.id);
    if (rows.length !== 1 || rows[0]!.membership_status !== 'active'
        || rows[0]!.user_status !== 'active') return undefined;
    return { candidate, membership: rows[0]! };
  }

  const delegate: SQLiteRegisteredAudienceSourceDelegate & OrganizerMergeValueSource = {
    sourceDefinitionKey: 'audience-source.communication.reviewer-reminder.explicit',
    ownsContactRef: (contactRefId: string) =>
      contactRefId.startsWith(REVIEWER_REMINDER_CONTACT_REF_PREFIX),
    resolveCurrentSnapshot() {
      throw new OrganizerAudienceResolutionError('source_contract_mismatch');
    },
    resolveExplicitContacts({ scope, audience, contactRefIds }) {
      if (audience.purposeRevision.purposeKey !== REVIEWER_REMINDER_PURPOSE_KEY) {
        throw new OrganizerAudienceResolutionError('source_contract_mismatch');
      }
      const state = current(scope);
      const candidates = contactRefIds.flatMap((contactRefId) => {
        if (!contactRefId.startsWith(REVIEWER_REMINDER_CONTACT_REF_PREFIX)) {
          throw new OrganizerAudienceResolutionError('source_contract_mismatch');
        }
        const candidate = eligibleCandidate(
          scope,
          contactRefId.slice(REVIEWER_REMINDER_CONTACT_REF_PREFIX.length),
          state
        );
        return candidate ? [candidate] : [];
      });
      return Object.freeze({
        source: audience.source,
        candidates: Object.freeze(candidates),
        sourceVersions: Object.freeze([organizerMessagePreviewSourceVersionSchema.parse({
          sourceKey: 'reviewer-reminder.current',
          sourceVersion: 1 + state.roster.version + state.authority.version
            + state.assignments.reduce((sum, assignment) => sum + assignment.version, 0),
          digestSha256: digest({
            roster: { version: state.roster.version, digestSha256: state.roster.digestSha256 },
            authority: { version: state.authority.version, digestSha256: state.authority.digestSha256 },
            candidates
          })
        })])
      });
    },
    resolveEmail({ scope, purposeRevision, candidate }): OrganizerAddressPolicyResolution {
      const purpose = organizerCommunicationPurposeRevisionRefSchema.parse(purposeRevision);
      if (purpose.purposeKey !== REVIEWER_REMINDER_PURPOSE_KEY
          || !candidate.contactRefId.startsWith(REVIEWER_REMINDER_CONTACT_REF_PREFIX)) {
        throw new OrganizerAudienceResolutionError('address_contact_mismatch');
      }
      const reviewerId = candidate.contactRefId.slice(REVIEWER_REMINDER_CONTACT_REF_PREFIX.length);
      const resolved = activeMembership(scope, reviewerId);
      if (!resolved || resolved.candidate.personRefId !== candidate.personRefId) {
        return organizerAddressPolicyResolutionSchema.parse({
          kind: 'no_eligible_address',
          evidence: evidenceRef('reviewer-reminder.address.ineligible', { scope, reviewerId })
        });
      }
      const emails = input.sqlite.query<EmailRow, [string]>(`
        SELECT id, display_email, verified, verified_at, revoked_at, created_at
          FROM user_emails
         WHERE user_id = ? AND verified = 1 AND revoked_at IS NULL
         ORDER BY id COLLATE BINARY
         LIMIT 2
      `).all(resolved.membership.user_id);
      if (emails.length !== 1) {
        return organizerAddressPolicyResolutionSchema.parse({
          kind: 'no_eligible_address',
          evidence: evidenceRef('reviewer-reminder.address.not-unique', {
            scope, reviewerId, userId: resolved.membership.user_id, eligibleCount: emails.length
          })
        });
      }
      const email = emails[0]!;
      const addressMaterial = {
        reviewerId,
        membershipId: resolved.membership.membership_id,
        membershipVersion: resolved.membership.membership_version,
        userId: resolved.membership.user_id,
        userEmailId: email.id,
        verifiedAt: email.verified_at,
        createdAt: email.created_at
      };
      return organizerAddressPolicyResolutionSchema.parse({
        kind: 'evaluated',
        selectionPolicy: {
          reference: { key: 'address-policy.communication.reviewer-user-email', version: 1 },
          definitionDigestSha256: digest({
            schemaVersion: 1,
            policy: 'one_current_verified_user_email',
            purposeKey: REVIEWER_REMINDER_PURPOSE_KEY
          })
        },
        address: {
          addressRefId: deterministicUuid('communication.reviewer-address', addressMaterial),
          addressVersion: 1,
          contactRefId: candidate.contactRefId,
          channel: 'email',
          lifecycle: 'active',
          lifecycleEvidence: evidenceRef('reviewer-reminder.address.lifecycle', addressMaterial),
          lookupFingerprint: {
            profile: input.addressFingerprintProfile.key,
            version: input.addressFingerprintProfile.version,
            keyedValue: createHmac('sha256', fingerprintKey)
              .update(email.display_email, 'utf8').digest('hex')
          },
          classifiedValue: {
            payloadRefId: deterministicUuid('communication.reviewer-address-payload', addressMaterial),
            payloadRefVersion: 1,
            classification: 'communication.contact.email',
            value: email.display_email
          }
        },
        purposeBasis: {
          state: 'allowed',
          evidence: evidenceRef('reviewer-reminder.purpose', {
            purposeKey: purpose.purposeKey, revisionId: purpose.revisionId
          })
        },
        consent: {
          state: 'not_required',
          evidence: evidenceRef('reviewer-reminder.consent', { communicationClass: 'transactional' })
        },
        suppression: {
          state: 'clear',
          evidence: evidenceRef('reviewer-reminder.suppression', { scope, reviewerId, store: 'none_mounted' })
        },
        doNotContact: {
          state: 'clear',
          evidence: evidenceRef('reviewer-reminder.do-not-contact', {
            scope, userId: resolved.membership.user_id, store: 'none_mounted'
          })
        }
      });
    },
    resolveMergeValues({ candidate, fieldKeys }) {
      return Object.freeze([...new Set(fieldKeys)].sort().flatMap((fieldKey) =>
        fieldKey === 'person.name'
          ? [Object.freeze({
              fieldKey,
              value: Object.freeze({ valueType: 'text' as const, value: candidate.safeLabel })
            })]
          : []
      ));
    }
  };
  return Object.freeze(delegate);
}
