import { describe, expect, test } from 'bun:test';
import type { StructuredOutcome } from '@jooevents/contracts';
import { createSampleSenderIdentityStore } from './sample/sender-identity';
import {
	createLiveSenderIdentitySettingsPort,
	createSampleSenderIdentitySettingsPort,
	type SettingsPageSenderIdentityPort
} from './sender-identity-settings-port';
import type {
	WorkspaceSenderIdentityLiveClient,
	WorkspaceSenderIdentityLiveReadResult,
	WorkspaceSenderIdentityLiveUpdateResult
} from './operations/workspace-sender-identity-live';

const correlationId = '00000000-0000-4000-8000-0000000003e8';

function outcome(
	overrides: Partial<StructuredOutcome> & Pick<StructuredOutcome, 'class' | 'kind'>
): StructuredOutcome {
	return { retryable: false, subjects: [], detail: null, detailSchemaVersion: 1, ...overrides };
}

function livePort(input: {
	readonly read?: WorkspaceSenderIdentityLiveReadResult;
	readonly update?: WorkspaceSenderIdentityLiveUpdateResult;
}): SettingsPageSenderIdentityPort {
	const client: WorkspaceSenderIdentityLiveClient = {
		read: async () =>
			input.read ?? { kind: 'unavailable', operation: 'read', reason: 'operation_not_registered' },
		update: async () =>
			input.update ?? {
				kind: 'unavailable',
				operation: 'update',
				reason: 'operation_not_registered'
			}
	};
	return createLiveSenderIdentitySettingsPort({ client });
}

function samplePort(): SettingsPageSenderIdentityPort {
	const store = createSampleSenderIdentityStore({ installationDisplayName: () => 'JooEvents' });
	return createSampleSenderIdentitySettingsPort({
		read: async () => store.read(),
		update: async (update) => store.update(update)
	});
}

describe('the live sender-identity settings seam', () => {
	test('turns a denied read into a typed absence carrying its support code', async () => {
		const port = livePort({
			read: {
				kind: 'outcome',
				outcome: outcome({ class: 'access_denied', kind: 'authority.not_authorized' }),
				correlationId
			}
		});

		expect(await port.read()).toEqual({ kind: 'denied', supportCode: correlationId });
	});

	test('reports an unmounted operation as unavailable, not as a failed request', async () => {
		expect(await livePort({}).read()).toEqual({ kind: 'unavailable' });
	});

	test('keeps a transport failure retryable-or-not with no message of its own', async () => {
		const port = livePort({
			read: { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } }
		});

		expect(await port.read()).toEqual({ kind: 'failure', retryable: true });
	});

	test('pins a field refusal to the field the operation named', async () => {
		const port = livePort({
			update: {
				kind: 'outcome',
				terminal: true,
				receipt: {
					id: '00000000-0000-4000-8000-00000000000b',
					operationName: 'communication.sender_identity.update',
					operationVersion: 1
				},
				outcome: outcome({
					class: 'policy_violation',
					kind: 'communication.sender_identity_refused',
					detail: { field: 'display_name', code: 'display_name_bidi_or_zero_width' }
				}),
				correlationId
			}
		});

		expect(
			await port.save({ expectedHeadVersion: 1, displayName: 'x', replyToAddress: null })
		).toEqual({
			kind: 'refused',
			field: 'display_name',
			code: 'display_name_bidi_or_zero_width',
			supportCode: correlationId
		});
	});

	test('refuses to narrate a refusal whose detail does not parse', async () => {
		const port = livePort({
			update: {
				kind: 'outcome',
				terminal: false,
				outcome: outcome({
					class: 'policy_violation',
					kind: 'communication.sender_identity_refused',
					detail: { field: 'display_name', code: 'display_name_smells_wrong' }
				}),
				correlationId
			}
		});

		expect(
			await port.save({ expectedHeadVersion: 1, displayName: 'x', replyToAddress: null })
		).toEqual({ kind: 'failure', retryable: false, supportCode: correlationId });
	});

	test('separates the autonomy intervention family from a field refusal', async () => {
		const port = livePort({
			update: {
				kind: 'outcome',
				terminal: false,
				outcome: outcome({ class: 'policy_violation', kind: 'autonomy.block' }),
				correlationId
			}
		});

		expect(
			await port.save({ expectedHeadVersion: 1, displayName: 'x', replyToAddress: null })
		).toEqual({ kind: 'intervened', supportCode: correlationId });
	});

	test('carries the current head out of a stale-revision outcome', async () => {
		const port = livePort({
			update: {
				kind: 'outcome',
				terminal: false,
				outcome: outcome({
					class: 'stale_revision',
					kind: 'communication.sender_identity_changed',
					detail: { code: 'head_version_changed', headVersion: 7 }
				}),
				correlationId
			}
		});

		expect(
			await port.save({ expectedHeadVersion: 1, displayName: 'x', replyToAddress: null })
		).toEqual({ kind: 'stale', headVersion: 7, supportCode: correlationId });
	});

	test('names the retry and in-progress conflicts apart', async () => {
		const busy = livePort({
			update: {
				kind: 'outcome',
				terminal: false,
				outcome: outcome({ class: 'conflict', kind: 'operation.in_progress', retryable: true }),
				correlationId
			}
		});
		const changed = livePort({
			update: {
				kind: 'outcome',
				terminal: false,
				outcome: outcome({
					class: 'idempotency_conflict',
					kind: 'operation.request_changed'
				}),
				correlationId
			}
		});

		const save = { expectedHeadVersion: 1, displayName: 'x', replyToAddress: null };
		expect(await busy.save(save)).toEqual({ kind: 'in_progress', supportCode: correlationId });
		expect(await changed.save(save)).toEqual({
			kind: 'request_changed',
			supportCode: correlationId
		});
	});
});

describe('the sample sender-identity seam', () => {
	test('reads the installation values while the workspace has set none', async () => {
		expect(await samplePort().read()).toEqual({
			kind: 'success',
			data: {
				headVersion: 1,
				displayName: null,
				replyToAddress: null,
				effective: {
					fromAddress: 'program@aie-demo.example',
					fromDisplayName: 'JooEvents',
					replyToAddress: null,
					source: 'installation'
				}
			}
		});
	});

	test('commits both values as one unit and advances the head by one', async () => {
		const port = samplePort();

		const saved = await port.save({
			expectedHeadVersion: 1,
			displayName: 'Deep Dish Conf',
			replyToAddress: 'talks@deepdish.example'
		});

		expect(saved).toEqual({
			kind: 'saved',
			data: {
				headVersion: 2,
				displayName: 'Deep Dish Conf',
				replyToAddress: 'talks@deepdish.example',
				effective: {
					fromAddress: 'program@aie-demo.example',
					fromDisplayName: 'Deep Dish Conf',
					replyToAddress: 'talks@deepdish.example',
					source: 'workspace'
				}
			}
		});
		expect(await port.read()).toMatchObject({ kind: 'success', data: { headVersion: 2 } });
	});

	test('clears a value back to the installation with null, never with an empty string', async () => {
		const port = samplePort();
		await port.save({
			expectedHeadVersion: 1,
			displayName: 'Deep Dish Conf',
			replyToAddress: null
		});

		expect(
			await port.save({ expectedHeadVersion: 2, displayName: null, replyToAddress: null })
		).toMatchObject({
			kind: 'saved',
			data: {
				displayName: null,
				effective: { fromDisplayName: 'JooEvents', source: 'installation' }
			}
		});
		expect(
			await port.save({ expectedHeadVersion: 3, displayName: '   ', replyToAddress: null })
		).toMatchObject({ kind: 'refused', field: 'display_name', code: 'display_name_empty' });
	});

	test('refuses a header-injection attempt on the field that carried it', async () => {
		const bidi = String.fromCodePoint(0x202e);
		const cases = [
			{
				displayName: `Deep Dish${String.fromCodePoint(0x0a)}Bcc: victim@example.test`,
				replyToAddress: null,
				field: 'display_name',
				code: 'display_name_control_character'
			},
			{
				displayName: `Deep${bidi}Dish`,
				replyToAddress: null,
				field: 'display_name',
				code: 'display_name_bidi_or_zero_width'
			},
			{
				displayName: null,
				replyToAddress: 'talks@deepdish.example, spoof@evil.example',
				field: 'reply_to_address',
				code: 'reply_to_multiple_addresses'
			},
			{
				displayName: null,
				replyToAddress: 'Program <talks@deepdish.example>',
				field: 'reply_to_address',
				code: 'reply_to_multiple_addresses'
			},
			{
				displayName: null,
				replyToAddress: 'not-an-address',
				field: 'reply_to_address',
				code: 'reply_to_not_one_address'
			}
		] as const;

		for (const attempt of cases) {
			const port = samplePort();
			expect(
				await port.save({
					expectedHeadVersion: 1,
					displayName: attempt.displayName,
					replyToAddress: attempt.replyToAddress
				})
			).toEqual({ kind: 'refused', field: attempt.field, code: attempt.code });
		}
	});

	test('refuses a value past the product bound rather than shortening it', async () => {
		const port = samplePort();

		expect(
			await port.save({
				expectedHeadVersion: 1,
				displayName: 'x'.repeat(201),
				replyToAddress: null
			})
		).toEqual({ kind: 'refused', field: 'display_name', code: 'display_name_too_long' });
		expect(
			await port.save({
				expectedHeadVersion: 1,
				displayName: null,
				replyToAddress: `${'a'.repeat(310)}@example.test`
			})
		).toEqual({ kind: 'refused', field: 'reply_to_address', code: 'reply_to_too_long' });
	});

	test('refuses a save against a head someone else has moved', async () => {
		const port = samplePort();
		await port.save({ expectedHeadVersion: 1, displayName: 'First', replyToAddress: null });

		expect(
			await port.save({ expectedHeadVersion: 1, displayName: 'Second', replyToAddress: null })
		).toEqual({ kind: 'stale', headVersion: 2 });
	});

	test('offers no support code, because the sample transport correlates nothing', async () => {
		const port = samplePort();

		const refused = await port.save({
			expectedHeadVersion: 1,
			displayName: null,
			replyToAddress: 'a@b.example, c@d.example'
		});

		expect(refused).not.toHaveProperty('supportCode');
	});
});
