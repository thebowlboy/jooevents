import { describe, expect, test } from 'bun:test';
import {
	WORKSPACE_OVERVIEW_AREAS,
	workspaceOverviewProjectionSchema
} from '@jooevents/contracts/workspace-overview';
import type { EventProgramPort } from './event-program/port';
import type { WorkspaceOverviewPort } from './operations/workspace-overview-live';
import type { DeadlineCatalogLivePort } from './operations/deadline-catalog-live';
import type { TaskLiveClient } from './operations/tasks-live';
import { formatDateRange } from '@jooevents/contracts';
import { createLiveOverviewPagePort } from './overview-page-live';
import type { OverviewPageSummary } from './overview-page-port';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

const areas = WORKSPACE_OVERVIEW_AREAS.map((area) => area === 'overview'
	? { area, status: 'available' as const, capabilities: ['workspace.overview.read'] }
	: { area, status: 'unavailable' as const, reason: 'not_implemented' as const });

function projection(overrides: Record<string, unknown> = {}) {
	return workspaceOverviewProjectionSchema.parse({
		schemaVersion: 1,
		event: {
			schemaVersion: 1,
			kind: 'current_event',
			eventSetVersion: 7,
			event: {
				id: id(1),
				name: 'Test Summit',
				timezone: 'Asia/Singapore',
				startDate: '2027-06-10',
				endDate: '2027-06-12',
				version: 3
			}
		},
		areas,
		metrics: {
			forms: { kind: 'exact', total: 5, draft: 1, open: 2, closed: 2 },
			submissions: { kind: 'exact', total: 12 },
			programVocabulary: {
				kind: 'exact',
				rooms: { total: 5, active: 4, retired: 1 },
				tracks: { total: 4, active: 3, retired: 1 },
				formats: { total: 4, active: 2, retired: 2 }
			},
			operations: { kind: 'exact', total: 9 },
			triage: { kind: 'exact', arrived: 12, sorted: 4 },
			reviews: { kind: 'exact', rounds: 1, assignments: 8, committed: 3 },
			reviewers: { kind: 'exact', total: 6 },
			decisions: { kind: 'exact', decided: 2, undecided: 10 },
			engagements: { kind: 'exact', total: 4, confirmed: 1 },
			sessions: { kind: 'exact', total: 6, placed: 2 },
			communications: { kind: 'exact', recipients: 5, sent: 4 },
			templates: { kind: 'exact', total: 7 }
		},
		history: {
			total: 1,
			truncated: false,
			threads: [{
				id: `operation:${id(3)}`,
				domain: 'forms',
				root: { kind: 'operation', receiptId: id(3) },
				firstOccurredAt: '2026-08-13T02:50:00.000Z',
				lastOccurredAt: '2026-08-13T02:55:00.000Z',
				actors: ['agent'],
				surfaces: ['operator_http'],
				latestOperation: { name: 'intake.form.create', version: 1 },
				latestReceipt: {
					id: id(3), operationName: 'intake.form.create', operationVersion: 1
				},
				latestOutcome: { kind: 'success' },
				evidence: { timelineEntries: 3, receipts: 2 }
			}]
		},
		...overrides
	});
}

function overviewPort(data = projection()): WorkspaceOverviewPort {
	return {
		source: { kind: 'live' },
		async read() { return { kind: 'success', data, correlationId: id(4) }; }
	};
}

function eventPort(calls: unknown[]): EventProgramPort['event'] {
	return {
		async read() { throw new Error('not_used'); },
		async create(input, options) {
			calls.push({ input, options });
			return {
				kind: 'success',
				data: {
					eventSetVersion: input.expectedEventSetVersion + 1,
					event: {
						id: id(5), name: input.name, timezone: input.timezone,
						startDate: input.startDate, endDate: input.endDate, version: 1
					}
				},
				receipt: { id: id(6), operationName: 'event.create', operationVersion: 1 },
				correlationId: id(7)
			};
		}
	};
}

describe('live Overview page port', () => {
	test('projects exact metrics and grouped history without inventing missing operational sections', async () => {
		const port = createLiveOverviewPagePort({
			overview: overviewPort(),
			event: eventPort([])
		});
		expect(port.snapshot()).toBeNull();
		const result = await port.read();
		expect(result).toMatchObject({
			kind: 'success',
			data: {
				event: {
					name: 'Test Summit',
					// The one date vocabulary spells this, not the port: a span in the
					// same month says its month once and never breaks across a line,
					// which is why the expectation is the vocabulary's own output
					// rather than a hand-typed twin carrying ordinary spaces.
					dates: formatDateRange('2027-06-10', '2027-06-12'),
					timezone: 'Asia/Singapore'
				},
				arrivals: null,
				navCounts: {
					submissions: '12', review: '38%', speakers: '4', reviewers: '6', templates: '7'
				},
				stats: [
					{ label: 'Forms', value: '5', sub: '2 open · 1 draft · 2 closed' },
					{ label: 'Submissions', value: '12', sub: '12 recorded submissions' },
					{ label: 'Program vocabulary', value: '13', sub: '9 active · 4 retired' },
					{ label: 'Changes', value: '9', sub: '9 recorded changes' }
				],
				attention: [],
				deadlines: [],
				trays: [],
				activity: [{
					id: `operation:${id(3)}`,
					actor: 'agent',
					name: 'An agent',
					text: 'recorded activity in forms',
					// The instant, not a rendering of it. The words are the date
					// vocabulary's job wherever the feed is drawn.
					at: '2026-08-13T02:55:00.000Z'
				}],
				sections: {
					attention: { kind: 'unavailable' },
					// The lanes state their own truth now, so the section carries no
					// apology of its own.
					pipeline: { kind: 'available' },
					deadlines: { kind: 'unavailable' },
					activity: { kind: 'available' },
					trays: { kind: 'unavailable' }
			}
			}
		});
		if (result.kind !== 'success') throw new Error('expected_success');
		expect(result.data.pipeline).toHaveLength(7);
		// Every area in this fixture is `not_implemented` apart from overview, so
		// no lane can be measured and none may claim a lock either: an unwired
		// area is an absence of wiring, never a fact about the event.
		expect(result.data.pipeline.every((stage) =>
			stage.availability.kind === 'unavailable'
			&& stage.state === 'unavailable'
			&& stage.headline === '—'
			&& stage.progress === undefined
			&& stage.paceTone === undefined
		)).toBe(true);
		// The abbreviation is gone: this lane opens the area the sidebar labels
		// Communications, and a control carries its meaning in full words.
		expect(result.data.pipeline.at(-1)?.label).toBe('Messages');
		expect(port.snapshot()).toEqual(result.data);
	});

	// The areas a real deployment actually mounts: every pipeline-relevant area
	// is available or partial, so lane state is decided by the metrics rather
	// than by capability wiring.
	const mountedAreas = WORKSPACE_OVERVIEW_AREAS.map((area) => area === 'templates'
		? { area, status: 'unavailable' as const, reason: 'not_implemented' as const }
		: { area, status: 'available' as const, capabilities: ['workspace.overview.read'] });

	function lane(data: OverviewPageSummary, key: string) {
		const found = data.pipeline.find((stage) => stage.key === key);
		if (!found) throw new Error(`missing_lane_${key}`);
		return found;
	}

	async function readMounted(metrics: Record<string, unknown>) {
		const base = projection();
		const result = await createLiveOverviewPagePort({
			overview: overviewPort(projection({
				areas: mountedAreas,
				metrics: { ...base.metrics, ...metrics }
			})),
			event: eventPort([])
		}).read();
		if (result.kind !== 'success') throw new Error('expected_success');
		return result.data;
	}

	test('a new event states what turns every stage on, one specific condition per lane', async () => {
		const data = await readMounted({
			forms: { kind: 'exact', total: 0, draft: 0, open: 0, closed: 0 },
			submissions: { kind: 'exact', total: 0 },
			triage: { kind: 'exact', arrived: 0, sorted: 0 },
			reviews: { kind: 'exact', rounds: 0, assignments: 0, committed: 0 },
			decisions: { kind: 'exact', decided: 0, undecided: 0 },
			engagements: { kind: 'exact', total: 0, confirmed: 0 },
			sessions: { kind: 'exact', total: 0, placed: 0 },
			communications: { kind: 'exact', recipients: 0, sent: 0 }
		});

		// Held, each with the one sentence naming what turns it on. No figure at
		// all: the dash was a refusal to say, and the condition is the answer.
		expect(data.pipeline.map((stage) => [stage.key, stage.availability])).toEqual([
			['collect', { kind: 'locked', condition: 'Collecting starts when your call for proposals (CFP) opens.' }],
			// Proven by its own arrival count now, not borrowed from the submission
			// total one lane over.
			['triage', { kind: 'locked', condition: 'The first submission to arrive lands here.' }],
			['review', { kind: 'locked', condition: 'Reviewing starts when you open a round.' }],
			['decide', { kind: 'locked', condition: 'Submissions get their answer here, once they arrive.' }],
			['speakers', { kind: 'locked', condition: 'Speakers appear here once you invite someone.' }],
			['schedule', { kind: 'locked', condition: 'Scheduling starts with the first session in the programme.' }],
			['comms', { kind: 'locked', condition: 'Messages appear here once you send your first one.' }]
		]);
		expect(data.pipeline.every((stage) => stage.headline === '' && stage.sub === '')).toBe(true);
		// Nothing is uncounted, so the footnote explaining dashes has nothing to
		// explain — which is the end state the seam request was for.
		expect(data.pipeline.some((stage) => stage.availability.kind === 'unavailable')).toBe(false);

		// An event with no form provably carries no closing date.
		expect(data.sections.deadlines).toEqual({
			kind: 'locked',
			condition: "Deadlines start with a form's closing date."
		});
	});

	test('a running event reports each stage from its own unit of work', async () => {
		const data = await readMounted({
			forms: { kind: 'exact', total: 3, draft: 1, open: 2, closed: 0 },
			submissions: { kind: 'exact', total: 12 },
			triage: { kind: 'exact', arrived: 12, sorted: 4 },
			reviews: { kind: 'exact', rounds: 2, assignments: 8, committed: 3 },
			decisions: { kind: 'exact', decided: 2, undecided: 10 },
			engagements: { kind: 'exact', total: 4, confirmed: 1 },
			sessions: { kind: 'exact', total: 6, placed: 2 },
			communications: { kind: 'exact', recipients: 5, sent: 4 }
		});

		expect(lane(data, 'collect')).toMatchObject({
			headline: '2', sub: 'forms are open to submissions', state: 'ok'
		});
		expect(lane(data, 'review')).toMatchObject({
			headline: '3', sub: 'of 8 reviews are in', state: 'ok'
		});
		// The count the reader will meet at the destination, and the approved
		// wording for it.
		expect(lane(data, 'decide')).toMatchObject({
			headline: '10', sub: 'of 12 submissions are waiting for your answer', state: 'ok'
		});
		expect(lane(data, 'speakers')).toMatchObject({
			headline: '1', sub: 'of 4 speakers have confirmed', state: 'ok'
		});
		expect(lane(data, 'schedule')).toMatchObject({
			headline: '2', sub: 'of 6 sessions have a time and a room', state: 'ok'
		});
		expect(lane(data, 'comms')).toMatchObject({
			headline: '4', sub: 'of 5 messages have been sent', state: 'ok'
		});

		// The outstanding half, matching Decide: the count the reader meets at the
		// destination, whose default tray is the Inbox.
		expect(lane(data, 'triage')).toMatchObject({
			headline: '8', sub: 'of 12 submissions are in the inbox', state: 'ok'
		});
		expect(data.attention).toEqual([
			{
				id: 'submissions-inbox', severity: 'soon', area: 'submissions',
				title: '8 submissions need triage',
				detail: 'They have arrived but have not been sorted yet.',
				action: 'Open submissions'
			},
			{
				id: 'undecided-submissions', severity: 'soon', area: 'decisions',
				title: '10 submissions are waiting for your answer',
				detail: 'They have not received an accept or reject decision yet.',
				action: 'Open decision board'
			}
		]);
		expect(data.sections.attention).toEqual({ kind: 'available' });

		// No lane draws a bar. A meter's job is the tone, a tone is a judgment
		// against a deadline, and this projection carries no deadline at all.
		expect(data.pipeline.every((stage) => stage.progress === undefined)).toBe(true);

		// Every lane answered from its own unit of work, so no dash is rendered
		// anywhere and the footnote that explains dashes has nothing to explain.
		expect(data.pipeline.some((stage) => stage.availability.kind === 'unavailable')).toBe(false);
	});

	test('maps canonical cross-workflow attention counts without inventing unsupported rows', async () => {
		const data = await readMounted({
			triage: { kind: 'exact', arrived: 0, sorted: 0 },
			decisions: { kind: 'exact', decided: 6, undecided: 0 },
			attention: {
				kind: 'exact', resultsNotSent: 4, overdueSpeakerTasks: 3,
				uncoveredReviews: 2, sessionsAwaitingPlacement: 2,
				sessionsMissingSpeakers: 1, failedDeliveries: 1
			}
		});

		expect(data.attention.map((item) => [item.id, item.severity, item.area, item.title])).toEqual([
			['decision-results-not-sent', 'now', 'decisions', '4 results have not been sent'],
			['overdue-speaker-tasks', 'now', 'tasks', '3 speaker tasks are overdue'],
			['uncovered-reviews', 'now', 'review', '2 reviews need coverage'],
			['sessions-awaiting-placement', 'soon', 'schedule', '2 sessions are awaiting placement'],
			['sessions-missing-speakers', 'soon', 'schedule', '1 session is missing speakers'],
			['failed-deliveries', 'now', 'messages', '1 message delivery needs attention']
		]);
		expect(data.attention.some((item) => item.id.includes('import') || item.id.includes('conflict')))
			.toBe(false);
		expect(data.sections.attention).toEqual({ kind: 'available' });
	});

	test('joins the canonical active deadline catalog and ignores cleared heads', async () => {
		const deadlines: DeadlineCatalogLivePort = {
			async read() {
				return {
					kind: 'success', correlationId: id(30), data: {
						schemaVersion: 1,
						scope: { workspaceId: id(31), eventId: id(1) },
						version: 4,
						digestSha256: 'a'.repeat(64),
						deadlines: [
							{
								schemaVersion: 1, id: id(32),
								scope: { workspaceId: id(31), eventId: id(1) },
								kind: 'review_due', version: 2, digestSha256: 'b'.repeat(64),
								gracePolicy: 'soft', status: 'active', displayDate: '2027-06-09',
								effectiveAt: '2027-06-09T16:00:00.000Z',
								boundary: {
									profile: { key: 'deadline.calendar-date.event-local-end-exclusive', version: 1, digestSha256: 'c'.repeat(64) },
									eventTimezone: 'Asia/Singapore', eventVersion: 3, localBoundaryDate: '2027-06-09'
								},
								createdByUserId: id(33), createdAt: '2026-08-13T02:50:00.000Z',
								updatedByUserId: id(33), updatedAt: '2026-08-13T02:55:00.000Z'
							},
							{
								schemaVersion: 1, id: id(34),
								scope: { workspaceId: id(31), eventId: id(1) },
								kind: 'cfp_close', version: 2, digestSha256: 'd'.repeat(64),
								gracePolicy: 'soft', status: 'cleared', displayDate: null,
								effectiveAt: null, boundary: null,
								createdByUserId: id(33), createdAt: '2026-08-13T02:50:00.000Z',
								updatedByUserId: id(33), updatedAt: '2026-08-13T02:55:00.000Z'
							}
						]
					}
				};
			}
		};
		const result = await createLiveOverviewPagePort({
			overview: overviewPort(projection({ areas: mountedAreas })),
			event: eventPort([]),
			deadlines
		}).read();
		if (result.kind !== 'success') throw new Error('expected_success');
		expect(result.data.deadlines).toEqual([{
			label: 'Reviews due',
			displayDate: '2027-06-09',
			effectiveAt: '2027-06-09T16:00:00.000Z'
		}]);
		expect(result.data.sections.deadlines).toEqual({ kind: 'available' });
	});

	test('names a task deadline from the canonical task definition that pins it', async () => {
		const deadlineId = id(40);
		const deadlines: DeadlineCatalogLivePort = {
			async read() {
				return {
					kind: 'success', correlationId: id(41), data: {
						schemaVersion: 1,
						scope: { workspaceId: id(31), eventId: id(1) },
						version: 1,
						digestSha256: 'a'.repeat(64),
						deadlines: [{
							schemaVersion: 1, id: deadlineId,
							scope: { workspaceId: id(31), eventId: id(1) },
							kind: 'task_due', version: 1, digestSha256: 'b'.repeat(64),
							gracePolicy: 'soft', status: 'active', displayDate: '2026-08-20',
							effectiveAt: '2026-08-21T07:00:00.000Z',
							boundary: {
								profile: { key: 'deadline.calendar-date.event-local-end-exclusive', version: 1, digestSha256: 'c'.repeat(64) },
								eventTimezone: 'America/Los_Angeles', eventVersion: 1, localBoundaryDate: '2026-08-20'
							},
							createdByUserId: id(42), createdAt: '2026-08-18T12:00:00.000Z',
							updatedByUserId: id(42), updatedAt: '2026-08-18T12:00:00.000Z'
						}]
					}
				};
			}
		};
		const tasks = {
			async readBoard() {
				return {
					kind: 'success', correlationId: id(43), data: {
						definitions: [{
							current: {
								name: 'Upload headshot',
								deadline: { reference: { id: deadlineId } }
							}
						}]
					}
				};
			}
		} as unknown as Pick<TaskLiveClient, 'readBoard'>;

		const result = await createLiveOverviewPagePort({
			overview: overviewPort(projection({ areas: mountedAreas })),
			event: eventPort([]),
			deadlines,
			tasks
		}).read();
		if (result.kind !== 'success') throw new Error('expected_success');
		expect(result.data.deadlines).toEqual([{
			label: 'Upload headshot',
			displayDate: '2026-08-20',
			effectiveAt: '2026-08-21T07:00:00.000Z'
		}]);
	});

	test('separates the two different reasons reviewing has not begun', async () => {
		const noRound = await readMounted({
			reviews: { kind: 'exact', rounds: 0, assignments: 0, committed: 0 }
		});
		expect(lane(noRound, 'review').availability).toEqual({
			kind: 'locked', condition: 'Reviewing starts when you open a round.'
		});

		const noAssignments = await readMounted({
			reviews: { kind: 'exact', rounds: 1, assignments: 0, committed: 0 }
		});
		expect(lane(noAssignments, 'review').availability).toEqual({
			kind: 'locked', condition: 'Reviewers start once submissions are assigned to them.'
		});
	});

	test('states a finished stage as finished rather than as a fraction of itself', async () => {
		const data = await readMounted({
			forms: { kind: 'exact', total: 2, draft: 1, open: 0, closed: 1 },
			triage: { kind: 'exact', arrived: 12, sorted: 12 },
			decisions: { kind: 'exact', decided: 12, undecided: 0 },
			sessions: { kind: 'exact', total: 6, placed: 6 },
			communications: { kind: 'exact', recipients: 5, sent: 5 }
		});
		expect(lane(data, 'collect').sub).toBe('form is closed, none open');
		expect(lane(data, 'triage').sub).toBe('The inbox is clear');
		expect(lane(data, 'decide').sub).toBe('Every submission has an answer');
		expect(lane(data, 'schedule').sub).toBe('Every session has a time and a room');
		expect(lane(data, 'comms').sub).toBe('Every message has been sent');
	});

	test('an unavailable metric locks nothing — an absent count is not a proof', async () => {
		const reason = { kind: 'unavailable', reason: 'dependency_unavailable' } as const;
		const data = await readMounted({
			forms: reason,
			submissions: reason,
			triage: reason,
			reviews: reason,
			decisions: reason,
			engagements: reason,
			sessions: reason,
			communications: reason
		});
		expect(data.pipeline.every((stage) => stage.availability.kind === 'unavailable')).toBe(true);
		expect(data.sections.deadlines.kind).toBe('unavailable');
	});

	test('uses the read event-set version and caller idempotency key for first-event creation', async () => {
		const calls: unknown[] = [];
		const noEvent = projection({
			event: { schemaVersion: 1, kind: 'no_event', eventSetVersion: 11 },
			metrics: Object.fromEntries([
				'forms', 'submissions', 'programVocabulary', 'operations', 'triage',
				'reviews', 'reviewers', 'decisions', 'engagements', 'sessions',
				'communications', 'templates'
			].map((metric) => [metric, { kind: 'unavailable', reason: 'event_required' }]))
		});
		const port = createLiveOverviewPagePort({
			overview: overviewPort(noEvent),
			event: eventPort(calls)
		});
		expect(await port.createEvent({
			name: 'Too early', timezone: 'UTC', startDate: '2027-01-01', endDate: '2027-01-02',
			idempotencyKey: 'same-key'
		})).toEqual({ ok: false, reason: 'Reload the overview before creating an event.' });
		await port.read();
		expect(await port.createEvent({
			name: 'Created', timezone: 'UTC', startDate: '2027-01-01', endDate: '2027-01-02',
			idempotencyKey: 'same-key'
		})).toEqual({ ok: true });
		expect(calls).toEqual([{
			input: {
				expectedEventSetVersion: 11,
				name: 'Created', timezone: 'UTC', startDate: '2027-01-01', endDate: '2027-01-02'
			},
			options: { idempotencyKey: 'same-key' }
		}]);
	});

	test('keeps transport failure safe and distinct from canonical outcomes', async () => {
		const port = createLiveOverviewPagePort({
			overview: {
				source: { kind: 'live' },
				async read() {
					return {
						kind: 'transport_error',
						error: { code: 'network_unavailable', retryable: true, correlationId: id(8) }
					};
				}
			},
			event: eventPort([])
		});
		expect(await port.read()).toEqual({
			kind: 'transport_error', retryable: true, correlationId: id(8)
		});
	});
});
