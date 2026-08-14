import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { normalizeEmail } from '@jooevents/identity-access';
import { buildCommunicationMessageRelease } from '@jooevents/communications';
import { outboundEmailDeliveryWorkInputSchema } from '@jooevents/contracts';
import { canonicalJsonText, encodeCanonicalJson } from '@jooevents/kernel';
import {
  insertOutboundEmailDeliveryRegistration,
  linkOutboundEmailDeliveryReceipt
} from './outbound-email-delivery';
import type { SQLiteCommunicationMessageReleaseStore } from './communications/message-releases';

/**
 * The workspace-User magic-link lane (owner revision, 2026-08-14: registered
 * or reserved). Two pieces live here: the eligibility decision — a link is
 * issued only when the normalized address is a verified address of exactly one
 * active, ready-linked User, or is named by exactly one open access
 * reservation — and the durable outbox registration of the link mail through
 * the same send-lane primitives the participant challenge lane uses. Neither
 * piece answers differently to the browser: a denied address produces no
 * durable work and the HTTP surface stays byte-uniform.
 */

export const WORKSPACE_SIGN_IN_LINK_PURPOSE = 'workspace.sign-in-link';
export const WORKSPACE_SIGN_IN_LINK_TEMPLATE_REVISION_REF_ID =
  'template.workspace-sign-in-link.v1';

const SENDER_PROFILE_REVISION_ID = 'sender.profile.workspace-auth.v1';
const SENDER_PRESENTATION_CONTRACT_KEY = 'sender.presentation.email-v1';
const SENDER_PRESENTATION_CONTRACT_VERSION = 1;
const ADDRESS_FINGERPRINT_PROFILE = 'fingerprint.workspace-email.sha256';
const ADDRESS_FINGERPRINT_VERSION = 1;

export const WORKSPACE_SIGN_IN_LINK_UNCONFIGURED_EXTERNAL_DELIVERY_KEY =
  'provider.not-activated';
export const WORKSPACE_SIGN_IN_LINK_UNCONFIGURED_PROVIDER_CONNECTION_REVISION_ID =
  'provider.connection.not-activated';

function digest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

/** Deterministic address fingerprint for oracle-free ledger lookups. */
export function workspaceSignInLinkAddressFingerprint(email: string): string {
  return digest({
    profile: ADDRESS_FINGERPRINT_PROFILE,
    version: ADDRESS_FINGERPRINT_VERSION,
    address: email.trim().toLowerCase()
  });
}

/**
 * Decides whether this address may receive a workspace sign-in link. The
 * decision is server-private: callers must answer the browser identically
 * either way. Exactly-one is load-bearing — zero, ambiguous, unverified,
 * inactive, and not-ready matches all deny.
 */
export function decideWorkspaceSignInLinkEligibility(input: {
  readonly sqlite: Database;
  readonly workspaceId: string;
  readonly email: string;
}): { readonly eligible: boolean } {
  const normalized = normalizeEmail(input.email);
  if (normalized.length < 3 || !normalized.includes('@')) return { eligible: false };

  // Registered: a verified auth address whose ready link lands on exactly one
  // active User. Candidates come back by case-folded compare; the canonical
  // normalizer confirms in code so SQL folding never widens the match.
  const registered = input.sqlite.query<{ readonly email: string }, [string]>(`
    SELECT au.email AS email
      FROM auth_users au
      JOIN auth_user_links l ON l.auth_user_id = au.id AND l.provisioning_state = 'ready'
      JOIN users u ON u.id = l.user_id AND u.status = 'active'
     WHERE au.email_verified = 1 AND lower(au.email) = lower(?)
  `).all(normalized).filter((row) => normalizeEmail(row.email) === normalized);
  if (registered.length === 1) return { eligible: true };
  if (registered.length > 1) return { eligible: false };

  const reservations = input.sqlite.query<{ readonly id: string }, [string, string]>(`
    SELECT id FROM access_reservations
     WHERE workspace_id = ? AND normalized_email = ? AND status = 'open'
  `).all(input.workspaceId, normalized);
  return { eligible: reservations.length === 1 };
}

/** Per-installation sender identity; composed from deployment configuration, never hardcoded. */
export interface WorkspaceSignInLinkSenderConfig {
  readonly fromAddress: string;
  readonly fromDisplayName?: string;
  readonly replyToAddress?: string;
}

export interface WorkspaceSignInLinkProviderRoute {
  readonly providerConnectionRevisionId: string;
}

export interface WorkspaceSignInLinkDeliveryIds {
  newReleaseId(): string;
  newDeliveryId(): string;
  newEvidenceId(): string;
}

export interface WorkspaceSignInLinkDeliveryEffect {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly requestId: string;
  readonly recipientEmail: string;
  /** The complete verification URL the auth layer built; rendered verbatim. */
  readonly linkUrl: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

/** Renders the fixed security-template text; no merge fields beyond the link and TTL. */
export function renderWorkspaceSignInLinkMessage(input: {
  readonly linkUrl: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}): { readonly subject: string; readonly textBody: string } {
  const parsed = new URL(input.linkUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('workspace_sign_in_link_url_invalid');
  }
  const validMinutes = Math.max(
    1,
    Math.round((Date.parse(input.expiresAt) - Date.parse(input.requestedAt)) / 60_000)
  );
  const subject = 'Your sign-in link';
  const textBody = [
    'Use this link to sign in:',
    '',
    parsed.toString(),
    '',
    `The link is valid for ${validMinutes} minutes and works once.`,
    'Requesting a new link replaces this one.',
    'If you did not request it, you can ignore this email.'
  ].join('\n');
  return Object.freeze({ subject, textBody });
}

export interface WorkspaceSignInLinkDelivery {
  enqueueSignInLink(effect: WorkspaceSignInLinkDeliveryEffect): void;
}

export function createSQLiteWorkspaceSignInLinkDelivery(input: {
  readonly sqlite: Database;
  readonly releases: SQLiteCommunicationMessageReleaseStore;
  readonly ids: WorkspaceSignInLinkDeliveryIds;
  readonly sender: WorkspaceSignInLinkSenderConfig;
  readonly providerRoute?: WorkspaceSignInLinkProviderRoute;
}): WorkspaceSignInLinkDelivery {
  const senderPresentation = Object.freeze({
    fromAddress: input.sender.fromAddress,
    ...(input.sender.fromDisplayName === undefined
      ? {}
      : { fromDisplayName: input.sender.fromDisplayName }),
    ...(input.sender.replyToAddress === undefined
      ? {}
      : { replyToAddress: input.sender.replyToAddress }),
    senderProfileRevisionId: SENDER_PROFILE_REVISION_ID,
    senderPresentationContractKey: SENDER_PRESENTATION_CONTRACT_KEY,
    senderPresentationContractVersion: SENDER_PRESENTATION_CONTRACT_VERSION
  });
  const senderPresentationDigestSha256 = digest({
    schemaVersion: 1,
    presentation: senderPresentation
  });
  const sender = Object.freeze({ ...senderPresentation, senderPresentationDigestSha256 });

  return Object.freeze({
    enqueueSignInLink(effect: WorkspaceSignInLinkDeliveryEffect): void {
      if (!input.sqlite.inTransaction) {
        throw new TypeError('workspace_sign_in_link_delivery_transaction_required');
      }
      const message = renderWorkspaceSignInLinkMessage({
        linkUrl: effect.linkUrl,
        requestedAt: effect.requestedAt,
        expiresAt: effect.expiresAt
      });
      const releaseId = input.ids.newReleaseId();
      const deliveryId = input.ids.newDeliveryId();
      // The recipient identity of this lane is the request itself: the address
      // lives only inside the classified envelope, so all recipient refs are
      // request-scoped opaque ids, and the receipt ref carries the same scope.
      const recipientRefId = `workspace-sign-in:${effect.requestId}`;
      const receiptId = recipientRefId;
      const release = buildCommunicationMessageRelease({
        workspaceId: effect.workspaceId,
        eventId: effect.eventId,
        releaseId,
        batchId: `workspace-sign-in.${effect.requestId}`,
        recipientRefId,
        personRefId: recipientRefId,
        contactRefId: recipientRefId,
        templateRevisionRefId: WORKSPACE_SIGN_IN_LINK_TEMPLATE_REVISION_REF_ID,
        contentRefId: `content.workspace-sign-in-link:${effect.requestId}`,
        purposeKey: WORKSPACE_SIGN_IN_LINK_PURPOSE,
        reviewedMessageDigestSha256: digest({
          schemaVersion: 1,
          subject: message.subject,
          textBody: message.textBody
        }),
        sender,
        toAddress: effect.recipientEmail,
        subject: message.subject,
        textBody: message.textBody,
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
        templateRevisionRefId: WORKSPACE_SIGN_IN_LINK_TEMPLATE_REVISION_REF_ID,
        contentRefId: release.contentRefId,
        providerConnectionRevisionId: input.providerRoute?.providerConnectionRevisionId
          ?? WORKSPACE_SIGN_IN_LINK_UNCONFIGURED_PROVIDER_CONNECTION_REVISION_ID,
        externalDeliveryKey: input.providerRoute === undefined
          ? WORKSPACE_SIGN_IN_LINK_UNCONFIGURED_EXTERNAL_DELIVERY_KEY
          : `workspace-sign-in.${effect.requestId}`,
        senderProfileRevisionId: SENDER_PROFILE_REVISION_ID,
        senderPresentationContractKey: SENDER_PRESENTATION_CONTRACT_KEY,
        senderPresentationContractVersion: SENDER_PRESENTATION_CONTRACT_VERSION,
        senderPresentationDigestSha256,
        channelAddressId: `channel-address.workspace-sign-in:${effect.requestId}`,
        channelAddressVersion: 1,
        addressLookupFingerprintProfile: ADDRESS_FINGERPRINT_PROFILE,
        addressLookupFingerprintVersion: ADDRESS_FINGERPRINT_VERSION,
        addressLookupFingerprintSha256: workspaceSignInLinkAddressFingerprint(
          effect.recipientEmail
        )
      });
      insertOutboundEmailDeliveryRegistration({
        sqlite: input.sqlite,
        workspaceId: effect.workspaceId,
        eventId: effect.eventId,
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
      if (!head) throw new TypeError('workspace_sign_in_link_registration_missing');
      const occurredAtMs = Date.parse(effect.requestedAt);
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_facts (
          fact_id, receipt_id, workspace_id, event_id, delivery_id,
          fact_kind, fact_version, payload_json, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'outbound_email_delivery_requested', 1, ?, ?)
      `).run(
        head.root_fact_id, receiptId, effect.workspaceId, effect.eventId, deliveryId,
        canonicalJsonText({
          contractVersion: 1,
          purpose: WORKSPACE_SIGN_IN_LINK_PURPOSE,
          requestId: effect.requestId,
          releaseId,
          reviewedMessageDigestSha256: work.reviewedMessageDigestSha256,
          reviewedEnvelopeDigestSha256: work.reviewedEnvelopeDigestSha256,
          recipientRefId,
          templateRevisionRefId: WORKSPACE_SIGN_IN_LINK_TEMPLATE_REVISION_REF_ID,
          contentRefId: work.contentRefId
        }),
        occurredAtMs
      );
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_outbox (
          pointer_id, receipt_id, fact_id, delivery_id, purpose, created_at_ms
        ) VALUES (?, ?, ?, ?, 'communication.outbound-email.dispatch', ?)
      `).run(
        head.root_outbox_pointer_id, receiptId, head.root_fact_id, deliveryId, occurredAtMs
      );
      input.sqlite.query(`
        INSERT INTO communication_outbound_delivery_history (
          history_id, thread_id, sequence, receipt_id, fact_id, delivery_id,
          attempt_id, parent_history_id, summary_code, occurred_at_ms
        ) VALUES (?, ?, 0, ?, ?, ?, NULL, NULL, 'communication.outbound-email.requested', ?)
      `).run(
        head.root_history_id, head.history_thread_id, receiptId, head.root_fact_id,
        deliveryId, occurredAtMs
      );
      linkOutboundEmailDeliveryReceipt({
        sqlite: input.sqlite,
        deliveryId,
        receiptId
      });
    }
  });
}
