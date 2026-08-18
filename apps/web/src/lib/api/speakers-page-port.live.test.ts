import { describe, expect, test } from 'bun:test';
import type {
	EngagementHeadDto,
	EngagementSnapshotDto,
	SpeakerProfileFieldKey,
	SpeakerProfileReviewQueueDto,
	SpeakerLineupSnapshotDto
} from '@jooevents/contracts';
import type {
	EngagementsLiveClient,
	EngagementsLiveRespondResult
} from './operations/engagements-live';
import type { SubmissionTriageLiveClient } from './operations/submission-triage-live';
import type { SessionCatalogCorePort } from './session-catalog-port';
import {
	createLiveSpeakersPagePort,
	SpeakersPageLiveError
} from './speakers-page-port.live';
import type { OrganizerSubmissionsPort } from './view-models/intake-submissions';
import type { SpeakerProfilesLiveClient } from './operations/speaker-profiles-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);
const workspaceId = id(1);
const eventId = id(2);
const sessionId = id(10);
const personId = id(20);
const submissionId = id(30);
const engagementId = id(40);

function invitedHead(overrides: Partial<EngagementHeadDto> = {}): EngagementHeadDto {
	return {
		schemaVersion: 1,
		id: engagementId,
		scope: { workspaceId, eventId },
		sessionId,
		personId,
		submissionId,
		seededByDecision: { version: 1, digestSha256: digest('a') },
		state: 'invited',
		invitedAt: '2026-08-13T10:00:00.000Z',
		respondBy: null,
		confirmation: null,
		cancellationRequest: null,
		cancelledAt: null,
		source: { kind: 'submission', id: submissionId, version: 1 },
		version: 1,
		...overrides
	};
}

function snapshot(engagements: readonly EngagementHeadDto[]): EngagementSnapshotDto {
	return { schemaVersion: 1, scope: { workspaceId, eventId }, engagements: [...engagements] };
}

function lineupSnapshot(overrides: Partial<SpeakerLineupSnapshotDto> = {}): SpeakerLineupSnapshotDto {
	return {
		schemaVersion: 1,
		scope: { workspaceId, eventId },
		version: 1,
		digestSha256: digest('b'),
		categories: [],
		entries: [{
			personId,
			position: 0,
			categoryId: null,
			publiclyVisible: true,
			version: 1
		}],
		...overrides
	};
}

function fakeEngagements(input: {
	readonly served: EngagementSnapshotDto;
	readonly responded?: unknown[];
	readonly keys?: string[];
	readonly result?: EngagementsLiveRespondResult;
	readonly lineup?: SpeakerLineupSnapshotDto;
	readonly lineupChanges?: unknown[];
}): EngagementsLiveClient {
	return {
		async readSnapshot() {
			return { kind: 'success', data: input.served, correlationId };
		},
		async respond(respondInput, idempotencyKey) {
			input.responded?.push(respondInput);
			input.keys?.push(idempotencyKey);
			return input.result ?? {
				kind: 'success',
				data: {
					action: respondInput.action,
					engagement: invitedHead()
				},
				receipt: { id: id(62), operationName: 'engagement.change', operationVersion: 1 },
				correlationId
			};
		},
		async readLineup() {
			return { kind: 'success', data: input.lineup ?? lineupSnapshot(), correlationId };
		},
		async changeLineup(changeInput) {
			input.lineupChanges?.push(changeInput);
			const category = changeInput.action === 'add_category'
				? { id: id(91), name: changeInput.name, accent: 'lavender' as const, status: 'active' as const, position: 0, version: 1 }
				: null;
			return {
				kind: 'success',
				data: { action: changeInput.action, lineupVersion: 2, entry: null, category },
				receipt: { id: id(92), operationName: 'speaker-lineup.change', operationVersion: 1 },
				correlationId
			};
		}
	};
}

function fakeSessions(input: {
	readonly title?: string;
	readonly participants?: readonly {
		readonly personId: string;
		readonly publiclyVisible: boolean;
	}[];
}): SessionCatalogCorePort {
	const participants = (input.participants ?? [{ personId, publiclyVisible: true }]).map(
		(participant, index) => ({
			personId: participant.personId,
			role: 'speaker',
			position: index,
			publiclyVisible: participant.publiclyVisible,
			source: { kind: 'submission', id: submissionId, version: 1 }
		})
	);
	return {
		source: { kind: 'live' },
		async readCatalog() {
			return {
				kind: 'success',
				data: {
					schemaVersion: 1,
					scope: { workspaceId, eventId },
					version: 3,
					digestSha256: digest('c'),
					sessions: [{
						schemaVersion: 1,
						scope: { workspaceId, eventId },
						id: sessionId,
						title: input.title ?? 'Typed Tools in Anger',
						plannedDurationMinutes: 30,
						lifecycle: 'programmed',
						programTarget: {
							setVersion: 1,
							setDigestSha256: digest('d'),
							format: { kind: 'format', id: id(70), name: 'Talk', status: 'active', version: 1 },
							track: null
						},
						roster: { version: 1, digestSha256: digest('e'), participants },
						version: 2,
						digestSha256: digest('f'),
						createdByUserId: id(80),
						createdAt: '2026-08-13T09:00:00.000Z',
						updatedByUserId: id(80),
						updatedAt: '2026-08-13T09:30:00.000Z'
					}]
				} as never,
				correlationId
			};
		},
		async applyChange() {
			throw new Error('unexpected session change');
		}
	};
}

function fakeTriage(names: Readonly<Record<string, string | null>>): Pick<SubmissionTriageLiveClient, 'read'> {
	return {
		async read(readId) {
			if (!(readId in names)) return { kind: 'transport_error', error: { code: 'http_404', retryable: false } };
			return {
				kind: 'success',
				data: { source: { id: readId, primaryParticipantName: names[readId] } } as never,
				correlationId
			};
		}
	};
}

function fakeContacts(input: {
	readonly emails?: Readonly<Record<string, string>>;
	readonly refuse?: boolean;
	readonly capability?: 'available' | 'unavailable';
}): Pick<OrganizerSubmissionsPort, 'source' | 'contact'> {
	if (input.capability === 'unavailable') {
		return {
			source: { kind: 'live', workspaceId },
			contact: { kind: 'unavailable', reason: 'not_authorized' }
		} as never;
	}
	return {
		source: { kind: 'live', workspaceId },
		contact: {
			kind: 'available',
			read: async (readId: string) => {
				if (input.refuse) {
					return {
						kind: 'outcome',
						outcome: {
							class: 'access_denied', kind: 'authority.permission_missing',
							retryable: false, message: 'no', detail: null, detailSchemaVersion: 1
						} as never,
						correlationId
					};
				}
				const email = input.emails?.[readId];
				return email === undefined
					? { kind: 'transport_error', error: { code: 'http_404', retryable: false } }
					: { kind: 'success', data: { submissionId: readId, email }, correlationId };
			}
		}
	} as never;
}

function composePort(overrides: Partial<Parameters<typeof createLiveSpeakersPagePort>[0]> = {}) {
	return createLiveSpeakersPagePort({
		engagements: fakeEngagements({ served: snapshot([invitedHead()]) }),
		sessions: fakeSessions({}),
		triage: fakeTriage({ [submissionId]: 'Amina Diallo' }),
		contacts: fakeContacts({ emails: { [submissionId]: 'amina@example.org' } }),
		...overrides
	});
}

function fakeProfiles(input: {
	readonly reviewRequired: boolean;
	readonly approved?: readonly SpeakerProfileFieldKey[];
	readonly approvals?: unknown[];
}): SpeakerProfilesLiveClient {
	const profile = {
		schemaVersion: 1 as const,
		workspaceId,
		personId,
		version: 3,
		headline: { revision: 2, digestSha256: digest('h'), value: 'Systems engineer' },
		biography: { revision: 1, digestSha256: digest('i'), value: '' },
		location: { revision: 1, digestSha256: digest('j'), value: 'Singapore' },
		links: { revision: 1, digestSha256: digest('k'), value: [] },
		updatedAt: '2026-08-18T00:00:00.000Z'
	};
	const policy = {
		schemaVersion: 1 as const, workspaceId, eventId, eventVersion: 4,
		reviewRequired: input.reviewRequired
	};
	const queue: SpeakerProfileReviewQueueDto = {
		schemaVersion: 1,
		policy,
		profiles: input.reviewRequired ? [{
			personId,
			profileVersion: profile.version,
			presentFields: ['headline', 'location'],
			approvedFields: [...(input.approved ?? [])]
		}] : []
	};
	return {
		async read() { throw new Error('unexpected profile read'); },
		async readReviewQueue() { return { kind: 'success', data: queue, correlationId }; },
		async update() { throw new Error('unexpected profile update'); },
		async approve(authorInput) {
			input.approvals?.push(authorInput);
			return {
				kind: 'success', data: {
					schemaVersion: 1, workspaceId, eventId, personId,
					reviewPolicy: policy, profile, approvals: []
				},
				receipt: { id: id(410), operationName: 'speaker.profile.approve', operationVersion: 1 },
				correlationId
			};
		},
		async updateReviewPolicy() { throw new Error('unexpected policy update'); }
	};
}

describe('live tuned Speakers page port', () => {
	test('refuses to compose over a non-live source', () => {
		expect(() =>
			composePort({
				sessions: { ...fakeSessions({}), source: { kind: 'sample', label: 'Sample data', scenario: { key: 'k', name: 'n', description: 'd' } } } as never
			})
		).toThrow(TypeError);
	});

	test('serves one row per engagement joined with session, name, and disclosed address', async () => {
		const port = composePort();
		const rows = await port.speakers.list();

		expect(rows).toEqual([{
			id: engagementId,
			personId,
			name: 'Amina Diallo',
			email: 'amina@example.org',
			state: 'invited',
			sessions: [{ id: sessionId, title: 'Typed Tools in Anger' }],
			tasksDone: 0,
			tasksTotal: 0,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: false,
			position: 0
		}]);
	});

	test('carries one canonical person identity across an existing-roster engagement', async () => {
		const secondEngagementId = id(41);
		const port = composePort({
			engagements: fakeEngagements({
				served: snapshot([
					invitedHead(),
					invitedHead({
						id: secondEngagementId,
						sessionId: id(11),
						submissionId: null,
						seededByDecision: null,
						source: { kind: 'organizer', id: id(81), version: 1 }
					})
				])
			})
		});

		const rows = await port.speakers.list();
		expect(rows.map((row) => ({ id: row.id, personId: row.personId, name: row.name, email: row.email })))
			.toEqual([
				{ id: engagementId, personId, name: 'Amina Diallo', email: 'amina@example.org' },
				{ id: secondEngagementId, personId, name: 'Amina Diallo', email: 'amina@example.org' }
			]);
	});

	test('derives public-content release from the event profile policy and exact approvals', async () => {
		const automatic = composePort({ profiles: fakeProfiles({ reviewRequired: false }) });
		expect((await automatic.speakers.list())[0]?.contentApproved).toBe(true);
		expect((await automatic.lineup.list())[0]?.contentApproved).toBe(true);

		const pending = composePort({
			profiles: fakeProfiles({ reviewRequired: true, approved: ['headline'] })
		});
		expect((await pending.speakers.list())[0]?.contentApproved).toBe(false);

		const reviewed = composePort({
			profiles: fakeProfiles({ reviewRequired: true, approved: ['headline', 'location'] })
		});
		expect((await reviewed.speakers.list())[0]?.contentApproved).toBe(true);
	});

	test('exposes the one review queue and commits one exact person approval', async () => {
		const approvals: unknown[] = [];
		const port = composePort({
			profiles: fakeProfiles({ reviewRequired: true, approved: [], approvals })
		});
		expect((await port.profileReview!.read()).profiles).toHaveLength(1);
		expect(await port.profileReview!.approve({
			personId,
			expectedProfileVersion: 3,
			fields: ['headline', 'location']
		})).toEqual({ ok: true });
		expect(approvals).toEqual([{
			personId,
			expectedProfileVersion: 3,
			fields: ['headline', 'location']
		}]);
	});

	test('joins task counters and task rows from the canonical Task board', async () => {
		const task = (state: 'pending' | 'complete', value: number) => ({
			schemaVersion: 1,
			scope: { workspaceId, eventId },
			id: id(400 + value), taskDefinitionId: id(500 + value),
			taskDefinitionRevisionId: id(600 + value), engagementId, personId,
			state,
			deadline: {
				kind: 'task_due',
				reference: {
					id: id(700 + value), version: 1, kind: 'task_due',
					displayDate: '2026-08-01', effectiveAt: '2026-08-01T15:59:59.999Z',
					timeBasis: { timezone: 'Asia/Singapore', timezoneEvidence: { version: 1, digestSha256: digest('f') } }
				}
			},
			deadlineOverride: null, completionEvidence: null,
			assignedAt: '2026-07-01T00:00:00.000Z',
			updatedAt: '2026-07-01T00:00:00.000Z', version: 1
		});
		const port = composePort({
			tasks: {
				async readBoard() {
					return {
						kind: 'success', correlationId,
						data: {
							schemaVersion: 1, scope: { workspaceId, eventId },
							catalogVersion: 1, catalogDigestSha256: digest('a'), definitions: [],
							assignments: [task('pending', 1), task('complete', 2)]
						} as never
					};
				}
			} as never
		});
		const [row] = await port.speakers.list();
		expect(row).toMatchObject({ tasksDone: 1, tasksTotal: 2, overdueTasks: 1 });
		expect(await port.tasks.assignments()).toHaveLength(2);
	});

	test('projects a stored cancellation request as cancel_requested and serves its note', async () => {
		const port = composePort({
			engagements: fakeEngagements({
				served: snapshot([invitedHead({
					state: 'confirmed',
					confirmation: {
						attribution: 'organizer_recorded',
						personId,
						recordedByUserId: id(90),
						confirmedAt: '2026-08-13T11:00:00.000Z'
					},
					cancellationRequest: {
						requestedBy: 'speaker',
						requestedAt: '2026-08-13T12:00:00.000Z',
						note: 'Family emergency.'
					},
					version: 3
				})])
			})
		});
		const [row] = await port.speakers.list();
		expect(row?.state).toBe('cancel_requested');
		expect(row?.note).toBe('Family emergency.');
	});

	test('keeps the address the empty value when disclosure refuses or is not composed', async () => {
		for (const contacts of [
			fakeContacts({ refuse: true }),
			fakeContacts({ capability: 'unavailable' })
		]) {
			const port = composePort({ contacts });
			const [row] = await port.speakers.list();
			expect(row?.name).toBe('Amina Diallo');
			expect(row?.email).toBe('');
		}
	});

	test('keeps lineup visibility independent from one session appearance', async () => {
		const port = composePort({
			sessions: fakeSessions({ participants: [{ personId, publiclyVisible: false }] })
		});
		const [row] = await port.speakers.list();
		expect(row?.publiclyVisible).toBe(true);

		const hiddenPort = composePort({
			sessions: fakeSessions({ participants: [{ personId, publiclyVisible: true }] }),
			engagements: fakeEngagements({
				served: snapshot([invitedHead()]),
				lineup: lineupSnapshot({
					entries: [{
						personId,
						position: 0,
						categoryId: null,
						publiclyVisible: false,
						version: 1
					}]
				})
			})
		});
		expect((await hiddenPort.speakers.list())[0]?.publiclyVisible).toBe(false);
	});

	test('orders rows by invitation instant then name and states positions', async () => {
		const laterId = id(41);
		const otherPerson = id(21);
		const heads = [
			invitedHead({
				id: laterId,
				personId: otherPerson,
				invitedAt: '2026-08-14T10:00:00.000Z'
			}),
			invitedHead()
		].sort((left, right) =>
			`${left.sessionId}:${left.personId}`.localeCompare(`${right.sessionId}:${right.personId}`)
		);
		const port = composePort({
			engagements: fakeEngagements({ served: snapshot(heads) }),
			sessions: fakeSessions({
				participants: [
					{ personId, publiclyVisible: true },
					{ personId: otherPerson, publiclyVisible: true }
				]
			})
		});
		const rows = await port.speakers.list();
		expect(rows.map((row) => [row.id, row.position])).toEqual([
			[engagementId, 0],
			[laterId, 1]
		]);
	});

	test('records a confirmation fenced on the freshly read engagement version', async () => {
		const responded: unknown[] = [];
		const keys: string[] = [];
		const port = composePort({
			engagements: fakeEngagements({
				served: snapshot([invitedHead({ version: 5 })]),
				responded, keys
			})
		});

		expect(await port.speakers.recordConfirmation(engagementId)).toEqual({ ok: true });
		expect(responded).toEqual([{
			action: 'record_confirmation',
			engagementId,
			expectedEngagementVersion: 5,
			attribution: 'organizer_recorded'
		}]);
		expect(keys).toHaveLength(1);
		expect(keys[0]!.length).toBeGreaterThanOrEqual(16);
	});

	test('accepts a cancellation and maps a stale refusal onto reviewed copy', async () => {
		const responded: unknown[] = [];
		const stale: EngagementsLiveRespondResult = {
			kind: 'outcome',
			outcome: {
				class: 'stale_revision', kind: 'engagement.changed', retryable: false,
				message: 'changed', detail: null, detailSchemaVersion: 1
			} as never,
			terminal: true,
			correlationId
		};
		const port = composePort({
			engagements: fakeEngagements({
				served: snapshot([invitedHead()]),
				responded,
				result: stale
			})
		});

		const outcome = await port.speakers.acceptCancellation(engagementId);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain('changed while you were working');
		expect(responded).toEqual([{
			action: 'accept_cancellation',
			engagementId,
			expectedEngagementVersion: 1
		}]);
	});

	test('refuses a response for an engagement that is no longer served', async () => {
		const responded: unknown[] = [];
		const port = composePort({
			engagements: fakeEngagements({ served: snapshot([]), responded })
		});
		const outcome = await port.speakers.recordConfirmation(engagementId);
		expect(outcome.ok).toBe(false);
		expect(responded).toEqual([]);
	});

	test('states the served truths: no tasks, no thread, no groups', async () => {
		const port = composePort();
		expect(await port.tasks.defs()).toEqual([]);
		expect(await port.tasks.assignments()).toEqual([]);
		expect(await port.communications.thread(personId)).toBeNull();
		expect(await port.vocab.speakerCategories()).toEqual([]);
	});

	test('serves and changes the person-level lineup', async () => {
		const lineupChanges: unknown[] = [];
		const port = composePort({
			engagements: fakeEngagements({ served: snapshot([invitedHead()]), lineupChanges })
		});
		expect(await port.lineup.list()).toEqual([{
			id: personId,
			rosterId: engagementId,
			name: 'Amina Diallo',
			state: 'invited',
			sessions: [{ id: sessionId, title: 'Typed Tools in Anger' }],
			publiclyVisible: true,
			contentApproved: false,
			position: 0
		}]);
		for (const outcome of [
			await port.lineup.reorder(personId, 0),
			await port.lineup.setCategory(personId, null),
			await port.lineup.setVisibility(personId, false)
		]) {
			expect(outcome.ok).toBe(true);
		}
		expect(await port.vocab.addSpeakerCategory('Keynotes')).toMatchObject({
			name: 'Keynotes', speakerCount: 0
		});
		expect(lineupChanges).toHaveLength(4);
	});

	test('a failed roster read throws typed instead of serving an empty roster', async () => {
		const port = composePort({
			engagements: {
				async readSnapshot() {
					return { kind: 'transport_error', error: { code: 'network_unavailable', retryable: true } };
				},
				async respond() {
					throw new Error('unexpected respond');
				},
				async readLineup() {
					return { kind: 'transport_error', error: { code: 'network_unavailable', retryable: true } };
				},
				async changeLineup() {
					throw new Error('unexpected lineup change');
				}
			}
		});
		await expect(port.speakers.list()).rejects.toThrow(SpeakersPageLiveError);
	});
});
