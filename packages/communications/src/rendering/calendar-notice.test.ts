import { describe, expect, test } from 'bun:test';
import {
  CALENDAR_NOTICE_STANDING_POLICY,
  renderCalendarNoticeMessage
} from './calendar-notice';

describe('calendar notice message', () => {
  test('is a phone-first transactional companion and the deployment policy defaults off', () => {
    expect(CALENDAR_NOTICE_STANDING_POLICY).toMatchObject({
      revocationSwitch: 'JOOEVENTS_CALENDAR_NOTICES', defaultState: 'off'
    });
    const message = renderCalendarNoticeMessage({
      eventName: 'Systems Week',
      changes: [{
        method: 'REQUEST', sessionTitle: 'Practical systems',
        startsAt: '2026-09-01T02:00:00.000Z', roomName: 'Room A'
      }],
      portalUrl: 'https://events.example.test/portal/sign-in'
    });
    expect(message.subject).toBe('Calendar update for Systems Week');
    expect(message.textBody).toContain('Practical systems · 1 Sep 2026 at 02:00 UTC · Room A');
    expect(message.htmlBody).toContain('width="600"');
    expect(message.htmlBody).not.toContain('@media');
  });

  test('names each requested and cancelled consequence in one combined message', () => {
    const message = renderCalendarNoticeMessage({
      eventName: 'Systems Week',
      changes: [
        { method: 'CANCEL', sessionTitle: 'Old slot', startsAt: '2026-09-01T02:00:00.000Z', roomName: null },
        { method: 'REQUEST', sessionTitle: 'New slot', startsAt: '2026-09-01T04:00:00.000Z', roomName: 'Hall 2' }
      ],
      portalUrl: 'https://events.example.test/portal/sign-in'
    });
    expect(message.subject).toBe('2 calendar updates for Systems Week');
    expect(message.textBody).toContain('Cancelled: Old slot');
    expect(message.textBody).toContain('New slot');
  });
});
