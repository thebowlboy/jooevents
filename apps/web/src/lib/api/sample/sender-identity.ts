import {
	workspaceSenderIdentitySchema,
	type StructuredOutcome,
	type WorkspaceSenderIdentityDto,
	type WorkspaceSenderIdentityRefusalCode
} from '@jooevents/contracts';
import { senderLine } from '../sender-identity-settings-port';

/**
 * The sample stand-in for the two mounted sender-identity operations.
 *
 * It is a fiction of the server, so it owns the same acceptance rules: the
 * header-safety checks are what make a refusal a refusal, and a sample that
 * accepted a name with a line break in it would let the Email section be built
 * against behaviour no live workspace has. Every answer is validated against
 * the served contract before it leaves here, so the fiction cannot drift into
 * a shape the live read would never produce.
 *
 * The from-address is a constant because it is installation configuration:
 * outbound mail is signed for it, so no workspace may move it.
 */

const INSTALLATION_FROM_ADDRESS = 'program@aie-demo.example';

/** This installation configures no reply-to, so replies return to the From address. */
const INSTALLATION_REPLY_TO: string | null = null;

const DISPLAY_NAME_MAX = 200;
const REPLY_TO_MAX = 320;

/** The characters that turn one reply-to into an address list or a named mailbox. */
const ADDRESS_LIST_PUNCTUATION = /[,;<>]/;
const ONE_ADDRESS = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** C0 and C1, DEL included: the bytes that let a value open a second header. */
function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

/**
 * Zero-width and text-direction marks. They render as nothing or reverse what
 * the reader sees, so a name carrying one can present an address it does not
 * hold.
 */
const INVISIBLE_CODE_POINTS: ReadonlySet<number> = new Set([
	0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
	0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
	0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
	0x2066, 0x2067, 0x2068, 0x2069,
	0xfeff
]);

function hasBidiOrZeroWidth(value: string): boolean {
	for (const character of value) {
		if (INVISIBLE_CODE_POINTS.has(character.codePointAt(0) ?? 0)) return true;
	}
	return false;
}

/** A half of a surrogate pair encodes to a replacement byte on the wire. */
function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

export type SampleSenderIdentityUpdate = {
	readonly expectedHeadVersion: number;
	readonly displayName: string | null;
	readonly replyToAddress: string | null;
};

export type SampleSenderIdentityResult =
	| { readonly kind: 'success'; readonly data: WorkspaceSenderIdentityDto }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome };

export interface SampleSenderIdentityStore {
	read(): WorkspaceSenderIdentityDto;
	update(input: SampleSenderIdentityUpdate): SampleSenderIdentityResult;
	/** The From line the sample's own message previews quote. */
	line(): string;
}

function refusal(
	field: 'display_name' | 'reply_to_address',
	code: WorkspaceSenderIdentityRefusalCode
): StructuredOutcome {
	return {
		class: 'policy_violation',
		kind: 'communication.sender_identity_refused',
		retryable: false,
		subjects: [],
		detail: { field, code },
		detailSchemaVersion: 1
	};
}

function stale(headVersion: number): StructuredOutcome {
	return {
		class: 'stale_revision',
		kind: 'communication.sender_identity_changed',
		retryable: false,
		subjects: [],
		detail: { code: 'head_version_changed', headVersion },
		detailSchemaVersion: 1
	};
}

type Accepted =
	| { readonly ok: true; readonly value: string | null }
	| { readonly ok: false; readonly code: WorkspaceSenderIdentityRefusalCode };

/** Trimming is the one repair; every other rule refuses rather than sanitises. */
function acceptDisplayName(raw: string | null): Accepted {
	if (raw === null) return { ok: true, value: null };
	const value = raw.trim();
	if (!value) return { ok: false, code: 'display_name_empty' };
	if (value.length > DISPLAY_NAME_MAX) return { ok: false, code: 'display_name_too_long' };
	if (hasControlCharacter(value)) return { ok: false, code: 'display_name_control_character' };
	if (hasBidiOrZeroWidth(value)) return { ok: false, code: 'display_name_bidi_or_zero_width' };
	if (hasUnpairedSurrogate(value)) return { ok: false, code: 'display_name_unpaired_surrogate' };
	// A name sitting beside the address must not carry address punctuation, or
	// it smuggles a second mailbox into the composed From header.
	if (/[,;<>"()[\]\\]/u.test(value)) return { ok: false, code: 'display_name_address_syntax' };
	return { ok: true, value };
}

function acceptReplyTo(raw: string | null): Accepted {
	if (raw === null) return { ok: true, value: null };
	const value = raw.trim();
	if (!value) return { ok: false, code: 'reply_to_empty' };
	if (value.length > REPLY_TO_MAX) return { ok: false, code: 'reply_to_too_long' };
	if (hasControlCharacter(value)) return { ok: false, code: 'reply_to_control_character' };
	if (hasBidiOrZeroWidth(value)) return { ok: false, code: 'reply_to_bidi_or_zero_width' };
	if (ADDRESS_LIST_PUNCTUATION.test(value)) {
		return { ok: false, code: 'reply_to_multiple_addresses' };
	}
	if (!ONE_ADDRESS.test(value)) return { ok: false, code: 'reply_to_not_one_address' };
	return { ok: true, value };
}

export function createSampleSenderIdentityStore(input: {
	/** What this installation is configured to sign its mail as. */
	readonly installationDisplayName: () => string | null;
}): SampleSenderIdentityStore {
	let headVersion = 1;
	let displayName: string | null = null;
	let replyToAddress: string | null = null;
	let updatedAt: string | null = null;

	function current(): WorkspaceSenderIdentityDto {
		return workspaceSenderIdentitySchema.parse({
			schemaVersion: 1,
			workspaceId: 'workspace.sample',
			headVersion,
			displayName,
			replyToAddress,
			effective: {
				fromAddress: INSTALLATION_FROM_ADDRESS,
				fromDisplayName: displayName ?? input.installationDisplayName(),
				replyToAddress: replyToAddress ?? INSTALLATION_REPLY_TO,
				source: displayName !== null || replyToAddress !== null ? 'workspace' : 'installation'
			},
			updatedAt
		});
	}

	return Object.freeze({
		read: current,
		update(proposal: SampleSenderIdentityUpdate): SampleSenderIdentityResult {
			if (proposal.expectedHeadVersion !== headVersion) {
				return { kind: 'outcome', outcome: stale(headVersion) };
			}
			const name = acceptDisplayName(proposal.displayName);
			if (!name.ok) return { kind: 'outcome', outcome: refusal('display_name', name.code) };
			const reply = acceptReplyTo(proposal.replyToAddress);
			if (!reply.ok) {
				return { kind: 'outcome', outcome: refusal('reply_to_address', reply.code) };
			}
			displayName = name.value;
			replyToAddress = reply.value;
			headVersion += 1;
			updatedAt = new Date().toISOString();
			return { kind: 'success', data: current() };
		},
		line(): string {
			const identity = current();
			return senderLine(identity.effective.fromDisplayName, identity.effective.fromAddress);
		}
	});
}
