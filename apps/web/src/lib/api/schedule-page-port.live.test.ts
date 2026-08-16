import { describe, expect, test } from 'bun:test';
import { createLiveSchedulePagePort, SchedulePageLiveError } from './schedule-page-port.live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const base = {
	vocabulary: { source: { kind: 'live' } }, proposals: { source: { kind: 'live' } },
	settings: {}, publication: {}
} as const;

describe('live Schedule page correction boundary', () => {
	test('keeps backward Session lifecycle refusal local and write-free', async () => {
		let writes = 0;
		const port = createLiveSchedulePagePort({
			placements: { source: { kind: 'live' } } as never,
			sessions: { source: { kind: 'live' }, readCatalog: async () => ({ kind: 'success', data: { sessions: [] } }) } as never,
			vocabulary: { source: { kind: 'live' } } as never,
			proposals: { source: { kind: 'live' } } as never,
			settings: {} as never, publication: {} as never,
			newIdempotencyKey: () => { writes += 1; return 'schedule-direct-attempt'; }
		});
		await expect(port.schedule.transitionSession('00000000-0000-4000-8000-000000000001', 'draft')).rejects.toBeInstanceOf(SchedulePageLiveError);
		expect(writes).toBe(0);
	});

	test('rereads the occurrence and sends one guarded unplace with a fresh key', async () => {
		const writes: unknown[] = [];
		const port = createLiveSchedulePagePort({
			...base,
			placements: { source: { kind: 'live' }, readPlacements: async () => ({ kind: 'success', data: {
				scheduleVersion: 7, occurrences: [{ id: id(1), sessionId: id(2), roomId: id(3),
					startAtUtc: '2027-01-01T09:00:00.000Z', endAtUtc: '2027-01-01T10:00:00.000Z', version: 4 }]
			} }), placeOrMove: async (request: unknown, key: string) => {
				writes.push({ request, key }); return { kind: 'success', data: { action: 'unplace', scheduleVersion: 8, occurrence: null } };
			} } as never,
			sessions: { source: { kind: 'live' } } as never,
			newIdempotencyKey: () => 'schedule-unplace-attempt-00000002'
		} as never);
		await port.schedule.unplace(id(2));
		expect(writes).toEqual([{ key: 'schedule-unplace-attempt-00000002', request: {
			action: 'unplace', expectedScheduleVersion: 7, occurrenceId: id(1), expectedOccurrenceVersion: 4
		} }]);
	});

	test('rereads the Session head and sends one guarded remove_new_session with a fresh key', async () => {
		const writes: unknown[] = [];
		const port = createLiveSchedulePagePort({
			...base,
			placements: { source: { kind: 'live' } } as never,
			sessions: { source: { kind: 'live' }, readCatalog: async () => ({ kind: 'success', data: {
				version: 5, digestSha256: 'a'.repeat(64), sessions: [{ id: id(2), version: 1, digestSha256: 'b'.repeat(64) }]
			} }), applyChange: async (request: unknown, key: string) => {
				writes.push({ request, key }); return { kind: 'success', data: { action: 'remove_new_session', catalogVersion: 6, session: null } };
			} } as never,
			newIdempotencyKey: () => 'session-remove-attempt-00000002'
		} as never);
		expect(await port.schedule.removeSession(id(2))).toEqual({ ok: true });
		expect(writes).toEqual([{ key: 'session-remove-attempt-00000002', request: {
			action: 'remove_new_session', expectedCatalogVersion: 5,
			expectedCatalogDigestSha256: 'a'.repeat(64), sessionId: id(2),
			expectedSessionVersion: 1, expectedSessionDigestSha256: 'b'.repeat(64)
		} }]);
	});
});
