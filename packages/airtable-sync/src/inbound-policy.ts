import {
  compileMapping,
  fieldPolicySchema,
  type CompileMappingResult,
  type FieldPolicy,
  type SyncAreaKey,
  type UserSyncDirection
} from './mapping';

export const AIRTABLE_INBOUND_OPERATION_KEYS = Object.freeze({
  taskAssignmentStatus: 'task.assignment-status@1'
} as const);

export const AIRTABLE_REQUEST_CONTRACT_KEYS = Object.freeze({
  engagementCancellation: 'engagement.cancellation-request@1'
} as const);

/**
 * The first effective inbound ceiling. Workspace choices may narrow these
 * policies, but provider data can never add another operation or request type.
 */
export const AIRTABLE_INITIAL_FIELD_POLICIES: readonly FieldPolicy[] = Object.freeze([
  fieldPolicySchema.parse({
    fieldKey: 'task.status',
    areaKey: 'tasks',
    allowedModes: ['not_shared', 'view_in_airtable', 'editable_in_airtable'],
    recommendedMode: 'editable_in_airtable',
    transformKey: 'enumerated_choice',
    dataClassification: 'ordinary',
    inboundOperationKey: AIRTABLE_INBOUND_OPERATION_KEYS.taskAssignmentStatus
  }),
  fieldPolicySchema.parse({
    fieldKey: 'speaker.requested_status',
    areaKey: 'people',
    allowedModes: ['not_shared', 'view_in_airtable', 'request_from_airtable'],
    recommendedMode: 'request_from_airtable',
    transformKey: 'enumerated_choice',
    dataClassification: 'personal',
    requestContractKey: AIRTABLE_REQUEST_CONTRACT_KEYS.engagementCancellation
  }),
  fieldPolicySchema.parse({
    fieldKey: 'speaker.cancellation_note',
    areaKey: 'people',
    allowedModes: ['not_shared', 'view_in_airtable', 'request_from_airtable'],
    recommendedMode: 'request_from_airtable',
    transformKey: 'bounded_text',
    dataClassification: 'personal',
    requestContractKey: AIRTABLE_REQUEST_CONTRACT_KEYS.engagementCancellation
  })
]);

/** Expands the finite area choices through the first server-owned field policy ceiling. */
export function compileInitialAirtableMapping(input: Readonly<{
  manifestVersion: number;
  revision: number;
  directions: readonly Readonly<{ areaKey: SyncAreaKey; direction: UserSyncDirection }>[];
  canReadRecords: boolean;
  canWriteRecords: boolean;
}>): CompileMappingResult {
  return compileMapping({
    draft: {
      manifestVersion: input.manifestVersion,
      revision: input.revision,
      areas: input.directions.map((area) => ({
        ...area,
        fields: AIRTABLE_INITIAL_FIELD_POLICIES
          .filter((policy) => policy.areaKey === area.areaKey)
          .map((policy) => ({
            fieldKey: policy.fieldKey,
            userMode: area.direction === 'not_connected'
              ? 'not_shared'
              : area.direction === 'keep_airtable_updated'
                ? 'view_in_airtable'
                : policy.recommendedMode
          }))
      }))
    },
    policies: AIRTABLE_INITIAL_FIELD_POLICIES,
    canReadRecords: input.canReadRecords,
    canWriteRecords: input.canWriteRecords
  });
}
