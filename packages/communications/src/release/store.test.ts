import { describe, expect, test } from 'bun:test';
import {
  CommunicationMessageReleaseError,
  buildCommunicationMessageRelease,
  computeReviewedEmailEnvelopeDigestSha256,
  createInMemoryCommunicationMessageReleaseStore,
  createReleaseStoreOutboundEmailEnvelopeResolver,
  parseCommunicationMessageRelease
} from '../index';

const base = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  eventId: '019c1df7-86b5-769b-bba4-5f7097bfa141',
  releaseId: 'mrel1.ada',
  batchId: 'batch.decision.1',
  recipientRefId: `rr1_${'a'.repeat(30)}`,
  personRefId: '019c1df7-86b5-769b-bba4-5f7097bfa741',
  contactRefId: 'submission-contact:019c1df7-86b5-769b-bba4-5f7097bfa541',
  templateRevisionRefId: '019c1df7-86b5-769b-bba4-5f7097bfa841',
  contentRefId: '019c1df7-86b5-769b-bba4-5f7097bfa842',
  purposeKey: 'decision_notification',
  reviewedMessageDigestSha256: 'c'.repeat(64),
  sender: {
    fromAddress: 'organizer@jooevents.example',
    senderProfileRevisionId: 'sender.profile.rev-1',
    senderPresentationContractKey: 'sender.presentation.email-v1',
    senderPresentationContractVersion: 1,
    senderPresentationDigestSha256: 'd'.repeat(64)
  },
  toAddress: 'ada@example.org',
  subject: 'Your submission decision',
  textBody: 'Hello Ada, your submission was accepted.',
  createdAt: '2026-08-14T10:00:00.000Z'
} as const;

describe('communication message releases', () => {
  test('materialization binds the reviewed envelope digest to exact bytes', () => {
    const release = buildCommunicationMessageRelease(base);
    expect(release.reviewedEnvelopeDigestSha256)
      .toBe(computeReviewedEmailEnvelopeDigestSha256(release.envelope));
    expect(String(release.envelope.to.address)).toBe('ada@example.org');
    // Deterministic: the same inputs always produce the same reviewed digests.
    expect(buildCommunicationMessageRelease(base).reviewedEnvelopeDigestSha256)
      .toBe(release.reviewedEnvelopeDigestSha256);
  });

  test('the reviewed envelope digest covers the optional HTML body', () => {
    const textOnly = buildCommunicationMessageRelease(base);
    expect(textOnly.envelope.htmlBody).toBeUndefined();
    const withHtml = buildCommunicationMessageRelease({
      ...base,
      htmlBody: '<p>Hello Ada, your submission was accepted.</p>'
    });
    expect(withHtml.envelope.htmlBody).toBe('<p>Hello Ada, your submission was accepted.</p>');
    expect(withHtml.reviewedEnvelopeDigestSha256)
      .not.toBe(textOnly.reviewedEnvelopeDigestSha256);
    expect(withHtml.reviewedEnvelopeDigestSha256)
      .toBe(computeReviewedEmailEnvelopeDigestSha256(withHtml.envelope));
    // A tampered HTML body can no longer claim the reviewed digest.
    expect(() => parseCommunicationMessageRelease({
      ...withHtml,
      envelope: { ...withHtml.envelope, htmlBody: '<p>Tampered.</p>' }
    })).toThrow(new CommunicationMessageReleaseError('invalid_release'));
  });

  test('the store is append-only and refuses divergent re-puts of a release id', () => {
    const store = createInMemoryCommunicationMessageReleaseStore();
    const release = buildCommunicationMessageRelease(base);
    store.put(release);
    store.put(release);
    expect(() => store.put(buildCommunicationMessageRelease({
      ...base,
      textBody: 'Tampered body.'
    }))).toThrow(new CommunicationMessageReleaseError('release_conflict'));
  });

  test('the envelope resolver refuses any binding drift', () => {
    const store = createInMemoryCommunicationMessageReleaseStore();
    const release = buildCommunicationMessageRelease(base);
    store.put(release);
    const resolver = createReleaseStoreOutboundEmailEnvelopeResolver({ releases: store });
    expect(resolver.resolve({
      deliveryId: '019c1df7-86b5-769b-bba4-5f7097bfa941',
      releaseId: release.releaseId,
      recipientRefId: release.recipientRefId,
      templateRevisionRefId: release.templateRevisionRefId,
      contentRefId: release.contentRefId
    })).toEqual(release.envelope);
    expect(() => resolver.resolve({
      deliveryId: '019c1df7-86b5-769b-bba4-5f7097bfa941',
      releaseId: release.releaseId,
      recipientRefId: `rr1_${'b'.repeat(30)}`,
      templateRevisionRefId: release.templateRevisionRefId,
      contentRefId: release.contentRefId
    })).toThrow(new CommunicationMessageReleaseError('release_binding_mismatch'));
    expect(() => resolver.resolve({
      deliveryId: '019c1df7-86b5-769b-bba4-5f7097bfa941',
      releaseId: 'mrel1.missing',
      recipientRefId: release.recipientRefId,
      templateRevisionRefId: release.templateRevisionRefId,
      contentRefId: release.contentRefId
    })).toThrow(new CommunicationMessageReleaseError('release_not_found'));
  });
});
