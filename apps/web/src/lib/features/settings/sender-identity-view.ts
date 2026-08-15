/**
 * The Email section's view model: what the two boxes hold, whether they differ
 * from what is saved, what the next message's From line will read, and the
 * reviewed sentence for every refusal the operation can return.
 *
 * Copy is a closed vocabulary keyed by the server's refusal code. Codes never
 * reach a template: an outcome whose detail does not parse never becomes a
 * `refused` result, so there is no path from an unknown code to the screen.
 */

import {
	senderLine,
	type SenderIdentityField,
	type SenderIdentityReadResult,
	type SenderIdentitySaveResult,
	type SenderIdentitySource,
	type SenderIdentityUpdate,
	type SenderIdentityView
} from '$lib/api/sender-identity-settings-port';
import type { WorkspaceSenderIdentityRefusalCode } from '@jooevents/contracts';

export interface SenderIdentityDraft {
	displayName: string;
	replyToAddress: string;
}

/** The control each refusal pins to, so a sentence never floats free of its box. */
export const senderIdentityFieldControlId: Readonly<Record<SenderIdentityField, string>> =
	Object.freeze({
		display_name: 'settings-email-sender-name',
		reply_to_address: 'settings-email-reply-to'
	});

/** An unset workspace value shows the box empty; the placeholder names what is in force. */
export function senderIdentityDraft(view: SenderIdentityView): SenderIdentityDraft {
	return {
		displayName: view.displayName ?? '',
		replyToAddress: view.replyToAddress ?? ''
	};
}

/**
 * What the boxes propose. An empty box is a clear back to the installation
 * value, so it sends `null` — an empty string is a refusal, not a clear.
 */
export function senderIdentityUpdate(
	draft: SenderIdentityDraft,
	view: SenderIdentityView
): SenderIdentityUpdate {
	return {
		expectedHeadVersion: view.headVersion,
		displayName: draft.displayName.trim() || null,
		replyToAddress: draft.replyToAddress.trim() || null
	};
}

/**
 * Dirty compares the values that would be sent, not the raw text, so adding a
 * trailing space to a saved name does not offer a save that changes nothing.
 */
export function senderIdentityDirty(
	draft: SenderIdentityDraft,
	view: SenderIdentityView
): boolean {
	const proposed = senderIdentityUpdate(draft, view);
	return (
		proposed.displayName !== view.displayName ||
		proposed.replyToAddress !== view.replyToAddress
	);
}

export type SenderPreviewFrom =
	| { readonly kind: 'line'; readonly value: string }
	/** Clearing hands the name back to a value this read never disclosed. */
	| { readonly kind: 'undisclosed' };

export type SenderPreviewReplyTo =
	| { readonly kind: 'address'; readonly value: string }
	/** No reply-to of its own: replies return to the From address. */
	| { readonly kind: 'from' }
	| { readonly kind: 'undisclosed' };

export interface SenderPreview {
	readonly from: SenderPreviewFrom;
	readonly replyTo: SenderPreviewReplyTo;
	readonly source: SenderIdentitySource;
}

type PendingValue =
	| { readonly kind: 'set'; readonly value: string }
	| { readonly kind: 'installation'; readonly value: string | null }
	| { readonly kind: 'undisclosed' };

/**
 * What one box resolves to. An emptied box falls back to the installation's
 * value, which the read discloses only while the workspace has none of its
 * own: a set workspace value replaces it in `effective`, so a cleared-but-
 * unsaved box cannot name its replacement without inventing one.
 */
function pending(box: string, saved: string | null, effective: string | null): PendingValue {
	const typed = box.trim();
	if (typed) return { kind: 'set', value: typed };
	return saved === null ? { kind: 'installation', value: effective } : { kind: 'undisclosed' };
}

export function senderPreview(
	draft: SenderIdentityDraft,
	view: SenderIdentityView
): SenderPreview {
	const name = pending(draft.displayName, view.displayName, view.effective.fromDisplayName);
	const replyTo = pending(
		draft.replyToAddress,
		view.replyToAddress,
		view.effective.replyToAddress
	);
	return {
		from:
			name.kind === 'undisclosed'
				? { kind: 'undisclosed' }
				: { kind: 'line', value: senderLine(name.value, view.effective.fromAddress) },
		replyTo:
			replyTo.kind === 'undisclosed'
				? { kind: 'undisclosed' }
				: replyTo.value
					? { kind: 'address', value: replyTo.value }
					: { kind: 'from' },
		source: name.kind === 'set' || replyTo.kind === 'set' ? 'workspace' : 'installation'
	};
}

export interface SenderPreviewLines {
	readonly from: string;
	readonly replyTo: string;
}

/**
 * A value only the installation holds is named as such rather than guessed at:
 * a preview that invented the fallback would be the one thing this block is
 * for disproving.
 */
const UNDISCLOSED = 'Set by this installation — save to see it';

export function senderPreviewLines(preview: SenderPreview): SenderPreviewLines {
	return {
		from: preview.from.kind === 'line' ? preview.from.value : UNDISCLOSED,
		replyTo:
			preview.replyTo.kind === 'address'
				? preview.replyTo.value
				: preview.replyTo.kind === 'from'
					? 'Replies come back to the From address'
					: UNDISCLOSED
	};
}

/**
 * One sentence per refusal the operation declares. Every one names what the
 * value may be rather than what the check is called.
 */
const refusalSentences: Readonly<Record<WorkspaceSenderIdentityRefusalCode, string>> =
	Object.freeze({
		display_name_empty:
			'A sender name can’t be blank. Clear the field to use the installation’s name.',
		display_name_too_long: 'Sender names are limited to 200 characters.',
		display_name_control_character:
			'Sender names can’t contain line breaks or control characters.',
		display_name_bidi_or_zero_width:
			'Sender names can’t contain invisible or text-direction characters.',
		display_name_unpaired_surrogate:
			'That sender name contains a broken character. Retype it or paste it again.',
		display_name_address_syntax:
			'Sender names can’t contain email address punctuation like < > @ or commas — put the address in the reply-to field instead.',
		reply_to_empty:
			'A reply-to address can’t be blank. Clear the field to use the installation’s.',
		reply_to_too_long: 'Reply-to addresses are limited to 320 characters.',
		reply_to_control_character:
			'Reply-to addresses can’t contain line breaks or control characters.',
		reply_to_bidi_or_zero_width:
			'Reply-to addresses can’t contain invisible or text-direction characters.',
		reply_to_multiple_addresses:
			'Enter one reply-to address on its own — no name, brackets, or list.',
		reply_to_not_one_address: 'That isn’t a valid email address.'
	});

export function senderIdentityRefusalSentence(code: WorkspaceSenderIdentityRefusalCode): string {
	return refusalSentences[code];
}

/** Why the section could not be read, in product terms and with a next action. */
export function senderIdentityReadSentence(
	result: Exclude<SenderIdentityReadResult, { readonly kind: 'success' }>
): string {
	switch (result.kind) {
		case 'denied':
			return 'You don’t have access to this workspace’s email settings. Someone with email permissions can change them.';
		case 'unavailable':
			return 'Email settings are not available in this build.';
		case 'failure':
			return result.retryable
				? 'Email settings couldn’t be reached. Try again.'
				: 'Email settings couldn’t be loaded.';
	}
}

/**
 * Why a save did not land, for every arm but the field refusals — those are
 * pinned to their own box by `senderIdentityRefusalSentence`.
 */
export function senderIdentitySaveSentence(
	result: Exclude<SenderIdentitySaveResult, { readonly kind: 'saved' | 'refused' }>
): string {
	switch (result.kind) {
		case 'stale':
			return 'Someone else changed these settings. Reload to see the current values, then save again.';
		case 'in_progress':
			return 'Saving is already in progress. Try again in a moment.';
		case 'request_changed':
			return 'This save was retried with different values. Start the save again.';
		case 'intervened':
			return 'This change needs a person with email permissions to approve it before it can be saved.';
		case 'denied':
			return 'You no longer have permission to change these email settings.';
		case 'unavailable':
			return 'Saving email settings is not available in this build.';
		case 'failure':
			return result.retryable
				? 'The change couldn’t reach JooEvents. Nothing was saved — try again.'
				: 'The change couldn’t be saved.';
	}
}

/** The support code a failed read or save offers, when the server correlated one. */
export function senderIdentitySupportCode(
	result: SenderIdentityReadResult | SenderIdentitySaveResult
): string | undefined {
	return 'supportCode' in result ? result.supportCode : undefined;
}
