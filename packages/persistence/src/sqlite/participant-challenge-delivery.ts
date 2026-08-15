import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  PARTICIPANT_SIGN_IN_CHALLENGE_PURPOSE,
  type ParticipantChallengeDelivery,
  type ParticipantSignInLinkDeliveryEffect
} from '@jooevents/identity-access';
import {
  buildCommunicationMessageRelease,
  composeCommunicationSenderPresentation,
  renderTransactionalEmail,
  type MailSenderPresentationResolver
} from '@jooevents/communications';
import { outboundEmailDeliveryWorkInputSchema } from '@jooevents/contracts';
import { canonicalJsonText, encodeCanonicalJson } from '@jooevents/kernel';
import {
  insertOutboundEmailDeliveryRegistration,
  linkOutboundEmailDeliveryReceipt
} from './outbound-email-delivery';
import type { SQLiteCommunicationMessageReleaseStore } from './communications/message-releases';

/**
 * Registers one auth-owned `security_challenge` magic-link mail as durable
 * outbox work inside the caller's request transaction, through the exact
 * send-lane primitives the decision-notification lane already uses: an
 * immutable classified release (the only place the recipient address and the
 * raw link exist) plus an outbound-delivery ledger registration with its root
 * fact, dispatch outbox pointer, and delivery-history root.
 *
 * Nothing here awaits a provider. The already-composed dispatch worker picks
 * the pending delivery up later; while the provider seam is inert (D4), the
 * deterministic fake terminally rejects the sentinel external key and the
 * delivery history records an honest terminal not-delivered. No organizer
 * thread/message row is written — security mail has no organizer projection.
 */

/**
 * Sender presentation is resolved once per send, never frozen at composition:
 * the from-address is the installation's, while display name and reply-to may
 * be workspace settings that change between two sends of the same process.
 */
export type ParticipantChallengeSenderResolver = MailSenderPresentationResolver;

/**
 * Mirrors the Wave-3 send-lane posture for the not-yet-activated provider:
 * a sentinel external delivery key that is not a fake scenario key, so every
 * attempt lands `known_rejected_terminal`. The activation change replaces
 * these only by composing an explicit `providerRoute` (below); without one,
 * this inert posture is unchanged.
 */
export const PARTICIPANT_CHALLENGE_UNCONFIGURED_EXTERNAL_DELIVERY_KEY = 'provider.not-activated';
export const PARTICIPANT_CHALLENGE_UNCONFIGURED_PROVIDER_CONNECTION_REVISION_ID =
  'provider.connection.not-activated';

/**
 * Route to the one activated outbound provider connection. When composed, new
 * sign-in-link deliveries cite the active connection revision and carry a
 * deterministic per-challenge external delivery key instead of the sentinels.
 */
export interface ParticipantChallengeProviderRoute {
  readonly providerConnectionRevisionId: string;
}

const TEMPLATE_REVISION_REF_ID = 'template.participant-sign-in-link.v1';
const PRODUCT_NAME = 'JooEvents';
const SITE_URL = 'https://jooevents.com';
const SENDER_PROFILE_REVISION_ID = 'sender.profile.participant-auth.v1';
const SENDER_PRESENTATION_CONTRACT_KEY = 'sender.presentation.email-v1';
const SENDER_PRESENTATION_CONTRACT_VERSION = 1;
const ADDRESS_FINGERPRINT_PROFILE = 'fingerprint.participant-email.sha256';
const ADDRESS_FINGERPRINT_VERSION = 1;

function digest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function assertPortalOrigin(candidate: string): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError('participant_portal_origin_invalid');
  }
  if (parsed.origin !== candidate || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new TypeError('participant_portal_origin_invalid');
  }
  return parsed.origin;
}

export interface SQLiteParticipantChallengeDeliveryIds {
  newReleaseId(): string;
  newDeliveryId(): string;
  newEvidenceId(): string;
}

/** Renders the fixed security template; no merge fields beyond the link and TTL. */
export function renderParticipantSignInLinkMessage(input: {
  readonly portalOrigin: string;
  readonly linkToken: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}): {
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
  readonly linkUrl: string;
} {
  const origin = assertPortalOrigin(input.portalOrigin);
  const linkUrl = `${origin}/p/${encodeURIComponent(input.linkToken)}`;
  const validMinutes = Math.max(
    1,
    Math.round((Date.parse(input.expiresAt) - Date.parse(input.requestedAt)) / 60_000)
  );
  const subject = 'Your sign-in link';
  const { textBody, htmlBody } = renderTransactionalEmail({
    subject,
    preheader: `Your one-time link to sign in to ${PRODUCT_NAME}.`,
    heading: `Sign in to ${PRODUCT_NAME}`,
    intro: ['Use this link to sign in:'],
    button: { label: 'Sign in', url: linkUrl },
    nakedLink: linkUrl,
    smallPrint: [
      `The link is valid for ${validMinutes} minutes and works once.`,
      'Requesting a new link replaces this one.',
      'If you did not request it, you can ignore this email.'
    ],
    siteUrl: SITE_URL,
    productName: PRODUCT_NAME
  });
  return Object.freeze({ subject, textBody, htmlBody, linkUrl });
}

/**
 * Same contract as the auth-owned port, narrowed to also return the delivery
 * evidence id minted inside the enqueue transaction.
 */
export interface SQLiteParticipantChallengeDelivery extends ParticipantChallengeDelivery {
  enqueueSignInLink(
    effect: ParticipantSignInLinkDeliveryEffect
  ): { readonly deliveryId: string };
}

export function createSQLiteParticipantChallengeDelivery(input: {
  readonly sqlite: Database;
  readonly releases: SQLiteCommunicationMessageReleaseStore;
  readonly ids: SQLiteParticipantChallengeDeliveryIds;
  readonly senderResolver: ParticipantChallengeSenderResolver;
  readonly portalOrigin: string;
  /** Set-once backlink from the challenge row to its delivery evidence. */
  readonly challenges: {
    linkChallengeDelivery(link: { readonly challengeId: string; readonly deliveryId: string }): void;
  };
  readonly providerRoute?: ParticipantChallengeProviderRoute;
}): SQLiteParticipantChallengeDelivery {
  const portalOrigin = assertPortalOrigin(input.portalOrigin);
  return Object.freeze({
    enqueueSignInLink(
      effect: ParticipantSignInLinkDeliveryEffect
    ): { readonly deliveryId: string } {
      if (!input.sqlite.inTransaction) {
        throw new TypeError('participant_challenge_delivery_transaction_required');
      }
      if (
        effect.kind !== 'participant_sign_in_link'
        || effect.purpose !== PARTICIPANT_SIGN_IN_CHALLENGE_PURPOSE
      ) {
        throw new TypeError('participant_challenge_delivery_effect_invalid');
      }
      // Resolved here, inside the enqueue: the profile revision id names the
      // lane's sender profile, and the presentation digest is the exact
      // per-send pin the ledger and provider revalidation compare.
      const { sender, senderPresentationDigestSha256 } = composeCommunicationSenderPresentation({
        resolver: input.senderResolver,
        senderProfileRevisionId: SENDER_PROFILE_REVISION_ID,
        senderPresentationContractKey: SENDER_PRESENTATION_CONTRACT_KEY,
        senderPresentationContractVersion: SENDER_PRESENTATION_CONTRACT_VERSION
      });
      const message = renderParticipantSignInLinkMessage({
        portalOrigin,
        linkToken: effect.linkToken,
        requestedAt: effect.requestedAt,
        expiresAt: effect.expiresAt
      });
      const releaseId = input.ids.newReleaseId();
      const deliveryId = input.ids.newDeliveryId();
      const recipientRefId = `participant-challenge:${effect.challengeId}`;
      // The recipient identity of this lane is the challenge itself: at
      // request time no Person row may exist yet (the identity mints at
      // completion), and the address lives only inside the classified
      // envelope, so all recipient refs are challenge-scoped opaque ids.
      const release = buildCommunicationMessageRelease({
        workspaceId: effect.lane.workspaceId,
        eventId: effect.lane.eventId,
        releaseId,
        batchId: `participant-sign-in.${effect.challengeId}`,
        recipientRefId,
        personRefId: recipientRefId,
        contactRefId: recipientRefId,
        templateRevisionRefId: TEMPLATE_REVISION_REF_ID,
        contentRefId: `content.participant-sign-in-link:${effect.challengeId}`,
        purposeKey: PARTICIPANT_SIGN_IN_CHALLENGE_PURPOSE,
        reviewedMessageDigestSha256: digest({
          schemaVersion: 2,
          subject: message.subject,
          textBody: message.textBody,
          htmlBody: message.htmlBody
        }),
        sender,
        toAddress: effect.recipientEmail,
        subject: message.subject,
        textBody: message.textBody,
        htmlBody: message.htmlBody,
        createdAt: effect.requestedAt
      });
      input.releases.put(release);

      const work = outboundEmailDeliveryWorkInputSchema.parse({
        contractVersion: 1,
        deliveryId,
        releaseId,
        dispatchGeneration: 1,
        reviewedMessageDigestSha256: release.reviewedMessageDigestSha256,
        reviewedEnvelopeDigestSha256: release.reviewedEnvelopeDigestSha256,
        recipientRefId,
        templateRevisionRefId: TEMPLATE_REVISION_REF_ID,
        contentRefId: release.contentRefId,
        providerConnectionRevisionId: input.providerRoute?.providerConnectionRevisionId
          ?? PARTICIPANT_CHALLENGE_UNCONFIGURED_PROVIDER_CONNECTION_REVISION_ID,
        externalDeliveryKey: input.providerRoute === undefined
          ? PARTICIPANT_CHALLENGE_UNCONFIGURED_EXTERNAL_DELIVERY_KEY
          : `participant-sign-in.${effect.challengeId}`,
        senderProfileRevisionId: SENDER_PROFILE_REVISION_ID,
        senderPresentationContractKey: SENDER_PRESENTATION_CONTRACT_KEY,
        senderPresentationContractVersion: SENDER_PRESENTATION_CONTRACT_VERSION,
        senderPresentationDigestSha256,
        channelAddressId: `channel-address.participant-challenge:${effect.challengeId}`,
        channelAddressVersion: 1,
        addressLookupFingerprintProfile: ADDRESS_FINGERPRINT_PROFILE,
        addressLookupFingerprintVersion: ADDRESS_FINGERPRINT_VERSION,
        addressLookupFingerprintSha256: digest({
          profile: ADDRESS_FINGERPRINT_PROFILE,
          version: ADDRESS_FINGERPRINT_VERSION,
          address: effect.recipientEmail.trim().toLowerCase()
        })
      });
      insertOutboundEmailDeliveryRegistration({
        sqlite: input.sqlite,
        workspaceId: effect.lane.workspaceId,
        eventId: effect.lane.eventId,
        work,
        evidence: {
          rootFactId: input.ids.newEvidenceId(),
          rootPointerId: input.ids.newEvidenceId(),
          historyThreadId: input.ids.newEvidenceId(),
          rootHistoryId: input.ids.newEvidenceId()
        },
        createdAt: effect.requestedAt
      });
      const head = input.sqlite.query<{
        readonly root_fact_id: string;
        readonly root_outbox_pointer_id: string;
        readonly history_thread_id: string;
        readonly root_history_id: string;
      }, [string]>(`
        SELECT root_fact_id, root_outbox_pointer_id, history_thread_id, root_history_id
          FROM communication_outbound_delivery_heads WHERE delivery_id = ?
      `).get(deliveryId);
      if (!head) throw new TypeError('participant_challenge_delivery_registration_missing');
      const occurredAtMs = Date.parse(effect.requestedAt);
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_facts (
          fact_id, receipt_id, workspace_id, event_id, delivery_id,
          fact_kind, fact_version, payload_json, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'outbound_email_delivery_requested', 1, ?, ?)
      `).run(
        head.root_fact_id, effect.receiptId, effect.lane.workspaceId, effect.lane.eventId,
        deliveryId,
        canonicalJsonText({
          contractVersion: 1,
          purpose: PARTICIPANT_SIGN_IN_CHALLENGE_PURPOSE,
          challengeId: effect.challengeId,
          releaseId,
          reviewedMessageDigestSha256: work.reviewedMessageDigestSha256,
          reviewedEnvelopeDigestSha256: work.reviewedEnvelopeDigestSha256,
          recipientRefId,
          templateRevisionRefId: TEMPLATE_REVISION_REF_ID,
          contentRefId: work.contentRefId
        }),
        occurredAtMs
      );
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_outbox (
          pointer_id, receipt_id, fact_id, delivery_id, purpose, created_at_ms
        ) VALUES (?, ?, ?, ?, 'communication.outbound-email.dispatch', ?)
      `).run(
        head.root_outbox_pointer_id, effect.receiptId, head.root_fact_id, deliveryId, occurredAtMs
      );
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_history (
          history_id, thread_id, sequence, receipt_id, fact_id, delivery_id,
          attempt_id, parent_history_id, summary_code, occurred_at_ms
        ) VALUES (?, ?, 0, ?, ?, ?, NULL, NULL, 'communication.outbound-email.requested', ?)
      `).run(
        head.root_history_id, head.history_thread_id, effect.receiptId, head.root_fact_id,
        deliveryId, occurredAtMs
      );
      linkOutboundEmailDeliveryReceipt({
        sqlite: input.sqlite,
        deliveryId,
        receiptId: effect.receiptId
      });
      input.challenges.linkChallengeDelivery({ challengeId: effect.challengeId, deliveryId });
      return Object.freeze({ deliveryId });
    }
  });
}
