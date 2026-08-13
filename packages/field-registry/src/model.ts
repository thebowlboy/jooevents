import { createHash } from 'node:crypto';
import {
  fieldRegistryFieldDefinitionSchema,
  fieldRegistryFieldViewSchema,
  fieldRegistryIdSchema,
  fieldRegistryScopeSchema,
  fieldRegistrySnapshotSchema,
  fieldRegistryStableKeySchema,
  fieldRegistryVersionSchema,
  type FieldRegistryAnswerOwner,
  type FieldRegistryContexts,
  type FieldRegistryFieldDefinitionDto,
  type FieldRegistryFieldViewDto,
  type FieldRegistryGroup,
  type FieldRegistryKind,
  type FieldRegistryMapsTo,
  type FieldRegistryOptionConfiguration,
  type FieldRegistryOptionSource,
  type FieldRegistryScopeDto,
  type FieldRegistrySnapshotDto
} from '@jooevents/contracts';
import { encodeCanonicalJson } from '@jooevents/kernel';
import { z } from 'zod';

export const fieldRegistryRemovedFieldSchema = z.strictObject({
  field: fieldRegistryFieldDefinitionSchema,
  removedAt: z.iso.datetime({ offset: true }),
  removedByUserId: fieldRegistryIdSchema,
  lastPosition: z.number().int().nonnegative().safe()
});

export const fieldRegistryStateSchema = z.strictObject({
  scope: fieldRegistryScopeSchema,
  version: fieldRegistryVersionSchema,
  fields: z.array(fieldRegistryFieldDefinitionSchema).max(500),
  removed: z.array(fieldRegistryRemovedFieldSchema).max(500)
}).superRefine((state, context) => {
  const ids = new Set<string>();
  const keys = new Set<string>();
  const mappings = new Set<string>();
  const addChoiceIds = (
    field: FieldRegistryFieldDefinitionDto,
    path: readonly (string | number)[]
  ) => {
    if (field.options.kind !== 'custom') return;
    field.options.choices.forEach((choice, choiceIndex) => {
      if (ids.has(choice.id)) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'options', 'choices', choiceIndex, 'id'],
          message: 'Application IDs must be unique across the registry.'
        });
      }
      ids.add(choice.id);
    });
  };
  const addMapping = (
    field: FieldRegistryFieldDefinitionDto,
    path: readonly (string | number)[]
  ) => {
    if (field.mapsTo === null) return;
    if (mappings.has(field.mapsTo)) {
      context.addIssue({
        code: 'custom', path: [...path, 'mapsTo'],
        message: 'Canonical mappings must be unique across active and removed fields.'
      });
    }
    mappings.add(field.mapsTo);
  };
  state.fields.forEach((field, index) => {
    if (field.position !== index) {
      context.addIssue({
        code: 'custom', path: ['fields', index, 'position'],
        message: 'Active field positions must be contiguous.'
      });
    }
    if (ids.has(field.id) || keys.has(field.key)) {
      context.addIssue({ code: 'custom', path: ['fields', index], message: 'Duplicate field identity.' });
    }
    ids.add(field.id);
    keys.add(field.key);
    addMapping(field, ['fields', index]);
    addChoiceIds(field, ['fields', index]);
  });
  state.removed.forEach((removed, index) => {
    if (ids.has(removed.field.id) || keys.has(removed.field.key)) {
      context.addIssue({ code: 'custom', path: ['removed', index], message: 'Duplicate field identity.' });
    }
    ids.add(removed.field.id);
    keys.add(removed.field.key);
    addMapping(removed.field, ['removed', index, 'field']);
    addChoiceIds(removed.field, ['removed', index, 'field']);
  });
});

export type FieldRegistryRemovedField = z.infer<typeof fieldRegistryRemovedFieldSchema>;
export type FieldRegistryState = z.infer<typeof fieldRegistryStateSchema>;

function freeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

export function parseFieldRegistryState(candidate: unknown): FieldRegistryState {
  return freeze(fieldRegistryStateSchema.parse(candidate));
}

/** Digest of the exact persisted aggregate state; live option projections are excluded. */
export function fieldRegistryStateDigest(state: FieldRegistryState): string {
  const parsed = parseFieldRegistryState(state);
  return createHash('sha256').update(encodeCanonicalJson(parsed)).digest('hex');
}

export interface FieldRegistryLiveOption {
  readonly id: string;
  readonly label: string;
  readonly version: number;
  readonly status: 'active' | 'retired';
}

export interface FieldRegistryLiveOptionSource {
  readLiveOptions(
    scope: FieldRegistryScopeDto,
    source: FieldRegistryOptionSource
  ): readonly FieldRegistryLiveOption[];
}

export function projectFieldRegistrySnapshot(input: {
  readonly state: FieldRegistryState;
  readonly optionSource: FieldRegistryLiveOptionSource;
}): FieldRegistrySnapshotDto {
  const state = parseFieldRegistryState(input.state);
  const fields = state.fields.map((field): FieldRegistryFieldViewDto => {
    const resolvedOptions = field.options.kind === 'program_vocabulary'
      ? input.optionSource.readLiveOptions(state.scope, field.options.source)
        .filter((option) => option.status === 'active')
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        .map(({ id, label, version }) => ({ id, label, version }))
      : null;
    return fieldRegistryFieldViewSchema.parse({ ...field, resolvedOptions });
  });
  return freeze(fieldRegistrySnapshotSchema.parse({
    schemaVersion: 1,
    scope: state.scope,
    version: state.version,
    registryDigestSha256: fieldRegistryStateDigest(state),
    fields
  }));
}

export interface CanonicalFieldRegistryBaselineIds {
  newFieldId(key: string): string;
  newChoiceId(fieldKey: string, choiceKey: string): string;
}

const visible = (required = false) => ({ visible: true, required });
const hidden = () => ({ visible: false, required: false });
const contexts = (input: {
  apply?: boolean;
  onboard?: boolean;
  profile?: boolean;
}): FieldRegistryContexts => ({
  apply: input.apply === undefined ? hidden() : visible(input.apply),
  onboard: input.onboard === undefined ? hidden() : visible(input.onboard),
  profile: input.profile === undefined ? hidden() : visible(input.profile)
});

interface BaselineSpec {
  readonly key: string;
  readonly kind: FieldRegistryKind;
  readonly label: string;
  readonly help?: string;
  readonly answerOwner: FieldRegistryAnswerOwner;
  readonly mapsTo?: FieldRegistryMapsTo;
  readonly consentKey?: string;
  readonly group: FieldRegistryGroup;
  readonly contexts: FieldRegistryContexts;
  readonly options?:
    | { readonly kind: 'custom'; readonly choices: readonly { readonly key: string; readonly label: string }[] }
    | { readonly kind: 'program_vocabulary'; readonly source: FieldRegistryOptionSource };
  readonly locked?: boolean;
}

const BASELINE = Object.freeze([
  { key: 'person.name', kind: 'text', label: 'Your name', answerOwner: 'person', mapsTo: 'person.name', group: 'identity', contexts: contexts({ apply: true, onboard: true, profile: false }) },
  { key: 'person.pronouns', kind: 'select', label: 'Pronouns', help: 'Optional — shown on your speaker page and badge if you share them.', answerOwner: 'person', group: 'identity', contexts: contexts({ onboard: false, profile: false }), options: { kind: 'custom', choices: [
    { key: 'she_her', label: 'She/her' }, { key: 'he_him', label: 'He/him' },
    { key: 'they_them', label: 'They/them' }, { key: 'self_describe', label: 'Prefer to self-describe' },
    { key: 'not_say', label: 'Prefer not to say' }
  ] } },
  { key: 'person.headline', kind: 'text', label: 'Headline', help: 'One line about you — role and company, or however you introduce yourself.', answerOwner: 'person', group: 'identity', contexts: contexts({ apply: true, onboard: false, profile: false }) },
  { key: 'person.location', kind: 'text', label: 'Where you’re based', help: 'City and country are enough. It helps us plan the program and travel.', answerOwner: 'person', group: 'identity', contexts: contexts({ apply: false, onboard: false, profile: false }) },
  { key: 'person.email', kind: 'email', label: 'Email', help: 'Where your decision and any reminders go. We never share it.', answerOwner: 'person', mapsTo: 'person.email', group: 'contact', contexts: contexts({ apply: true, onboard: true, profile: false }), locked: true },
  { key: 'person.work_link', kind: 'url', label: 'A link to your work', help: 'A past talk, a repository, or your site — anything that shows how you present.', answerOwner: 'person', group: 'presence', contexts: contexts({ apply: false, onboard: false, profile: false }) },
  { key: 'person.website', kind: 'url', label: 'Website', help: 'Your personal or company site.', answerOwner: 'person', group: 'presence', contexts: contexts({ apply: false, onboard: false, profile: false }) },
  { key: 'person.linkedin', kind: 'url', label: 'LinkedIn', answerOwner: 'person', group: 'presence', contexts: contexts({ apply: false, onboard: false, profile: false }) },
  { key: 'person.x', kind: 'url', label: 'X account', answerOwner: 'person', group: 'presence', contexts: contexts({ apply: false, onboard: false, profile: false }) },
  { key: 'person.github', kind: 'url', label: 'GitHub', answerOwner: 'person', group: 'presence', contexts: contexts({ apply: false, onboard: false, profile: false }) },
  { key: 'talk.title', kind: 'text', label: 'Talk title', help: 'A working title is fine — you can refine it later.', answerOwner: 'talk', mapsTo: 'talk.title', group: 'talk', contexts: contexts({ apply: true }) },
  { key: 'talk.abstract', kind: 'textarea', label: 'Abstract', help: 'What you’ll cover and who it’s for, in a few sentences.', answerOwner: 'talk', mapsTo: 'talk.abstract', group: 'talk', contexts: contexts({ apply: true }) },
  { key: 'talk.format', kind: 'select', label: 'Format', help: 'Pick the closest fit — length can be adjusted together later.', answerOwner: 'talk', mapsTo: 'talk.format', group: 'talk', contexts: contexts({ apply: true }), options: { kind: 'program_vocabulary', source: 'formats' } },
  { key: 'talk.track', kind: 'select', label: 'Track', help: 'Your best guess is enough; the program team may move it.', answerOwner: 'talk', mapsTo: 'talk.track', group: 'talk', contexts: contexts({ apply: true }), options: { kind: 'program_vocabulary', source: 'tracks' } },
  { key: 'talk.notes', kind: 'textarea', label: 'Anything else?', help: 'Co-speakers, constraints, AV needs — anything the team should know.', answerOwner: 'talk', group: 'talk', contexts: contexts({ apply: false }) },
  { key: 'person.arrival', kind: 'datetime', label: 'Arrival date', help: 'When you land, so we can plan pickups and the speaker dinner.', answerOwner: 'person', group: 'logistics', contexts: contexts({ onboard: true }) },
  { key: 'person.dietary', kind: 'text', label: 'Dietary needs', help: 'Allergies and preferences for the speaker dinner and green room.', answerOwner: 'person', group: 'logistics', contexts: contexts({ onboard: false }) },
  { key: 'person.headshot', kind: 'file', label: 'Headshot', help: 'A recent photo for the program page. Square works best.', answerOwner: 'person', group: 'materials', contexts: contexts({ onboard: true, profile: false }) },
  { key: 'person.recording_consent', kind: 'checkbox', label: 'I agree to the code of conduct and to my session being recorded if accepted', help: 'Recordings are published after the event.', answerOwner: 'person', consentKey: 'recording_and_code_of_conduct', group: 'consent', contexts: contexts({ apply: true }) }
] as const satisfies readonly BaselineSpec[]);

function baselineOptions(
  spec: BaselineSpec,
  ids: CanonicalFieldRegistryBaselineIds
): FieldRegistryOptionConfiguration {
  if (!spec.options) return { kind: 'none' };
  if (spec.options.kind === 'program_vocabulary') return { ...spec.options };
  return {
    kind: 'custom',
    choices: spec.options.choices.map((choice, position) => ({
      id: fieldRegistryIdSchema.parse(ids.newChoiceId(spec.key, choice.key)),
      key: fieldRegistryStableKeySchema.parse(choice.key),
      label: choice.label,
      position
    }))
  };
}

export function createCanonicalFieldRegistryBaseline(input: {
  readonly scope: FieldRegistryScopeDto;
  readonly ids: CanonicalFieldRegistryBaselineIds;
}): FieldRegistryState {
  const scope = fieldRegistryScopeSchema.parse(input.scope);
  const fields: FieldRegistryFieldDefinitionDto[] = BASELINE.map((spec, position) =>
    fieldRegistryFieldDefinitionSchema.parse({
      id: fieldRegistryIdSchema.parse(input.ids.newFieldId(spec.key)),
      key: fieldRegistryStableKeySchema.parse(spec.key),
      version: 1,
      kind: spec.kind,
      label: spec.label,
      help: 'help' in spec ? spec.help : null,
      answerOwner: spec.answerOwner,
      mapsTo: 'mapsTo' in spec ? spec.mapsTo : null,
      purpose: 'consentKey' in spec
        ? { kind: 'consent', key: spec.consentKey }
        : { kind: 'ordinary' },
      scope: { kind: 'shared' },
      group: spec.group,
      position,
      contexts: spec.contexts,
      options: baselineOptions(spec, input.ids),
      constraints: 'locked' in spec && spec.locked
        ? { removal: 'forbidden', applyVisibility: 'required_visible' }
        : { removal: 'allowed', applyVisibility: 'editable' },
      fileUpload: spec.kind === 'file' ? 'disabled' : 'not_applicable'
    })
  );
  return parseFieldRegistryState({ scope, version: 1, fields, removed: [] });
}

export function fieldRegistryAggregateId(eventId: string): string {
  return `field_registry:${fieldRegistryIdSchema.parse(eventId)}`;
}
