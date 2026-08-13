import { createHash } from 'node:crypto';
import {
  deadlineDisplayDateSchema,
  deadlineEventTimeBasisSchema,
  type DeadlineEventTimeBasisDto
} from '@jooevents/contracts/deadlines';
import { encodeCanonicalJson, parseIanaTimezone } from '@jooevents/kernel';

export const DEADLINE_CALENDAR_BOUNDARY_PROFILE_KEY =
  'deadline.calendar-date.event-local-end-exclusive';
export const DEADLINE_CALENDAR_BOUNDARY_PROFILE_VERSION = 1;

const profileDefinition = Object.freeze({
  key: DEADLINE_CALENDAR_BOUNDARY_PROFILE_KEY,
  version: DEADLINE_CALENDAR_BOUNDARY_PROFILE_VERSION,
  semantics: 'first-instant-of-next-event-local-calendar-date',
  timezoneRules: 'iana-runtime-canonical',
  ambiguity: 'reject',
  nonexistent: 'reject'
});

export const DEADLINE_CALENDAR_BOUNDARY_PROFILE = Object.freeze({
  key: DEADLINE_CALENDAR_BOUNDARY_PROFILE_KEY,
  version: DEADLINE_CALENDAR_BOUNDARY_PROFILE_VERSION,
  digestSha256: createHash('sha256').update(encodeCanonicalJson(profileDefinition)).digest('hex')
});

export type DeadlineBoundaryResolutionErrorCode =
  | 'invalid_display_date'
  | 'invalid_event_timezone'
  | 'boundary_nonexistent'
  | 'boundary_ambiguous';

export class DeadlineBoundaryResolutionError extends Error {
  constructor(readonly code: DeadlineBoundaryResolutionErrorCode) {
    super(code);
    this.name = 'DeadlineBoundaryResolutionError';
  }
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

function nextDate(value: string): string {
  const parsed = deadlineDisplayDateSchema.safeParse(value);
  if (!parsed.success) throw new DeadlineBoundaryResolutionError('invalid_display_date');
  const [year, month, day] = parsed.data.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + 1));
  return date.toISOString().slice(0, 10);
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  try {
    const canonical = parseIanaTimezone(timeZone);
    if (canonical !== timeZone) throw new TypeError('noncanonical timezone');
    return new Intl.DateTimeFormat('en-CA-u-ca-iso8601', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23'
    });
  } catch {
    throw new DeadlineBoundaryResolutionError('invalid_event_timezone');
  }
}

function partsAt(format: Intl.DateTimeFormat, epochMs: number): LocalParts {
  const values = new Map<string, string>(
    format.formatToParts(epochMs).map((part) => [part.type, part.value])
  );
  const read = (key: string): number => Number(values.get(key));
  const parts = {
    year: read('year'), month: read('month'), day: read('day'), hour: read('hour'),
    minute: read('minute'), second: read('second'), millisecond: read('fractionalSecond')
  };
  if (Object.values(parts).some((value) => !Number.isInteger(value))) {
    throw new DeadlineBoundaryResolutionError('invalid_event_timezone');
  }
  return parts;
}

function localEpoch(parts: LocalParts): number {
  return Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour,
    parts.minute, parts.second, parts.millisecond
  );
}

function sameParts(left: LocalParts, right: LocalParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute
    && left.second === right.second && left.millisecond === right.millisecond;
}

/**
 * Resolves one event-local closing date to its exclusive UTC boundary. Candidate
 * offsets are obtained from the IANA formatter around the target; every candidate is
 * then round-tripped and exactly one must survive. No process timezone participates.
 */
export function resolveDeadlineCalendarBoundary(input: {
  readonly displayDate: string;
  readonly eventTimeBasis: DeadlineEventTimeBasisDto;
}): {
  readonly displayDate: string;
  readonly effectiveAt: string;
  readonly boundary: {
    readonly profile: typeof DEADLINE_CALENDAR_BOUNDARY_PROFILE;
    readonly eventTimezone: string;
    readonly eventVersion: number;
    readonly localBoundaryDate: string;
  };
} {
  const displayDate = deadlineDisplayDateSchema.safeParse(input.displayDate);
  if (!displayDate.success) throw new DeadlineBoundaryResolutionError('invalid_display_date');
  const eventTimeBasis = deadlineEventTimeBasisSchema.safeParse(input.eventTimeBasis);
  if (!eventTimeBasis.success) throw new DeadlineBoundaryResolutionError('invalid_event_timezone');
  const localBoundaryDate = nextDate(displayDate.data);
  const [year, month, day] = localBoundaryDate.split('-').map(Number);
  const target: LocalParts = {
    year: year!, month: month!, day: day!, hour: 0, minute: 0, second: 0, millisecond: 0
  };
  const targetEpoch = localEpoch(target);
  const format = formatter(eventTimeBasis.data.timezone);
  const offsets = new Set<number>();
  // Three days on each side includes both sides of every ordinary civil transition.
  for (let hour = -72; hour <= 72; hour += 1) {
    const probe = targetEpoch + hour * 60 * 60 * 1_000;
    offsets.add(localEpoch(partsAt(format, probe)) - probe);
  }
  const matches = [...offsets]
    .map((offset) => targetEpoch - offset)
    .filter((candidate) => sameParts(partsAt(format, candidate), target))
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .sort((left, right) => left - right);
  if (matches.length === 0) throw new DeadlineBoundaryResolutionError('boundary_nonexistent');
  if (matches.length !== 1) throw new DeadlineBoundaryResolutionError('boundary_ambiguous');
  return deepFreeze({
    displayDate: displayDate.data,
    effectiveAt: new Date(matches[0]!).toISOString(),
    boundary: {
      profile: DEADLINE_CALENDAR_BOUNDARY_PROFILE,
      eventTimezone: eventTimeBasis.data.timezone,
      eventVersion: eventTimeBasis.data.eventVersion,
      localBoundaryDate
    }
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
