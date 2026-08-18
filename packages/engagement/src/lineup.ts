import {
  speakerLineupAuthorInputSchema,
  speakerLineupMutationPlanSchema,
  speakerLineupPlanningInputSchema,
  speakerLineupSnapshotSchema,
  type SpeakerLineupAction,
  type SpeakerLineupCategoryDto,
  type SpeakerLineupChangeData,
  type SpeakerLineupEntryDto,
  type SpeakerLineupMutationPlanDto,
  type SpeakerLineupPlanningInput,
  type SpeakerLineupSnapshotDto
} from '@jooevents/contracts';
import { canonicalJsonSha256 } from '@jooevents/kernel';

export type SpeakerLineupErrorCode =
  | 'lineup_missing'
  | 'stale_lineup'
  | 'entry_missing'
  | 'category_missing'
  | 'category_name_exists'
  | 'invalid_order'
  | 'invalid_plan';

export class SpeakerLineupPlanningError extends Error {
  constructor(
    readonly code: SpeakerLineupErrorCode,
    readonly subjectId?: string
  ) {
    super(code);
    this.name = 'SpeakerLineupPlanningError';
  }
}

export interface SpeakerLineupReadPort {
  readSpeakerLineupSnapshot(scope: {
    readonly workspaceId: string;
    readonly eventId: string;
  }): SpeakerLineupSnapshotDto | undefined;
}

export function speakerLineupDigest(
  snapshot: Omit<SpeakerLineupSnapshotDto, 'digestSha256'>
): string {
  return canonicalJsonSha256(snapshot);
}

export function parseSpeakerLineupSnapshot(value: unknown): SpeakerLineupSnapshotDto {
  const snapshot = speakerLineupSnapshotSchema.parse(value);
  const { digestSha256, ...unsigned } = snapshot;
  if (speakerLineupDigest(unsigned) !== digestSha256) {
    throw new TypeError('speaker_lineup_digest_mismatch');
  }
  return deepFreeze(snapshot);
}

export function createSpeakerLineupSnapshot(input: {
  readonly scope: SpeakerLineupSnapshotDto['scope'];
  readonly version: number;
  readonly categories: readonly SpeakerLineupCategoryDto[];
  readonly entries: readonly SpeakerLineupEntryDto[];
}): SpeakerLineupSnapshotDto {
  const unsigned = {
    schemaVersion: 1 as const,
    scope: input.scope,
    version: input.version,
    categories: [...input.categories],
    entries: [...input.entries]
  };
  return parseSpeakerLineupSnapshot({
    ...unsigned,
    digestSha256: speakerLineupDigest(unsigned)
  });
}

export function resolveSpeakerLineupPlanningInput(input: {
  readonly authorInput: unknown;
  readonly scope: SpeakerLineupSnapshotDto['scope'];
  readonly actorUserId: string;
  readonly occurredAt: string;
  readonly categoryId?: string;
}): SpeakerLineupPlanningInput {
  const authorInput = speakerLineupAuthorInputSchema.parse(input.authorInput);
  return speakerLineupPlanningInputSchema.parse({
    scope: input.scope,
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
    categoryId: authorInput.action === 'add_category' ? input.categoryId ?? null : null,
    authorInput
  });
}

function casefold(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function changedData(
  action: SpeakerLineupAction,
  snapshot: SpeakerLineupSnapshotDto,
  personId?: string,
  categoryId?: string
): SpeakerLineupChangeData {
  return {
    action,
    lineupVersion: snapshot.version,
    entry: personId === undefined
      ? null
      : snapshot.entries.find((entry) => entry.personId === personId) ?? null,
    category: categoryId === undefined
      ? null
      : snapshot.categories.find((category) => category.id === categoryId) ?? null
  };
}

/** Deterministically plans one ordinary lineup mutation over the exact current snapshot. */
export function planSpeakerLineupMutation(input: {
  readonly planningInput: SpeakerLineupPlanningInput;
  readonly lineups: SpeakerLineupReadPort;
}): SpeakerLineupMutationPlanDto {
  const planning = speakerLineupPlanningInputSchema.parse(input.planningInput);
  const before = input.lineups.readSpeakerLineupSnapshot(planning.scope);
  if (!before) throw new SpeakerLineupPlanningError('lineup_missing');
  if (before.version !== planning.authorInput.expectedLineupVersion) {
    throw new SpeakerLineupPlanningError('stale_lineup');
  }

  let categories = [...before.categories];
  let entries = [...before.entries];
  const wire = planning.authorInput;

  if (wire.action === 'reorder') {
    if (wire.personIds.length !== entries.length
        || new Set(wire.personIds).size !== entries.length
        || wire.personIds.some((personId) => !entries.some((entry) => entry.personId === personId))) {
      throw new SpeakerLineupPlanningError('invalid_order');
    }
    const byPerson = new Map(entries.map((entry) => [entry.personId, entry]));
    entries = wire.personIds.map((personId, position) => {
      const entry = byPerson.get(personId)!;
      return entry.position === position
        ? entry
        : { ...entry, position, version: entry.version + 1 };
    });
  } else if (wire.action === 'set_category') {
    if (wire.categoryId !== null
        && !categories.some((category) =>
          category.id === wire.categoryId && category.status === 'active')) {
      throw new SpeakerLineupPlanningError('category_missing', wire.categoryId ?? undefined);
    }
    let found = false;
    entries = entries.map((entry) => {
      if (entry.personId !== wire.personId) return entry;
      found = true;
      return { ...entry, categoryId: wire.categoryId, version: entry.version + 1 };
    });
    if (!found) throw new SpeakerLineupPlanningError('entry_missing', wire.personId);
  } else if (wire.action === 'set_visibility') {
    let found = false;
    entries = entries.map((entry) => {
      if (entry.personId !== wire.personId) return entry;
      found = true;
      return { ...entry, publiclyVisible: wire.publiclyVisible, version: entry.version + 1 };
    });
    if (!found) throw new SpeakerLineupPlanningError('entry_missing', wire.personId);
  } else {
    if (planning.categoryId === null) throw new SpeakerLineupPlanningError('invalid_plan');
    if (categories.some((category) => casefold(category.name) === casefold(wire.name))) {
      throw new SpeakerLineupPlanningError('category_name_exists');
    }
    const accents = ['lavender', 'sea', 'neutral'] as const;
    categories.push({
      id: planning.categoryId,
      name: wire.name,
      accent: accents[categories.length % accents.length]!,
      status: 'active',
      position: categories.length,
      version: 1
    });
  }

  const after = createSpeakerLineupSnapshot({
    scope: before.scope,
    version: before.version + 1,
    categories,
    entries
  });
  return speakerLineupMutationPlanSchema.parse({ input: planning, before, after });
}

export function speakerLineupChangeDataFromPlan(
  planInput: SpeakerLineupMutationPlanDto
): SpeakerLineupChangeData {
  const plan = speakerLineupMutationPlanSchema.parse(planInput);
  const wire = plan.input.authorInput;
  return changedData(
    wire.action,
    plan.after,
    'personId' in wire ? wire.personId : undefined,
    wire.action === 'add_category' ? plan.input.categoryId ?? undefined : undefined
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
