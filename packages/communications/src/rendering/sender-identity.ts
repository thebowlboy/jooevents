import { encodeCanonicalJson } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { parseEmailAddress, type EmailAddress } from '../providers/port';

/**
 * Acceptance for the two workspace-editable pieces of outbound sender
 * presentation: the display name that reaches a `From:`/`Reply-To:` header and
 * the single reply-to address. The from-address itself is never here — it is
 * per-installation configuration, because moving it breaks SPF/DKIM alignment.
 *
 * These values cross into a mail header, so acceptance is a security boundary,
 * not formatting. The refused classes are exactly the ones the transactional
 * renderer already refuses in `assertLine` (C0/DEL controls, which include CR
 * and LF, plus the zero-width and bidi-override formatting block), widened by
 * the header-injection and unpaired-surrogate cases a stored, replayed value
 * can carry. Nothing is repaired: a refused value is refused with a code, never
 * silently stripped into a different value than the operator typed.
 */

/** The one downstream ceiling: `communicationSenderPresentationSchema` caps a display name at 200. */
export const SENDER_DISPLAY_NAME_MAXIMUM_LENGTH = 200;
export const SENDER_REPLY_TO_MAXIMUM_LENGTH = 320;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const BIDI_OR_ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u;
/**
 * A single mailbox only. Any address-list separator, angle-bracket group
 * syntax, or comment/quote delimiter would let one stored value expand into
 * several recipients or a second header field once a provider serializes it.
 */
const ADDRESS_LIST_OR_GROUP_SYNTAX = /[,;<>"()[\]\\]/u;

export const SENDER_DISPLAY_NAME_REFUSAL_CODES = [
  'display_name_empty',
  'display_name_too_long',
  'display_name_control_character',
  'display_name_bidi_or_zero_width',
  'display_name_unpaired_surrogate',
  'display_name_address_syntax'
] as const;
export type SenderDisplayNameRefusalCode = (typeof SENDER_DISPLAY_NAME_REFUSAL_CODES)[number];

export const SENDER_REPLY_TO_REFUSAL_CODES = [
  'reply_to_empty',
  'reply_to_too_long',
  'reply_to_control_character',
  'reply_to_bidi_or_zero_width',
  'reply_to_multiple_addresses',
  'reply_to_not_one_address'
] as const;
export type SenderReplyToRefusalCode = (typeof SENDER_REPLY_TO_REFUSAL_CODES)[number];

export type SenderIdentityRefusalCode =
  | SenderDisplayNameRefusalCode
  | SenderReplyToRefusalCode;

export type SenderDisplayNameAcceptance =
  | Readonly<{ kind: 'accepted'; value: string }>
  | Readonly<{ kind: 'refused'; code: SenderDisplayNameRefusalCode }>;

export type SenderReplyToAcceptance =
  | Readonly<{ kind: 'accepted'; value: EmailAddress }>
  | Readonly<{ kind: 'refused'; code: SenderReplyToRefusalCode }>;

function hasOnlyPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Accepts a workspace-authored sender display name. Surrounding ASCII spaces
 * are removed before acceptance — the only permitted repair, because it changes
 * no rendered character — and every other deviation refuses with its code.
 */
export function acceptSenderDisplayName(value: string): SenderDisplayNameAcceptance {
  const trimmed = value.trim();
  if (trimmed.length === 0) return Object.freeze({ kind: 'refused', code: 'display_name_empty' });
  if (trimmed.length > SENDER_DISPLAY_NAME_MAXIMUM_LENGTH) {
    return Object.freeze({ kind: 'refused', code: 'display_name_too_long' });
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return Object.freeze({ kind: 'refused', code: 'display_name_control_character' });
  }
  if (BIDI_OR_ZERO_WIDTH.test(trimmed)) {
    return Object.freeze({ kind: 'refused', code: 'display_name_bidi_or_zero_width' });
  }
  if (!hasOnlyPairedSurrogates(trimmed)) {
    return Object.freeze({ kind: 'refused', code: 'display_name_unpaired_surrogate' });
  }
  // A display name sits directly beside the address in the composed From
  // header, so address punctuation here is how a second mailbox gets smuggled
  // in: `Events <billing@elsewhere.test>` as a "name" renders a header with two
  // angle-addrs and lets a reader believe the wrong one. The reply-to path has
  // always refused this class; the name must refuse it for the same reason.
  if (ADDRESS_LIST_OR_GROUP_SYNTAX.test(trimmed)) {
    return Object.freeze({ kind: 'refused', code: 'display_name_address_syntax' });
  }
  return Object.freeze({ kind: 'accepted', value: trimmed });
}

/** Accepts exactly one reply-to mailbox; a list, a group, or a display form all refuse. */
export function acceptSenderReplyToAddress(value: string): SenderReplyToAcceptance {
  const trimmed = value.trim();
  if (trimmed.length === 0) return Object.freeze({ kind: 'refused', code: 'reply_to_empty' });
  if (trimmed.length > SENDER_REPLY_TO_MAXIMUM_LENGTH) {
    return Object.freeze({ kind: 'refused', code: 'reply_to_too_long' });
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return Object.freeze({ kind: 'refused', code: 'reply_to_control_character' });
  }
  if (BIDI_OR_ZERO_WIDTH.test(trimmed)) {
    return Object.freeze({ kind: 'refused', code: 'reply_to_bidi_or_zero_width' });
  }
  if (ADDRESS_LIST_OR_GROUP_SYNTAX.test(trimmed)) {
    return Object.freeze({ kind: 'refused', code: 'reply_to_multiple_addresses' });
  }
  let parsed: EmailAddress;
  try {
    parsed = parseEmailAddress(trimmed);
  } catch {
    return Object.freeze({ kind: 'refused', code: 'reply_to_not_one_address' });
  }
  return Object.freeze({ kind: 'accepted', value: parsed });
}

/** Installation-owned sender identity; the from-address is only ever from here. */
export interface InstallationMailSenderIdentity {
  readonly fromAddress: string;
  readonly fromDisplayName?: string;
  readonly replyToAddress?: string;
}

/** Workspace-editable overlay; an absent field means "keep the installation value". */
export interface WorkspaceMailSenderIdentity {
  readonly displayName: string | null;
  readonly replyToAddress: string | null;
}

export interface ResolvedMailSenderPresentation {
  readonly fromAddress: string;
  readonly fromDisplayName?: string;
  readonly replyToAddress?: string;
  /** `workspace` exactly when at least one workspace value overrode the installation value. */
  readonly source: 'installation' | 'workspace';
}

/**
 * Composes the presentation one send uses: the from-address is always the
 * installation's, and each of display name and reply-to is the workspace value
 * when set and the installation value otherwise. Callers resolve per send, not
 * per boot, so an edit takes effect on the next mail.
 */
export function resolveMailSenderPresentation(input: {
  readonly installation: InstallationMailSenderIdentity;
  readonly workspace: WorkspaceMailSenderIdentity | undefined;
}): ResolvedMailSenderPresentation {
  const displayName = input.workspace?.displayName ?? undefined;
  const replyToAddress = input.workspace?.replyToAddress ?? undefined;
  const resolvedDisplayName = displayName ?? input.installation.fromDisplayName;
  const resolvedReplyTo = replyToAddress ?? input.installation.replyToAddress;
  return Object.freeze({
    fromAddress: input.installation.fromAddress,
    ...(resolvedDisplayName === undefined ? {} : { fromDisplayName: resolvedDisplayName }),
    ...(resolvedReplyTo === undefined ? {} : { replyToAddress: resolvedReplyTo }),
    source: displayName === undefined && replyToAddress === undefined
      ? 'installation'
      : 'workspace'
  });
}

/**
 * The per-send seam both security-mail deliveries hold instead of a frozen
 * sender: every enqueue calls `resolve()` and composes the presentation it
 * returns, so a workspace edit lands on the next mail without a restart.
 */
export interface MailSenderPresentationResolver {
  resolve(): ResolvedMailSenderPresentation;
}

export interface ComposedCommunicationSenderPresentation {
  /** The exact `communicationSenderPresentationSchema` input for this send. */
  readonly sender: Readonly<{
    fromAddress: string;
    fromDisplayName?: string;
    replyToAddress?: string;
    senderProfileRevisionId: string;
    senderPresentationContractKey: string;
    senderPresentationContractVersion: number;
    senderPresentationDigestSha256: string;
  }>;
  readonly senderPresentationDigestSha256: string;
}

/**
 * Composes one send's sender presentation from a resolver call and pins it with
 * its own digest. The profile revision id names which sender profile a lane
 * uses; the digest is the exact per-send pin, so two sends of the same lane
 * under different workspace presentations are distinguishable in the ledger.
 */
export function composeCommunicationSenderPresentation(input: {
  readonly resolver: MailSenderPresentationResolver;
  readonly senderProfileRevisionId: string;
  readonly senderPresentationContractKey: string;
  readonly senderPresentationContractVersion: number;
}): ComposedCommunicationSenderPresentation {
  const resolved = input.resolver.resolve();
  const presentation = Object.freeze({
    fromAddress: resolved.fromAddress,
    ...(resolved.fromDisplayName === undefined
      ? {}
      : { fromDisplayName: resolved.fromDisplayName }),
    ...(resolved.replyToAddress === undefined
      ? {}
      : { replyToAddress: resolved.replyToAddress }),
    senderProfileRevisionId: input.senderProfileRevisionId,
    senderPresentationContractKey: input.senderPresentationContractKey,
    senderPresentationContractVersion: input.senderPresentationContractVersion
  });
  const senderPresentationDigestSha256 = bytesToHex(
    sha256(encodeCanonicalJson({ schemaVersion: 1, presentation }))
  );
  return Object.freeze({
    sender: Object.freeze({ ...presentation, senderPresentationDigestSha256 }),
    senderPresentationDigestSha256
  });
}
