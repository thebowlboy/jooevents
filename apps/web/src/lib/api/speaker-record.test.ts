import { describe, expect, test } from 'bun:test';
import {
	afterGapStatement,
	continuityCue,
	cueSlotLabel,
	deliverableView,
	deliverableViews,
	nextStep,
	provenanceSentence,
	quietSentence,
	scopedAttention,
	speakerRecordHref
} from './speaker-record';
import type { SpeakerDeliverable, SpeakerRecordSnapshot } from './speaker-record-port';
import type { AssignmentState, EngagementState, SpeakerRow, TaskDef } from './types';

const row = (over: Partial<SpeakerRow> = {}): SpeakerRow => ({
	id: 'spk-5',
	name: 'Lukas Brandt',
	email: 'lukas@perfpanel.se',
	state: 'confirmed',
	sessions: [{ id: 'ses-3', title: 'Panel: Who Owns Agent Reliability?' }],
	tasksDone: 2,
	tasksTotal: 5,
	overdueTasks: 2,
	publiclyVisible: false,
	contentApproved: false,
	position: 4,
	...over
});

const def = (over: Partial<TaskDef> = {}): TaskDef => ({
	id: 'task-travel',
	name: 'Travel details',
	kind: 'form',
	required: true,
	dueAbsolute: 'Sep 18, 23:59 EDT',
	dueRelative: 'in 39 days',
	...over
});

const deliverable = (over: Partial<SpeakerDeliverable> = {}): SpeakerDeliverable => ({
	def: def(),
	assignment: { taskId: 'task-travel', speakerId: 'spk-5', state: 'received', overdue: false },
	submission: {
		kind: 'form',
		submittedAt: 'Aug 15, 09:12 EDT',
		answers: [{ fieldId: 'arrival', label: 'Arriving', value: 'Mon Oct 12, 18:40' }]
	},
	...over
});

const snapshot = (over: Partial<SpeakerRecordSnapshot> = {}): SpeakerRecordSnapshot => ({
	engagement: row(),
	sessions: [
		{
			id: 'ses-3',
			title: 'Panel: Who Owns Agent Reliability?',
			placement: { day: 'Wed Oct 14', time: '14:00–14:45', room: 'Main Stage' },
			href: '/app/schedule?session=ses-3'
		}
	],
	publication: { onLineup: false, provisional: false },
	provenance: { kind: 'editorial' },
	otherEngagements: [],
	deliverables: [],
	thread: null,
	submissions: [],
	publicCard: null,
	profile: {
		schemaVersion: 1,
		workspaceId: '00000000-0000-4000-8000-000000000001',
		eventId: '00000000-0000-4000-8000-000000000002',
		personId: '00000000-0000-4000-8000-000000000003',
		profile: null,
		approvals: []
	},
	history: [],
	...over
});

const assignment = (state: AssignmentState, overdue = false) => ({
	taskId: 'task-travel',
	speakerId: 'spk-5',
	state,
	overdue
});

describe('scoped attention', () => {
	test('a cancellation request leads, and its one remedy is the walk', () => {
		const rows = scopedAttention(
			snapshot({
				engagement: row({ state: 'cancel_requested', note: 'Client emergency.' }),
				deliverables: [deliverable({ assignment: assignment('todo', true) })]
			})
		);

		expect(rows[0].reason).toBe('cancel_requested');
		expect(rows[0].tone).toBe('danger');
		expect(rows[0].detail).toBe('Client emergency.');
	});

	test('the walk has exactly one door on the page, and it is the header’s next step', () => {
		const state = snapshot({ engagement: row({ state: 'cancel_requested' }) });
		const walk = '/app/speakers?panel=cancellation&engagement=spk-5';

		expect(nextStep(state)?.href).toBe(walk);
		expect(scopedAttention(state).filter((entry) => entry.door?.href === walk)).toEqual([]);
	});

	test('a bounced address is this person’s own fact, with the message as its remedy', () => {
		const rows = scopedAttention(
			snapshot({
				thread: {
					personId: 'spk-5',
					personName: 'Lukas Brandt',
					entries: [
						{
							id: 'thr-1',
							at: 'Yesterday, 16:40',
							purpose: 'Speaker onboarding',
							subject: 'Speaker onboarding — what happens next',
							outcome: 'bounced',
							actor: 'you'
						}
					]
				}
			})
		);

		expect(rows).toHaveLength(1);
		expect(rows[0].reason).toBe('bounced');
		expect(rows[0].title).toContain('never received');
		expect(rows[0].door?.href).toBe('/app/messages?person=spk-5');
	});

	test('overdue tasks name themselves and door to the reminder ceremony', () => {
		const rows = scopedAttention(
			snapshot({
				deliverables: [
					deliverable({
						def: def({ id: 'task-av', name: 'AV requirements form' }),
						assignment: { taskId: 'task-av', speakerId: 'spk-5', state: 'todo', overdue: true },
						submission: null
					}),
					deliverable({
						def: def({ id: 'task-headshot', name: 'Headshot upload' }),
						assignment: {
							taskId: 'task-headshot',
							speakerId: 'spk-5',
							state: 'todo',
							overdue: true
						},
						submission: null
					})
				]
			})
		);

		expect(rows).toHaveLength(1);
		expect(rows[0].reason).toBe('overdue_tasks');
		expect(rows[0].title).toBe('2 tasks are past their due date.');
		expect(rows[0].detail).toBe('AV requirements form · Headshot upload');
		expect(rows[0].door?.href).toBe('/app/tasks?speaker=spk-5&filter=overdue');
	});

	test('received work waiting on the organizer is terminal — its rows are on this page', () => {
		const rows = scopedAttention(snapshot({ deliverables: [deliverable()] }));

		expect(rows.map((entry) => entry.reason)).toEqual(['awaiting_review']);
		expect(rows[0].title).toBe('Lukas Brandt sent 1 thing that is waiting for you to read.');
		expect(rows[0].door).toBeUndefined();
	});

	test('an unconfirmed engagement states the wait and leaves the act to the header', () => {
		const rows = scopedAttention(snapshot({ engagement: row({ state: 'invited' }) }));

		expect(rows.map((entry) => entry.reason)).toEqual(['unconfirmed']);
		expect(rows[0].door).toBeUndefined();
	});

	test('a decided-but-unsent result names the person, not the record', () => {
		const rows = scopedAttention(
			snapshot({
				submissions: [
					{
						id: 'sub-102',
						title: 'Typed Tool Contracts',
						decision: 'accepted',
						notified: false,
						href: '/app/submissions?submission=sub-102',
						decisionHref: '/app/decisions?submission=sub-102'
					}
				]
			})
		);

		expect(rows.map((entry) => entry.reason)).toEqual(['result_not_sent']);
		expect(rows[0].title).toBe(
			'Lukas Brandt has not been told the result of their proposal.'
		);
		expect(rows[0].door?.href).toBe('/app/decisions?scope=unnotified');
	});

	test('a notified decision raises nothing', () => {
		const rows = scopedAttention(
			snapshot({
				submissions: [
					{
						id: 'sub-101',
						title: 'Context Caching',
						decision: 'accepted',
						notified: true,
						href: '/app/submissions?submission=sub-101',
						decisionHref: '/app/decisions?submission=sub-101'
					}
				]
			})
		);

		expect(rows).toEqual([]);
	});

	test('a quiet record is empty, and says so calmly', () => {
		expect(scopedAttention(snapshot())).toEqual([]);
		expect(quietSentence('Sofia Berg', 'confirmed')).toBe('Nothing needs you for Sofia Berg.');
	});

	test('a terminal engagement is an archive: the section is empty by definition', () => {
		for (const state of ['declined', 'cancelled'] as const) {
			const rows = scopedAttention(
				snapshot({
					engagement: row({ state }),
					deliverables: [
						deliverable({ assignment: assignment('todo', true), submission: null }),
						deliverable()
					],
					thread: {
						personId: 'spk-5',
						personName: 'Lukas Brandt',
						entries: [
							{
								id: 'thr-1',
								at: 'Yesterday',
								purpose: 'Onboarding',
								subject: 'Onboarding',
								outcome: 'bounced',
								actor: 'you'
							}
						]
					}
				})
			);
			expect(rows).toEqual([]);
		}
		expect(quietSentence('Astrid Holm', 'declined')).toContain('kept as it stands');
	});

	test('the ladder ranks by consequence, not by arrival order', () => {
		const rows = scopedAttention(
			snapshot({
				engagement: row({ state: 'invited' }),
				deliverables: [
					deliverable({ assignment: assignment('todo', true), submission: null }),
					deliverable()
				],
				thread: {
					personId: 'spk-5',
					personName: 'Lukas Brandt',
					entries: [
						{
							id: 'thr-1',
							at: 'Yesterday',
							purpose: 'Onboarding',
							subject: 'Onboarding',
							outcome: 'bounced',
							actor: 'you'
						}
					]
				},
				submissions: [
					{
						id: 'sub-102',
						title: 'Typed Tool Contracts',
						decision: 'accepted',
						notified: false,
						href: '/app/submissions?submission=sub-102',
						decisionHref: '/app/decisions?submission=sub-102'
					}
				]
			})
		);

		expect(rows.map((entry) => entry.reason)).toEqual([
			'bounced',
			'result_not_sent',
			'overdue_tasks',
			'awaiting_review',
			'unconfirmed'
		]);
	});
});

describe('deliverable rendering model', () => {
	test('no accept control renders above unviewable content', () => {
		const view = deliverableView(
			deliverable({ assignment: assignment('received'), submission: null }),
			'confirmed'
		);

		expect(view.content).toBeNull();
		expect(view.acceptable).toBe(false);
		expect(view.acceptRefusal).toBe(
			'Nothing submitted can be read here, so there is nothing to accept yet.'
		);
	});

	test('received material that reads is acceptable', () => {
		const view = deliverableView(deliverable(), 'confirmed');

		expect(view.content?.kind).toBe('form');
		expect(view.acceptable).toBe(true);
		expect(view.acceptRefusal).toBeUndefined();
		expect(view.tone).toBe('received');
	});

	test('a portal draft is never rendered, and the row says not yet submitted', () => {
		const view = deliverableView(
			deliverable({
				assignment: assignment('todo'),
				submission: { kind: 'draft', startedAt: 'Aug 12, 22:41 EDT' }
			}),
			'confirmed'
		);

		expect(view.content).toBeNull();
		expect(view.notYetSubmitted).toBe(true);
		expect(view.acceptable).toBe(false);
		// No accept control exists at all on a todo row, so no refusal is dodged.
		expect(view.acceptRefusal).toBeUndefined();
	});

	test('a draft never becomes content even if the assignment moved on', () => {
		const view = deliverableView(
			deliverable({
				assignment: assignment('received'),
				submission: { kind: 'draft', startedAt: 'Aug 12, 22:41 EDT' }
			}),
			'confirmed'
		);

		expect(view.content).toBeNull();
		expect(view.acceptable).toBe(false);
	});

	test('a quiet todo claims no content area', () => {
		const view = deliverableView(
			deliverable({ assignment: assignment('todo'), submission: null }),
			'confirmed'
		);

		expect(view.content).toBeNull();
		expect(view.notYetSubmitted).toBe(false);
		expect(view.tone).toBe('quiet');
		expect(view.waivable).toBe(true);
	});

	test('an overdue todo takes the overdue tone and leaves the reminder to attention', () => {
		const views = deliverableViews(
			snapshot({
				deliverables: [deliverable({ assignment: assignment('todo', true), submission: null })]
			})
		);

		expect(views[0].tone).toBe('overdue');
		// One fact, one door: the reminder ceremony rides the attention row, and
		// the row here would be a second landing for the same number.
		expect(Object.keys(views[0])).not.toContain('remindHref');
	});

	test('a due figure renders only where it still says something', () => {
		const due = (state: AssignmentState, overdue = false) =>
			deliverableView(
				deliverable({ assignment: assignment(state, overdue), submission: null }),
				'confirmed'
			).due;

		// Waiting work: the countdown is the information.
		expect(due('todo')).toBe('in 39 days');
		expect(due('received')).toBe('in 39 days');
		// The badge already carries the timing, and the definition's countdown can
		// disagree with this person's own overdue flag.
		expect(due('todo', true)).toBeUndefined();
		// Settled: the deadline has stopped mattering.
		expect(due('complete')).toBeUndefined();
		expect(due('late-complete')).toBeUndefined();
		expect(due('waived')).toBeUndefined();
	});

	test('settled work keeps its content and its settlement line', () => {
		for (const state of ['complete', 'late-complete'] as const) {
			const view = deliverableView(
				deliverable({
					assignment: assignment(state),
					settlement: { at: 'Aug 10, 09:31 EDT', by: 'you' }
				}),
				'confirmed'
			);
			expect(view.content?.kind).toBe('form');
			expect(view.settlement?.by).toBe('you');
			expect(view.tone).toBe('settled');
			expect(view.waivable).toBe(false);
		}
	});

	test('a waived assignment claims no content', () => {
		const view = deliverableView(
			deliverable({
				assignment: assignment('waived'),
				settlement: { at: 'Aug 14, 15:20 EDT', by: 'you' }
			}),
			'confirmed'
		);

		expect(view.content).toBeNull();
		expect(view.settlement?.at).toBe('Aug 14, 15:20 EDT');
	});

	test('a terminal engagement keeps its material readable and its acts inert', () => {
		const view = deliverableView(deliverable(), 'cancelled');

		expect(view.content?.kind).toBe('form');
		expect(view.acceptable).toBe(false);
		expect(view.waivable).toBe(false);
		expect(view.acceptRefusal).toContain('closed');
	});

	test('ranks overdue, then waiting, then quiet, then settled', () => {
		const views = deliverableViews(
			snapshot({
				deliverables: [
					deliverable({
						def: def({ id: 'a', name: 'Settled' }),
						assignment: { taskId: 'a', speakerId: 'spk-5', state: 'complete', overdue: false }
					}),
					deliverable({
						def: def({ id: 'b', name: 'Quiet' }),
						assignment: { taskId: 'b', speakerId: 'spk-5', state: 'todo', overdue: false },
						submission: null
					}),
					deliverable({ def: def({ id: 'c', name: 'Waiting' }) }),
					deliverable({
						def: def({ id: 'd', name: 'Late' }),
						assignment: { taskId: 'd', speakerId: 'spk-5', state: 'todo', overdue: true },
						submission: null
					})
				]
			})
		);

		expect(views.map((view) => view.def.name)).toEqual(['Late', 'Waiting', 'Quiet', 'Settled']);
	});
});

describe('header composition', () => {
	test('the continuity cue composes standing · when · where · publication', () => {
		const arms = continuityCue(
			snapshot({ publication: { onLineup: true, provisional: false, releaseNumber: 4 } })
		);

		expect(arms.map((arm) => arm.text)).toEqual([
			'confirmed',
			'Wed 14:00',
			'Main Stage',
			'public since release 4'
		]);
	});

	test('each arm renders only when its fact exists', () => {
		const arms = continuityCue(
			snapshot({
				engagement: row({ state: 'invited' }),
				sessions: [{ id: 'ses-3', title: 'Panel', href: '/app/schedule?session=ses-3' }],
				publication: { onLineup: true, provisional: true }
			})
		);

		expect(arms.map((arm) => arm.key)).toEqual(['standing']);
		expect(arms[0].text).toBe('invited');
	});

	test('the slot label spends the weekday and the start of the range', () => {
		expect(cueSlotLabel({ day: 'Wed Oct 14', time: '14:00–14:45', room: 'Main Stage' })).toBe(
			'Wed 14:00'
		);
		expect(cueSlotLabel({ day: '', time: '', room: 'Main Stage' })).toBeUndefined();
	});

	test('provenance reads in the attribution grammar', () => {
		expect(
			provenanceSentence(
				snapshot({
					provenance: { kind: 'submission', submissionId: 'sub-101', title: 'Context Caching' }
				})
			)
		).toBe('Decided from the submission “Context Caching”.');
		expect(
			provenanceSentence(
				snapshot({ provenance: { kind: 'direct_entry', by: 'Linnea Koski' } })
			)
		).toBe('Direct entry by Linnea Koski.');
		expect(provenanceSentence(snapshot({ provenance: { kind: 'import' } }))).toBe(
			'Added by import.'
		);
		expect(provenanceSentence(snapshot())).toBe('Editorial addition to the roster.');
	});

	test('the one next step follows the roster’s own vocabulary', () => {
		expect(nextStep(snapshot({ engagement: row({ state: 'invited' }) }))?.kind).toBe(
			'record_confirmation'
		);
		const walk = nextStep(snapshot({ engagement: row({ state: 'cancel_requested' }) }));
		expect(walk?.kind).toBe('review_cancellation');
		expect(walk?.href).toBe('/app/speakers?panel=cancellation&engagement=spk-5');
		expect(nextStep(snapshot())).toBeNull();
		expect(nextStep(snapshot({ engagement: row({ state: 'cancelled' }) }))).toBeNull();
	});

	test('the after-gap statement holds only while the lineup still names them', () => {
		expect(
			afterGapStatement(
				snapshot({
					engagement: row({ state: 'cancelled', publiclyVisible: true }),
					publication: { onLineup: true, provisional: false }
				})
			)
		).toContain('Main Stage');
		expect(
			afterGapStatement(
				snapshot({
					engagement: row({ state: 'cancelled' }),
					publication: { onLineup: false, provisional: false }
				})
			)
		).toBeUndefined();
		expect(afterGapStatement(snapshot())).toBeUndefined();
	});

	test('every person-shaped door resolves to the one record URL', () => {
		expect(speakerRecordHref('spk-5')).toBe('/app/speakers/spk-5');
	});
});
