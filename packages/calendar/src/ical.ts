export type IcalendarMethod = 'REQUEST' | 'CANCEL';

export interface IcalendarPerson {
  readonly email: string;
  readonly commonName: string;
}

export interface IcalendarTimezoneObservance {
  readonly kind: 'STANDARD' | 'DAYLIGHT';
  /** Local wall time in basic iCalendar form, for example 20261101T020000. */
  readonly dtstart: string;
  readonly offsetFrom: string;
  readonly offsetTo: string;
  readonly name: string;
  readonly rdates?: readonly string[];
}

export interface IcalendarTimezoneDefinition {
  readonly tzid: string;
  readonly observances: readonly IcalendarTimezoneObservance[];
}

interface IcalendarEventBase {
  readonly method: IcalendarMethod;
  readonly uid: string;
  readonly sequence: number;
  /** Canonical UTC instant supplied by the caller; the renderer never reads a clock. */
  readonly dtstamp: string;
  readonly summary: string;
  readonly description: string;
  readonly location: string;
  readonly organizer: IcalendarPerson;
  readonly attendee: IcalendarPerson;
}

export type IcalendarEventInput = IcalendarEventBase & ({
  readonly timing: 'timed';
  readonly startAt: string;
  readonly endAt: string;
  readonly timezone: IcalendarTimezoneDefinition;
} | {
  readonly timing: 'date';
  readonly startDate: string;
  readonly endDateExclusive: string;
});

const BASIC_LOCAL = /^\d{8}T\d{6}$/;
const OFFSET = /^[+-]\d{4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertSafeScalar(value: string, code: string): void {
  if (value.length === 0 || /[\u0000\r\n]/u.test(value)) throw new TypeError(code);
}

function utcDateTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new TypeError('calendar_ical_instant_invalid');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError('calendar_ical_instant_invalid');
  }
  return value.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function dateValue(value: string): string {
  if (!DATE.test(value)) throw new TypeError('calendar_ical_date_invalid');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError('calendar_ical_date_invalid');
  }
  return value.replaceAll('-', '');
}

function localDateTime(instant: string, timezone: string): string {
  utcDateTime(instant);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  const local = `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
  if (!BASIC_LOCAL.test(local)) throw new TypeError('calendar_ical_timezone_projection_invalid');
  return local;
}

function escapeText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replace(/\r\n|\r|\n/gu, '\\n')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}

function parameterText(value: string): string {
  assertSafeScalar(value, 'calendar_ical_parameter_invalid');
  return `"${value.replaceAll('^', '^^').replaceAll('"', "^'")}"`;
}

function mailbox(value: string): string {
  assertSafeScalar(value, 'calendar_ical_mailbox_invalid');
  const address = value.toLowerCase().startsWith('mailto:') ? value.slice(7) : value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) throw new TypeError('calendar_ical_mailbox_invalid');
  return `mailto:${address}`;
}

function validateTimezone(definition: IcalendarTimezoneDefinition): void {
  assertSafeScalar(definition.tzid, 'calendar_ical_tzid_invalid');
  if (definition.observances.length === 0) throw new TypeError('calendar_ical_observance_required');
  for (const observance of definition.observances) {
    const rdatesValid = observance.rdates === undefined
      || observance.rdates.every((value) => BASIC_LOCAL.test(value));
    if (!BASIC_LOCAL.test(observance.dtstart)
        || !OFFSET.test(observance.offsetFrom)
        || !OFFSET.test(observance.offsetTo)
        || !rdatesValid) {
      throw new TypeError('calendar_ical_observance_invalid');
    }
    assertSafeScalar(observance.name, 'calendar_ical_observance_name_invalid');
  }
}

function foldLine(line: string): string {
  const segments: string[] = [];
  let segment = '';
  let bytes = 0;
  let maximum = 75;
  for (const character of line) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > maximum && segment.length > 0) {
      segments.push(segment);
      segment = character;
      bytes = size;
      maximum = 74;
    } else {
      segment += character;
      bytes += size;
    }
  }
  segments.push(segment);
  return segments.join('\r\n ');
}

function timezoneLines(definition: IcalendarTimezoneDefinition): readonly string[] {
  validateTimezone(definition);
  const lines = ['BEGIN:VTIMEZONE', `TZID:${escapeText(definition.tzid)}`, `X-LIC-LOCATION:${escapeText(definition.tzid)}`];
  for (const observance of definition.observances) {
    lines.push(
      `BEGIN:${observance.kind}`,
      `DTSTART:${observance.dtstart}`,
      `TZOFFSETFROM:${observance.offsetFrom}`,
      `TZOFFSETTO:${observance.offsetTo}`,
      `TZNAME:${escapeText(observance.name)}`
    );
    if (observance.rdates && observance.rdates.length > 0) {
      lines.push(`RDATE:${observance.rdates.join(',')}`);
    }
    lines.push(`END:${observance.kind}`);
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

/** Deterministic RFC 5545/5546 rendering. All bytes derive only from the input. */
export function renderIcalendar(input: IcalendarEventInput): Uint8Array {
  assertSafeScalar(input.uid, 'calendar_ical_uid_invalid');
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new TypeError('calendar_ical_sequence_invalid');
  }
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'PRODID:-//JooEvents//Calendar Delivery//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    `METHOD:${input.method}`
  ];
  if (input.timing === 'timed') lines.push(...timezoneLines(input.timezone));
  lines.push(
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${utcDateTime(input.dtstamp)}`
  );
  if (input.timing === 'timed') {
    if (input.startAt >= input.endAt) throw new TypeError('calendar_ical_time_range_invalid');
    lines.push(
      `DTSTART;TZID=${parameterText(input.timezone.tzid)}:${localDateTime(input.startAt, input.timezone.tzid)}`,
      `DTEND;TZID=${parameterText(input.timezone.tzid)}:${localDateTime(input.endAt, input.timezone.tzid)}`
    );
  } else {
    if (input.startDate >= input.endDateExclusive) throw new TypeError('calendar_ical_date_range_invalid');
    lines.push(
      `DTSTART;VALUE=DATE:${dateValue(input.startDate)}`,
      `DTEND;VALUE=DATE:${dateValue(input.endDateExclusive)}`
    );
  }
  lines.push(
    `SUMMARY:${escapeText(input.summary)}`,
    `DESCRIPTION:${escapeText(input.description)}`,
    `LOCATION:${escapeText(input.location)}`,
    `ORGANIZER;CN=${parameterText(input.organizer.commonName)}:${mailbox(input.organizer.email)}`,
    `ATTENDEE;CN=${parameterText(input.attendee.commonName)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:${mailbox(input.attendee.email)}`,
    `STATUS:${input.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR'
  );
  return new TextEncoder().encode(`${lines.map(foldLine).join('\r\n')}\r\n`);
}
