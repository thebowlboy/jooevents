import { describe, expect, test } from 'bun:test';
import { createLiveSchedulePagePort, SchedulePageLiveError } from './schedule-page-port.live';
import type { SpeakerRow, SurfaceTemplate } from './types';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const base = {
	vocabulary: { source: { kind: 'live' } }, proposals: { source: { kind: 'live' } },
	attribution: { source: { kind: 'live' }, read: async () => ({ kind: 'success', data: [] }) },
	attributionMutations: { source: { kind: 'live' } },
	settings: {}, publication: {}, speakers: { list: async () => [] }, templates: {}
} as const;

describe('live Schedule page correction boundary', () => {
	test('keeps backward Session lifecycle refusal local and write-free', async () => {
		let writes = 0;
		const port = createLiveSchedulePagePort({
			placements: { source: { kind: 'live' } } as never,
			sessions: { source: { kind: 'live' }, readCatalog: async () => ({ kind: 'success', data: { sessions: [] } }) } as never,
			vocabulary: { source: { kind: 'live' } } as never,
			proposals: { source: { kind: 'live' } } as never,
			attribution: { source: { kind: 'live' } } as never,
			attributionMutations: { source: { kind: 'live' } } as never,
			settings: {} as never, publication: {} as never,
			speakers: {} as never, templates: {} as never,
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
			} }), applyChange: async (request: unknown, key: string) => {
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

	test('adds multiple rooms once, retains removal evidence, and restores the same break ids', async () => {
		const roomA = id(3);
		const roomB = id(4);
		const breakA = id(5);
		const breakB = id(6);
		const writes: unknown[] = [];
		let scheduleVersion = 7;
		let heads: any[] = [];
		let key = 0;
		const placements = {
			source: { kind: 'live' },
			readPlacements: async () => ({
				kind: 'success',
				data: { scheduleVersion, occurrences: [], breaks: heads.filter((head) => head.status === 'active') }
			}),
			applyChange: async (request: any, idempotencyKey: string) => {
				writes.push({ request, idempotencyKey });
				scheduleVersion += 1;
				if (request.action === 'break_add') {
					heads = [breakA, breakB].map((breakId, index) => ({
						id: breakId, label: request.label, dayKey: request.dayKey,
						roomId: request.roomIds[index], startMin: request.startMin, endMin: request.endMin,
						status: 'active', version: 1
					}));
				} else {
					heads = heads.map((head) => ({
						...head,
						status: request.action === 'break_remove' ? 'removed' : 'active',
						version: head.version + 1
					}));
				}
				return { kind: 'success', data: { action: request.action, scheduleVersion, breaks: heads } };
			}
		};
		const port = createLiveSchedulePagePort({
			placements: placements as never,
			sessions: { source: { kind: 'live' }, readCatalog: async () => ({
				kind: 'success', data: { sessions: [] }
			}) } as never,
			vocabulary: {
				source: { kind: 'live' },
				rooms: async () => [roomA, roomB].map((roomId, index) => ({
					id: roomId, name: `Room ${index + 1}`, capacity: null, status: 'active', usage: {}
				}))
			} as never,
			proposals: { source: { kind: 'live' } } as never,
			attribution: { source: { kind: 'live' }, read: async () => ({ kind: 'success', data: [] }) } as never,
			attributionMutations: { source: { kind: 'live' } } as never,
			settings: { get: async () => ({
				startDate: '2026-11-01', endDate: '2026-11-01', timezone: 'UTC',
				dayStart: '09:00', dayEnd: '17:00', slotMinutes: 30
			}) } as never,
			publication: { overview: async () => ({ currentProgramRelease: null, surfaceHeads: [] }) } as never,
			speakers: { list: async () => [] } as never,
			templates: {} as never,
			newIdempotencyKey: () => `schedule-break-attempt-${++key}`
		});

		await port.schedule.state();
		const created = await port.schedule.addBreak({
			label: 'Lunch', dayKey: '2026-11-01', roomIds: [roomA, roomB],
			startMin: 180, durationMin: 60
		});
		expect(created.map((head) => head.id)).toEqual([breakA, breakB]);
		await port.schedule.removeBreaks([breakA, breakB]);
		const restored = await port.schedule.restoreBreaks([breakA, breakB]);
		expect(restored.map((head) => head.id)).toEqual([breakA, breakB]);
		expect(writes.map((entry: any) => entry.request)).toEqual([
			{
				action: 'break_add', expectedScheduleVersion: 7, label: 'Lunch',
				dayKey: '2026-11-01', roomIds: [roomA, roomB], startMin: 180, endMin: 240
			},
			{
				action: 'break_remove', expectedScheduleVersion: 8,
				breaks: [{ id: breakA, expectedVersion: 1 }, { id: breakB, expectedVersion: 1 }]
			},
			{
				action: 'break_restore', expectedScheduleVersion: 9,
				breaks: [{ id: breakA, expectedVersion: 2 }, { id: breakB, expectedVersion: 2 }]
			}
		]);
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

	test('delegates roster and surface-template reads to the joined live owners', async () => {
		const roster: SpeakerRow[] = [{
			id: id(4), personId: id(6), name: 'Ada', email: 'ada@example.test', state: 'confirmed', sessions: [],
			tasksDone: 0, tasksTotal: 0, overdueTasks: 0, publiclyVisible: true,
			contentApproved: true, position: 0
		}];
		const surfaces: SurfaceTemplate[] = [{
			id: id(5), kind: 'schedule', name: 'Programme', purpose: 'Publish the programme.',
			blocks: [], revision: 1, revisions: [], usedBy: ['schedule']
		}];
		const port = createLiveSchedulePagePort({
			...base,
			placements: { source: { kind: 'live' } } as never,
			sessions: { source: { kind: 'live' } } as never,
			speakers: {
				list: async () => roster,
				profile: async () => null
			} as never,
			templates: { list: async () => ({ surfaces }) } as never
		} as never);

		expect(await port.speakers.list()).toBe(roster);
		expect(await port.templates.list()).toEqual({ surfaces });
	});

	test('projects canonical Session participants through person-keyed live roster rows', async () => {
		const personId = id(41);
		const port = createLiveSchedulePagePort({
			placements: { source: { kind: 'live' }, readPlacements: async () => ({
				kind: 'success', data: { scheduleVersion: 1, occurrences: [], breaks: [] }
			}) } as never,
			sessions: { source: { kind: 'live' }, readCatalog: async () => ({
				kind: 'success', data: { sessions: [{
					id: id(42), title: 'Opening', plannedDurationMinutes: 30,
					lifecycle: 'programmed', programTarget: { format: { id: id(43) }, track: null },
					roster: { participants: [{ personId }] }
				}] }
			}) } as never,
			vocabulary: { source: { kind: 'live' }, rooms: async () => [] } as never,
			proposals: { source: { kind: 'live' } } as never,
			attribution: { source: { kind: 'live' }, read: async () => ({ kind: 'success', data: [] }) } as never,
			attributionMutations: { source: { kind: 'live' } } as never,
			settings: { get: async () => ({}) } as never,
			publication: { overview: async () => ({ currentProgramRelease: null, surfaceHeads: [] }) } as never,
			speakers: { list: async () => [{
				id: id(44), personId, name: 'Ada Lovelace', email: 'ada@example.test',
				state: 'confirmed', sessions: [], tasksDone: 0, tasksTotal: 0, overdueTasks: 0,
				publiclyVisible: true, contentApproved: false, position: 0
			}], profile: async () => null } as never,
			templates: {} as never
		});

		const state = await port.schedule.state();
		expect(state.sessions[0]?.speakers).toEqual([
			{ personId, name: 'Ada Lovelace', email: 'ada@example.test' }
		]);
	});

	test('refuses an unresolved canonical Session participant instead of rendering an empty roster', async () => {
		const port = createLiveSchedulePagePort({
			placements: { source: { kind: 'live' }, readPlacements: async () => ({
				kind: 'success', data: { scheduleVersion: 1, occurrences: [], breaks: [] }
			}) } as never,
			sessions: { source: { kind: 'live' }, readCatalog: async () => ({
				kind: 'success', data: { sessions: [{
					id: id(52), title: 'Opening', plannedDurationMinutes: 30,
					lifecycle: 'programmed', programTarget: { format: { id: id(53) }, track: null },
					roster: { participants: [{ personId: id(51) }] }
				}] }
			}) } as never,
			vocabulary: { source: { kind: 'live' }, rooms: async () => [] } as never,
			proposals: { source: { kind: 'live' } } as never,
			attribution: { source: { kind: 'live' }, read: async () => ({ kind: 'success', data: [] }) } as never,
			attributionMutations: { source: { kind: 'live' } } as never,
			settings: { get: async () => ({}) } as never,
			publication: { overview: async () => ({ currentProgramRelease: null, surfaceHeads: [] }) } as never,
			speakers: { list: async () => [], profile: async () => null } as never,
			templates: {} as never
		});

		await expect(port.schedule.state()).rejects.toMatchObject({
			code: 'session_participant_projection_unavailable'
		});
	});

	test('serves Decision-owned origins and only accepted unrouted attach candidates', async () => {
		const sessionId = id(61);
		const personId = id(62);
		const routedId = id(63);
		const unroutedId = id(64);
		const port = createLiveSchedulePagePort({
			...base,
			placements: { source: { kind: 'live' } } as never,
			sessions: { source: { kind: 'live' }, readCatalog: async () => ({
				kind: 'success', data: { sessions: [{
					id: sessionId,
					roster: { participants: [{
						personId, source: { kind: 'submission', id: routedId, version: 1 }
					}] }
				}] }
			}) } as never,
			attribution: { source: { kind: 'live' }, read: async () => ({ kind: 'success', data: [
				{
					id: routedId, title: 'Routed talk', primaryParticipantName: 'Ada',
					source: 'cfp', decision: 'accepted', origin: { sessionId, kind: 'attached' }
				},
				{
					id: unroutedId, title: 'Unrouted talk', primaryParticipantName: 'Grace',
					source: 'cfp', decision: 'accepted', origin: null
				},
				{
					id: id(65), title: 'Waitlisted talk', primaryParticipantName: 'Linus',
					source: 'cfp', decision: 'waitlisted', origin: null
				}
			] }) } as never,
			speakers: { list: async () => [{
				id: id(66), personId, name: 'Ada', email: 'ada@example.test', state: 'confirmed',
				sessions: [], tasksDone: 0, tasksTotal: 0, overdueTasks: 0,
				publiclyVisible: true, contentApproved: true, position: 0
			}], profile: async () => null } as never
		} as never);

		expect(await port.schedule.sessionOrigins(sessionId)).toEqual([{
			id: routedId, title: 'Routed talk', source: 'cfp', speakerEmails: ['ada@example.test']
		}]);
		expect(await port.schedule.attachCandidates(sessionId)).toEqual([{
			id: unroutedId, title: 'Unrouted talk', speakers: [{ name: 'Grace' }]
		}]);
	});

	test('attaches one accepted Submission and restores through its exact receipt evidence', async () => {
		const sessionId = id(71);
		const submissionId = id(72);
		const recovery = { sessionPlan: { input: { action: 'roster_append' } } } as never;
		const writes: { request: unknown; key: string }[] = [];
		let reads = 0;
		const port = createLiveSchedulePagePort({
			...base,
			placements: { source: { kind: 'live' } } as never,
			sessions: {
				source: { kind: 'live' },
				readCatalog: async () => {
					reads += 1;
					return { kind: 'success', data: {
						version: reads === 1 ? 5 : 6,
						digestSha256: (reads === 1 ? 'a' : 'c').repeat(64),
						sessions: [{
							id: sessionId,
							version: reads === 1 ? 2 : 3,
							digestSha256: (reads === 1 ? 'b' : 'd').repeat(64)
						}]
					} };
				}
			} as never,
			attributionMutations: {
				source: { kind: 'live' },
				apply: async (request: any, key: string) => {
					writes.push({ request, key });
					return request.action === 'attach_unlinked'
						? { kind: 'success', data: { action: 'attach_unlinked', recovery } }
						: { kind: 'success', data: { action: 'restore_route', recovery: null } };
				}
			} as never,
			newIdempotencyKey: () => `session-route-${writes.length + 1}`
		} as never);

		expect(await port.schedule.attachSubmission(sessionId, submissionId)).toEqual({ ok: true });
		expect(await port.schedule.detachSubmission(sessionId, submissionId)).toEqual({ ok: true });
		expect(writes).toEqual([
			{
				key: 'session-route-1',
				request: {
					action: 'attach_unlinked',
					expectedCatalogVersion: 5,
					expectedCatalogDigestSha256: 'a'.repeat(64),
					expectedSessionVersion: 2,
					expectedSessionDigestSha256: 'b'.repeat(64),
					targetSessionId: sessionId,
					submissionId
				}
			},
			{
				key: 'session-route-2',
				request: {
					action: 'restore_route',
					expectedCatalogVersion: 6,
					expectedCatalogDigestSha256: 'c'.repeat(64),
					expectedSessionVersion: 3,
					expectedSessionDigestSha256: 'd'.repeat(64),
					original: recovery
				}
			}
		]);
	});
});
