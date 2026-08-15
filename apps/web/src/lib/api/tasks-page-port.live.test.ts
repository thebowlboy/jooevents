import { describe, expect, test } from 'bun:test';
import type { TaskBoardSnapshotDto } from '@jooevents/contracts';
import type { TaskLiveClient } from './operations/tasks-live';
import { createLiveTasksPagePort } from './tasks-page-port.live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const digest = 'a'.repeat(64);

function board(): TaskBoardSnapshotDto {
	const scope = { workspaceId: id(1), eventId: id(2) };
	const deadline = {
		kind: 'task_due' as const,
		reference: {
			id: id(8), version: 1, digestSha256: digest,
			displayDate: '2027-05-31', effectiveAt: '2027-05-31T15:59:59.999Z',
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
	test('projects the canonical board and carries mutations through exact compensation', async () => {
		const mutations: unknown[] = [];
		const compensations: unknown[] = [];
		const client = {
			async readBoard() { return { kind: 'success', data: board(), correlationId: id(90) }; },
			async mutate(input: unknown) {
				mutations.push(input);
				return { kind: 'success', correlationId: id(90), data: {
					safeDiff: {} as never,
					source: {
						changesetId: id(20), revisionId: id(21), revisionDigest: digest,
						commitReceiptId: id(22)
					}
				} };
			},
			async compensate(source: unknown) {
				compensations.push(source);
				return { kind: 'success', correlationId: id(90), data: {} as never };
			}
		} as unknown as TaskLiveClient;
		const port = createLiveTasksPagePort({
			tasks: client,
			speakers: { speakers: { list: async () => [] } } as never,
			templates: { templates: { list: async () => ({ messages: [] }) } } as never,
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
		expect(compensations).toHaveLength(1);
		const created = await port.tasks.createDefinition({
			name: 'Slides', description: null, completionMode: 'file_upload',
			required: false, dueOn: '2027-06-01'
		});
		expect(created).toEqual({ ok: true });
		expect(mutations.at(-1)).toMatchObject({ action: 'create_definition', name: 'Slides' });
	});
});
