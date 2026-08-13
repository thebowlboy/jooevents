import {
  parseAggregateVersion,
  parseEventId,
  parseWorkspaceId,
  type AggregateVersion,
  type Brand,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  deriveProgramTrackAccent,
  isCanonicalProgramVocabularyName,
  normalizeProgramVocabularyNameInput,
  programVocabularyIdSchema,
  programVocabularyNameSchema,
  programVocabularyScopeSchema,
  programVocabularyStatusSchema,
  programVocabularyVersionSchema,
  type ProgramTrackAccent,
  type ProgramVocabularyKind,
  type ProgramVocabularyStatus
} from '@jooevents/contracts';
import { z } from 'zod';

export type ProgramVocabularyId<Kind extends ProgramVocabularyKind> =
  Brand<string, `ProgramVocabularyId:${Kind}`>;
export type ProgramRoomId = ProgramVocabularyId<'room'>;
export type ProgramTrackId = ProgramVocabularyId<'track'>;
export type ProgramFormatId = ProgramVocabularyId<'format'>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseProgramVocabularyId<Kind extends ProgramVocabularyKind>(
  kind: Kind,
  value: unknown
): ProgramVocabularyId<Kind> {
  if (typeof value !== 'string' || !uuid.test(value)) {
    throw new TypeError(`${kind} id must be a UUIDv4 or UUIDv7`);
  }
  return value.toLowerCase() as ProgramVocabularyId<Kind>;
}

export function parseCanonicalProgramVocabularyId<Kind extends ProgramVocabularyKind>(
  kind: Kind,
  value: unknown
): ProgramVocabularyId<Kind> {
  if (!programVocabularyIdSchema.safeParse(value).success) {
    throw new TypeError(`${kind} id must be a canonical lowercase UUIDv4 or UUIDv7`);
  }
  return value as ProgramVocabularyId<Kind>;
}

export interface ProgramVocabularyScope {
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
}

interface ProgramItemBase<Kind extends ProgramVocabularyKind> {
  readonly kind: Kind;
  readonly id: ProgramVocabularyId<Kind>;
  readonly scope: ProgramVocabularyScope;
  readonly name: string;
  readonly status: ProgramVocabularyStatus;
  readonly version: AggregateVersion;
}

export interface ProgramRoom extends ProgramItemBase<'room'> {
  readonly capacity: number | null;
}

export interface ProgramTrack extends ProgramItemBase<'track'> {
  readonly accent: ProgramTrackAccent;
}

export interface ProgramFormat extends ProgramItemBase<'format'> {}

export type ProgramVocabularyItem = ProgramRoom | ProgramTrack | ProgramFormat;

export interface ProgramVocabularyState {
  readonly scope: ProgramVocabularyScope;
  readonly setVersion: AggregateVersion;
  readonly rooms: readonly ProgramRoom[];
  readonly tracks: readonly ProgramTrack[];
  readonly formats: readonly ProgramFormat[];
}

export type ProgramVocabularyStateInput = {
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
  readonly setVersion: number;
  readonly rooms?: readonly {
    readonly id: string;
    readonly name: string;
    readonly capacity: number | null;
    readonly status: ProgramVocabularyStatus;
    readonly version: number;
  }[];
  readonly tracks?: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: ProgramVocabularyStatus;
    readonly version: number;
  }[];
  readonly formats?: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: ProgramVocabularyStatus;
    readonly version: number;
  }[];
};

export function normalizeProgramVocabularyName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('program vocabulary name must be a string');
  const normalized = normalizeProgramVocabularyNameInput(value);
  if (!isCanonicalProgramVocabularyName(normalized)) {
    throw new TypeError('program vocabulary name must contain 1 to 200 characters');
  }
  return normalized;
}

export function parseCanonicalProgramVocabularyName(value: unknown): string {
  const parsed = programVocabularyNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError('program vocabulary name must use its canonical stored form');
  }
  return parsed.data;
}

export function parseRoomCapacity(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('room capacity must be a positive safe integer or null');
  }
  return value;
}

function parseScope(input: { readonly workspaceId: string; readonly eventId: string }): ProgramVocabularyScope {
  return Object.freeze({
    workspaceId: parseWorkspaceId(input.workspaceId),
    eventId: parseEventId(input.eventId)
  });
}

/** Compares canonical text by JavaScript code units, independent of locale. */
export function compareProgramVocabularyCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareItems(left: ProgramVocabularyItem, right: ProgramVocabularyItem): number {
  return compareProgramVocabularyCanonicalText(left.id, right.id);
}

function parseStatus(value: unknown): ProgramVocabularyStatus {
  if (value !== 'active' && value !== 'retired') {
    throw new TypeError('program vocabulary status must be active or retired');
  }
  return value;
}

export function createProgramVocabularyState(input: ProgramVocabularyStateInput): ProgramVocabularyState {
  const scope = parseScope(input.scope);
  const rooms = (input.rooms ?? []).map((item): ProgramRoom => Object.freeze({
    kind: 'room',
    id: parseProgramVocabularyId('room', item.id),
    scope,
    name: normalizeProgramVocabularyName(item.name),
    capacity: parseRoomCapacity(item.capacity),
    status: parseStatus(item.status),
    version: parseAggregateVersion(item.version)
  })).sort(compareItems);
  const tracks = (input.tracks ?? []).map((item): ProgramTrack => {
    const id = parseProgramVocabularyId('track', item.id);
    return Object.freeze({
      kind: 'track',
      id,
      scope,
      name: normalizeProgramVocabularyName(item.name),
      accent: deriveProgramTrackAccent(id),
      status: parseStatus(item.status),
      version: parseAggregateVersion(item.version)
    });
  }).sort(compareItems);
  const formats = (input.formats ?? []).map((item): ProgramFormat => Object.freeze({
    kind: 'format',
    id: parseProgramVocabularyId('format', item.id),
    scope,
    name: normalizeProgramVocabularyName(item.name),
    status: parseStatus(item.status),
    version: parseAggregateVersion(item.version)
  })).sort(compareItems);
  const ids = [...rooms, ...tracks, ...formats].map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new TypeError('program vocabulary ids must be unique in an event');
  return deepFreeze({
    scope,
    setVersion: parseAggregateVersion(input.setVersion),
    rooms,
    tracks,
    formats
  });
}

const canonicalRoomStateInputSchema = z.strictObject({
  id: programVocabularyIdSchema,
  name: programVocabularyNameSchema,
  capacity: z.number().int().positive().safe().nullable(),
  status: programVocabularyStatusSchema,
  version: programVocabularyVersionSchema
});
const canonicalNamedStateInputSchema = z.strictObject({
  id: programVocabularyIdSchema,
  name: programVocabularyNameSchema,
  status: programVocabularyStatusSchema,
  version: programVocabularyVersionSchema
});
const canonicalProgramVocabularyItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('room'),
    scope: programVocabularyScopeSchema,
    ...canonicalRoomStateInputSchema.shape
  }),
  z.strictObject({
    kind: z.literal('track'),
    scope: programVocabularyScopeSchema,
    ...canonicalNamedStateInputSchema.shape
  }),
  z.strictObject({
    kind: z.literal('format'),
    scope: programVocabularyScopeSchema,
    ...canonicalNamedStateInputSchema.shape
  })
]);
const canonicalStateInputSchema = z.strictObject({
  scope: programVocabularyScopeSchema,
  setVersion: programVocabularyVersionSchema,
  rooms: z.array(canonicalRoomStateInputSchema),
  tracks: z.array(canonicalNamedStateInputSchema),
  formats: z.array(canonicalNamedStateInputSchema)
}).superRefine((state, context) => {
  const seen = new Set<string>();
  for (const [family, items] of [
    ['rooms', state.rooms],
    ['tracks', state.tracks],
    ['formats', state.formats]
  ] as const) {
    for (const [index, item] of items.entries()) {
      if (index > 0 && compareProgramVocabularyCanonicalText(items[index - 1]!.id, item.id) >= 0) {
        context.addIssue({
          code: 'custom',
          path: [family, index, 'id'],
          message: 'items must be uniquely ordered by canonical id'
        });
      }
      if (seen.has(item.id)) {
        context.addIssue({
          code: 'custom',
          path: [family, index, 'id'],
          message: 'item ids must be unique across vocabulary kinds'
        });
      }
      seen.add(item.id);
    }
  }
});

/** Parses already-canonical stored state without trimming, normalizing, sorting, or repairing it. */
export function parseProgramVocabularyState(value: unknown): ProgramVocabularyState {
  const parsed = canonicalStateInputSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('invalid_canonical_program_vocabulary_state');
  return createProgramVocabularyState(parsed.data);
}

/** Parses one already-canonical domain item without changing its stored representation. */
export function parseProgramVocabularyItem(value: unknown): ProgramVocabularyItem {
  const parsed = canonicalProgramVocabularyItemSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('invalid_canonical_program_vocabulary_item');
  const state = createProgramVocabularyState({
    scope: parsed.data.scope,
    setVersion: 1,
    rooms: parsed.data.kind === 'room' ? [parsed.data] : [],
    tracks: parsed.data.kind === 'track' ? [parsed.data] : [],
    formats: parsed.data.kind === 'format' ? [parsed.data] : []
  });
  const item = programVocabularyItems(state)[0];
  if (!item) throw new TypeError('invalid_canonical_program_vocabulary_item');
  return item;
}

export function sameProgramVocabularyScope(
  left: ProgramVocabularyScope,
  right: ProgramVocabularyScope
): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

export function programVocabularyItems(state: ProgramVocabularyState): readonly ProgramVocabularyItem[] {
  return [...state.rooms, ...state.tracks, ...state.formats];
}

export function itemsOfKind<Kind extends ProgramVocabularyKind>(
  state: ProgramVocabularyState,
  kind: Kind
): readonly Extract<ProgramVocabularyItem, { readonly kind: Kind }>[] {
  if (kind === 'room') return state.rooms as readonly Extract<ProgramVocabularyItem, { readonly kind: Kind }>[];
  if (kind === 'track') return state.tracks as readonly Extract<ProgramVocabularyItem, { readonly kind: Kind }>[];
  return state.formats as readonly Extract<ProgramVocabularyItem, { readonly kind: Kind }>[];
}

export function resolveProgramVocabularyItem<Kind extends ProgramVocabularyKind>(
  state: ProgramVocabularyState,
  kind: Kind,
  id: string
): Extract<ProgramVocabularyItem, { readonly kind: Kind }> | undefined {
  return itemsOfKind(state, kind).find((item) => item.id === id);
}

export function activeProgramVocabularyItems<Kind extends ProgramVocabularyKind>(
  state: ProgramVocabularyState,
  kind: Kind
): readonly Extract<ProgramVocabularyItem, { readonly kind: Kind }>[] {
  return itemsOfKind(state, kind).filter((item) => item.status === 'active');
}

export function requireActiveProgramVocabularyAssignment<Kind extends ProgramVocabularyKind>(
  state: ProgramVocabularyState,
  kind: Kind,
  id: string
): Extract<ProgramVocabularyItem, { readonly kind: Kind }> {
  const item = resolveProgramVocabularyItem(state, kind, id);
  if (!item) throw new TypeError('program_vocabulary_item_missing');
  if (item.status !== 'active') throw new TypeError('program_vocabulary_item_retired');
  return item;
}

export function nextAggregateVersion(version: AggregateVersion): AggregateVersion {
  return parseAggregateVersion(version + 1);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
