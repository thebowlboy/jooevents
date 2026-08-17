import { FOUNDATION_TRIAL_UOW_SQL } from './foundation-trial-uow';
import { AGENT_ACTION_RUN_SQL } from './agent-action-runs';
import { DECISION_SQL } from './decision';
import { SQLITE_ENGAGEMENT_SQL } from './engagement';
import { TASK_SQL } from './tasks';
import { EVENT_SPINE_SQL } from './event-spine';
import { EVENT_SETTINGS_SQL } from './event-settings';
import { TEMPLATE_AUTHORING_SQL } from './template-authoring';
import { SQLITE_TEMPLATE_ARTIFACT_NATIVE_EFFECT_SQL } from './template-artifact-native-effect-domain';
import { TEMPLATE_EDIT_EFFECT_SQL } from './template-edit-effect-domain';
import { DEADLINE_SQL } from './deadline';
import { FIELD_REGISTRY_SQL } from './field-registry';
import { SQLITE_FILES_SQL } from './files';
import { SQLITE_INTAKE_FORM_WRITE_EFFECT_SQL } from './intake-form-write-effect-domain';
import {
  SQLITE_INTAKE_PARTICIPANT_ATTRIBUTION_CONFORMANCE_SQL
} from './intake-participant-attribution-conformance';
import { SQLITE_INTAKE_PUBLIC_MUTATION_EFFECT_SQL } from './intake-public-mutation-effect-domain';
import { SQLITE_INTAKE_SQL } from './intake';
import { SQLITE_SUBMISSION_TRIAGE_E2_0001_SQL } from './submission-triage';
import {
  createEphemeralSQLiteRuntime,
  type EphemeralSQLiteRuntime,
  type EphemeralSQLiteSchemaArtifact
} from './ephemeral-sqlite-runtime';
import { MODEL_DURABILITY_TRIAL_SQL } from './model-durability-trial';
import { SQLITE_PARTICIPANT_ACCESS_SQL } from './participant-access';
import { SQLITE_PARTICIPANT_PORTAL_EFFECT_SQL } from './participant-portal-effect-domain';
import { SQLITE_RELEASE_SQL } from './release';
import { SQLITE_RELEASE_NATIVE_EFFECT_SQL } from './release-native-effect-domain';
import { SQLITE_ORGANIZER_AUDIENCE_PREVIEW_SQL } from './communications/audience-preview';
import { SQLITE_COMMUNICATION_MESSAGE_RELEASES_SQL } from './communications/message-releases';
import {
  SQLITE_COMMUNICATION_RELEASE_SQL
} from './communications/message-release-effect-domain';
import { SQLITE_ORGANIZER_COMMUNICATION_AUTHORING_SQL } from './communications/organizer-authoring';
import { SQLITE_ORGANIZER_COMMUNICATION_AUTHORING_EFFECT_SQL } from './communications/organizer-authoring-effect-domain';
import { SQLITE_EMAIL_PROVIDER_CONFIGURATION_SQL } from './communications/provider-configuration';
import { SQLITE_WORKSPACE_SENDER_IDENTITY_SQL } from './communications/workspace-sender-identity';
import { SQLITE_OUTBOUND_EMAIL_DELIVERY_SQL } from './outbound-email-delivery';
import { SESSION_SQL } from './session';
import { REVIEW_SQL } from './review';
import {
  REVIEW_EVALUATION_DRAFT_SAVE_EFFECT_SQL
} from './review-evaluation-draft-save-effect-domain';
import { REVIEWER_ROSTER_SQL } from './reviewer-roster';
import { PROGRAM_VOCABULARY_SQL } from './program-vocabulary';
import { SQLITE_PROGRAM_VOCABULARY_MERGE_EFFECT_SQL } from './program-vocabulary-merge-effect-domain';
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
import { SQLITE_API_KEYS_SQL } from './api-keys';
import { SQLITE_EXTERNAL_API_RATE_LIMIT_SQL } from './external-api-rate-limits';

function schemaArtifact(id: string, sql: string): EphemeralSQLiteSchemaArtifact {
  return Object.freeze({ id, sql });
}

/** Exact ordered current-authoring inventory verified against the retained chain. */
export const FOUNDATION_SCHEMA_AUTHORING_ARTIFACTS: readonly EphemeralSQLiteSchemaArtifact[] =
  Object.freeze([
    schemaArtifact('foundation-uow', FOUNDATION_TRIAL_UOW_SQL),
    schemaArtifact('agent-action-runs', AGENT_ACTION_RUN_SQL),
    schemaArtifact('event-spine', EVENT_SPINE_SQL),
    schemaArtifact('event-settings-domain', EVENT_SETTINGS_SQL),
    schemaArtifact('template-authoring-domain', TEMPLATE_AUTHORING_SQL),
    schemaArtifact('template-artifact-native-effect', SQLITE_TEMPLATE_ARTIFACT_NATIVE_EFFECT_SQL),
    schemaArtifact('template-edit-effect', TEMPLATE_EDIT_EFFECT_SQL),
    schemaArtifact('deadline-domain', DEADLINE_SQL),
    schemaArtifact('program-vocabulary-domain', PROGRAM_VOCABULARY_SQL),
    schemaArtifact('program-vocabulary-merge-effect', SQLITE_PROGRAM_VOCABULARY_MERGE_EFFECT_SQL),
    schemaArtifact('schedule-placement-domain', SCHEDULE_PLACEMENT_SQL),
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
    schemaArtifact('api-keys-domain', SQLITE_API_KEYS_SQL),
    schemaArtifact('external-api-rate-limits', SQLITE_EXTERNAL_API_RATE_LIMIT_SQL),
    schemaArtifact('intake-domain', SQLITE_INTAKE_SQL),
    schemaArtifact('release-domain', SQLITE_RELEASE_SQL),
    schemaArtifact('release-native-effect', SQLITE_RELEASE_NATIVE_EFFECT_SQL),
    schemaArtifact('intake-form-write-effect', SQLITE_INTAKE_FORM_WRITE_EFFECT_SQL),
    schemaArtifact('submission-triage-domain', SQLITE_SUBMISSION_TRIAGE_E2_0001_SQL),
    schemaArtifact('field-registry-domain', FIELD_REGISTRY_SQL),
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
    schemaArtifact('session-domain', SESSION_SQL),
    schemaArtifact('reviewer-roster-domain', REVIEWER_ROSTER_SQL),
    schemaArtifact('review-domain', REVIEW_SQL),
    schemaArtifact('review-evaluation-draft-save-effect', REVIEW_EVALUATION_DRAFT_SAVE_EFFECT_SQL),
    schemaArtifact('decision-domain', DECISION_SQL),
    schemaArtifact('engagement-domain', SQLITE_ENGAGEMENT_SQL),
    schemaArtifact('task-domain', TASK_SQL),
    schemaArtifact('communication-outbound-delivery', SQLITE_OUTBOUND_EMAIL_DELIVERY_SQL),
    schemaArtifact('communication-message-releases', SQLITE_COMMUNICATION_MESSAGE_RELEASES_SQL),
    schemaArtifact(
      'communication-release-native-effect',
      SQLITE_COMMUNICATION_RELEASE_SQL
    ),
    schemaArtifact('participant-access', SQLITE_PARTICIPANT_ACCESS_SQL),
    schemaArtifact('participant-portal-effect', SQLITE_PARTICIPANT_PORTAL_EFFECT_SQL),
    schemaArtifact('files-domain', SQLITE_FILES_SQL)
  ]);

/** Opens one isolated runtime from the accepted retained Foundation baseline. */
export function createFoundationEphemeralSQLiteRuntime(): EphemeralSQLiteRuntime {
  return createEphemeralSQLiteRuntime([]);
}
