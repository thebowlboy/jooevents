import { describe, expect, test } from 'bun:test';
import { WORKSPACE_SENDER_IDENTITY_REFUSAL_CODES } from '@jooevents/contracts';
import {
	senderLine,
	type SenderIdentityView
} from '$lib/api/sender-identity-settings-port';
import {
	senderIdentityDirty,
	senderIdentityDraft,
	senderIdentityFieldControlId,
	senderIdentityReadSentence,
	senderIdentityRefusalSentence,
	senderIdentitySaveSentence,
	senderIdentitySupportCode,
	senderIdentityUpdate,
	senderPreview,
	senderPreviewLines
} from './sender-identity-view';

const FROM = 'program@aie-demo.example';

/** Nothing set for the workspace: the installation's name is in force. */
const untouched: SenderIdentityView = {
	headVersion: 1,
	displayName: null,
	replyToAddress: null,
	effective: {
		fromAddress: FROM,
		fromDisplayName: 'JooEvents',
		replyToAddress: null,
		source: 'installation'
	}
};

/** Both values set for the workspace, so `effective` echoes them back. */
const overridden: SenderIdentityView = {
	headVersion: 4,
	displayName: 'Deep Dish Conf',
	replyToAddress: 'program@deepdish.example',
	effective: {
		fromAddress: FROM,
		fromDisplayName: 'Deep Dish Conf',
		replyToAddress: 'program@deepdish.example',
		source: 'workspace'
	}
};

describe('the sender line', () => {
	test('is Name <address> when a name is in force and the address alone otherwise', () => {
		expect(senderLine('Deep Dish Conf', FROM)).toBe(`Deep Dish Conf <${FROM}>`);
		expect(senderLine(null, FROM)).toBe(FROM);
	});
});

describe('the draft', () => {
	test('shows an unset workspace value as an empty box', () => {
		expect(senderIdentityDraft(untouched)).toEqual({ displayName: '', replyToAddress: '' });
		expect(senderIdentityDraft(overridden)).toEqual({
			displayName: 'Deep Dish Conf',
			replyToAddress: 'program@deepdish.example'
		});
	});

	test('sends an emptied box as a clear, never as an empty string', () => {
		expect(senderIdentityUpdate({ displayName: '  ', replyToAddress: '' }, overridden)).toEqual({
			expectedHeadVersion: 4,
			displayName: null,
			replyToAddress: null
		});
	});

	test('proposes the head version it was read at, so a save is an optimistic commit', () => {
		expect(
			senderIdentityUpdate({ displayName: 'Deep Dish Conf', replyToAddress: '' }, untouched)
				.expectedHeadVersion
		).toBe(1);
	});
});

describe('dirty tracking', () => {
	test('compares the values that would be sent, not the raw text', () => {
		expect(senderIdentityDirty(senderIdentityDraft(untouched), untouched)).toBe(false);
		expect(senderIdentityDirty(senderIdentityDraft(overridden), overridden)).toBe(false);
		// Whitespace alone changes nothing, so it must not offer a save.
		expect(
			senderIdentityDirty(
				{ displayName: '  Deep Dish Conf  ', replyToAddress: 'program@deepdish.example' },
				overridden
			)
		).toBe(false);
	});

	test('is true for a changed value and for a cleared one', () => {
		expect(senderIdentityDirty({ displayName: 'Other', replyToAddress: '' }, untouched)).toBe(true);
		expect(
			senderIdentityDirty(
				{ displayName: '', replyToAddress: 'program@deepdish.example' },
				overridden
			)
		).toBe(true);
	});
});

describe('the preview', () => {
	test('quotes the installation values while the workspace has set none', () => {
		const preview = senderPreview(senderIdentityDraft(untouched), untouched);

		expect(preview.source).toBe('installation');
		expect(senderPreviewLines(preview)).toEqual({
			from: `JooEvents <${FROM}>`,
			replyTo: 'Replies come back to the From address'
		});
	});

	test('follows the boxes as they are typed, before anything is saved', () => {
		const preview = senderPreview(
			{ displayName: '  Deep Dish Conf  ', replyToAddress: ' talks@deepdish.example ' },
			untouched
		);

		expect(preview.source).toBe('workspace');
		expect(senderPreviewLines(preview)).toEqual({
			from: `Deep Dish Conf <${FROM}>`,
			replyTo: 'talks@deepdish.example'
		});
	});

	test('never invents the fallback a cleared workspace value hands back', () => {
		// `effective` echoes the workspace value while one is set, so the
		// installation's own is not in this read to be shown.
		const preview = senderPreview({ displayName: '', replyToAddress: '' }, overridden);

		expect(preview.from).toEqual({ kind: 'undisclosed' });
		expect(preview.replyTo).toEqual({ kind: 'undisclosed' });
		expect(senderPreviewLines(preview)).toEqual({
			from: 'Set by this installation — save to see it',
			replyTo: 'Set by this installation — save to see it'
		});
	});

	test('reads an unnamed installation as the bare address', () => {
		const unnamed: SenderIdentityView = {
			...untouched,
			effective: { ...untouched.effective, fromDisplayName: null }
		};

		expect(senderPreviewLines(senderPreview(senderIdentityDraft(unnamed), unnamed)).from).toBe(FROM);
	});

	test('is workspace-sourced as soon as either box holds a value', () => {
		expect(
			senderPreview({ displayName: '', replyToAddress: 'talks@deepdish.example' }, untouched)
				.source
		).toBe('workspace');
	});
});

describe('refusal copy', () => {
	test('answers every code the operation can refuse with', () => {
		for (const code of WORKSPACE_SENDER_IDENTITY_REFUSAL_CODES) {
			expect(senderIdentityRefusalSentence(code).length).toBeGreaterThan(0);
		}
	});

	test('reads as guidance about the value, never as the code or the check', () => {
		const sentences = WORKSPACE_SENDER_IDENTITY_REFUSAL_CODES.map(senderIdentityRefusalSentence);

		for (const [index, sentence] of sentences.entries()) {
			expect(sentence).not.toContain(WORKSPACE_SENDER_IDENTITY_REFUSAL_CODES[index] as string);
			expect(sentence).not.toContain('_');
			expect(sentence.endsWith('.')).toBe(true);
		}
		expect(new Set(sentences).size).toBe(sentences.length);
	});

	test('says what to do about a header-injection attempt in plain words', () => {
		expect(senderIdentityRefusalSentence('reply_to_multiple_addresses')).toBe(
			'Enter one reply-to address on its own — no name, brackets, or list.'
		);
		expect(senderIdentityRefusalSentence('display_name_control_character')).toBe(
			'Sender names can’t contain line breaks or control characters.'
		);
		expect(senderIdentityRefusalSentence('reply_to_not_one_address')).toBe(
			'That isn’t a valid email address.'
		);
	});

	test('pins each field to the control that caused it', () => {
		expect(senderIdentityFieldControlId.display_name).toBe('settings-email-sender-name');
		expect(senderIdentityFieldControlId.reply_to_address).toBe('settings-email-reply-to');
	});
});

describe('failure copy', () => {
	test('gives every read failure a sentence with a next step', () => {
		expect(senderIdentityReadSentence({ kind: 'denied' })).toContain('don’t have access');
		expect(senderIdentityReadSentence({ kind: 'unavailable' })).toContain('not available');
		expect(senderIdentityReadSentence({ kind: 'failure', retryable: true })).toContain('Try again');
		expect(senderIdentityReadSentence({ kind: 'failure', retryable: false })).not.toContain(
			'Try again'
		);
	});

	test('gives every non-field save failure its own sentence', () => {
		const sentences = [
			senderIdentitySaveSentence({ kind: 'stale', headVersion: 3 }),
			senderIdentitySaveSentence({ kind: 'in_progress' }),
			senderIdentitySaveSentence({ kind: 'request_changed' }),
			senderIdentitySaveSentence({ kind: 'intervened' }),
			senderIdentitySaveSentence({ kind: 'denied' }),
			senderIdentitySaveSentence({ kind: 'unavailable' }),
			senderIdentitySaveSentence({ kind: 'failure', retryable: true }),
			senderIdentitySaveSentence({ kind: 'failure', retryable: false })
		];

		expect(new Set(sentences).size).toBe(sentences.length);
		for (const sentence of sentences) {
			expect(sentence).not.toContain('_');
			expect(sentence.endsWith('.')).toBe(true);
		}
	});

	test('offers a support code only where the server correlated one', () => {
		expect(senderIdentitySupportCode({ kind: 'denied', supportCode: 'corr-1' })).toBe('corr-1');
		expect(senderIdentitySupportCode({ kind: 'in_progress' })).toBeUndefined();
		expect(senderIdentitySupportCode({ kind: 'success', data: untouched })).toBeUndefined();
	});
});
