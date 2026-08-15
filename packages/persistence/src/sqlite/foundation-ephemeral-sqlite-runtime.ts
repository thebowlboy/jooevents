import { CHANGESET_LIFECYCLE_SQL } from './changeset-lifecycle';
import { FOUNDATION_TRIAL_UOW_SQL } from './foundation-trial-uow';
import { DECISION_SQL } from './decision';
import { DECISION_CHANGESET_EFFECT_SQL } from './decision-changeset-effect-domain';
import { DECISION_DRAFT_EFFECT_SQL } from './decision-draft-effect-domain';
import { SQLITE_ENGAGEMENT_SQL } from './engagement';
import { SQLITE_ENGAGEMENT_DRAFT_EFFECT_SQL } from './engagement-draft-effect-domain';
import { SQLITE_ENGAGEMENT_CHANGESET_EFFECT_SQL } from './engagement-changeset-effect-domain';
import { TASK_SQL } from './tasks';
import { TASK_DRAFT_EFFECT_SQL } from './task-draft-effect-domain';
import { TASK_CHANGESET_EFFECT_SQL } from './task-changeset-effect-domain';
import { EVENT_SPINE_SQL } from './event-spine';
import { EVENT_CREATION_CHANGESET_EFFECT_SQL } from './event-changeset-effect-domain';
import { EVENT_CREATE_DRAFT_EFFECT_SQL } from './event-create-draft-effect-domain';
import { EVENT_SETTINGS_SQL } from './event-settings';
import { EVENT_SETTINGS_CHANGESET_EFFECT_SQL } from './event-settings-changeset-effect-domain';
import { EVENT_SETTINGS_UPDATE_DRAFT_EFFECT_SQL } from './event-settings-draft-effect-domain';
import { TEMPLATE_AUTHORING_SQL } from './template-authoring';
import { TEMPLATE_ARTIFACT_DRAFT_EFFECT_SQL } from './template-artifact-draft-effect-domain';
import { TEMPLATE_EDIT_EFFECT_SQL } from './template-edit-effect-domain';
import {
  TEMPLATE_ARTIFACT_CHANGESET_EFFECT_SQL
} from './template-artifact-changeset-effect-domain';
import { DEADLINE_CHANGESET_EFFECT_SQL } from './deadline-changeset-effect-domain';
import { DEADLINE_DRAFT_EFFECT_SQL } from './deadline-draft-effect-domain';
import { DEADLINE_SQL } from './deadline';
import { FIELD_REGISTRY_CHANGESET_EFFECT_SQL } from './field-registry-changeset-effect-domain';
import { FIELD_REGISTRY_DRAFT_EFFECT_SQL } from './field-registry-draft-effect-domain';
import { FIELD_REGISTRY_SQL } from './field-registry';
import { SQLITE_FILES_SQL } from './files';
import {
  SQLITE_INTAKE_DIRECT_ENTRY_EFFECT_SQL
} from './intake-direct-entry-effect-domain';
import { INTAKE_FORM_CHANGESET_EFFECT_SQL } from './intake-form-changeset-effect-domain';
import { INTAKE_FORM_DRAFT_EFFECT_SQL } from './intake-form-draft-effect-domain';
import {
  SQLITE_INTAKE_PARTICIPANT_ATTRIBUTION_CONFORMANCE_SQL
} from './intake-participant-attribution-conformance';
import { SQLITE_INTAKE_PUBLIC_MUTATION_EFFECT_SQL } from './intake-public-mutation-effect-domain';
import { SQLITE_INTAKE_SQL } from './intake';
import { SUBMISSION_TRIAGE_CHANGESET_EFFECT_SQL } from './submission-triage-changeset-effect-domain';
import { SQLITE_SUBMISSION_TRIAGE_DRAFT_EFFECT_SQL } from './submission-triage-draft-effect-domain';
import { SQLITE_SUBMISSION_TRIAGE_SQL } from './submission-triage';
import {
  createEphemeralSQLiteRuntime,
  type EphemeralSQLiteRuntime,
  type EphemeralSQLiteSchemaArtifact
} from './ephemeral-sqlite-runtime';
import { MODEL_DURABILITY_TRIAL_SQL } from './model-durability-trial';
import { SQLITE_PARTICIPANT_ACCESS_SQL } from './participant-access';
import { SQLITE_PARTICIPANT_PORTAL_EFFECT_SQL } from './participant-portal-effect-domain';
import { SQLITE_RELEASE_SQL } from './release';
import { SQLITE_RELEASE_DRAFT_EFFECT_SQL } from './release-draft-effect-domain';
import { SQLITE_RELEASE_CHANGESET_EFFECT_SQL } from './release-changeset-effect-domain';
import { SQLITE_ORGANIZER_AUDIENCE_PREVIEW_SQL } from './communications/audience-preview';
import { SQLITE_COMMUNICATION_MESSAGE_RELEASES_SQL } from './communications/message-releases';
import {
  SQLITE_COMMUNICATION_RELEASE_CHANGESET_SQL
} from './communications/message-release-effect-domain';
import { SQLITE_ORGANIZER_COMMUNICATION_AUTHORING_SQL } from './communications/organizer-authoring';
import { SQLITE_ORGANIZER_COMMUNICATION_AUTHORING_EFFECT_SQL } from './communications/organizer-authoring-effect-domain';
import { SQLITE_EMAIL_PROVIDER_CONFIGURATION_SQL } from './communications/provider-configuration';
import { SQLITE_WORKSPACE_SENDER_IDENTITY_SQL } from './communications/workspace-sender-identity';
import { SQLITE_OUTBOUND_EMAIL_DELIVERY_SQL } from './outbound-email-delivery';
import { SESSION_SQL } from './session';
import { SESSION_DRAFT_EFFECT_SQL } from './session-draft-effect-domain';
import { SESSION_CHANGESET_EFFECT_SQL } from './session-changeset-effect-domain';
import { REVIEW_SQL } from './review';
import { REVIEW_DRAFT_EFFECT_SQL } from './review-draft-effect-domain';
import {
  REVIEW_EVALUATION_DRAFT_SAVE_EFFECT_SQL
} from './review-evaluation-draft-save-effect-domain';
import { REVIEW_CHANGESET_EFFECT_SQL } from './review-changeset-effect-domain';
import { REVIEWER_ROSTER_SQL } from './reviewer-roster';
import { REVIEWER_ROSTER_DRAFT_EFFECT_SQL } from './reviewer-roster-draft-effect-domain';
import {
  REVIEWER_ROSTER_CHANGESET_EFFECT_SQL
} from './reviewer-roster-changeset-effect-domain';
import { PROGRAM_VOCABULARY_DRAFT_EFFECT_SQL } from './program-vocabulary-draft-effect-domain';
import { PROGRAM_VOCABULARY_CHANGESET_EFFECT_SQL } from './program-vocabulary-changeset-effect-domain';
import { PROGRAM_VOCABULARY_REVIEWED_COMMIT_TRIAL_SQL } from './program-vocabulary-reviewed-commit-trial';
import { PROGRAM_VOCABULARY_TRIAL_SQL } from './program-vocabulary-trial';
import { PROGRAM_VOCABULARY_SQL } from './program-vocabulary';
import { SCHEDULE_PLACEMENT_CHANGESET_EFFECT_SQL } from './schedule-placement-changeset-effect-domain';
import { SCHEDULE_PLACEMENT_DRAFT_EFFECT_SQL } from './schedule-placement-draft-effect-domain';
import { SCHEDULE_PLACEMENT_SQL } from './schedule-placement';
import { PUBLIC_MUTATION_CONTINUATION_TRIAL_SQL } from './public-mutation-continuation-trial';
import { SQLITE_PUBLIC_MUTATION_EFFECT_COMPLETION_SQL } from './public-mutation-effect-completion';
import { READ_IMMUTABLE_AUDIT_TRIAL_SQL } from './read-immutable-audit-trial';
import { REGISTERED_CONSUMER_OPERATION_TRIAL_SQL } from './registered-consumer-operation-trial';
import { REGISTERED_JOB_OPERATION_TRIAL_SQL } from './registered-job-operation-trial';
import {
  RELIABILITY_CONSUMER_IMMUTABILITY_TRIAL_SQL,
  RELIABILITY_CONSUMER_TRIAL_SQL
} from './reliability-consumer-trial';
import { RELIABILITY_FACT_EFFECT_TRIAL_SQL } from './reliability-fact-effect-trial';
import {
  RELIABILITY_JOB_IMMUTABILITY_TRIAL_SQL,
  RELIABILITY_JOB_TRIAL_SQL
} from './reliability-job-trial';
import { VERIFIED_INBOX_PROCESSING_TRIAL_SQL } from './verified-inbox-processing-trial';
import { VERIFIED_INBOX_TRIAL_SQL } from './verified-inbox-trial';
import { SQLITE_CLASSIFIED_PAYLOAD_STORE_SQL } from './sqlite-classified-payload-store';
import { WORKSPACE_TEAM_SQL } from './workspace-team';
import { WORKSPACE_TEAM_DRAFT_EFFECT_SQL } from './workspace-team-draft-effect-domain';
import { WORKSPACE_TEAM_CHANGESET_EFFECT_SQL } from './workspace-team-changeset-effect-domain';

function schemaArtifact(id: string, sql: string): EphemeralSQLiteSchemaArtifact {
  return Object.freeze({ id, sql });
}

/** Exact ordered additive schema installed by the ephemeral Foundation runtime. */
export const FOUNDATION_EPHEMERAL_SCHEMA_ARTIFACTS: readonly EphemeralSQLiteSchemaArtifact[] =
  Object.freeze([
    schemaArtifact('foundation-uow', FOUNDATION_TRIAL_UOW_SQL),
    schemaArtifact('event-spine', EVENT_SPINE_SQL),
    schemaArtifact('event-settings-domain', EVENT_SETTINGS_SQL),
    schemaArtifact('template-authoring-domain', TEMPLATE_AUTHORING_SQL),
    schemaArtifact('template-artifact-draft-effect', TEMPLATE_ARTIFACT_DRAFT_EFFECT_SQL),
    schemaArtifact('template-edit-effect', TEMPLATE_EDIT_EFFECT_SQL),
    schemaArtifact('deadline-domain', DEADLINE_SQL),
    schemaArtifact('changeset-lifecycle', CHANGESET_LIFECYCLE_SQL),
    schemaArtifact('deadline-draft-effect', DEADLINE_DRAFT_EFFECT_SQL),
    schemaArtifact('deadline-changeset-effect', DEADLINE_CHANGESET_EFFECT_SQL),
    schemaArtifact('event-create-draft-effect', EVENT_CREATE_DRAFT_EFFECT_SQL),
    schemaArtifact('event-creation-changeset-effect', EVENT_CREATION_CHANGESET_EFFECT_SQL),
    schemaArtifact('event-settings-draft-effect', EVENT_SETTINGS_UPDATE_DRAFT_EFFECT_SQL),
    schemaArtifact('event-settings-changeset-effect', EVENT_SETTINGS_CHANGESET_EFFECT_SQL),
    schemaArtifact('template-artifact-changeset-effect', TEMPLATE_ARTIFACT_CHANGESET_EFFECT_SQL),
    schemaArtifact('program-vocabulary-domain', PROGRAM_VOCABULARY_SQL),
    schemaArtifact('schedule-placement-domain', SCHEDULE_PLACEMENT_SQL),
    schemaArtifact('program-vocabulary-draft-effect', PROGRAM_VOCABULARY_DRAFT_EFFECT_SQL),
    schemaArtifact('program-vocabulary-changeset-effect', PROGRAM_VOCABULARY_CHANGESET_EFFECT_SQL),
    schemaArtifact('schedule-placement-draft-effect', SCHEDULE_PLACEMENT_DRAFT_EFFECT_SQL),
    schemaArtifact('schedule-placement-changeset-effect', SCHEDULE_PLACEMENT_CHANGESET_EFFECT_SQL),
    schemaArtifact('classified-payload-store', SQLITE_CLASSIFIED_PAYLOAD_STORE_SQL),
    schemaArtifact('communication-organizer-authoring', SQLITE_ORGANIZER_COMMUNICATION_AUTHORING_SQL),
    schemaArtifact(
      'communication-organizer-authoring-effect',
      SQLITE_ORGANIZER_COMMUNICATION_AUTHORING_EFFECT_SQL
    ),
    schemaArtifact('communication-organizer-audience-preview', SQLITE_ORGANIZER_AUDIENCE_PREVIEW_SQL),
    schemaArtifact('communication-email-provider-configuration', SQLITE_EMAIL_PROVIDER_CONFIGURATION_SQL),
    schemaArtifact('communication-workspace-sender-identity', SQLITE_WORKSPACE_SENDER_IDENTITY_SQL),
    schemaArtifact('workspace-team-domain', WORKSPACE_TEAM_SQL),
    schemaArtifact('workspace-team-draft-effect', WORKSPACE_TEAM_DRAFT_EFFECT_SQL),
    schemaArtifact('workspace-team-changeset-effect', WORKSPACE_TEAM_CHANGESET_EFFECT_SQL),
    schemaArtifact('intake-domain', SQLITE_INTAKE_SQL),
    schemaArtifact('release-domain', SQLITE_RELEASE_SQL),
    schemaArtifact('release-draft-effect', SQLITE_RELEASE_DRAFT_EFFECT_SQL),
    schemaArtifact('release-changeset-effect', SQLITE_RELEASE_CHANGESET_EFFECT_SQL),
    schemaArtifact('intake-form-draft-effect', INTAKE_FORM_DRAFT_EFFECT_SQL),
    schemaArtifact('intake-form-changeset-effect', INTAKE_FORM_CHANGESET_EFFECT_SQL),
    schemaArtifact('submission-triage-domain', SQLITE_SUBMISSION_TRIAGE_SQL),
    schemaArtifact('submission-triage-draft-effect', SQLITE_SUBMISSION_TRIAGE_DRAFT_EFFECT_SQL),
    schemaArtifact('submission-triage-changeset-effect', SUBMISSION_TRIAGE_CHANGESET_EFFECT_SQL),
    schemaArtifact('intake-direct-entry-effect', SQLITE_INTAKE_DIRECT_ENTRY_EFFECT_SQL),
    schemaArtifact('field-registry-domain', FIELD_REGISTRY_SQL),
    schemaArtifact('field-registry-draft-effect', FIELD_REGISTRY_DRAFT_EFFECT_SQL),
    schemaArtifact('field-registry-changeset-effect', FIELD_REGISTRY_CHANGESET_EFFECT_SQL),
    schemaArtifact('read-audit', READ_IMMUTABLE_AUDIT_TRIAL_SQL),
    schemaArtifact('reliability-fact-effect', RELIABILITY_FACT_EFFECT_TRIAL_SQL),
    schemaArtifact('reliability-consumer', RELIABILITY_CONSUMER_TRIAL_SQL),
    schemaArtifact('reliability-consumer-immutability', RELIABILITY_CONSUMER_IMMUTABILITY_TRIAL_SQL),
    schemaArtifact('registered-consumer', REGISTERED_CONSUMER_OPERATION_TRIAL_SQL),
    schemaArtifact('reliability-job', RELIABILITY_JOB_TRIAL_SQL),
    schemaArtifact('reliability-job-immutability', RELIABILITY_JOB_IMMUTABILITY_TRIAL_SQL),
    schemaArtifact('registered-job', REGISTERED_JOB_OPERATION_TRIAL_SQL),
    schemaArtifact('model-durability', MODEL_DURABILITY_TRIAL_SQL),
    schemaArtifact('verified-inbox', VERIFIED_INBOX_TRIAL_SQL),
    schemaArtifact('verified-inbox-processing', VERIFIED_INBOX_PROCESSING_TRIAL_SQL),
    schemaArtifact('public-mutation-continuation', PUBLIC_MUTATION_CONTINUATION_TRIAL_SQL),
    schemaArtifact(
      'public-mutation-effect-completion',
      SQLITE_PUBLIC_MUTATION_EFFECT_COMPLETION_SQL
    ),
    schemaArtifact('intake-public-mutation-effect', SQLITE_INTAKE_PUBLIC_MUTATION_EFFECT_SQL),
    schemaArtifact(
      'intake-participant-attribution-conformance',
      SQLITE_INTAKE_PARTICIPANT_ATTRIBUTION_CONFORMANCE_SQL
    ),
    schemaArtifact('program-vocabulary', PROGRAM_VOCABULARY_TRIAL_SQL),
    schemaArtifact('program-vocabulary-reviewed-commit', PROGRAM_VOCABULARY_REVIEWED_COMMIT_TRIAL_SQL),
    schemaArtifact('session-domain', SESSION_SQL),
    schemaArtifact('session-draft-effect', SESSION_DRAFT_EFFECT_SQL),
    schemaArtifact('session-changeset-effect', SESSION_CHANGESET_EFFECT_SQL),
    schemaArtifact('reviewer-roster-domain', REVIEWER_ROSTER_SQL),
    schemaArtifact('review-domain', REVIEW_SQL),
    schemaArtifact('review-draft-effect', REVIEW_DRAFT_EFFECT_SQL),
    schemaArtifact('review-evaluation-draft-save-effect', REVIEW_EVALUATION_DRAFT_SAVE_EFFECT_SQL),
    schemaArtifact('review-changeset-effect', REVIEW_CHANGESET_EFFECT_SQL),
    schemaArtifact('reviewer-roster-draft-effect', REVIEWER_ROSTER_DRAFT_EFFECT_SQL),
    schemaArtifact('reviewer-roster-changeset-effect', REVIEWER_ROSTER_CHANGESET_EFFECT_SQL),
    schemaArtifact('decision-domain', DECISION_SQL),
    schemaArtifact('decision-draft-effect', DECISION_DRAFT_EFFECT_SQL),
    schemaArtifact('decision-changeset-effect', DECISION_CHANGESET_EFFECT_SQL),
    schemaArtifact('engagement-domain', SQLITE_ENGAGEMENT_SQL),
    schemaArtifact('task-domain', TASK_SQL),
    schemaArtifact('task-draft-effect', TASK_DRAFT_EFFECT_SQL),
    schemaArtifact('task-changeset-effect', TASK_CHANGESET_EFFECT_SQL),
    schemaArtifact('engagement-draft-effect', SQLITE_ENGAGEMENT_DRAFT_EFFECT_SQL),
    schemaArtifact('engagement-changeset-effect', SQLITE_ENGAGEMENT_CHANGESET_EFFECT_SQL),
    schemaArtifact('communication-outbound-delivery', SQLITE_OUTBOUND_EMAIL_DELIVERY_SQL),
    schemaArtifact('communication-message-releases', SQLITE_COMMUNICATION_MESSAGE_RELEASES_SQL),
    schemaArtifact(
      'communication-release-changeset-effect',
      SQLITE_COMMUNICATION_RELEASE_CHANGESET_SQL
    ),
    schemaArtifact('participant-access', SQLITE_PARTICIPANT_ACCESS_SQL),
    schemaArtifact('participant-portal-effect', SQLITE_PARTICIPANT_PORTAL_EFFECT_SQL),
    schemaArtifact('files-domain', SQLITE_FILES_SQL)
  ]);

/** Opens one isolated runtime with the exact ordered Foundation schema. */
export function createFoundationEphemeralSQLiteRuntime(): EphemeralSQLiteRuntime {
  return createEphemeralSQLiteRuntime(FOUNDATION_EPHEMERAL_SCHEMA_ARTIFACTS);
}
