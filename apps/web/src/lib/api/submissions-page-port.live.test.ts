import { describe, expect, test } from 'bun:test';
import {
	submissionTriageListSchema,
	submissionTriageReadSchema
} from '@jooevents/contracts/submission-triage';
import type { DecisionStateRowDto } from '@jooevents/contracts';
import {
	mapSubmissionTriageList,
	mapSubmissionTriageRead
} from './mappers/submission-triage';
import type { DecisionsLiveClient } from './operations/decisions-live';
import type {
	DirectEntryLiveClient,
	DirectEntryLiveCreateResult
} from './operations/direct-entry-live';
import type {
	SubmissionTriageLiveApplyResult,
	SubmissionTriageLiveClient
} from './operations/submission-triage-live';
import type { ReviewCorePort } from './review-core-port';
import type { ReviewSnapshotView } from './view-models/review';
import type { OrganizerFormsPort } from './view-models/intake-forms';
import type { SessionCatalogCorePort } from './session-catalog-port';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import {
	createLiveSubmissionsPagePort,
	SubmissionsPageLiveError
} from './submissions-page-port.live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);
const workspaceId = id(1);
const eventId = id(2);
const formId = id(3);
const formVersionId = id(4);
const trackId = id(11);
const formatId = id(12);

type RowState = 'inbox' | 'set_aside' | 'spam';

function triageRowDto(input: {
	readonly value: number;
	readonly state?: RowState;
	readonly source?: 'public_form' | 'direct_entry';
	readonly sessionId?: string;
	readonly version?: number;
	readonly primaryParticipantId?: string;
}) {
	const submissionId = id(input.value);
	const submittedAt = '2026-08-13T09:00:00.000Z';
	const state = input.state ?? 'inbox';
	return {
		schemaVersion: 1,
		source: {
			schemaVersion: 1,
			scope: { workspaceId, eventId },
			source: input.source ?? 'public_form',
			summary: {
				schemaVersion: 1,
				id: submissionId,
				formId,
				formVersionId,
				target: input.sessionId
					? { kind: 'session', sessionId: input.sessionId }
					: { kind: 'general_pool' },
				title: 'Streaming agents',
				primaryParticipantName: 'Noor Haddad',
				...(input.primaryParticipantId
					? { primaryParticipantId: input.primaryParticipantId } : {}),
				submittedAt
			},
			detail: {
				schemaVersion: 1,
				submissionId,
				formId,
				formVersionId,
				submittedAt,
				participantCount: 1,
				answers: [
					{ kind: 'text', fieldId: id(5), fieldLabel: 'Title', value: 'Streaming agents' }
				],
				affirmedConsentFieldIds: []
			},
			abstract: null,
			track: { id: trackId, label: 'Web' },
			format: { id: formatId, label: 'Talk' },
		},
		triage: {
			schemaVersion: 1,
			scope: { workspaceId, eventId },
			submissionId,
			version: input.version ?? 3,
			state,
			setAsideAttribution:
				state === 'set_aside'
					? {
							kind: 'registered_run',
							runId: id(31),
							standingPolicy: {
								reference: { key: 'policy.triage.scout', version: 2 },
								definitionDigestSha256: digest('d')
							},
							invocationEvidenceIds: ['evidence-1']
						}
					: null,
			updatedAt: '2026-08-13T10:02:00.000Z'
		},
		arrival: {
			schemaVersion: 1,
			id: id(input.value + 400),
			scope: { workspaceId, eventId },
			submissionId,
			formId,
			formVersionId,
			source: input.source ?? 'public_form',
			submittedAt,
			classification: 'on_time',
			closeEvidence: null,
			recordedAt: submittedAt
		},
		visibleTray:
			state === 'spam' ? 'spam' : state === 'set_aside' ? 'set_aside' : 'inbox'
	};
}

const queryGuard = {
	schemaVersion: 1,
	scope: { workspaceId, eventId },
	version: 7,
	digestSha256: digest('a')
};

function triagePage(rows: ReturnType<typeof triageRowDto>[], totals: {
	inbox: number; set_aside: number; late: number; spam: number;
}) {
	return mapSubmissionTriageList(submissionTriageListSchema.parse({
		schemaVersion: 1,
		queryGuard,
		rows,
		trayTotals: totals,
		search: null
	}));
}

function triageRead(row: ReturnType<typeof triageRowDto>) {
	return mapSubmissionTriageRead(submissionTriageReadSchema.parse({
		schemaVersion: 1,
		queryGuard,
		row
	}));
}

function fakeTriage(input: {
	readonly page?: ReturnType<typeof triagePage>;
	readonly rows?: Readonly<Record<string, ReturnType<typeof triageRowDto>>>;
	readonly applied?: unknown[];
	readonly applyResult?: SubmissionTriageLiveApplyResult;
}): SubmissionTriageLiveClient {
	return {
		async list() {
			if (!input.page) throw new Error('unexpected triage list');
			return { kind: 'success', data: input.page, correlationId };
		},
		async read(submissionId: string) {
			const row = input.rows?.[submissionId];
			if (!row) {
				return {
					kind: 'outcome',
					outcome: {
						class: 'conflict',
						kind: 'submission_triage.submission_missing',
						retryable: false,
						subjects: [],
						detail: null,
						detailSchemaVersion: 1
					},
					correlationId
				};
			}
			return { kind: 'success', data: triageRead(row), correlationId };
		},
		async apply(applyInput, _idempotencyKey) {
			input.applied?.push(applyInput);
			return input.applyResult ?? {
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: applyInput.action,
					queryGuard: { ...queryGuard, schemaVersion: 1 as const },
					submissionIds: applyInput.submissionIds
				},
				receipt: { id: id(62), operationName: 'submission.triage.transition', operationVersion: 1 },
				correlationId
			};
		}
	};
}

function decisionState(rows: readonly DecisionStateRowDto[]): Pick<DecisionsLiveClient, 'readState'> {
	return {
		async readState(submissionIds) {
			return {
				kind: 'success',
				data: {
					schemaVersion: 1,
					rows: submissionIds.map((submissionId) =>
						rows.find((row) => row.submissionId === submissionId)
							?? { submissionId, head: null, origin: null })
				},
				correlationId
			};
		}
	};
}

function decidedHead(submissionId: string, state: 'accepted' | 'declined') {
	return {
		schemaVersion: 1 as const,
		scope: { workspaceId, eventId },
		submissionId,
		state,
		version: 2,
		digestSha256: digest('c'),
		decidedByUserId: id(31),
		decidedAt: '2026-08-13T11:00:00.000Z'
	};
}

function reviewCore(snapshot: Partial<ReviewSnapshotView> = {}): ReviewCorePort {
	const served: ReviewSnapshotView = {
		schemaVersion: 1,
		viewer: { kind: 'organizer' },
		plans: [],
		standings: {},
		...snapshot
	} as ReviewSnapshotView;
	return {
		source: { kind: 'live' },
		async readSnapshot() {
			return { kind: 'success', data: served, correlationId };
		},
		async readRoundSetup() {
			throw new Error('unexpected round setup read');
		},
		async changeRound() {
			throw new Error('unexpected draft');
		},
		async stepBack() {
			throw new Error('unexpected draft');
		},
		async changeEvaluation() {
			throw new Error('unexpected draft');
		},
		async changeAccolade() {
			throw new Error('unexpected accolade change');
		},
		async saveEvaluationDraft() {
			throw new Error('unexpected save');
		}
	};
}

function fakeVocabulary(): Pick<
	ProgramVocabularySettingsPort,
	'source' | 'tracks' | 'formats' | 'addTrack' | 'addFormat'
> {
	return {
		source: { kind: 'live' },
		async tracks() {
			return [];
		},
		async formats() {
			return [];
		},
		async addTrack() {
			throw new Error('unexpected addTrack');
		},
		async addFormat() {
			throw new Error('unexpected addFormat');
		}
	} as never;
}

function fakeForms(input: {
	readonly forms?: readonly {
		readonly id: string;
		readonly status: 'draft' | 'open' | 'closed';
		readonly version: number;
		readonly target:
			| { kind: 'general_pool' }
			| { kind: 'session'; sessionId: string }
			| { kind: 'category'; categoryKind: 'track' | 'format'; categoryId: string };
	}[];
	readonly fields?: readonly { readonly id: string; readonly included: boolean }[];
}): Pick<OrganizerFormsPort, 'source' | 'list' | 'readDetail'> {
	return {
		source: { kind: 'live' },
		async list() {
			return {
				kind: 'success',
				data: {
					catalogVersion: 1,
					registryPin: { version: 1, digestSha256: digest('e') },
					forms: (input.forms ?? []).map((form) => ({
						id: form.id,
						name: 'Standard application',
						target: form.target.kind === 'general_pool'
							? { kind: 'general_pool', label: 'General pool' }
							: form.target.kind === 'session'
								? { kind: 'session', sessionId: form.target.sessionId, label: 'Session target' }
								: {
										kind: 'category',
										categoryKind: form.target.categoryKind,
										categoryId: form.target.categoryId,
										label: form.target.categoryKind === 'track' ? 'Track target' : 'Format target'
									},
						status: form.status,
						statusLabel: form.status === 'open' ? 'Open' : form.status === 'draft' ? 'Draft' : 'Closed',
						version: form.version,
						currentPublishedVersionId: id(90),
						composition: { excludedFieldIds: [], requiredOverrides: {}, optionExposure: {} },
						registryPin: { version: 1, digestSha256: digest('e') },
						closesAt: null,
						fieldCount: input.fields?.length ?? 0,
						configurationIssues: [],
						submissionCount: 0,
						updatedAt: '2026-08-13T08:00:00.000Z',
						updatedAtLabel: 'today'
					}))
				} as never,
				correlationId
			};
		},
		async readDetail(requested: string) {
			const form = (input.forms ?? []).find((candidate) => candidate.id === requested);
			if (!form) throw new Error('unexpected form detail read');
			return {
				kind: 'success',
				data: {
					form: {
						id: form.id,
						version: form.version,
						status: form.status,
						currentPublishedVersionId: id(90),
						name: 'Standard application',
						target: { kind: 'general_pool', label: 'General pool' },
						definition: {} as never
					},
					registryPin: { version: 1, digestSha256: digest('e') },
					fields: (input.fields ?? []).map((field) => ({
						field: { id: field.id } as never,
						included: field.included,
						required: false,
						requiredOverridden: false,
						exposureAll: true
					})),
					configurationIssues: [],
					createdAt: '2026-08-13T08:00:00.000Z',
					updatedAt: '2026-08-13T08:00:00.000Z',
					updatedAtLabel: 'today',
					publishedVersion: {
						id: id(90),
						number: 1,
						sourceDefinitionVersion: form.version,
						publishedAt: '2026-08-13T08:00:00.000Z',
						publishedAtLabel: 'today'
					}
				} as never,
				correlationId
			};
		}
	};
}

function fakeSessions(sessions: readonly {
	readonly id: string;
	readonly title: string;
	readonly lifecycle: 'draft' | 'collecting' | 'programmed';
}[]): SessionCatalogCorePort {
	return {
		source: { kind: 'live' },
		async readCatalog() {
			return {
				kind: 'success',
				data: {
					version: 1,
					digestSha256: digest('f'),
					sessions: sessions.map((session) => ({
						id: session.id,
						title: session.title,
						lifecycle: session.lifecycle
					}))
				} as never,
				correlationId
			};
		},
		async applyChange() {
			throw new Error('unexpected session change');
		}
	} as never;
}

const registryFields = [
	{ id: id(41), kind: 'text', mapsTo: 'talk.title' },
	{ id: id(42), kind: 'text', mapsTo: 'person.name' },
	{ id: id(40), kind: 'email', mapsTo: 'person.email' },
	{ id: id(43), kind: 'select', mapsTo: 'talk.track' },
	{ id: id(44), kind: 'select', mapsTo: 'talk.format' },
	{ id: id(45), kind: 'textarea', mapsTo: 'talk.abstract' }
] as const;

function fakeDirectEntry(input: {
	readonly created?: unknown[];
	readonly keys?: string[];
	readonly result?: DirectEntryLiveCreateResult;
}): DirectEntryLiveClient {
	return {
		async readFieldIdentities() {
			return {
				kind: 'success',
				data: { version: 1, fields: registryFields },
				correlationId
			};
		},
		async create(wire, idempotencyKey) {
			input.created?.push(wire);
			input.keys?.push(idempotencyKey);
			return input.result ?? {
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'create',
					submissionId: id(21),
					formId,
					formVersionId,
					source: 'direct_entry',
					submittedAt: '2026-08-13T09:00:00.000Z'
				},
				receipt: { id: id(62), operationName: 'submission.direct_entry.create', operationVersion: 1 },
				correlationId
			};
		}
	};
}

function composePort(overrides: Partial<Parameters<typeof createLiveSubmissionsPagePort>[0]> = {}) {
	return createLiveSubmissionsPagePort({
		triage: fakeTriage({}),
		directEntry: fakeDirectEntry({}),
		decisions: decisionState([]),
		review: reviewCore(),
		vocabulary: fakeVocabulary(),
		forms: fakeForms({}),
		sessions: fakeSessions([]),
		newIdempotencyKey: () => 'je.test.submissions.key',
		...overrides
	});
}

describe('live tuned Submissions page port', () => {
	test('joins triage rows with decision heads and standings, never inventing facts', async () => {
		const undecided = triageRowDto({ value: 21, source: 'direct_entry' });
		const decided = triageRowDto({
			value: 22, state: 'set_aside', primaryParticipantId: id(80)
		});
		const page = triagePage([undecided, decided], {
			inbox: 1, set_aside: 1, late: 0, spam: 0
		});
		const port = composePort({
			triage: fakeTriage({ page }),
			decisions: decisionState([
				{
					submissionId: id(22),
					head: decidedHead(id(22), 'accepted'),
					origin: null,
					notificationAcceptedAt: '2026-08-13T11:03:00.000Z'
				}
			]),
			review: reviewCore({
				standings: {
					[id(22)]: {
						submissionId: id(22),
						value: 4.2,
						scaleMax: 5,
						reviews: 3,
						n: 9,
						median: 4,
						band: 'upper',
						phrase: 'Higher than most',
						slice: { label: 'Web' },
						bins: Array.from({ length: 24 }, (_, index) => (index === 0 ? 9 : 0))
					}
				} as never
			})
		});

		const served = await port.submissions.list({});
		expect(served.trayTotals).toEqual({ inbox: 1, 'set-aside': 1, late: 0, spam: 0 });
		const first = served.rows[0]!;
		expect(first).toMatchObject({
			id: id(21),
			source: 'direct_entry',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			trackId,
			formatId,
			// Absent standing is the canonical absence: zero committed reviews.
			reviewCount: 0
		});
		// The one served participant: disclosed name, undisclosed address as ''.
		expect(first.speakers).toEqual([{ name: 'Noor Haddad', email: '' }]);
		expect(first.decidedAt).toBeUndefined();
		const second = served.rows[1]!;
		expect(second).toMatchObject({
			id: id(22),
			tray: 'set-aside',
			decision: 'accepted',
			decidedAt: '2026-08-13T11:00:00.000Z',
			notified: true,
			reviewCount: 3,
			reviewAverage: 4.2,
			// Registered-run set-aside attribution surfaces its policy identity.
			setAsideBy: 'policy.triage.scout'
		});
		expect(second.speakers).toEqual([{
			name: 'Noor Haddad', email: '', personId: id(80)
		}]);
		expect(second.standing).toMatchObject({
			value: 4.2, reviews: 3, band: 'upper', phrase: 'Higher than most'
		});
	});

	test('serves the uninitialized triage spine as the proven-empty page', async () => {
		const port = composePort({
			triage: {
				...fakeTriage({}),
				async list() {
					return {
						kind: 'outcome',
						outcome: {
							class: 'conflict',
							kind: 'submission_triage.not_initialized',
							retryable: false,
							subjects: [],
							detail: null,
							detailSchemaVersion: 1
						},
						correlationId
					};
				}
			}
		});
		expect(await port.submissions.list({})).toEqual({
			rows: [],
			trayTotals: { inbox: 0, 'set-aside': 0, late: 0, spam: 0 }
		});
	});

	test('direct entry refuses the dispositions this wire cannot truthfully carry', async () => {
		const port = composePort();
		await expect(port.submissions.addDirectEntry({
			title: 'Invited talk',
			speakers: [{ name: 'A', email: 'a@example.test' }],
			trackId,
			formatId,
			disposition: 'accepted'
		})).rejects.toMatchObject({
			name: 'SubmissionsPageLiveError',
			code: 'direct_entry_accept_unavailable',
			// A standing gap: resubmitting refuses identically, so the copy — not
			// a retry — is the remedy the modal must surface.
			retryable: false
		});
		await expect(port.submissions.addDirectEntry({
			title: 'Panel',
			speakers: [
				{ name: 'A', email: 'a@example.test' },
				{ name: 'B', email: 'b@example.test' }
			],
			trackId,
			formatId,
			disposition: 'inbox'
		})).rejects.toMatchObject({ code: 'direct_entry_single_speaker' });
	});

	test('direct entry commits through an open covering form and returns the canonical re-read', async () => {
		const createdRow = triageRowDto({ value: 21, source: 'direct_entry' });
		const created: unknown[] = [];
		const keys: string[] = [];
		const port = composePort({
			triage: fakeTriage({ rows: { [id(21)]: createdRow } }),
			directEntry: fakeDirectEntry({ created, keys }),
			forms: fakeForms({
				forms: [{ id: formId, status: 'open', version: 4, target: { kind: 'general_pool' } }],
				fields: registryFields.map((field) => ({ id: field.id, included: true }))
			})
		});

		const submission = await port.submissions.addDirectEntry({
			title: 'Streaming agents',
			abstract: 'Practical systems.',
			speakers: [{ name: 'Noor Haddad', email: 'noor@example.test' }],
			trackId,
			formatId,
			disposition: 'inbox'
		});
		expect(created).toEqual([{
			formId,
			expectedFormDefinitionVersion: 4,
			answers: [
				{ kind: 'email', fieldId: id(40), value: 'noor@example.test' },
				{ kind: 'text', fieldId: id(41), value: 'Streaming agents' },
				{ kind: 'text', fieldId: id(42), value: 'Noor Haddad' },
				{ kind: 'select', fieldId: id(43), choiceId: trackId },
				{ kind: 'select', fieldId: id(44), choiceId: formatId },
				{ kind: 'textarea', fieldId: id(45), value: 'Practical systems.' }
			]
		}]);
		expect(keys).toEqual(['je.test.submissions.key']);
		expect(submission).toMatchObject({
			id: id(21),
			source: 'direct_entry',
			tray: 'inbox',
			decision: 'undecided'
		});
	});

	test('direct entry accepts a category form only when its pin is a declared fact', async () => {
		const createdRow = triageRowDto({ value: 21, source: 'direct_entry' });
		const created: unknown[] = [];
		const port = composePort({
			triage: fakeTriage({ rows: { [id(21)]: createdRow } }),
			directEntry: fakeDirectEntry({ created }),
			forms: fakeForms({
				forms: [
					// A pool for a DIFFERENT track contradicts the declared track.
					{
						id: id(80),
						status: 'open',
						version: 2,
						target: { kind: 'category', categoryKind: 'track', categoryId: id(99) }
					},
					// The declared format's own pool carries the entry truthfully.
					{
						id: formId,
						status: 'open',
						version: 4,
						target: { kind: 'category', categoryKind: 'format', categoryId: formatId }
					}
				],
				fields: registryFields.map((field) => ({ id: field.id, included: true }))
			})
		});
		await port.submissions.addDirectEntry({
			title: 'Streaming agents',
			speakers: [{ name: 'Noor Haddad', email: 'noor@example.test' }],
			trackId,
			formatId,
			disposition: 'inbox'
		});
		expect(created).toEqual([expect.objectContaining({ formId })]);
	});

	test('direct entry refuses when no open form can carry the declared facts', async () => {
		const port = composePort({
			forms: fakeForms({
				forms: [{ id: formId, status: 'open', version: 4, target: { kind: 'general_pool' } }],
				// The form asks title and email only: track/format facts would drop.
				fields: [
					{ id: id(41), included: true },
					{ id: id(40), included: true }
				]
			})
		});
		await expect(port.submissions.addDirectEntry({
			title: 'Streaming agents',
			speakers: [{ name: 'Noor Haddad', email: 'noor@example.test' }],
			trackId,
			formatId,
			disposition: 'inbox'
		})).rejects.toMatchObject({ code: 'direct_entry_form_unavailable' });
	});

	test('tray transitions carry fresh heads and the newest guard in canonical order', async () => {
		const rowA = triageRowDto({ value: 22, version: 5 });
		const rowB = triageRowDto({ value: 21, version: 3 });
		const applied: unknown[] = [];
		const port = composePort({
			triage: fakeTriage({ rows: { [id(21)]: rowB, [id(22)]: rowA }, applied })
		});
		await port.submissions.setAside([id(22), id(21)]);
		expect(applied).toEqual([{
			action: 'set_aside',
			submissionIds: [id(21), id(22)],
			expectedHeads: [
				{ submissionId: id(21), version: 3 },
				{ submissionId: id(22), version: 5 }
			],
			expectedQueryGuard: { version: 7, digestSha256: digest('a') }
		}]);
	});

	test('typed absences stay absences: profile, previous visit, and session doors', async () => {
		const port = composePort({
			sessions: fakeSessions([
				{ id: id(70), title: 'Panel: agents', lifecycle: 'collecting' },
				{ id: id(71), title: 'Keynote', lifecycle: 'programmed' }
			]),
			decisions: decisionState([
				{
					submissionId: id(22),
					head: decidedHead(id(22), 'accepted'),
					origin: {
						schemaVersion: 1,
						scope: { workspaceId, eventId },
						submissionId: id(22),
						sessionId: id(71),
						kind: 'spawned',
						linkedByUserId: id(31),
						linkedAt: '2026-08-13T11:00:00.000Z'
					}
				}
			])
		});
		expect(await port.speakers.profile('a@example.test')).toBeNull();
		expect(await port.visits.previous()).toBeNull();
		expect(await port.schedule.collectingSessions()).toEqual([
			{ id: id(70), title: 'Panel: agents' }
		]);
		expect(await port.schedule.originOf(id(22))).toEqual({
			sessionId: id(71),
			title: 'Keynote',
			kind: 'spawn'
		});
		expect(await port.schedule.originOf(id(23))).toBeNull();
		expect(await port.forms.openCount()).toBe(0);
	});

	test('originsOf reads decision state and the session catalogue once for a set of ids', async () => {
		let decisionReads = 0;
		let catalogReads = 0;
		const baseDecisions = decisionState([
			{
				submissionId: id(22),
				head: decidedHead(id(22), 'accepted'),
				origin: {
					schemaVersion: 1,
					scope: { workspaceId, eventId },
					submissionId: id(22),
					sessionId: id(71),
					kind: 'spawned',
					linkedByUserId: id(31),
					linkedAt: '2026-08-13T11:00:00.000Z'
				}
			}
		]);
		const baseSessions = fakeSessions([
			{ id: id(70), title: 'Panel: agents', lifecycle: 'collecting' },
			{ id: id(71), title: 'Keynote', lifecycle: 'programmed' }
		]);
		const port = composePort({
			sessions: {
				...baseSessions,
				async readCatalog() {
					catalogReads += 1;
					return baseSessions.readCatalog();
				}
			},
			decisions: {
				async readState(ids) {
					decisionReads += 1;
					return baseDecisions.readState(ids);
				}
			}
		});
		expect(port.schedule.originsOf).toBeDefined();
		expect(await port.schedule.originsOf!([id(22), id(23), id(22)])).toEqual({
			[id(22)]: { sessionId: id(71), title: 'Keynote', kind: 'spawn' },
			[id(23)]: null
		});
		expect(decisionReads).toBe(1);
		expect(catalogReads).toBe(1);
	});

	test('originsOf of an empty set reads nothing', async () => {
		let decisionReads = 0;
		let catalogReads = 0;
		const baseSessions = fakeSessions([]);
		const port = composePort({
			sessions: {
				...baseSessions,
				async readCatalog() {
					catalogReads += 1;
					return baseSessions.readCatalog();
				}
			},
			decisions: {
				async readState(ids) {
					decisionReads += 1;
					return decisionState([]).readState(ids);
				}
			}
		});
		expect(await port.schedule.originsOf!([])).toEqual({});
		expect(decisionReads).toBe(0);
		expect(catalogReads).toBe(0);
	});

	test('originsOf refuses when the origin session is not in the catalogue', async () => {
		const port = composePort({
			sessions: fakeSessions([]),
			decisions: decisionState([{
				submissionId: id(22),
				head: decidedHead(id(22), 'accepted'),
				origin: {
					schemaVersion: 1,
					scope: { workspaceId, eventId },
					submissionId: id(22),
					sessionId: id(71),
					kind: 'spawned',
					linkedByUserId: id(31),
					linkedAt: '2026-08-13T11:00:00.000Z'
				}
			}])
		});
		await expect(port.schedule.originsOf!([id(22)])).rejects.toMatchObject({
			name: 'SubmissionsPageLiveError',
			code: 'origin_session_missing'
		});
	});
});
