import { describe, expect, test } from 'bun:test';
import type { TaskBoardSnapshotDto } from '@jooevents/contracts';
import type { TaskLiveClient } from './operations/tasks-live';
import { createLiveTasksPagePort } from './tasks-page-port.live';
import type { ScheduleState } from './types';
import { taskDefinitionView } from './mappers/tasks';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const digest = 'a'.repeat(64);

function schedule(): ScheduleState {
	return {
		days: [{ key: 'day-1', label: 'Monday, 7 June' }],
		rooms: [{
			id: id(21), name: 'Studio', capacity: 80, status: 'active',
			usage: { currentReferences: 1, historicalPins: 0 }
		}],
		dayStart: '09:00', slotMinutes: 30, slotsPerDay: 16,
		sessions: [{
			id: id(20), title: 'Typed systems', speakers: [], trackId: id(22),
			formatId: id(23), durationMin: 45, state: 'programmed'
		}],
		placements: [{
			sessionId: id(20), dayKey: 'day-1', roomId: id(21), startMin: 75, conflicts: []
		}],
		breaks: [], published: false
	};
}

function board(): TaskBoardSnapshotDto {
	const scope = { workspaceId: id(1), eventId: id(2) };
	const deadline = {
		kind: 'task_due' as const,
		reference: {
			id: id(8), version: 1, digestSha256: digest,
			displayDate: '2027-05-31', effectiveAt: '2027-05-31T15:59:59.999Z',
			eventTimezone: 'America/Los_Angeles',
			gracePolicy: 'soft' as const
		}
	};
	return {
		schemaVersion: 1, scope, catalogVersion: 2, catalogDigestSha256: digest,
		definitions: [{
			head: {
				schemaVersion: 1, scope, id: id(3), currentRevisionId: id(4),
				currentRevisionNumber: 1, version: 1
			},
			current: {
				schemaVersion: 1, scope, taskDefinitionId: id(3), revisionId: id(4),
				number: 1, predecessorRevisionId: null, predecessorDigestSha256: null,
				name: 'Upload headshot', description: null, subjectKind: 'engagement',
				completionMode: 'file_upload', required: true,
				visibility: 'assigned_participants',
				assignmentRule: { kind: 'all_confirmed_speakers', version: 1 },
				deadline, createdByUserId: id(9), createdAt: '2026-08-15T00:00:00.000Z',
				digestSha256: digest
			}
		}],
		assignments: [{
			schemaVersion: 1, scope, id: id(5), taskDefinitionId: id(3),
			taskDefinitionRevisionId: id(4), engagementId: id(6), personId: id(7),
			state: 'pending', deadline, deadlineOverride: null, completionEvidence: null,
			assignedAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z', version: 1
		}]
	} as unknown as TaskBoardSnapshotDto;
}

describe('live tuned Tasks page port', () => {
	test('projects task due dates in the event calendar around today', () => {
		const template = board().definitions[0]!;
		const at = Date.parse('2026-08-19T12:00:00.000Z');
		const deadlines = [
			['2026-08-09', '2026-08-10T07:00:00.000Z', '1 week ago'],
			['2026-08-18', '2026-08-19T07:00:00.000Z', 'yesterday'],
			['2026-08-19', '2026-08-20T07:00:00.000Z', 'today'],
			['2026-08-20', '2026-08-21T07:00:00.000Z', 'tomorrow'],
			['2026-08-26', '2026-08-27T07:00:00.000Z', 'in 1 week'],
			['2026-09-09', '2026-09-10T07:00:00.000Z', 'in 3 weeks']
		] as const;

		const projected = deadlines.map(([displayDate, effectiveAt]) => taskDefinitionView({
			...template,
			current: {
				...template.current,
				deadline: {
					...template.current.deadline,
					reference: {
						...template.current.deadline.reference,
						displayDate,
						effectiveAt
					}
				}
			}
		}, at));
		expect(projected.map((deadline) => deadline.dueRelative))
			.toEqual(deadlines.map(([, , relative]) => relative));
		expect(projected.map((deadline) => deadline.overdue))
			.toEqual([true, true, false, false, false, false]);

		expect(taskDefinitionView(template, at).dueAbsolute).toBe('31\u00a0May\u00a02027');
	});

	test('projects the canonical board and restores through a fresh direct mutation', async () => {
		const mutations: unknown[] = [];
		const client = {
			async readBoard() { return { kind: 'success', data: board(), correlationId: id(90) }; },
			async mutate(input: unknown) {
				mutations.push(input);
				return { kind: 'success', correlationId: id(90), data: { action: 'restore_assignment' } as never };
			}
		} as unknown as TaskLiveClient;
		const port = createLiveTasksPagePort({
			tasks: client,
			speakers: { speakers: { list: async () => [] } } as never,
			templates: { templates: { list: async () => ({ messages: [] }) } } as never,
			schedule: { state: async () => schedule() },
			remind: async () => undefined
		});
		expect(await port.tasks.defs()).toMatchObject([{
			id: id(3), name: 'Upload headshot', kind: 'upload', required: true
		}]);
		expect(await port.tasks.assignments()).toEqual([{
			taskId: id(3), speakerId: id(6), state: 'todo', overdue: false
		}]);
		await port.tasks.markWaived(id(3), id(6));
		expect(mutations.at(-1)).toEqual({
			action: 'waive_assignment', assignmentId: id(5), expectedVersion: 1
		});
		await port.tasks.restoreAssignment(id(3), id(6), 'todo', false);
		expect(mutations.at(-1)).toEqual({
			action: 'restore_assignment', assignmentId: id(5), expectedVersion: 1
		});
		const created = await port.tasks.createDefinition({
			name: 'Slides', description: null, completionMode: 'file_upload',
			required: false, dueOn: '2027-06-01'
		});
		expect(created).toEqual({ ok: true });
		expect(mutations.at(-1)).toMatchObject({ action: 'create_definition', name: 'Slides' });
	});

	test('joins the canonical placed slot into the speaker profile without storing a copy', async () => {
		let placed = true;
		const speaker = {
			id: id(30), name: 'Ada', email: 'ada@example.test', state: 'confirmed',
			sessions: [{ id: id(20), title: 'Typed systems' }], provisional: false
		};
		const port = createLiveTasksPagePort({
			tasks: {} as TaskLiveClient,
			speakers: { speakers: { list: async () => [speaker] } } as never,
			templates: { templates: { list: async () => ({ messages: [] }) } } as never,
			schedule: {
				async state() {
					const current = schedule();
					return { ...current, placements: placed ? current.placements : [] };
				}
			},
			remind: async () => undefined
		});

		expect(await port.speakers.profile('ada@example.test')).toMatchObject({
			name: 'Ada',
			sessions: [{
				id: id(20), title: 'Typed systems',
				placement: { day: 'Monday, 7 June', time: '10:15–11:00', room: 'Studio' }
			}]
		});
		placed = false;
		expect((await port.speakers.profile('ada@example.test'))?.sessions).toEqual([
			{ id: id(20), title: 'Typed systems' }
		]);
		expect(await port.speakers.profile('missing@example.test')).toBeNull();
	});
});
