import { describe, expect, test } from 'bun:test';
import { renderSubmissionConfirmationMessage } from './submission-confirmation';

const input = Object.freeze({
  eventName: 'Riverside Conf 2027',
  submissionTitle: 'Scaling PostgreSQL',
  submittedAt: '2026-08-17T08:15:00.000Z',
  portalUrl: 'https://events.example.test/portal/sign-in'
});

describe('submission confirmation renderer', () => {
  test('renders equivalent deterministic HTML and text with the canonical portal door', () => {
    const first = renderSubmissionConfirmationMessage(input);
    const second = renderSubmissionConfirmationMessage(input);
    expect(second).toEqual(first);
    for (const value of [first.textBody, first.htmlBody]) {
      expect(value).toContain('Application received');
      expect(value).toContain('Scaling PostgreSQL');
      expect(value).toContain('Riverside Conf 2027');
      expect(value).toContain('17 Aug 2026 · 08:15 UTC');
      expect(value).toContain('https://events.example.test/portal/sign-in');
    }
    expect(first.subject).toBe('We received your application to Riverside Conf 2027');
  });

  test('escapes authored text and refuses unsafe or state-carrying portal URLs', () => {
    const rendered = renderSubmissionConfirmationMessage({
      ...input,
      submissionTitle: '<img src=x onerror=alert(1)>'
    });
    expect(rendered.textBody).toContain('<img src=x onerror=alert(1)>');
    expect(rendered.htmlBody).not.toContain('<img src=x onerror=alert(1)>');
    expect(rendered.htmlBody).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(() => renderSubmissionConfirmationMessage({
      ...input,
      portalUrl: 'https://events.example.test/portal/sign-in?email=maya@example.com'
    })).toThrow('submission_confirmation_portal_url_invalid');
    expect(() => renderSubmissionConfirmationMessage({
      ...input,
      portalUrl: 'javascript:alert(1)'
    })).toThrow('submission_confirmation_portal_url_invalid');
  });

  test('keeps the maximum accepted event and proposal labels inside the email contract', () => {
    const rendered = renderSubmissionConfirmationMessage({
      ...input,
      eventName: 'E'.repeat(500),
      submissionTitle: 'T'.repeat(500)
    });
    expect(rendered.subject.length).toBeLessThanOrEqual(998);
    expect(rendered.textBody).toContain('T'.repeat(500));
    expect(rendered.htmlBody).toContain('E'.repeat(500));
  });
});
