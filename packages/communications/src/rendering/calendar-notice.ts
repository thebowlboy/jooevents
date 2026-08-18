import { renderTransactionalEmail } from './transactional-email';

export const CALENDAR_NOTICE_PURPOSE_KEY = 'calendar_notice' as const;
export const CALENDAR_NOTICE_TEMPLATE_REVISION_REF_ID = 'template.calendar-notice.v1' as const;

export const CALENDAR_NOTICE_STANDING_POLICY = Object.freeze({
  key: 'standing-policy.calendar-notice',
  version: 1,
  communicationClass: 'event_transactional',
  owner: 'workspace_owner',
  trigger: 'sealed_calendar_notice_generation@1',
  maximumRegistrationsPerGeneration: 1,
  revocationSwitch: 'JOOEVENTS_CALENDAR_NOTICES',
  defaultState: 'off'
} as const);

export interface CalendarNoticeMessageChange {
  readonly method: 'REQUEST' | 'CANCEL';
  readonly sessionTitle: string;
  readonly startsAt: string;
  readonly roomName: string | null;
}

function bounded(value: string, label: string): string {
  const selected = value.trim();
  if (selected.length === 0 || selected.length > 500
      || /[\u0000\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(selected)) {
    throw new TypeError(`calendar_notice_${label}_invalid`);
  }
  return selected;
}

function summary(change: CalendarNoticeMessageChange): string {
  const title = bounded(change.sessionTitle, 'session_title');
  const startsAt = new Date(change.startsAt);
  if (!Number.isFinite(startsAt.getTime()) || startsAt.toISOString() !== change.startsAt) {
    throw new TypeError('calendar_notice_starts_at_invalid');
  }
  const when = startsAt.toLocaleString('en-GB', {
    timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short'
  });
  const room = change.roomName === null ? '' : ` · ${bounded(change.roomName, 'room_name')}`;
  return change.method === 'CANCEL'
    ? `Cancelled: ${title} · ${when} UTC${room}`
    : `${title} · ${when} UTC${room}`;
}

/** Frozen human-readable companion to the release's method-partitioned iTIP bytes. */
export function renderCalendarNoticeMessage(input: {
  readonly eventName: string;
  readonly changes: readonly CalendarNoticeMessageChange[];
  readonly portalUrl: string;
}): Readonly<{ subject: string; textBody: string; htmlBody: string }> {
  const eventName = bounded(input.eventName, 'event_name');
  if (input.changes.length === 0 || input.changes.length > 1_000) {
    throw new TypeError('calendar_notice_changes_invalid');
  }
  const changes = input.changes.map(summary);
  const subject = input.changes.length === 1
    ? `Calendar update for ${eventName}`
    : `${input.changes.length} calendar updates for ${eventName}`;
  const portalUrl = new URL(input.portalUrl);
  if ((portalUrl.protocol !== 'https:' && portalUrl.protocol !== 'http:')
      || portalUrl.username || portalUrl.password || portalUrl.hash) {
    throw new TypeError('calendar_notice_portal_url_invalid');
  }
  const rendered = renderTransactionalEmail({
    subject,
    preheader: `Your speaking schedule for ${eventName} changed.`,
    heading: 'Your speaking schedule changed',
    intro: [
      `The organizer updated your speaking schedule for ${eventName}.`,
      ...changes,
      'Open or download the calendar invitation attached to this email to apply the update.'
    ],
    button: { label: 'See your speaking schedule', url: portalUrl.toString() },
    nakedLink: portalUrl.toString(),
    smallPrint: [
      'This message is about an event you are speaking at; it is not a marketing email.'
    ],
    siteUrl: new URL('/', portalUrl).toString(),
    productName: 'JooEvents'
  });
  return Object.freeze({ subject, textBody: rendered.textBody, htmlBody: rendered.htmlBody });
}
