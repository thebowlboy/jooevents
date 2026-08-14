import { describe, expect, test } from 'bun:test';
import { createFakeEmailEnvelope } from '../providers/fake';
import {
  computeReviewedEmailEnvelopeDigestSha256,
  parseEmailAddress,
  type ImmutableEmailEnvelope
} from '../providers/port';
import {
  MARKED_RESEND_BODY_NOTE,
  MARKED_RESEND_SUBJECT_PREFIX,
  deriveMarkedResendEmailEnvelope
} from './resend';

describe('marked resend envelope derivation', () => {
  test('prefixes the subject, notes the resend first in the body, and repins the digest', () => {
    const reviewed = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Decision for your talk',
      textBody: 'Reviewed body line.'
    });
    const derived = deriveMarkedResendEmailEnvelope(reviewed);
    expect(derived.subject).toBe('[Resend] Decision for your talk');
    expect(derived.subject.startsWith(MARKED_RESEND_SUBJECT_PREFIX)).toBe(true);
    expect(derived.textBody.split('\n')[0]).toBe(MARKED_RESEND_BODY_NOTE);
    expect(derived.textBody.endsWith('\n\nReviewed body line.')).toBe(true);
    expect(derived.from).toEqual(reviewed.from);
    expect(derived.to).toEqual(reviewed.to);
    expect(derived.htmlBody).toBeUndefined();
    expect([...derived.headers]).toEqual([...reviewed.headers]);
    expect(computeReviewedEmailEnvelopeDigestSha256(derived))
      .not.toBe(computeReviewedEmailEnvelopeDigestSha256(reviewed));
    expect(Object.isFrozen(derived)).toBe(true);
    // Pure derivation: the resend digest is reproducible from the reviewed bytes alone.
    const again = deriveMarkedResendEmailEnvelope(reviewed);
    expect(computeReviewedEmailEnvelopeDigestSha256(again))
      .toBe(computeReviewedEmailEnvelopeDigestSha256(derived));
  });

  test('preserves reply-to and notes the resend in the HTML body when present', () => {
    const reviewed: ImmutableEmailEnvelope = Object.freeze({
      contractVersion: 1,
      from: Object.freeze({ address: parseEmailAddress('sender@example.test'), displayName: 'Organizers' }),
      to: Object.freeze({ address: parseEmailAddress('recipient@example.test') }),
      replyTo: Object.freeze({ address: parseEmailAddress('replies@example.test') }),
      subject: 'Schedule update',
      textBody: 'Plain body.',
      htmlBody: '<p>Rich body.</p>',
      headers: Object.freeze([])
    });
    const derived = deriveMarkedResendEmailEnvelope(reviewed);
    expect(derived.replyTo).toEqual(reviewed.replyTo);
    expect(derived.from).toEqual(reviewed.from);
    expect(derived.htmlBody).toBe(`<p>${MARKED_RESEND_BODY_NOTE}</p>\n<p>Rich body.</p>`);
  });

  test('a full HTML document keeps its doctype first and gains the note inside <body>', () => {
    const document = '<!doctype html><html><head><title>t</title></head>'
      + '<body style="margin:0;"><table><tr><td>Sign in</td></tr></table></body></html>';
    const derived = deriveMarkedResendEmailEnvelope(Object.freeze({
      contractVersion: 1,
      from: Object.freeze({ address: parseEmailAddress('sender@example.test') }),
      to: Object.freeze({ address: parseEmailAddress('recipient@example.test') }),
      subject: 'Your sign-in link',
      textBody: 'Plain body.',
      htmlBody: document,
      headers: Object.freeze([])
    }));
    expect(derived.htmlBody?.startsWith('<!doctype html>')).toBe(true);
    expect(derived.htmlBody).toBe(
      '<!doctype html><html><head><title>t</title></head>'
      + `<body style="margin:0;"><p>${MARKED_RESEND_BODY_NOTE}</p>`
      + '<table><tr><td>Sign in</td></tr></table></body></html>'
    );
    expect(derived.textBody.startsWith(`${MARKED_RESEND_BODY_NOTE}\n\n`)).toBe(true);
  });

  test('clamps the derived subject to the envelope subject bound', () => {
    const reviewed = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'S'.repeat(998),
      textBody: 'Body.'
    });
    const derived = deriveMarkedResendEmailEnvelope(reviewed);
    expect(derived.subject).toHaveLength(998);
    expect(derived.subject.startsWith(`${MARKED_RESEND_SUBJECT_PREFIX}SSS`)).toBe(true);
    computeReviewedEmailEnvelopeDigestSha256(derived);
  });

  test('refuses an envelope that does not satisfy the reviewed contract', () => {
    const invalid = {
      contractVersion: 1,
      from: { address: 'not-an-address' },
      to: { address: 'recipient@example.test' },
      subject: 'x',
      textBody: 'x',
      headers: []
    } as unknown as ImmutableEmailEnvelope;
    expect(() => deriveMarkedResendEmailEnvelope(invalid)).toThrow();
  });
});
