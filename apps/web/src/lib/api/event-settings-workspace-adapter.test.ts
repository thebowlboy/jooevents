import { describe, expect, test } from 'bun:test';
import type { EventSettingsUpdateInput } from '@jooevents/contracts';
import {
	createEventSettingsWorkspaceAdapter,
	EventSettingsWorkspaceAdapterError
} from './event-settings-workspace-adapter';
import type {
	EventSettingsLiveClient,
	EventSettingsLiveReadResult,
	EventSettingsLiveUpdateResult
} from './operations/event-settings-live';
import type { EventSettingsView } from './view-models/event-settings';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const eventId = id(1);
const correlationId = id(900);

const current: EventSettingsView = Object.freeze({
	eventId,
	eventSetVersion: 3,
	eventVersion: 4,
	name: 'JooEvents Assembly',
	timezone: 'Asia/Singapore',
	startDate: '2027-03-18',
	endDate: '2027-03-20',
	location: 'Singapore',
	venueNote: 'Use the west entrance.',
	dayStart: '09:00',
	dayEnd: '18:00',
	slotMinutes: 30,
	dates: 'Mar 18–20, 2027'
});

const updated: EventSettingsView = Object.freeze({
	...current,
	eventVersion: 5,
	name: 'JooEvents Assembly Live',
	location: 'Suntec Convention Centre',
	venueNote: 'Registration opens on Level 2.',
	dates: 'Mar 18–20, 2027'
});

function readSuccess(data: EventSettingsView = current): EventSettingsLiveReadResult {
	return { kind: 'success', data, correlationId };
}

function updateSuccess(): EventSettingsLiveUpdateResult {
	return {
		kind: 'success',
		data: { settings: updated },
		receipt: { id: id(4), operationName: 'event.settings.update', operationVersion: 1 },
		correlationId
	};
}

function liveClient(input: {
	readonly reads: readonly EventSettingsLiveReadResult[];
	readonly update?: (
		request: EventSettingsUpdateInput,
		idempotencyKey: string
	) => EventSettingsLiveUpdateResult | Promise<EventSettingsLiveUpdateResult>;
}): EventSettingsLiveClient {
	let readIndex = 0;
	return {
		async read() {
			const result = input.reads[Math.min(readIndex, input.reads.length - 1)];
			readIndex += 1;
			if (!result) throw new TypeError('missing_read_fixture');
			return result;
		},
		async update(request, key) {
			if (!input.update) throw new TypeError('unexpected_update');
			return input.update(request, key);
		}
	};
}

describe('source-neutral Event Settings Workspace adapter', () => {
	test('maps the canonical record into operator identity fields without inventing indexing', async () => {
		const api = createEventSettingsWorkspaceAdapter({
			client: liveClient({ reads: [readSuccess()] })
		});
		const settings = await api.get();
		expect(settings).toEqual({
			name: current.name,
			dates: current.dates,
			startDate: current.startDate,
			endDate: current.endDate,
			location: current.location,
			timezone: current.timezone,
			venueNote: current.venueNote,
			dayStart: current.dayStart,
			dayEnd: current.dayEnd,
			slotMinutes: current.slotMinutes
		});
		expect(settings).not.toHaveProperty('publicIndexing');
	});

	test('maps only the typed event-required outcome to the operator no-event state', async () => {
		const api = createEventSettingsWorkspaceAdapter({
			client: liveClient({
				reads: [{
					kind: 'outcome',
					outcome: {
						class: 'conflict',
						kind: 'event.settings.event_required',
						retryable: false,
						subjects: [],
						detail: null,
						detailSchemaVersion: 1
					},
					correlationId
				}]
			})
		});
		expect(await api.get()).toBeNull();
	});

	test('re-reads hidden guards, authors all nine values, and returns the committed projection', async () => {
		let captured: { request: EventSettingsUpdateInput; key: string } | undefined;
		const api = createEventSettingsWorkspaceAdapter({
			client: liveClient({
				reads: [readSuccess()],
				update(request, key) {
					captured = { request, key };
					return updateSuccess();
				}
			}),
			newIdempotencyKey: () => 'event-settings-save-1'
		});

		expect(await api.update({
			name: '  JooEvents Assembly Live  ',
			location: '  Suntec   Convention Centre  ',
			venueNote: '  Registration opens on Level 2.  '
		})).toEqual({
			name: updated.name,
			dates: updated.dates,
			startDate: updated.startDate,
			endDate: updated.endDate,
			location: updated.location,
			timezone: updated.timezone,
			venueNote: updated.venueNote,
			dayStart: updated.dayStart,
			dayEnd: updated.dayEnd,
			slotMinutes: updated.slotMinutes
		});
		expect(captured).toEqual({
			key: 'event-settings-save-1',
			request: {
				expectedEventId: eventId,
				expectedEventSetVersion: 3,
				expectedEventVersion: 4,
				name: updated.name,
				timezone: current.timezone,
				startDate: current.startDate,
				endDate: current.endDate,
				location: updated.location,
				venueNote: updated.venueNote,
				dayStart: current.dayStart,
				dayEnd: current.dayEnd,
				slotMinutes: 30
			}
		});
	});

	test('merges geometry patches by explicit key so null clears and absence preserves', async () => {
		const captured: EventSettingsUpdateInput[] = [];
		const api = createEventSettingsWorkspaceAdapter({
			client: liveClient({
				reads: [readSuccess()],
				update(request) {
					captured.push(request);
					return updateSuccess();
				}
			})
		});

		await api.update({ slotMinutes: 15 });
		expect(captured[0]).toMatchObject({
			dayStart: current.dayStart,
			dayEnd: current.dayEnd,
			slotMinutes: 15
		});

		await api.update({ dayStart: null, dayEnd: null, slotMinutes: null });
		expect(captured[1]).toMatchObject({
			dayStart: null,
			dayEnd: null,
			slotMinutes: null
		});
	});

	test('refuses an incoherent geometry patch with the reviewed invalid-request copy', async () => {
		const api = createEventSettingsWorkspaceAdapter({
			client: liveClient({
				reads: [readSuccess()],
				update() {
					throw new TypeError('unexpected_update');
				}
			})
		});
		for (const patch of [
			{ dayStart: null },
			{ slotMinutes: 25 },
			{ dayStart: '18:30' as const },
			{ dayStart: '09:10' as const, dayEnd: '18:00' as const, slotMinutes: 60 }
		]) {
			try {
				await api.update(patch);
				throw new TypeError('expected_invalid_request_refusal');
			} catch (error) {
				expect(error).toBeInstanceOf(EventSettingsWorkspaceAdapterError);
				expect((error as EventSettingsWorkspaceAdapterError).code).toBe('invalid_request');
			}
		}
	});

	test('treats a normalized no-op as a read and creates no empty operation', async () => {
		let updates = 0;
		const api = createEventSettingsWorkspaceAdapter({
			client: liveClient({
				reads: [readSuccess()],
				update() {
					updates += 1;
					return updateSuccess();
				}
			})
		});
		expect(await api.update({ name: `  ${current.name}  ` })).toMatchObject({
			name: current.name,
			dates: current.dates
		});
		expect(updates).toBe(0);
	});

	test('refuses unsupported derived and public-surface fields instead of silently dropping them', async () => {
		let reads = 0;
		const api = createEventSettingsWorkspaceAdapter({
			client: {
				async read() {
					reads += 1;
					return readSuccess();
				},
				async update() {
					throw new TypeError('unexpected_update');
				}
			}
		});
		for (const patch of [{ publicIndexing: true }, { dates: 'A made-up range' }]) {
			try {
				await api.update(patch);
				throw new TypeError('expected_adapter_refusal');
			} catch (error) {
				expect(error).toBeInstanceOf(EventSettingsWorkspaceAdapterError);
				expect((error as EventSettingsWorkspaceAdapterError).code)
					.toBe('event_settings_field_not_supported');
			}
		}
		expect(reads).toBe(0);
	});

	test('keeps stale and unavailable failures explicit with safe copy', async () => {
		const staleClient = liveClient({
			reads: [readSuccess()],
			update: () => ({
				kind: 'outcome',
				outcome: {
					class: 'stale_revision',
					kind: 'event.settings_changed',
					retryable: false,
					subjects: [{ type: 'event', id: eventId }],
					detail: { code: 'stale_event', action: 'update', eventId },
					detailSchemaVersion: 1
				},
				terminal: false,
				correlationId
			})
		});
		const api = createEventSettingsWorkspaceAdapter({ client: staleClient });
		try {
			await api.update({ name: 'Changed elsewhere' });
			throw new TypeError('expected_stale_refusal');
		} catch (error) {
			expect(error).toBeInstanceOf(EventSettingsWorkspaceAdapterError);
			expect((error as Error).message)
				.toBe('Event settings changed while you were working. Reload and try again.');
		}
	});
});
