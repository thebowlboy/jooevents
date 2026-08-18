import { describe, expect, test } from 'bun:test';
import type { TaskBoardSnapshotDto } from '@jooevents/contracts';
import { createLiveSpeakerRecordPort, SpeakerRecordLiveError } from './speaker-record-port.live';
import type { ScheduleState, SpeakerRow } from './types';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const digest = 'a'.repeat(64);
const workspaceId = id(1);
const eventId = id(2);
const engagementId = id(3);
const otherEngagementId = id(4);
const personId = id(5);
const sessionId = id(6);
const otherSessionId = id(7);
const submissionId = id(8);
const taskId = id(9);
const taskSubmissionId = id(10);

const speaker = (over: Partial<SpeakerRow> = {}): SpeakerRow => ({
	id: engagementId,
	personId,
	name: 'Amina Diallo',
	email: 'amina@example.org',
	state: 'confirmed',
	sessions: [{ id: sessionId, title: 'Typed tools in anger' }],
	tasksDone: 0,
	tasksTotal: 1,
	overdueTasks: 0,
	publiclyVisible: true,
	contentApproved: false,
	position: 0,
	...over
});

function schedule(): ScheduleState {
	return {
		days: [{ key: '2027-06-07', label: 'Mon 7 Jun' }],
		rooms: [{
			id: id(20), name: 'Main stage', capacity: 400, status: 'active',
			usage: { currentReferences: 1, historicalPins: 0 }
		}],
		dayStart: '09:00', slotMinutes: 15, slotsPerDay: 40,
		sessions: [{
			id: sessionId, title: 'Typed tools in anger', speakers: [],
			trackId: id(21), formatId: id(22), durationMin: 45, state: 'programmed'
		}],
		placements: [{
			sessionId, dayKey: '2027-06-07', roomId: id(20), startMin: 60, conflicts: []
		}],
		breaks: [], published: true
	};
}

function taskBoard(): TaskBoardSnapshotDto {
	const scope = { workspaceId, eventId };
	const deadline = {
		kind: 'task_due' as const,
		reference: {
			id: id(30), version: 1, digestSha256: digest,
			displayDate: '2027-05-31', effectiveAt: '2027-05-31T15:59:59.999Z',
			gracePolicy: 'soft' as const
		}
	};
	return {
		schemaVersion: 1, scope, catalogVersion: 1, catalogDigestSha256: digest,
		definitions: [{
			head: {
				schemaVersion: 1, scope, id: taskId, currentRevisionId: id(31),
				currentRevisionNumber: 1, version: 1
			},
			current: {
				schemaVersion: 1, scope, taskDefinitionId: taskId, revisionId: id(31),
				number: 1, predecessorRevisionId: null, predecessorDigestSha256: null,
				name: 'Travel details', description: null, subjectKind: 'engagement',
				completionMode: 'form', required: true, visibility: 'assigned_participants',
				assignmentRule: { kind: 'all_confirmed_speakers', version: 1 },
				deadline, createdByUserId: id(32), createdAt: '2026-08-15T00:00:00.000Z',
				digestSha256: digest
			}
		}],
		assignments: [{
			schemaVersion: 1, scope, id: id(33), taskDefinitionId: taskId,
			taskDefinitionRevisionId: id(31), engagementId, personId,
			state: 'received_pending_check', deadline, deadlineOverride: null,
			completionEvidence: { kind: 'form', submissionId: taskSubmissionId },
			assignedAt: '2026-08-15T00:00:00.000Z',
			updatedAt: '2026-08-16T00:00:00.000Z', version: 2
		}]
	} as unknown as TaskBoardSnapshotDto;
}

function head(over: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1, id: engagementId, scope: { workspaceId, eventId },
		sessionId, personId, submissionId,
		seededByDecision: { submissionId, decisionVersion: 1, decisionDigestSha256: digest },
		state: 'confirmed', invitedAt: '2026-08-10T00:00:00.000Z', respondBy: null,
		confirmation: {
			attribution: 'organizer_recorded', personId, recordedByUserId: id(40),
			confirmedAt: '2026-08-11T00:00:00.000Z'
		},
		cancellationRequest: null, cancelledAt: null,
		source: { kind: 'submission', id: submissionId, version: 1 }, version: 2,
		...over
	};
}

function compose(overrides: Record<string, unknown> = {}) {
	const rows = [
		speaker(),
		speaker({
			id: otherEngagementId,
			sessions: [{ id: otherSessionId, title: 'A second commitment' }],
			publiclyVisible: false,
			position: 1
		})
	];
	return createLiveSpeakerRecordPort({
		speakers: {
			speakers: {
				list: async () => rows,
				recordConfirmation: async () => ({ ok: true }),
				acceptCancellation: async () => ({ ok: true })
			},
			lineup: {
				list: async () => [{
					id: personId, rosterId: engagementId, name: 'Amina Diallo',
					state: 'confirmed', sessions: rows[0]!.sessions, publiclyVisible: true,
					contentApproved: false, position: 0
				}],
				reorder: async () => ({ ok: true }),
				setCategory: async () => ({ ok: true }),
				setVisibility: async () => ({ ok: true })
			},
			tasks: { defs: async () => [], assignments: async () => [] },
			communications: {
				thread: async () => ({
					personId, personName: 'Amina Diallo',
					entries: [{
						id: id(50), at: '18 Aug 2026', purpose: 'Onboarding',
						subject: 'Welcome', outcome: 'accepted', actor: 'you'
					}]
				})
			},
			vocab: { speakerCategories: async () => [], addSpeakerCategory: async () => null }
		} as never,
		engagements: {
			readSnapshot: async () => ({
				kind: 'success', correlationId: id(60),
				data: {
					schemaVersion: 1, scope: { workspaceId, eventId },
					engagements: [
						head(),
							head({
								id: otherEngagementId, sessionId: otherSessionId,
								submissionId: null, seededByDecision: null,
								source: { kind: 'editorial', id: id(61), version: 1 }
							})
					]
				}
			})
		} as never,
		tasks: { readBoard: async () => ({ kind: 'success', data: taskBoard(), correlationId: id(62) }) } as never,
		taskActions: {
			tasks: {
				acceptFulfillment: async () => ({ ok: true }),
				markWaived: async () => undefined,
				restoreAssignment: async () => undefined
			}
		} as never,
		schedule: { schedule: { state: async () => schedule() } } as never,
		triage: {
			read: async (readId: string) => ({
				kind: 'success', correlationId: id(63),
				data: { source: { id: readId, title: 'Reliable agents' } }
			})
		} as never,
		decisions: {
			readState: async (ids: readonly string[]) => ({
				kind: 'success', correlationId: id(64),
				data: {
					schemaVersion: 1,
					rows: ids.map((current) => ({
						submissionId: current,
						head: { state: 'accepted' },
						origin: null,
						notificationAcceptedAt: '2026-08-17T00:00:00.000Z'
					}))
				}
			})
		} as never,
		intake: {
			readDetail: async () => ({
				kind: 'success', correlationId: id(65),
				data: {
					submissionId: taskSubmissionId,
					submittedAtLabel: '16 Aug 2026 · 09:00 UTC',
					answers: [
						{ type: 'text', fieldId: id(70), fieldLabel: 'Arrival', value: 'Monday evening' },
						{ type: 'checkbox', fieldId: id(71), fieldLabel: 'Needs a visa letter', checked: true }
					]
				}
			})
		} as never,
		files: { read: async () => ({ received: [] }), downloadPath: () => null } as never,
		...overrides
	} as never);
}

describe('live Speaker Record port', () => {
	test('joins canonical person, placement, linked proposal, task content, thread, and provenance', async () => {
		const record = await compose().record.read(engagementId);
		expect(record).not.toBeNull();
		expect(record).toMatchObject({
			engagement: { id: engagementId, personId, name: 'Amina Diallo' },
			publication: { onLineup: true, provisional: true },
			provenance: { kind: 'submission', submissionId, title: 'Reliable agents' },
			submissionCoverage: 'linked_only',
			submissions: [{ id: submissionId, decision: 'accepted', notified: true }]
		});
		expect(record?.sessions[0]?.placement).toMatchObject({ room: 'Main stage' });
		expect(record?.otherEngagements).toEqual([{
			id: otherEngagementId,
			state: 'confirmed',
			sessionTitles: ['A second commitment'],
			href: `/app/speakers/${otherEngagementId}`
		}]);
		expect(record?.deliverables[0]?.submission).toEqual({
			kind: 'form',
			submittedAt: '16 Aug 2026 · 09:00 UTC',
			answers: [
				{ fieldId: id(70), label: 'Arrival', value: 'Monday evening' },
				{ fieldId: id(71), label: 'Needs a visa letter', value: 'Yes' }
			]
		});
		expect(record?.thread?.entries).toHaveLength(1);
		expect(record?.history).toEqual([]);
	});

	test('refuses an incomplete Decision projection instead of calling a linked result undecided', async () => {
		const port = compose({
			decisions: {
				readState: async () => ({
					kind: 'success', correlationId: id(80),
					data: { schemaVersion: 1, rows: [] }
				})
			}
		});
		await expect(port.record.read(engagementId)).rejects.toMatchObject({
			name: 'SpeakerRecordLiveError',
			code: 'speaker_record_decisions_incomplete'
		} satisfies Partial<SpeakerRecordLiveError>);
	});

	test('serves only the exact retained MediaAsset revision as submitted file evidence', async () => {
		const fileBoard = structuredClone(taskBoard()) as TaskBoardSnapshotDto;
		(fileBoard.definitions[0]!.current as { completionMode: string }).completionMode = 'file_upload';
		(fileBoard.assignments[0] as { completionEvidence: unknown }).completionEvidence = {
			kind: 'file', mediaAssetId: id(90), mediaAssetVersion: 3
		};
		const material = {
			kind: 'file', attachmentId: id(91), attachmentVersion: 1,
			assetId: id(90), assetVersion: 3, name: 'headshot.png', byteSize: 120_000,
			sizeLabel: '120 KB', contentType: 'image/png', scan: 'scanned', downloadable: true,
			attachedAt: '2026-08-16T09:00:00.000Z', origin: 'speaker'
		};
		const port = compose({
			tasks: {
				readBoard: async () => ({ kind: 'success', data: fileBoard, correlationId: id(92) })
			},
			files: {
				read: async () => ({
					received: [{ engagementId, items: [material] }]
				}),
				downloadPath: (assetId: string) => `/api/files/${assetId}`
			}
		});
		const record = await port.record.read(engagementId);
		expect(record?.deliverables[0]?.submission).toMatchObject({
			kind: 'upload',
			files: [{
				id: id(90), name: 'headshot.png', kindLabel: 'PNG image',
				sizeLabel: '120 KB', href: `/api/files/${id(90)}`
			}]
		});

		material.assetVersion = 2;
		const stale = await port.record.read(engagementId);
		expect(stale?.deliverables[0]?.submission).toBeNull();
	});

	test('refuses a blank identity instead of rendering a person-shaped empty record', async () => {
		const port = compose({
			speakers: {
				speakers: {
					list: async () => [speaker({ name: '', email: '' })],
					recordConfirmation: async () => ({ ok: true })
				},
				lineup: { list: async () => [] },
				communications: { thread: async () => null }
			}
		});
		await expect(port.record.read(engagementId)).rejects.toMatchObject({
			code: 'speaker_record_identity_unavailable'
		});
	});
});
