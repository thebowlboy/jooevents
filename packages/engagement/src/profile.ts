import {
  speakerProfileApprovePlanSchema,
  speakerProfileReviewPolicyUpdatePlanSchema,
  speakerProfileUpdatePlanSchema,
  speakerProfileViewSchema,
  type SpeakerProfileApprovalDto,
  type SpeakerProfileApprovePlanDto,
  type SpeakerProfileApprovePlanningInput,
  type SpeakerProfileDto,
  type SpeakerProfileFieldKey,
  type SpeakerProfilePolicyApprovalCandidateDto,
  type SpeakerProfileReviewPolicyDto,
  type SpeakerProfileReviewPolicyUpdatePlanDto,
  type SpeakerProfileReviewPolicyUpdatePlanningInput,
  type SpeakerProfileUpdatePlanDto,
  type SpeakerProfileUpdatePlanningInput,
  type SpeakerProfileViewDto
} from '@jooevents/contracts';
import { canonicalJsonSha256 } from '@jooevents/kernel';

export const SPEAKER_PROFILE_FIELDS = Object.freeze([
  'headline', 'biography', 'location', 'links'
] as const satisfies readonly SpeakerProfileFieldKey[]);

export const SPEAKER_PROFILE_PLANNING_ERROR_CODES = Object.freeze([
  'person_out_of_scope', 'stale_profile', 'profile_missing', 'profile_no_change',
  'profile_field_empty', 'profile_field_already_approved', 'profile_review_not_required',
  'profile_policy_no_change'
] as const);
export type SpeakerProfilePlanningErrorCode = typeof SPEAKER_PROFILE_PLANNING_ERROR_CODES[number];

export class SpeakerProfilePlanningError extends Error {
  constructor(
    readonly code: SpeakerProfilePlanningErrorCode,
    readonly field: SpeakerProfileFieldKey | null = null
  ) {
    super(code);
    this.name = 'SpeakerProfilePlanningError';
  }
}

export interface SpeakerProfilePlanningRepository {
  hasEventPersonRelationship(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly personId: string;
  }): boolean;
  readSpeakerProfileView(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly personId: string;
  }): SpeakerProfileViewDto;
  readReviewPolicy(input: {
    readonly workspaceId: string;
    readonly eventId: string;
  }): SpeakerProfileReviewPolicyDto;
  readPolicyApprovalCandidates(input: {
    readonly workspaceId: string;
    readonly eventId: string;
  }): readonly SpeakerProfilePolicyApprovalCandidateDto[];
}

function digest(value: unknown): string {
  return canonicalJsonSha256(value);
}

function emptyProfile(input: SpeakerProfileUpdatePlanningInput): SpeakerProfileDto {
  const empty = '';
  const links: SpeakerProfileDto['links']['value'] = [];
  return {
    schemaVersion: 1,
    workspaceId: input.scope.workspaceId,
    personId: input.authorInput.personId,
    version: 1,
    headline: { revision: 1, digestSha256: digest(empty), value: empty },
    biography: { revision: 1, digestSha256: digest(empty), value: empty },
    location: { revision: 1, digestSha256: digest(empty), value: empty },
    links: { revision: 1, digestSha256: digest(links), value: links },
    updatedAt: input.occurredAt
  };
}

function changedText(
  current: SpeakerProfileDto['headline'],
  value: string
): SpeakerProfileDto['headline'] {
  return { revision: current.revision + 1, digestSha256: digest(value), value };
}

function valuePresent(profile: SpeakerProfileDto, field: SpeakerProfileFieldKey): boolean {
  return field === 'links' ? profile.links.value.length > 0 : profile[field].value.length > 0;
}

export function planSpeakerProfileUpdate(input: {
  readonly planningInput: SpeakerProfileUpdatePlanningInput;
  readonly profiles: SpeakerProfilePlanningRepository;
}): SpeakerProfileUpdatePlanDto {
  const planning = input.planningInput;
  const scope = { ...planning.scope, personId: planning.authorInput.personId };
  if (!input.profiles.hasEventPersonRelationship(scope)) {
    throw new SpeakerProfilePlanningError('person_out_of_scope');
  }
  const before = speakerProfileViewSchema.parse(input.profiles.readSpeakerProfileView(scope));
  const current = before.profile;
  if ((current?.version ?? null) !== planning.authorInput.expectedProfileVersion) {
    throw new SpeakerProfilePlanningError('stale_profile');
  }

  const base = current ?? emptyProfile(planning);
  const patch = planning.authorInput.patch;
  const changedFields: SpeakerProfileFieldKey[] = [];
  const afterProfile: SpeakerProfileDto = {
    ...base,
    version: base.version + (current === null ? 0 : 1),
    updatedAt: planning.occurredAt,
    headline: patch.headline !== undefined && patch.headline !== base.headline.value
      ? (changedFields.push('headline'), current === null
        ? { revision: 1, digestSha256: digest(patch.headline), value: patch.headline }
        : changedText(base.headline, patch.headline))
      : base.headline,
    biography: patch.biography !== undefined && patch.biography !== base.biography.value
      ? (changedFields.push('biography'), current === null
        ? { revision: 1, digestSha256: digest(patch.biography), value: patch.biography }
        : changedText(base.biography, patch.biography))
      : base.biography,
    location: patch.location !== undefined && patch.location !== base.location.value
      ? (changedFields.push('location'), current === null
        ? { revision: 1, digestSha256: digest(patch.location), value: patch.location }
        : changedText(base.location, patch.location))
      : base.location,
    links: patch.links !== undefined && digest(patch.links) !== base.links.digestSha256
      ? (changedFields.push('links'), {
          revision: current === null ? 1 : base.links.revision + 1,
          digestSha256: digest(patch.links),
          value: patch.links
        })
      : base.links
  };
  if (changedFields.length === 0) throw new SpeakerProfilePlanningError('profile_no_change');

  const changed = new Set(changedFields);
  const retainedApprovals = before.approvals.filter((approval) => !changed.has(approval.field));
  const insertedApprovals: SpeakerProfileApprovalDto[] = before.reviewPolicy.reviewRequired
    ? []
    : changedFields.map((field, index) => {
        const value = afterProfile[field];
        return {
          id: planning.autoApprovalIds[index]!,
          workspaceId: planning.scope.workspaceId,
          eventId: planning.scope.eventId,
          personId: planning.authorInput.personId,
          field,
          fieldRevision: value.revision,
          fieldDigestSha256: value.digestSha256,
          actor: {
            kind: 'policy' as const,
            policyKey: 'profile_content_review' as const,
            policyVersion: 1 as const,
            initiatedByUserId: planning.actorUserId
          },
          approvedAt: planning.occurredAt
        };
      });
  const after = {
    ...before,
    profile: afterProfile,
    approvals: SPEAKER_PROFILE_FIELDS
      .map((field) => [...retainedApprovals, ...insertedApprovals]
        .find((approval) => approval.field === field))
      .filter((approval): approval is SpeakerProfileApprovalDto => approval !== undefined)
  };
  return speakerProfileUpdatePlanSchema.parse({
    input: planning, before, after, changedFields, insertedApprovals
  });
}

export function planSpeakerProfileApproval(input: {
  readonly planningInput: SpeakerProfileApprovePlanningInput;
  readonly profiles: SpeakerProfilePlanningRepository;
}): SpeakerProfileApprovePlanDto {
  const planning = input.planningInput;
  const scope = { ...planning.scope, personId: planning.authorInput.personId };
  if (!input.profiles.hasEventPersonRelationship(scope)) {
    throw new SpeakerProfilePlanningError('person_out_of_scope');
  }
  const before = speakerProfileViewSchema.parse(input.profiles.readSpeakerProfileView(scope));
  if (!before.reviewPolicy.reviewRequired) {
    throw new SpeakerProfilePlanningError('profile_review_not_required');
  }
  const profile = before.profile;
  if (!profile) throw new SpeakerProfilePlanningError('profile_missing');
  if (profile.version !== planning.authorInput.expectedProfileVersion) {
    throw new SpeakerProfilePlanningError('stale_profile');
  }

  const approvalsByField = new Map(before.approvals.map((approval) => [approval.field, approval]));
  const inserted: SpeakerProfileApprovalDto[] = planning.authorInput.fields.map((field, index) => {
    const value = profile[field];
    if (!valuePresent(profile, field)) throw new SpeakerProfilePlanningError('profile_field_empty', field);
    const existing = approvalsByField.get(field);
    if (existing?.fieldRevision === value.revision
        && existing.fieldDigestSha256 === value.digestSha256) {
      throw new SpeakerProfilePlanningError('profile_field_already_approved', field);
    }
    return {
      id: planning.approvalIds[index]!,
      workspaceId: planning.scope.workspaceId,
      eventId: planning.scope.eventId,
      personId: planning.authorInput.personId,
      field,
      fieldRevision: value.revision,
      fieldDigestSha256: value.digestSha256,
      actor: { kind: 'user', userId: planning.actorUserId },
      approvedAt: planning.occurredAt
    };
  });
  for (const approval of inserted) approvalsByField.set(approval.field, approval);
  const after = {
    ...before,
    approvals: SPEAKER_PROFILE_FIELDS
      .map((field) => approvalsByField.get(field))
      .filter((approval): approval is SpeakerProfileApprovalDto => approval !== undefined)
  };
  return speakerProfileApprovePlanSchema.parse({ input: planning, before, after, inserted });
}

export function planSpeakerProfileReviewPolicyUpdate(input: {
  readonly planningInput: SpeakerProfileReviewPolicyUpdatePlanningInput;
  readonly profiles: SpeakerProfilePlanningRepository;
}): SpeakerProfileReviewPolicyUpdatePlanDto {
  const planning = input.planningInput;
  const before = input.profiles.readReviewPolicy(planning.scope);
  if (before.eventVersion !== planning.authorInput.expectedEventVersion) {
    throw new SpeakerProfilePlanningError('stale_profile');
  }
  if (before.reviewRequired === planning.authorInput.reviewRequired) {
    throw new SpeakerProfilePlanningError('profile_policy_no_change');
  }
  const candidates = planning.authorInput.reviewRequired
    ? []
    : [...input.profiles.readPolicyApprovalCandidates(planning.scope)];
  if (planning.approvalIds.length !== candidates.length) {
    throw new TypeError('profile_policy_approval_ids_inconsistent');
  }
  const insertedApprovals: SpeakerProfileApprovalDto[] = candidates.map((candidate, index) => ({
    id: planning.approvalIds[index]!,
    workspaceId: planning.scope.workspaceId,
    eventId: planning.scope.eventId,
    personId: candidate.personId,
    field: candidate.field,
    fieldRevision: candidate.fieldRevision,
    fieldDigestSha256: candidate.fieldDigestSha256,
    actor: {
      kind: 'policy',
      policyKey: 'profile_content_review',
      policyVersion: 1,
      initiatedByUserId: planning.actorUserId
    },
    approvedAt: planning.occurredAt
  }));
  const after: SpeakerProfileReviewPolicyDto = {
    ...before,
    eventVersion: before.eventVersion + 1,
    reviewRequired: planning.authorInput.reviewRequired
  };
  return speakerProfileReviewPolicyUpdatePlanSchema.parse({
    input: planning, before, after, insertedApprovals
  });
}
