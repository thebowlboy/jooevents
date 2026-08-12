import { describe, expect, test } from 'bun:test';
import { api } from './workspace';
import {
	formatUsage,
	removalBlockReason,
	roomUsage,
	trackUsage,
	usageLabel,
	usageTotal,
	type VocabUsageSource
} from './vocab';
import { scenarios } from './sample/registry';
import type { WorkspaceDataset } from './sample/dataset';

function sourceOf(dataset: WorkspaceDataset): VocabUsageSource {
	return {
		submissions: dataset.submissions,
		sessions: dataset.schedule.sessions,
		placements: dataset.schedule.placements
	};
}

describe('vocabulary usage', () => {
	test('counts what every sample dataset actually references', () => {
		for (const dataset of scenarios) {
			const source = sourceOf(dataset);
			for (const track of dataset.tracks) {
				const usage = trackUsage(track.id, source);
				expect(usage.submissions).toBe(
					dataset.submissions.filter((row) => row.trackId === track.id).length
				);
				expect(usage.sessions).toBe(
					dataset.schedule.sessions.filter((row) => row.trackId === track.id).length
				);
				expect(usage.placements).toBe(0);
			}
			for (const format of dataset.formats) {
				const usage = formatUsage(format.id, source);
				expect(usage.submissions).toBe(
					dataset.submissions.filter((row) => row.formatId === format.id).length
				);
				expect(usage.sessions).toBe(
					dataset.schedule.sessions.filter((row) => row.formatId === format.id).length
				);
			}
			for (const room of dataset.schedule.rooms) {
				const usage = roomUsage(room.id, source);
				expect(usage.placements).toBe(
					dataset.schedule.placements.filter((row) => row.roomId === room.id).length
				);
			}
		}
	});

	test('a removal is blocked exactly while usage is nonzero, on every dataset', () => {
		for (const dataset of scenarios) {
			const source = sourceOf(dataset);
			const entries = [
				...dataset.tracks.map((track) => ({ kind: 'track' as const, id: track.id })),
				...dataset.formats.map((format) => ({ kind: 'format' as const, id: format.id })),
				...dataset.schedule.rooms.map((room) => ({ kind: 'room' as const, id: room.id }))
			];
			for (const entry of entries) {
				const usage =
					entry.kind === 'track'
						? trackUsage(entry.id, source)
						: entry.kind === 'format'
							? formatUsage(entry.id, source)
							: roomUsage(entry.id, source);
				const reason = removalBlockReason(entry.kind, usage);
				expect(reason === null).toBe(usageTotal(usage) === 0);
				if (reason) expect(reason).toContain(String(usageTotal(usage)));
			}
		}
	});

	test('states the count in the row and the remedy in the reason', () => {
		expect(usageLabel('track', { submissions: 42, sessions: 6, placements: 0 })).toBe(
			'42 submissions · 6 sessions'
		);
		expect(usageLabel('format', { submissions: 1, sessions: 0, placements: 0 })).toBe('1 submission');
		expect(usageLabel('room', { submissions: 0, sessions: 0, placements: 3 })).toBe(
			'3 scheduled sessions'
		);
		expect(usageLabel('room', { submissions: 0, sessions: 0, placements: 0 })).toBe('not used yet');

		expect(removalBlockReason('track', { submissions: 42, sessions: 6, placements: 0 })).toBe(
			'48 submissions and sessions reference this track. Retire it to stop new use — everything already using it keeps rendering.'
		);
		expect(removalBlockReason('room', { submissions: 0, sessions: 0, placements: 1 })).toBe(
			'1 scheduled session sits in this room. Retire it to stop new use — everything already using it keeps rendering.'
		);
		// A retired entry is already out of new use, so the remedy changes.
		expect(
			removalBlockReason('format', { submissions: 2, sessions: 1, placements: 0 }, 'retired')
		).toBe(
			'3 submissions and sessions use this format. It stays retired and keeps rendering wherever it is used.'
		);
	});
});

describe('vocabulary namespace', () => {
	test('owns every vocabulary read and write, and settings owns none', () => {
		for (const name of [
			'tracks',
			'formats',
			'rooms',
			'addTrack',
			'addFormat',
			'addRoom',
			'removeTrack',
			'removeFormat',
			'removeRoom',
			'retireTrack',
			'restoreTrack',
			'retireFormat',
			'restoreFormat',
			'retireRoom',
			'restoreRoom'
		]) {
			expect(typeof (api.vocab as unknown as Record<string, unknown>)[name]).toBe('function');
		}
		const settings = api.settings as unknown as Record<string, unknown>;
		for (const name of ['rooms', 'addRoom', 'removeRoom', 'addTrack', 'removeTrack', 'addFormat', 'removeFormat']) {
			expect(settings[name]).toBeUndefined();
		}
	});

	test('lists carry usage and a lifecycle status', async () => {
		const [tracks, formats, rooms] = await Promise.all([
			api.vocab.tracks(),
			api.vocab.formats(),
			api.vocab.rooms()
		]);
		for (const entry of [...tracks, ...formats, ...rooms]) {
			expect(entry.status).toBe('active');
			expect(usageTotal(entry.usage)).toBeGreaterThanOrEqual(0);
		}
	});

	test('refuses a delete exactly when the listed usage says it would', async () => {
		for (const track of await api.vocab.tracks()) {
			const outcome = await api.vocab.removeTrack(track.id);
			const reason = removalBlockReason('track', track.usage, track.status);
			expect(outcome.ok).toBe(reason === null);
			if (!outcome.ok) expect(outcome.reason).toBe(reason ?? '');
		}
	});

	test('an unused entry deletes; retire and restore move only the status', async () => {
		const created = await api.vocab.addFormat('Fireside');
		expect(created.status).toBe('active');
		expect(usageTotal(created.usage)).toBe(0);

		expect(await api.vocab.retireFormat(created.id)).toEqual({ ok: true });
		expect((await api.vocab.formats()).find((entry) => entry.id === created.id)?.status).toBe(
			'retired'
		);
		expect(await api.vocab.restoreFormat(created.id)).toEqual({ ok: true });
		expect((await api.vocab.formats()).find((entry) => entry.id === created.id)?.status).toBe(
			'active'
		);

		expect(await api.vocab.removeFormat(created.id)).toEqual({ ok: true });
		expect((await api.vocab.formats()).some((entry) => entry.id === created.id)).toBe(false);
	});

	test('a retired room is no longer suggested for a placement', async () => {
		const rooms = await api.vocab.rooms();
		const target = rooms[0];
		const session = (await api.schedule.state()).sessions[0];
		if (!target || !session) return;

		await api.vocab.retireRoom(target.id);
		const suggestions = await api.schedule.suggestSlots(session.id);
		expect(suggestions.some((slot) => slot.roomId === target.id)).toBe(false);
		await api.vocab.restoreRoom(target.id);
	});
});
