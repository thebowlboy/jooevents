import { canonicalJsonSha256, type CanonicalJson } from '@jooevents/kernel';
import { z } from 'zod';

export const SYNC_AREA_KEYS = [
  'events',
  'people',
  'submissions',
  'sessions',
  'schedule',
  'tasks',
  'communication_summary'
] as const;

export type SyncAreaKey = (typeof SYNC_AREA_KEYS)[number];

export const USER_SYNC_DIRECTIONS = [
  'not_connected',
  'keep_airtable_updated',
  'work_from_airtable'
] as const;

export type UserSyncDirection = (typeof USER_SYNC_DIRECTIONS)[number];

export const FIELD_SYNC_MODES = [
  'not_shared',
  'view_in_airtable',
  'editable_in_airtable',
  'request_from_airtable'
] as const;

export type FieldSyncMode = (typeof FIELD_SYNC_MODES)[number];

export const TRANSFORM_KEYS = [
  'trimmed_text',
  'bounded_text',
  'validated_email',
  'validated_phone',
  'validated_url',
  'enumerated_choice',
  'boolean',
  'number',
  'date',
  'date_time',
  'stable_link_set'
] as const;

export type SyncTransformKey = (typeof TRANSFORM_KEYS)[number];

const fieldModeSchema = z.enum(FIELD_SYNC_MODES);
const directionSchema = z.enum(USER_SYNC_DIRECTIONS);
const areaKeySchema = z.enum(SYNC_AREA_KEYS);
const transformKeySchema = z.enum(TRANSFORM_KEYS);

export const fieldPolicySchema = z.object({
  fieldKey: z.string().min(1).max(160),
  areaKey: areaKeySchema,
  allowedModes: z.array(fieldModeSchema).min(1).max(FIELD_SYNC_MODES.length),
  recommendedMode: fieldModeSchema,
  transformKey: transformKeySchema,
  dataClassification: z.enum(['ordinary', 'personal', 'sensitive', 'classified']),
  inboundOperationKey: z.string().min(1).max(200).optional(),
  requestContractKey: z.string().min(1).max(200).optional()
}).strict().superRefine((value, context) => {
  if (!value.allowedModes.includes(value.recommendedMode)) {
    context.addIssue({ code: 'custom', message: 'recommended_mode_not_allowed' });
  }
  if (
    value.allowedModes.includes('editable_in_airtable')
    && value.inboundOperationKey === undefined
  ) {
    context.addIssue({ code: 'custom', message: 'editable_mode_requires_operation' });
  }
  if (
    value.allowedModes.includes('request_from_airtable')
    && value.requestContractKey === undefined
  ) {
    context.addIssue({ code: 'custom', message: 'request_mode_requires_contract' });
  }
});

export type FieldPolicy = z.infer<typeof fieldPolicySchema>;

export const mappingFieldSelectionSchema = z.object({
  fieldKey: z.string().min(1).max(160),
  userMode: fieldModeSchema
}).strict();

export const mappingAreaSelectionSchema = z.object({
  areaKey: areaKeySchema,
  direction: directionSchema,
  fields: z.array(mappingFieldSelectionSchema).max(256)
}).strict();

export const mappingDraftSchema = z.object({
  manifestVersion: z.number().int().positive(),
  revision: z.number().int().positive(),
  areas: z.array(mappingAreaSelectionSchema).max(SYNC_AREA_KEYS.length)
}).strict();

export type MappingDraft = z.infer<typeof mappingDraftSchema>;

export type FieldModeResolution =
  | { readonly kind: 'enabled'; readonly mode: FieldSyncMode }
  | {
      readonly kind: 'refused';
      readonly code:
        | 'field_policy_missing'
        | 'mode_exceeds_policy'
        | 'direction_excludes_field'
        | 'provider_capability_missing';
    };

function directionAllows(direction: UserSyncDirection, mode: FieldSyncMode): boolean {
  if (direction === 'not_connected') return mode === 'not_shared';
  if (direction === 'keep_airtable_updated') {
    return mode === 'not_shared' || mode === 'view_in_airtable';
  }
  return true;
}

export function resolveEffectiveFieldMode(input: {
  readonly policy: FieldPolicy | undefined;
  readonly direction: UserSyncDirection;
  readonly requestedMode: FieldSyncMode;
  readonly canReadRecords: boolean;
  readonly canWriteRecords: boolean;
}): FieldModeResolution {
  const policy = input.policy;
  if (!policy) return { kind: 'refused', code: 'field_policy_missing' };
  if (!policy.allowedModes.includes(input.requestedMode)) {
    return { kind: 'refused', code: 'mode_exceeds_policy' };
  }
  if (!directionAllows(input.direction, input.requestedMode)) {
    return { kind: 'refused', code: 'direction_excludes_field' };
  }
  if (input.requestedMode !== 'not_shared' && !input.canWriteRecords) {
    return { kind: 'refused', code: 'provider_capability_missing' };
  }
  if (
    (input.requestedMode === 'editable_in_airtable'
      || input.requestedMode === 'request_from_airtable')
    && !input.canReadRecords
  ) {
    return { kind: 'refused', code: 'provider_capability_missing' };
  }
  return { kind: 'enabled', mode: input.requestedMode };
}

export interface CompiledFieldMapping {
  readonly fieldKey: string;
  readonly areaKey: SyncAreaKey;
  readonly mode: FieldSyncMode;
  readonly transformKey: SyncTransformKey;
  readonly dataClassification: FieldPolicy['dataClassification'];
  readonly inboundOperationKey?: string;
  readonly requestContractKey?: string;
}

export interface CompiledMapping {
  readonly manifestVersion: number;
  readonly revision: number;
  readonly areas: readonly Readonly<{
    areaKey: SyncAreaKey;
    direction: UserSyncDirection;
  }>[];
  readonly fields: readonly CompiledFieldMapping[];
  readonly digestSha256: string;
}

export type CompileMappingResult =
  | { readonly kind: 'ready'; readonly mapping: CompiledMapping }
  | {
      readonly kind: 'refused';
      readonly issues: readonly {
        readonly areaKey?: string;
        readonly fieldKey?: string;
        readonly code: string;
      }[];
    };

export function compileMapping(input: {
  readonly draft: unknown;
  readonly policies: readonly FieldPolicy[];
  readonly canReadRecords: boolean;
  readonly canWriteRecords: boolean;
}): CompileMappingResult {
  const parsed = mappingDraftSchema.safeParse(input.draft);
  if (!parsed.success) {
    return {
      kind: 'refused',
      issues: parsed.error.issues.map((issue) => ({
        code: issue.message,
        ...(issue.path[1] !== undefined ? { areaKey: String(issue.path[1]) } : {})
      }))
    };
  }
  const policies = new Map<string, FieldPolicy>();
  const issues: Array<{ areaKey?: string; fieldKey?: string; code: string }> = [];
  for (const candidate of input.policies) {
    const policy = fieldPolicySchema.safeParse(candidate);
    if (!policy.success) {
      issues.push({ fieldKey: candidate.fieldKey, code: 'field_policy_invalid' });
      continue;
    }
    if (policies.has(policy.data.fieldKey)) {
      issues.push({ fieldKey: policy.data.fieldKey, code: 'field_policy_duplicate' });
      continue;
    }
    policies.set(policy.data.fieldKey, Object.freeze(policy.data));
  }
  const seenAreas = new Set<SyncAreaKey>();
  const seenFields = new Set<string>();
  const fields: CompiledFieldMapping[] = [];
  for (const area of parsed.data.areas) {
    if (seenAreas.has(area.areaKey)) {
      issues.push({ areaKey: area.areaKey, code: 'mapping_area_duplicate' });
      continue;
    }
    seenAreas.add(area.areaKey);
    for (const field of area.fields) {
      if (seenFields.has(field.fieldKey)) {
        issues.push({ areaKey: area.areaKey, fieldKey: field.fieldKey, code: 'mapping_field_duplicate' });
        continue;
      }
      seenFields.add(field.fieldKey);
      const policy = policies.get(field.fieldKey);
      if (policy?.areaKey !== area.areaKey) {
        issues.push({ areaKey: area.areaKey, fieldKey: field.fieldKey, code: 'field_policy_missing' });
        continue;
      }
      const resolution = resolveEffectiveFieldMode({
        policy,
        direction: area.direction,
        requestedMode: field.userMode,
        canReadRecords: input.canReadRecords,
        canWriteRecords: input.canWriteRecords
      });
      if (resolution.kind === 'refused') {
        issues.push({ areaKey: area.areaKey, fieldKey: field.fieldKey, code: resolution.code });
        continue;
      }
      fields.push(Object.freeze({
        fieldKey: policy.fieldKey,
        areaKey: policy.areaKey,
        mode: resolution.mode,
        transformKey: policy.transformKey,
        dataClassification: policy.dataClassification,
        ...(policy.inboundOperationKey ? { inboundOperationKey: policy.inboundOperationKey } : {}),
        ...(policy.requestContractKey ? { requestContractKey: policy.requestContractKey } : {})
      }));
    }
  }
  if (issues.length > 0) return { kind: 'refused', issues: Object.freeze(issues) };
  fields.sort((left, right) =>
    left.areaKey.localeCompare(right.areaKey) || left.fieldKey.localeCompare(right.fieldKey)
  );
  const areas = parsed.data.areas.map((area) => Object.freeze({
    areaKey: area.areaKey,
    direction: area.direction
  })).sort((left, right) => left.areaKey.localeCompare(right.areaKey));
  const body = {
    manifestVersion: parsed.data.manifestVersion,
    revision: parsed.data.revision,
    areas,
    fields: fields as unknown as CanonicalJson
  };
  return {
    kind: 'ready',
    mapping: Object.freeze({
      manifestVersion: body.manifestVersion,
      revision: body.revision,
      areas: Object.freeze(areas),
      fields: Object.freeze(fields),
      digestSha256: canonicalJsonSha256(body)
    })
  };
}
