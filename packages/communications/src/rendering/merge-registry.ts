import { formatDate, formatInstant } from '@jooevents/contracts';
import {
  organizerCommunicationDefinitionRefSchema,
  organizerCommunicationOpaqueIdSchema,
  organizerCommunicationStableKeySchema,
  organizerMessageTemplateFieldBindingSchema,
  organizerTemplateFieldFallbackValueSchema,
  type OrganizerCommunicationAuthoringPayloadRef
} from '@jooevents/contracts/communications/organizer';
import { canonicalJsonText } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';

export const organizerMergeFieldValueTypeSchema = z.enum([
  'text', 'url', 'date', 'instant', 'integer'
]);

const canonicalHttpsOriginSchema = z.string().max(2_000).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.hostname.length > 0
      && value === parsed.origin;
  } catch {
    return false;
  }
}, { message: 'Expected a canonical HTTPS origin.' });

export const organizerMergeFieldDefinitionSchema = z.discriminatedUnion('valueType', [
  z.strictObject({
    fieldKey: organizerCommunicationStableKeySchema,
    valueType: z.literal('text')
  }),
  z.strictObject({
    fieldKey: organizerCommunicationStableKeySchema,
    valueType: z.literal('date')
  }),
  z.strictObject({
    fieldKey: organizerCommunicationStableKeySchema,
    valueType: z.literal('instant')
  }),
  z.strictObject({
    fieldKey: organizerCommunicationStableKeySchema,
    valueType: z.literal('integer')
  }),
  z.strictObject({
    fieldKey: organizerCommunicationStableKeySchema,
    valueType: z.literal('url'),
    allowedHttpsOrigins: z.array(canonicalHttpsOriginSchema).min(1).max(64)
  }).superRefine((definition, context) => {
    for (let index = 1; index < definition.allowedHttpsOrigins.length; index += 1) {
      if (definition.allowedHttpsOrigins[index - 1]! >= definition.allowedHttpsOrigins[index]!) {
        context.addIssue({
          code: 'custom',
          path: ['allowedHttpsOrigins', index],
          message: 'Allowed HTTPS origins must be unique and use canonical order.'
        });
      }
    }
  })
]);

export type OrganizerMergeFieldValue = z.infer<typeof organizerTemplateFieldFallbackValueSchema>;
export type OrganizerMergeFieldDefinition = z.infer<typeof organizerMergeFieldDefinitionSchema>;

export interface OrganizerMergeRegistryRelease {
  readonly identity: ReturnType<typeof organizerCommunicationDefinitionRefSchema.parse>;
  readonly fields: readonly OrganizerMergeFieldDefinition[];
}

export interface OrganizerResolvedMergeValue {
  readonly fieldKey: string;
  readonly value: OrganizerMergeFieldValue;
}

export interface OrganizerFallbackMergeValue {
  readonly payloadRefId: string;
  readonly payloadRefVersion: number;
  readonly fieldKey: string;
  readonly value: OrganizerMergeFieldValue;
}

export interface OrganizerResolvedMergeFields {
  readonly values: ReadonlyMap<string, OrganizerMergeFieldValue | undefined>;
  readonly canonicalValues: readonly Readonly<{
    fieldKey: string;
    value: OrganizerMergeFieldValue | null;
    source: 'resolved' | 'fallback' | 'absent_optional';
  }>[];
  readonly warningCodes: readonly string[];
}

export type OrganizerMergeRegistryErrorCode =
  | 'invalid_registry'
  | 'invalid_binding'
  | 'unknown_merge_field'
  | 'merge_value_type_mismatch'
  | 'required_merge_field_missing'
  | 'fallback_binding_mismatch';

export class OrganizerMergeRegistryError extends Error {
  constructor(readonly code: OrganizerMergeRegistryErrorCode) {
    super(code);
    this.name = 'OrganizerMergeRegistryError';
  }
}

function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJsonText(value))));
}

function canonicalFields(value: unknown): readonly OrganizerMergeFieldDefinition[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new OrganizerMergeRegistryError('invalid_registry');
  }
  let fields: OrganizerMergeFieldDefinition[];
  try {
    fields = value.map((field) => organizerMergeFieldDefinitionSchema.parse(field));
  } catch {
    throw new OrganizerMergeRegistryError('invalid_registry');
  }
  for (let index = 1; index < fields.length; index += 1) {
    if (fields[index - 1]!.fieldKey >= fields[index]!.fieldKey) {
      throw new OrganizerMergeRegistryError('invalid_registry');
    }
  }
  return Object.freeze(fields.map((field) => Object.freeze({ ...field })));
}

export function createOrganizerMergeRegistryRelease(input: {
  readonly reference: { readonly key: string; readonly version: number };
  readonly fields: unknown;
}): OrganizerMergeRegistryRelease {
  const fields = canonicalFields(input.fields);
  let reference: { readonly key: string; readonly version: number };
  try {
    reference = organizerCommunicationDefinitionRefSchema.shape.reference.parse(input.reference);
  } catch {
    throw new OrganizerMergeRegistryError('invalid_registry');
  }
  const definitionDigestSha256 = digest({ schemaVersion: 1, reference, fields });
  return Object.freeze({
    identity: organizerCommunicationDefinitionRefSchema.parse({
      reference,
      definitionDigestSha256
    }),
    fields
  });
}

function valueMatches(definition: OrganizerMergeFieldDefinition, value: OrganizerMergeFieldValue): boolean {
  return definition.valueType === value.valueType;
}

function canonicalBindings(value: unknown): readonly ReturnType<
  typeof organizerMessageTemplateFieldBindingSchema.parse
>[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new OrganizerMergeRegistryError('invalid_binding');
  }
  let bindings: ReturnType<typeof organizerMessageTemplateFieldBindingSchema.parse>[];
  try {
    bindings = value.map((binding) => organizerMessageTemplateFieldBindingSchema.parse(binding));
  } catch {
    throw new OrganizerMergeRegistryError('invalid_binding');
  }
  for (let index = 1; index < bindings.length; index += 1) {
    if (bindings[index - 1]!.fieldKey >= bindings[index]!.fieldKey) {
      throw new OrganizerMergeRegistryError('invalid_binding');
    }
  }
  return Object.freeze(bindings.map((binding) => Object.freeze({ ...binding })));
}

function canonicalRequested(value: readonly string[]): readonly string[] {
  let keys: string[];
  try {
    keys = value.map((key) => organizerCommunicationStableKeySchema.parse(key));
  } catch {
    throw new OrganizerMergeRegistryError('unknown_merge_field');
  }
  keys.sort();
  const unique = [...new Set(keys)];
  return Object.freeze(unique);
}

function resolvedMap(
  values: readonly OrganizerResolvedMergeValue[],
  definitions: ReadonlyMap<string, OrganizerMergeFieldDefinition>
): ReadonlyMap<string, OrganizerMergeFieldValue> {
  const result = new Map<string, OrganizerMergeFieldValue>();
  for (const candidate of values) {
    let fieldKey: string;
    let value: OrganizerMergeFieldValue;
    try {
      fieldKey = organizerCommunicationStableKeySchema.parse(candidate.fieldKey);
      value = organizerTemplateFieldFallbackValueSchema.parse(candidate.value);
    } catch {
      throw new OrganizerMergeRegistryError('merge_value_type_mismatch');
    }
    const definition = definitions.get(fieldKey);
    if (definition === undefined) throw new OrganizerMergeRegistryError('unknown_merge_field');
    if (result.has(fieldKey)) throw new OrganizerMergeRegistryError('merge_value_type_mismatch');
    if (!valueMatches(definition, value)) {
      throw new OrganizerMergeRegistryError('merge_value_type_mismatch');
    }
    result.set(fieldKey, value);
  }
  return result;
}

function fallbackMap(
  values: readonly OrganizerFallbackMergeValue[],
  definitions: ReadonlyMap<string, OrganizerMergeFieldDefinition>
): ReadonlyMap<string, OrganizerFallbackMergeValue> {
  const result = new Map<string, OrganizerFallbackMergeValue>();
  for (const candidate of values) {
    let payloadRefId: string;
    let fieldKey: string;
    let value: OrganizerMergeFieldValue;
    try {
      payloadRefId = organizerCommunicationOpaqueIdSchema.parse(candidate.payloadRefId);
      if (!Number.isSafeInteger(candidate.payloadRefVersion) || candidate.payloadRefVersion < 1) throw new TypeError();
      fieldKey = organizerCommunicationStableKeySchema.parse(candidate.fieldKey);
      value = organizerTemplateFieldFallbackValueSchema.parse(candidate.value);
    } catch {
      throw new OrganizerMergeRegistryError('fallback_binding_mismatch');
    }
    const definition = definitions.get(fieldKey);
    if (definition === undefined || !valueMatches(definition, value) || result.has(payloadRefId)) {
      throw new OrganizerMergeRegistryError('fallback_binding_mismatch');
    }
    result.set(payloadRefId, Object.freeze({ ...candidate, payloadRefId, fieldKey, value }));
  }
  return result;
}

/** Resolves only registry-declared fields; no expression or implicit lookup is possible. */
export function resolveOrganizerMergeFields(input: {
  readonly registry: OrganizerMergeRegistryRelease;
  readonly bindings: unknown;
  readonly requestedFieldKeys: readonly string[];
  readonly resolvedValues: readonly OrganizerResolvedMergeValue[];
  readonly fallbackValues?: readonly OrganizerFallbackMergeValue[];
}): OrganizerResolvedMergeFields {
  let identity: ReturnType<typeof organizerCommunicationDefinitionRefSchema.parse>;
  try {
    identity = organizerCommunicationDefinitionRefSchema.parse(input.registry.identity);
  } catch {
    throw new OrganizerMergeRegistryError('invalid_registry');
  }
  const fields = canonicalFields(input.registry.fields);
  if (identity.definitionDigestSha256 !== digest({
    schemaVersion: 1,
    reference: identity.reference,
    fields
  })) {
    throw new OrganizerMergeRegistryError('invalid_registry');
  }
  const definitions = new Map(fields.map((field) => [field.fieldKey, field]));
  const bindings = canonicalBindings(input.bindings);
  const bindingByField = new Map(bindings.map((binding) => [binding.fieldKey, binding]));
  const requested = canonicalRequested(input.requestedFieldKeys);
  const live = resolvedMap(input.resolvedValues, definitions);
  const fallbacks = fallbackMap(input.fallbackValues ?? [], definitions);
  const values = new Map<string, OrganizerMergeFieldValue | undefined>();
  const canonicalValues: Array<{
    fieldKey: string;
    value: OrganizerMergeFieldValue | null;
    source: 'resolved' | 'fallback' | 'absent_optional';
  }> = [];
  let optionalAbsent = false;

  for (const fieldKey of requested) {
    const definition = definitions.get(fieldKey);
    const binding = bindingByField.get(fieldKey);
    if (definition === undefined || binding === undefined) {
      throw new OrganizerMergeRegistryError('unknown_merge_field');
    }
    const resolved = live.get(fieldKey);
    if (resolved !== undefined) {
      values.set(fieldKey, resolved);
      canonicalValues.push({ fieldKey, value: resolved, source: 'resolved' });
      continue;
    }
    if (binding.fallback.kind === 'payload_ref') {
      const fallback = fallbacks.get(binding.fallback.payloadRefId);
      if (fallback === undefined
          || fallback.payloadRefVersion !== binding.fallback.payloadRefVersion
          || fallback.fieldKey !== fieldKey) {
        throw new OrganizerMergeRegistryError('fallback_binding_mismatch');
      }
      values.set(fieldKey, fallback.value);
      canonicalValues.push({ fieldKey, value: fallback.value, source: 'fallback' });
      continue;
    }
    if (binding.requirement === 'required') {
      throw new OrganizerMergeRegistryError('required_merge_field_missing');
    }
    optionalAbsent = true;
    values.set(fieldKey, undefined);
    canonicalValues.push({ fieldKey, value: null, source: 'absent_optional' });
  }

  return Object.freeze({
    values,
    canonicalValues: Object.freeze(canonicalValues.map((entry) => Object.freeze(entry))),
    warningCodes: Object.freeze(optionalAbsent ? ['merge.optional_absent'] : [])
  });
}

export interface OrganizerMergeValueTextOptions {
  /**
   * The event's IANA timezone, used to spell an `instant` merge value on the
   * wall clock the recipient's event actually runs on.
   *
   * When it is absent the instant is spelled in UTC **and labelled `UTC`**, so
   * the line is still a true statement about the moment rather than a clock
   * with no zone attached. It is not the local time the reader wants, which is
   * why the label is not optional here: an unlabelled clock is the one thing a
   * recipient can act on and be wrong about.
   */
  readonly timezone?: string | undefined;
}

/**
 * The text a merge value contributes to a rendered message.
 *
 * `date` and `instant` are stored as machine strings — `2027-03-18` and
 * `2027-03-18T23:59:00.000Z` — and a recipient must never be shown either. They
 * go through the one date vocabulary, the same one the operator app reads, so
 * the date in the message about a deadline matches the date on the screen that
 * set it.
 *
 * The switch is exhaustive on purpose and has no `default`: the previous
 * `default: return value.value` is exactly how the two machine strings reached
 * recipients unnoticed. A new merge value type must now be a compile error
 * rather than a silent passthrough.
 */
export function organizerMergeValueText(
  value: OrganizerMergeFieldValue,
  options: OrganizerMergeValueTextOptions = {}
): string {
  switch (value.valueType) {
    case 'integer': return String(value.value);
    case 'date': return formatDate(value.value);
    case 'instant': return formatInstant(value.value, options.timezone ?? 'UTC', { zone: true });
    case 'text':
    case 'url': return value.value;
  }
}

export type OrganizerTemplateFallbackPayloadRef = Extract<
  OrganizerCommunicationAuthoringPayloadRef,
  { readonly payloadKind: 'template_field_fallback' }
>;
