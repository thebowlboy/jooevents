import {
  computeReviewedEmailEnvelopeDigestSha256,
  type ImmutableEmailEnvelope
} from '../providers/port';

/** Short subject prefix carried by the single automatic retry after an unknown acceptance. */
export const MARKED_RESEND_SUBJECT_PREFIX = '[Resend] ';

/**
 * First body line of a marked resend. It states why a second copy may arrive so
 * a double delivery reads as intent, not error. The text is a fixed constant:
 * the derived envelope must be reproducible from the reviewed release alone.
 */
export const MARKED_RESEND_BODY_NOTE =
  'This is a resend: our system could not confirm that the first attempt arrived. '
  + 'If you already received this message, please disregard this copy.';

/** The envelope contract's subject bound; the derived subject is clamped to it. */
const SUBJECT_MAXIMUM_LENGTH = 998;

function freezeParty<Party extends { readonly address: unknown }>(party: Party): Party {
  return Object.freeze({ ...party });
}

/**
 * Derives the marked resend envelope from the exact reviewed envelope. The
 * derivation is a pure function of the reviewed bytes, so the resend is itself
 * digest-pinned: the worker computes this envelope's digest at retry time, the
 * ledger records it on the marked attempt, and the provider preparer re-verifies
 * the submitted bytes against it. The reviewed original is never mutated —
 * addressing, reply-to, and headers are preserved; only the subject gains the
 * `[Resend]` prefix (clamped to the envelope's subject bound) and each body
 * gains the fixed leading resend note.
 */
/**
 * The note must land INSIDE the document: bytes before `<!doctype html>` make
 * the resent mail an invalid document that renders in quirks mode with the
 * note outside the page background. A full document gets the note directly
 * after its opening <body>; fragment-style html keeps the leading note.
 */
function injectHtmlResendNote(htmlBody: string): string {
  const note = `<p>${MARKED_RESEND_BODY_NOTE}</p>`;
  const bodyOpen = /<body[^>]*>/i.exec(htmlBody);
  if (bodyOpen) {
    const at = bodyOpen.index + bodyOpen[0].length;
    return `${htmlBody.slice(0, at)}${note}${htmlBody.slice(at)}`;
  }
  return `${note}\n${htmlBody}`;
}

export function deriveMarkedResendEmailEnvelope(
  reviewed: ImmutableEmailEnvelope
): ImmutableEmailEnvelope {
  computeReviewedEmailEnvelopeDigestSha256(reviewed);
  const common = {
    from: freezeParty(reviewed.from),
    to: freezeParty(reviewed.to),
    ...(reviewed.replyTo === undefined ? {} : { replyTo: freezeParty(reviewed.replyTo) }),
    subject: `${MARKED_RESEND_SUBJECT_PREFIX}${reviewed.subject}`.slice(0, SUBJECT_MAXIMUM_LENGTH),
    textBody: `${MARKED_RESEND_BODY_NOTE}\n\n${reviewed.textBody}`,
    ...(reviewed.htmlBody === undefined
      ? {}
      : { htmlBody: injectHtmlResendNote(reviewed.htmlBody) }),
    headers: Object.freeze(reviewed.headers.map((header) => Object.freeze({ ...header })))
  };
  const derived: ImmutableEmailEnvelope = reviewed.contractVersion === 1
    ? Object.freeze({ contractVersion: 1, ...common })
    : Object.freeze({
      contractVersion: 2,
      ...common,
      attachments: Object.freeze(reviewed.attachments.map((attachment) =>
        Object.freeze({ ...attachment })
      )),
      ...(reviewed.calendarPart === undefined ? {} : {
        calendarPart: Object.freeze({ ...reviewed.calendarPart })
      })
    });
  computeReviewedEmailEnvelopeDigestSha256(derived);
  return derived;
}
