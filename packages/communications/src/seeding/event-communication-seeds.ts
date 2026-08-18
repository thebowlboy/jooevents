import {
  organizerCommunicationAudienceDraftSchema,
  organizerCommunicationAudienceOptionSchema,
  organizerCommunicationDefinitionRefSchema,
  organizerCommunicationPurposeRevisionRefSchema,
  type OrganizerCommunicationAudienceOption,
  type OrganizerCommunicationPurposeRevisionRef
} from '@jooevents/contracts/communications/organizer';
import { canonicalJsonText, parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DECISION_NOTIFICATION_PURPOSE_KEY } from '../rendering/decision-notification';
import {
  SUBMISSION_CONFIRMATION_PURPOSE_KEY,
  SUBMISSION_CONFIRMATION_STANDING_POLICY,
  SUBMISSION_CONFIRMATION_TEMPLATE_REVISION_REF_ID
} from '../rendering/submission-confirmation';
import { TASK_REMINDER_PURPOSE_KEY } from '../rendering/task-reminder';
import { REVIEWER_REMINDER_PURPOSE_KEY } from '../rendering/reviewer-reminder';
import {
  CALENDAR_NOTICE_PURPOSE_KEY,
  CALENDAR_NOTICE_STANDING_POLICY,
  CALENDAR_NOTICE_TEMPLATE_REVISION_REF_ID
} from '../rendering/calendar-notice';

export const EVENT_DECISION_AUDIENCE_STATUSES = Object.freeze(['accepted', 'declined'] as const);
export type EventDecisionAudienceStatus = (typeof EVENT_DECISION_AUDIENCE_STATUSES)[number];
export const EVENT_DECISION_SEED_OWNER_KEY = 'system.communication.decision-seed';

type OrganizerCommunicationDefinitionRef = ReturnType<
  typeof organizerCommunicationDefinitionRefSchema.parse
>;

export interface EventCommunicationSeedScope {
  readonly workspaceId: string;
  readonly eventId: string;
}

export interface EventCommunicationPurposeSeed {
  readonly purposeRevision: OrganizerCommunicationPurposeRevisionRef;
  readonly label: string;
  readonly communicationClass: 'transactional';
  readonly policyDigestSha256: string;
  readonly description: string;
  readonly allowedAudienceSources: readonly OrganizerCommunicationDefinitionRef[];
}

export interface EventCommunicationTemplateSeed {
  readonly status: EventDecisionAudienceStatus;
  readonly templateId: string;
  readonly templateKey: string;
  readonly templateName: string;
  readonly templateRevisionId: string;
  readonly revisionNumber: 1;
  readonly digestSha256: string;
  readonly contentPayloadRefId: string;
  readonly bindingsPayloadRefId: string;
  readonly contentPayload: unknown;
  readonly bindingsPayload: unknown;
  readonly renderer: OrganizerCommunicationDefinitionRef;
  readonly mergeRegistry: OrganizerCommunicationDefinitionRef;
}

export interface EventCommunicationSeedPlan {
  readonly scope: EventCommunicationSeedScope;
  readonly purposes: readonly EventCommunicationPurposeSeed[];
  readonly decisionPurpose: EventCommunicationPurposeSeed;
  readonly templates: readonly EventCommunicationTemplateSeed[];
  readonly audienceOptions: readonly OrganizerCommunicationAudienceOption[];
}

export interface EventCommunicationPurposeSeedPlan {
  readonly scope: EventCommunicationSeedScope;
  readonly purposes: readonly EventCommunicationPurposeSeed[];
  readonly decisionPurpose: EventCommunicationPurposeSeed;
  readonly taskReminderPurpose: EventCommunicationPurposeSeed;
  readonly reviewerReminderPurpose: EventCommunicationPurposeSeed;
  readonly submissionConfirmationPurpose: EventCommunicationPurposeSeed;
  readonly calendarNoticePurpose: EventCommunicationPurposeSeed;
}

function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJsonText(value))));
}

function deterministicUuid(
  namespace: string,
  material: unknown,
  variant: '8' | 'a'
): string {
  const hex = digest({ namespace, material });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}`
    + `-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function scope(value: EventCommunicationSeedScope): EventCommunicationSeedScope {
  return Object.freeze({
    workspaceId: parseWorkspaceId(value.workspaceId),
    eventId: parseEventId(value.eventId)
  });
}

export function createDecisionAudienceSourceDefinition(
  status: EventDecisionAudienceStatus
): OrganizerCommunicationDefinitionRef {
  const reference = Object.freeze({
    key: `audience-source.communication.decision-set.${status}`,
    version: 1
  });
  return organizerCommunicationDefinitionRefSchema.parse({
    reference,
    definitionDigestSha256: digest({
      schemaVersion: 1,
      kind: 'decision_set',
      binding: 'current_snapshot',
      reference,
      statuses: [status]
    })
  });
}

export function createDecisionAudienceRecipeSource(status: EventDecisionAudienceStatus) {
  const sourceDefinition = createDecisionAudienceSourceDefinition(status);
  const recipeId = `recipe.communication.decision-set.${status}`;
  return Object.freeze({
    kind: 'registered_query' as const,
    recipeId,
    recipeVersion: 1,
    recipeDigestSha256: digest({
      schemaVersion: 1,
      recipeId,
      recipeVersion: 1,
      sourceDefinition,
      statuses: [status]
    }),
    sourceDefinition
  });
}

const optionLabels: Readonly<Record<EventDecisionAudienceStatus, string>> = Object.freeze({
  accepted: 'Accepted submissions',
  declined: 'Declined submissions'
});

export function createDecisionAudienceOption(input: {
  readonly status: EventDecisionAudienceStatus;
  readonly purposeRevision: OrganizerCommunicationPurposeRevisionRef;
}): OrganizerCommunicationAudienceOption {
  const purposeRevision = organizerCommunicationPurposeRevisionRefSchema.parse(input.purposeRevision);
  const source = createDecisionAudienceRecipeSource(input.status);
  const audienceDraft = organizerCommunicationAudienceDraftSchema.parse({
    schemaVersion: 1,
    binding: 'current_snapshot',
    purposeRevision,
    source
  });
  const optionId = `option.communication.decision-set.${input.status}`;
  const body = {
    schemaVersion: 1,
    optionId,
    optionVersion: 1,
    label: optionLabels[input.status],
    recipientEstimate: {
      knowledge: 'unknown' as const,
      reasonCode: 'audience.resolved_at_preview'
    },
    audienceDraft
  };
  return organizerCommunicationAudienceOptionSchema.parse({
    ...body,
    optionDigestSha256: digest(body)
  });
}

export function createEventCommunicationSeedRendererDefinition(): OrganizerCommunicationDefinitionRef {
  const reference = Object.freeze({ key: 'renderer.communication.plain-text', version: 1 });
  const definition = Object.freeze({ kind: 'plain_text', version: 1 });
  return organizerCommunicationDefinitionRefSchema.parse({
    reference,
    definitionDigestSha256: digest({ schemaVersion: 1, reference, definition })
  });
}

function decisionTemplateContent(status: EventDecisionAudienceStatus) {
  const opening = status === 'accepted'
    ? ', good news — your submission was accepted.'
    : ', thank you for submitting. After review, your submission was not selected this time.';
  return Object.freeze({
    kind: 'email/v1' as const,
    subject: [
      { kind: 'merge_field' as const, fieldKey: 'submission.title' },
      { kind: 'text' as const, value: status === 'accepted' ? ': accepted' : ': decision update' }
    ],
    body: {
      mode: 'composed' as const,
      blocks: [
        {
          kind: 'paragraph' as const,
          content: [
            { kind: 'merge_field' as const, fieldKey: 'person.name' },
            { kind: 'text' as const, value: opening }
          ]
        },
        {
          kind: 'detail_rows' as const,
          rows: [
            {
              label: [{ kind: 'text' as const, value: 'Submission' }],
              value: [{ kind: 'merge_field' as const, fieldKey: 'submission.title' }]
            },
            {
              label: [{ kind: 'text' as const, value: 'Decision' }],
              value: [{ kind: 'merge_field' as const, fieldKey: 'decision.status' }]
            }
          ]
        }
      ]
    },
    plainTextPolicy: 'derive_v1' as const,
    attachmentSlotKeys: []
  });
}

const templateFieldBindings = Object.freeze([
  Object.freeze({
    fieldKey: 'decision.status',
    requirement: 'required' as const,
    fallback: Object.freeze({ kind: 'none' as const })
  }),
  Object.freeze({
    fieldKey: 'person.name',
    requirement: 'required' as const,
    fallback: Object.freeze({ kind: 'none' as const })
  }),
  Object.freeze({
    fieldKey: 'submission.title',
    requirement: 'required' as const,
    fallback: Object.freeze({ kind: 'none' as const })
  })
]);

function purposeSeed(input: {
  readonly selected: EventCommunicationSeedScope;
  readonly purposeKey: string;
  readonly namespace: string;
  readonly variant: '8' | 'a';
  readonly label: string;
  readonly description: string;
  readonly policyMaterial: unknown;
  readonly allowedAudienceSources: readonly OrganizerCommunicationDefinitionRef[];
}): EventCommunicationPurposeSeed {
  const purposeId = deterministicUuid(
    `communication.purpose.${input.namespace}`,
    input.selected,
    input.variant
  );
  const revisionId = deterministicUuid(
    `communication.purpose-revision.${input.namespace}`,
    input.selected,
    input.variant
  );
  const policyDigestSha256 = digest(input.policyMaterial);
  const purposeRevision = organizerCommunicationPurposeRevisionRefSchema.parse({
    purposeId,
    purposeKey: input.purposeKey,
    revisionId,
    revisionNumber: 1,
    digestSha256: digest({
      schemaVersion: 1,
      purposeId,
      purposeKey: input.purposeKey,
      revisionId,
      revisionNumber: 1,
      policyDigestSha256
    })
  });
  return Object.freeze({
    purposeRevision,
    label: input.label,
    communicationClass: 'transactional',
    policyDigestSha256,
    description: input.description,
    allowedAudienceSources: Object.freeze([...input.allowedAudienceSources])
  });
}

export function createEventCommunicationPurposeSeedPlan(
  rawScope: EventCommunicationSeedScope
): EventCommunicationPurposeSeedPlan {
  const selected = scope(rawScope);
  const allowedAudienceSources = EVENT_DECISION_AUDIENCE_STATUSES
    .map(createDecisionAudienceSourceDefinition)
    .sort((left, right) =>
      `${left.reference.key}@${left.reference.version}`.localeCompare(
        `${right.reference.key}@${right.reference.version}`
      )
    );
  const decisionPurpose = purposeSeed({
    selected,
    purposeKey: DECISION_NOTIFICATION_PURPOSE_KEY,
    namespace: 'decision-notification',
    variant: 'a',
    label: 'Decision notifications',
    description: 'Transactional acceptance and decline notifications for decided submissions.',
    policyMaterial: {
      schemaVersion: 1,
      purposeKey: DECISION_NOTIFICATION_PURPOSE_KEY,
      communicationClass: 'transactional',
      consent: 'not_required',
      allowedAudienceSources
    },
    allowedAudienceSources
  });
  const taskPurpose = purposeSeed({
    selected,
    purposeKey: TASK_REMINDER_PURPOSE_KEY,
    namespace: 'task-reminder',
    variant: '8',
    label: 'Speaker task reminders',
    description: 'Organizer-reviewed reminders for currently incomplete speaker tasks.',
    policyMaterial: {
      schemaVersion: 1,
      purposeKey: TASK_REMINDER_PURPOSE_KEY,
      communicationClass: 'transactional',
      consent: 'not_required',
      audience: 'explicit_task_engagements@1'
    },
    allowedAudienceSources: []
  });
  const reviewerPurpose = purposeSeed({
    selected,
    purposeKey: REVIEWER_REMINDER_PURPOSE_KEY,
    namespace: 'reviewer-reminder',
    variant: 'a',
    label: 'Reviewer reminders',
    description: 'Organizer-reviewed reminders for active reviewers with unfinished assignments.',
    policyMaterial: {
      schemaVersion: 1,
      purposeKey: REVIEWER_REMINDER_PURPOSE_KEY,
      communicationClass: 'transactional',
      consent: 'not_required',
      audience: 'explicit_reviewers_with_unfinished_assignments@1'
    },
    allowedAudienceSources: []
  });
  const submissionPurpose = purposeSeed({
    selected,
    purposeKey: SUBMISSION_CONFIRMATION_PURPOSE_KEY,
    namespace: 'submission-confirmation',
    variant: '8',
    label: 'Submission confirmations',
    description: 'A receipt sent once after a public application is committed.',
    policyMaterial: {
      ...SUBMISSION_CONFIRMATION_STANDING_POLICY,
      purposeKey: SUBMISSION_CONFIRMATION_PURPOSE_KEY,
      templateRevisionRefId: SUBMISSION_CONFIRMATION_TEMPLATE_REVISION_REF_ID,
      consent: 'not_required_requested_transaction',
      suppression: 'requested_transaction_receipt_not_suppressed'
    },
    allowedAudienceSources: []
  });
  const calendarPurpose = purposeSeed({
    selected,
    purposeKey: CALENDAR_NOTICE_PURPOSE_KEY,
    namespace: 'calendar-notice',
    variant: 'a',
    label: 'Calendar notices',
    description: 'Transactional invitations and updates for confirmed speakers.',
    policyMaterial: {
      ...CALENDAR_NOTICE_STANDING_POLICY,
      purposeKey: CALENDAR_NOTICE_PURPOSE_KEY,
      templateRevisionRefId: CALENDAR_NOTICE_TEMPLATE_REVISION_REF_ID,
      consent: 'not_required_event_participation'
    },
    allowedAudienceSources: []
  });
  return Object.freeze({
    scope: selected,
    purposes: Object.freeze([
      decisionPurpose, taskPurpose, reviewerPurpose, submissionPurpose, calendarPurpose
    ]),
    decisionPurpose,
    taskReminderPurpose: taskPurpose,
    reviewerReminderPurpose: reviewerPurpose,
    submissionConfirmationPurpose: submissionPurpose,
    calendarNoticePurpose: calendarPurpose
  });
}

export function createEventCommunicationSeedPlan(input: {
  readonly scope: EventCommunicationSeedScope;
  readonly mergeRegistry: unknown;
  readonly renderer: unknown;
}): EventCommunicationSeedPlan {
  const purposePlan = createEventCommunicationPurposeSeedPlan(input.scope);
  const selected = purposePlan.scope;
  const decisionPurpose = purposePlan.decisionPurpose;
  const mergeRegistry = organizerCommunicationDefinitionRefSchema.parse(input.mergeRegistry);
  const renderer = organizerCommunicationDefinitionRefSchema.parse(input.renderer);
  const templates = EVENT_DECISION_AUDIENCE_STATUSES.map((status) => {
    const templateId = deterministicUuid(`communication.template.decision-${status}`, selected, 'a');
    const templateRevisionId = deterministicUuid(
      `communication.template-revision.decision-${status}`,
      selected,
      'a'
    );
    const contentPayloadRefId = deterministicUuid(
      `communication.template-content.decision-${status}`,
      selected,
      'a'
    );
    const bindingsPayloadRefId = deterministicUuid(
      `communication.template-bindings.decision-${status}`,
      selected,
      'a'
    );
    const content = decisionTemplateContent(status);
    return Object.freeze({
      status,
      templateId,
      templateKey: `decision.${status}`,
      templateName: status === 'accepted' ? 'Decision accepted' : 'Decision declined',
      templateRevisionId,
      revisionNumber: 1 as const,
      digestSha256: digest({
        schemaVersion: 1,
        templateId,
        templateRevisionId,
        revisionNumber: 1,
        content,
        fieldBindings: templateFieldBindings,
        renderer,
        mergeRegistry
      }),
      contentPayloadRefId,
      bindingsPayloadRefId,
      contentPayload: Object.freeze({
        payloadKind: 'template_content' as const,
        schemaVersion: 1 as const,
        value: content
      }),
      bindingsPayload: Object.freeze({
        payloadKind: 'template_field_bindings' as const,
        schemaVersion: 1 as const,
        value: templateFieldBindings
      }),
      renderer,
      mergeRegistry
    });
  });
  return Object.freeze({
    scope: selected,
    purposes: purposePlan.purposes,
    decisionPurpose,
    templates: Object.freeze(templates),
    audienceOptions: Object.freeze(EVENT_DECISION_AUDIENCE_STATUSES.map((status) =>
      createDecisionAudienceOption({ status, purposeRevision: decisionPurpose.purposeRevision })
    ))
  });
}
