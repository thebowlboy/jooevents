import { renderTransactionalEmail } from './transactional-email';

export const SUBMISSION_CONFIRMATION_PURPOSE_KEY = 'submission_confirmation' as const;
export const SUBMISSION_CONFIRMATION_TEMPLATE_REVISION_REF_ID =
  'template.submission-confirmation.v1' as const;

export const SUBMISSION_CONFIRMATION_STANDING_POLICY = Object.freeze({
  key: 'standing-policy.submission-confirmation',
  version: 1,
  communicationClass: 'event_transactional',
  owner: 'workspace_owner',
  trigger: 'application_submitted@1',
  maximumRegistrationsPerSubmission: 1,
  producerAuthorizationLifetimeMs: 300_000,
  revocationSwitch: 'JOOEVENTS_SUBMISSION_CONFIRMATIONS'
} as const);

/**
 * Frozen merge inventory for the first submission receipt. Every value comes
 * from committed event/submission state; the portal URL is application-owned.
 */
export const SUBMISSION_CONFIRMATION_MERGE_FIELDS = Object.freeze([
  'event.name',
  'submission.title',
  'submission.submitted_at',
  'portal.url'
] as const);

export interface SubmissionConfirmationMessageInput {
  readonly eventName: string;
  readonly submissionTitle: string;
  readonly submittedAt: string;
  readonly portalUrl: string;
}

export interface SubmissionConfirmationMessage {
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}

const UTC_MONTHS = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
] as const);

function presentSubmittedAt(value: Date): string {
  const day = value.getUTCDate().toString().padStart(2, '0');
  const month = UTC_MONTHS[value.getUTCMonth()]!;
  const year = value.getUTCFullYear();
  const hour = value.getUTCHours().toString().padStart(2, '0');
  const minute = value.getUTCMinutes().toString().padStart(2, '0');
  return `${day} ${month} ${year} · ${hour}:${minute} UTC`;
}

function boundedLine(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 500
      || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(trimmed)) {
    throw new TypeError(`submission_confirmation_${label}_invalid`);
  }
  return trimmed;
}

function canonicalPortalUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('submission_confirmation_portal_url_invalid');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      || parsed.username !== '' || parsed.password !== '' || parsed.search !== ''
      || parsed.hash !== '' || parsed.pathname !== '/portal/sign-in') {
    throw new TypeError('submission_confirmation_portal_url_invalid');
  }
  return parsed.toString();
}

export function renderSubmissionConfirmationMessage(
  input: SubmissionConfirmationMessageInput
): SubmissionConfirmationMessage {
  const eventName = boundedLine(input.eventName, 'event_name');
  const submissionTitle = boundedLine(input.submissionTitle, 'submission_title');
  const submittedAt = new Date(input.submittedAt);
  if (!Number.isFinite(submittedAt.getTime()) || submittedAt.toISOString() !== input.submittedAt) {
    throw new TypeError('submission_confirmation_submitted_at_invalid');
  }
  const portalUrl = canonicalPortalUrl(input.portalUrl);
  const subject = `We received your application to ${eventName}`;
  const { textBody, htmlBody } = renderTransactionalEmail({
    subject,
    preheader: `Your application to ${eventName} was received.`,
    heading: 'Application received',
    intro: [
      `We received your application to ${eventName}.`,
      `Proposal: “${submissionTitle}”.`,
      `Submitted ${presentSubmittedAt(submittedAt)}.`,
      'Organizers will contact you when there is an update.'
    ],
    button: { label: 'See your application', url: portalUrl },
    nakedLink: portalUrl,
    smallPrint: [
      "We'll ask for your email and send a sign-in link. No password.",
      'This message confirms a request you made; it is not a marketing email.'
    ],
    siteUrl: new URL('/', portalUrl).toString(),
    productName: 'JooEvents'
  });
  return Object.freeze({ subject, textBody, htmlBody });
}
