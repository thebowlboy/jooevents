import type { IcalendarTimezoneDefinition, IcalendarTimezoneObservance } from './ical';

function parts(timeZone: string, at: number): Record<string, string> {
  try {
    return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZoneName: 'short'
    }).formatToParts(new Date(at)).filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]));
  } catch {
    throw new TypeError('calendar_timezone_invalid');
  }
}

function offsetMinutes(timeZone: string, at: number): number {
  const value = parts(timeZone, at);
  const projected = Date.UTC(
    Number(value.year), Number(value.month) - 1, Number(value.day),
    Number(value.hour), Number(value.minute), Number(value.second)
  );
  return Math.round((projected - Math.floor(at / 1_000) * 1_000) / 60_000);
}

function offset(value: number): string {
  const sign = value < 0 ? '-' : '+';
  const absolute = Math.abs(value);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}${String(absolute % 60).padStart(2, '0')}`;
}

function localBasic(timeZone: string, at: number): string {
  const value = parts(timeZone, at);
  return `${value.year}${value.month}${value.day}T${value.hour}${value.minute}${value.second}`;
}

function transitionMinute(timeZone: string, left: number, right: number, priorOffset: number): number {
  let low = Math.floor(left / 60_000) * 60_000;
  let high = Math.ceil(right / 60_000) * 60_000;
  while (high - low > 60_000) {
    const middle = Math.floor((low + high) / 120_000) * 60_000;
    if (offsetMinutes(timeZone, middle) === priorOffset) low = middle;
    else high = middle;
  }
  return high;
}

/** Deterministic VTIMEZONE observations over the supplied artifact horizon. */
export function buildIcalendarTimezoneDefinition(input: {
  readonly timeZone: string;
  readonly startAt: string;
  readonly endAt: string;
}): IcalendarTimezoneDefinition {
  const start = Date.parse(input.startAt);
  const end = Date.parse(input.endAt);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) {
    throw new TypeError('calendar_timezone_range_invalid');
  }
  const scanStart = Date.UTC(new Date(start).getUTCFullYear() - 1, 0, 1);
  const scanEnd = Date.UTC(new Date(end).getUTCFullYear() + 2, 0, 1);
  const sixHours = 21_600_000;
  let priorAt = scanStart;
  let prior = offsetMinutes(input.timeZone, priorAt);
  const initialParts = parts(input.timeZone, scanStart);
  const observances: IcalendarTimezoneObservance[] = [{
    kind: 'STANDARD',
    dtstart: localBasic(input.timeZone, scanStart),
    offsetFrom: offset(prior),
    offsetTo: offset(prior),
    name: initialParts.timeZoneName ?? input.timeZone
  }];
  for (let at = scanStart + sixHours; at <= scanEnd; at += sixHours) {
    const current = offsetMinutes(input.timeZone, at);
    if (current === prior) {
      priorAt = at;
      continue;
    }
    const transition = transitionMinute(input.timeZone, priorAt, at, prior);
    const transitionParts = parts(input.timeZone, transition);
    observances.push({
      kind: current > prior ? 'DAYLIGHT' : 'STANDARD',
      dtstart: localBasic(input.timeZone, transition),
      offsetFrom: offset(prior),
      offsetTo: offset(current),
      name: transitionParts.timeZoneName ?? input.timeZone
    });
    prior = current;
    priorAt = at;
  }
  return Object.freeze({
    tzid: input.timeZone,
    observances: Object.freeze(observances.map((item) => Object.freeze(item)))
  });
}
