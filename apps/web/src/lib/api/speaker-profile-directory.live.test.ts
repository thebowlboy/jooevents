import { describe, expect, test } from 'bun:test';
import { createSpeakerProfileBatchLiveSource } from './speaker-profile-directory.live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

describe('live speaker profile directory', () => {
	test('reads one directory and joins requested people by canonical Person id', async () => {
		let directoryReads = 0;
		const source = createSpeakerProfileBatchLiveSource({
			roster: {
				async list() {
					return [
						{
							id: id(4), personId: id(5), name: 'Ada', email: 'ada@example.test',
							state: 'confirmed' as const, sessions: [{ id: id(6), title: 'Opening' }],
							tasksDone: 0, tasksTotal: 0, overdueTasks: 0,
							publiclyVisible: true, contentApproved: true, position: 0
						},
						{
							id: id(7), personId: id(5), name: '', email: '',
							state: 'confirmed' as const, sessions: [{ id: id(10), title: 'Panel' }],
							tasksDone: 0, tasksTotal: 0, overdueTasks: 0,
							publiclyVisible: true, contentApproved: true, position: 1
						}
					];
				}
			},
			profiles: {
				async readDirectory() {
					directoryReads += 1;
					return { kind: 'success' as const, correlationId: id(9), data: {
						schemaVersion: 1 as const, workspaceId: id(1), eventId: id(2), profiles: [{
							schemaVersion: 1 as const, workspaceId: id(1), eventId: id(2), personId: id(5),
							reviewPolicy: { schemaVersion: 1 as const, workspaceId: id(1), eventId: id(2), eventVersion: 1, reviewRequired: false },
							profile: {
								schemaVersion: 1 as const, workspaceId: id(1), personId: id(5), version: 1,
								headline: { revision: 1, digestSha256: 'a'.repeat(64), value: 'Engineer' },
								biography: { revision: 1, digestSha256: 'b'.repeat(64), value: '' },
								location: { revision: 1, digestSha256: 'c'.repeat(64), value: 'Singapore' },
								links: { revision: 1, digestSha256: 'd'.repeat(64), value: [] },
								updatedAt: '2026-08-19T00:00:00.000Z'
							}, approvals: []
						}]
					} };
				},
				async read() { throw new Error('singular profile read is forbidden'); },
				async readReviewQueue() { throw new Error('unexpected'); },
				async update() { throw new Error('unexpected'); },
				async approve() { throw new Error('unexpected'); },
				async updateReviewPolicy() { throw new Error('unexpected'); }
			},
			schedule: {
				async state() {
					return {
						days: [], rooms: [], dayStart: '09:00', slotMinutes: 30,
						slotsPerDay: 0, sessions: [], placements: [], breaks: [], published: false
					};
				}
			}
		});
		const profiles = await source.profiles([
			{ key: id(5), personId: id(5), email: 'ada@example.test', submissionCount: 3 },
			{ key: id(8), personId: id(8), email: 'missing@example.test', submissionCount: 1 }
		]);
		expect(directoryReads).toBe(1);
		expect(profiles[id(5)]).toMatchObject({
			name: 'Ada', headline: 'Engineer', location: 'Singapore', submissionCount: 3,
			speakerId: id(4), sessions: [
				{ id: id(6), title: 'Opening' },
				{ id: id(10), title: 'Panel' }
			]
		});
		expect(profiles[id(8)]).toBeNull();
	});
});
