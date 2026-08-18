import type { IcalendarEventInput, IcalendarTimezoneDefinition } from './ical';

export const newYork2026: IcalendarTimezoneDefinition = Object.freeze({
  tzid: 'America/New_York',
  observances: Object.freeze([
    Object.freeze({
      kind: 'DAYLIGHT' as const,
      dtstart: '20260308T020000', offsetFrom: '-0500', offsetTo: '-0400', name: 'EDT',
      rdates: Object.freeze(['20260308T020000'])
    }),
    Object.freeze({
      kind: 'STANDARD' as const,
      dtstart: '20261101T020000', offsetFrom: '-0400', offsetTo: '-0500', name: 'EST',
      rdates: Object.freeze(['20261101T020000'])
    })
  ])
});

const people = Object.freeze({
  organizer: Object.freeze({ email: 'program@example.org', commonName: 'JooEvents Program Team' }),
  attendee: Object.freeze({ email: 'maya@example.net', commonName: 'Maya “Systems” Chen' })
});

const timedBase = Object.freeze({
  uid: 'commitment-42@calendar.jooevents',
  dtstamp: '2026-08-18T02:03:04.000Z',
  timing: 'timed' as const,
  startAt: '2026-09-01T14:00:00.000Z',
  endAt: '2026-09-01T14:45:00.000Z',
  timezone: newYork2026,
  description: 'Bring questions, examples; and notes.\nSecond line proves escaping.',
  location: 'Hall A, Level 2',
  ...people
});

export const icalGoldenInputs: Readonly<Record<string, IcalendarEventInput>> = Object.freeze({
  request: Object.freeze({
    ...timedBase,
    method: 'REQUEST', sequence: 0,
    summary: 'Practical distributed systems — reliable calendars across teams and time zones'
  }),
  update: Object.freeze({
    ...timedBase,
    method: 'REQUEST', sequence: 2,
    startAt: '2026-09-01T15:00:00.000Z', endAt: '2026-09-01T15:45:00.000Z',
    summary: 'Practical distributed systems — updated room and time'
  }),
  cancel: Object.freeze({
    ...timedBase,
    method: 'CANCEL', sequence: 3,
    startAt: '2026-09-01T15:00:00.000Z', endAt: '2026-09-01T15:45:00.000Z',
    summary: 'Practical distributed systems — cancelled'
  }),
  date: Object.freeze({
    method: 'REQUEST', uid: 'deadline-7@calendar.jooevents', sequence: 0,
    dtstamp: '2026-08-18T02:03:04.000Z', timing: 'date',
    startDate: '2026-10-12', endDateExclusive: '2026-10-13',
    summary: 'Slides due', description: 'Upload the final deck.', location: 'JooEvents portal',
    ...people
  })
});
