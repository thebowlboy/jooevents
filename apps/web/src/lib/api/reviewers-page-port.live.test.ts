import { describe, expect, test } from 'bun:test';
import {
	reviewerRosterSnapshotSchema,
	type ReviewerRosterSnapshotDto
} from '@jooevents/contracts/reviewer-roster';
import { reviewSnapshotSchema, type ReviewSnapshot } from '@jooevents/contracts/reviews';
import { mapReviewSnapshot } from './mappers/review';
import { mapReviewerRosterSnapshot } from './mappers/reviewer-roster';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type { ReviewCorePort } from './review-core-port';
import type { ReviewerRosterCorePort } from './reviewer-roster-core-port';
import {
	createLiveReviewersPagePort,
	ReviewersPageLiveError
} from './reviewers-page-port.live';
import type { ScheduleState, SessionItem } from './types';
import type { ProgramFormatView, ProgramTrackView } from './view-models/program-vocabulary';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);
const adaId = id(10);
const benId = id(20);
const caraId = id(30);
const danId = id(40);
const trackId = id(50);

const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const CAPABILITIES = [
	'event.read',
	'speaker.directory.read',
	'submission.read',
	'submission.score',
	'submission.comment',
	'schedule.read'
] as const;

const scope = Object.freeze({ workspaceId: id(1), eventId: id(2) });

function membership(memberId: string) {
	return { kind: 'workspace_membership' as const, id: memberId, version: 1 };
}

function reservation(reservationId: string) {
	return { kind: 'access_reservation' as const, id: reservationId, version: 1 };
}

function rosterSnapshot(): ReviewerRosterSnapshotDto {
	return reviewerRosterSnapshotSchema.parse({
		schemaVersion: 1,
		scope,
		version: 4,
		digestSha256: digest('a'),
		rosterVersion: 3,
		rosterDigestSha256: digest('b'),
		authorityVersion: 2,
		authorityDigestSha256: digest('c'),
		reviewers: [{
			reviewerId: adaId,
			recordVersion: 2,
			projectionVersion: 3,
			status: 'active',
			accessSubject: membership(id(11)),
			authority: {
				schemaVersion: 1,
				scope,
				rosterSubject: membership(id(11)),
				currentSubject: membership(id(11)),
				state: 'active',
				version: 5,
				digestSha256: digest('d'),
				capabilityIds: CAPABILITIES,
				evidenceIds: ['evidence:ada'],
				displayName: 'Ada Bell'
			},
			displayName: 'Ada Bell',
			reviews: [{ kind: 'track', id: trackId }]
		}, {
			reviewerId: benId,
			recordVersion: 1,
			projectionVersion: 1,
			status: 'invited',
			accessSubject: reservation(id(21)),
			authority: {
				schemaVersion: 1,
				scope,
				rosterSubject: reservation(id(21)),
				currentSubject: reservation(id(21)),
				state: 'reserved',
				version: 1,
				digestSha256: digest('e'),
				capabilityIds: CAPABILITIES,
				evidenceIds: ['evidence:ben'],
				displayName: 'Ben Cho'
			},
			// Roster-level display name deliberately undisclosed.
			reviews: []
		}, {
			reviewerId: caraId,
			recordVersion: 1,
			projectionVersion: 2,
			status: 'active',
			accessSubject: membership(id(31)),
			authority: {
				schemaVersion: 1,
				scope,
				rosterSubject: membership(id(31)),
				currentSubject: membership(id(31)),
				state: 'active',
				version: 2,
				digestSha256: digest('1'),
				capabilityIds: CAPABILITIES,
				evidenceIds: ['evidence:cara'],
				displayName: 'Cara Diaz'
			},
			displayName: 'Cara Diaz',
			reviews: []
		}, {
			reviewerId: danId,
			recordVersion: 3,
			projectionVersion: 4,
			status: 'revoked',
			accessSubject: membership(id(41)),
			authority: {
				schemaVersion: 1,
				scope,
				rosterSubject: membership(id(41)),
				state: 'unavailable',
				version: 1,
				digestSha256: digest('2'),
				capabilityIds: [],
				evidenceIds: ['evidence:dan']
			},
			displayName: 'Dan Els',
			reviews: [{ kind: 'track', id: trackId }]
		}]
	});
}

function reviewSnapshot(
	// Unparsed input shape on purpose: the schema parse brands the id.
	viewer: { kind: 'organizer' } | { kind: 'reviewer'; reviewerId: string } = { kind: 'organizer' }
): ReviewSnapshot {
	const adaRow = (assigned: number, done: number, steppedBack = 0, awaiting = 0) => ({
		reviewerId: adaId,
		displayName: 'Ada Bell',
		assigned,
		done,
		steppedBack,
		awaitingReassignment: awaiting
	});
	const defaultCriteria = (criterionId: string) => [{
		id: criterionId, key: 'overall', label: 'Overall', position: 0,
		weightBps: 10_000, scaleMin: 1, scaleMax: 5
	}];
	return reviewSnapshotSchema.parse({
		schemaVersion: 1,
		viewer,
		plans: [{
			id: id(60),
			ordinal: 1,
			name: 'Round 1',
			state: 'closed',
			version: 2,
			scaleMax: 5,
			criteria: defaultCriteria(id(63)),
			deadlineEffectiveAt: '2026-07-28T23:59:59.000Z',
			anonymized: true,
			antiAnchoring: true,
			done: 4,
			total: 4,
			reviewers: [adaRow(4, 4, 1, 1)]
		}, {
			id: id(61),
			ordinal: 2,
			name: 'Discarded round',
			state: 'discarded',
			version: 2,
			scaleMax: 5,
			criteria: defaultCriteria(id(64)),
			deadlineEffectiveAt: '2026-08-20T23:59:59.000Z',
			anonymized: true,
			antiAnchoring: true,
			done: 0,
			total: 9,
			reviewers: [adaRow(9, 0)]
		}, {
			id: id(62),
			ordinal: 3,
			name: 'Round 2',
			state: 'open',
			version: 1,
			scaleMax: 5,
			criteria: defaultCriteria(id(65)),
			deadlineEffectiveAt: '2026-09-01T23:59:59.000Z',
			anonymized: true,
			antiAnchoring: true,
			done: 1,
			total: 2,
			reviewers: [adaRow(2, 1)]
		}],
		standings: {}
	});
}

function rosterPort(): { readonly port: ReviewerRosterCorePort; readonly calls: string[] } {
	const calls: string[] = [];
	const port: ReviewerRosterCorePort = {
		source: { kind: 'live' },
		async readSnapshot() {
			calls.push('readSnapshot');
			return {
				kind: 'success',
				data: mapReviewerRosterSnapshot(rosterSnapshot()),
				correlationId
			};
		},
		async draftChange() {
			calls.push('draftChange');
			throw new Error('unused');
		}
	};
	return { port, calls };
}

function reviewPort(snapshot: ReviewSnapshot = reviewSnapshot()): ReviewCorePort {
	return {
		source: { kind: 'live' },
		async readSnapshot() {
			return { kind: 'success', data: mapReviewSnapshot(snapshot), correlationId };
		},
		async readRoundSetup() {
			throw new Error('unused');
		},
		async draftRoundChange() {
			throw new Error('unused');
		},
		async draftStepBack() {
			throw new Error('unused');
		},
		async draftEvaluationChange() {
			throw new Error('unused');
		},
		async saveEvaluationDraft() {
			throw new Error('unused');
		}
	};
}

function vocabulary(): Pick<ProgramVocabularySettingsPort, 'source' | 'tracks' | 'formats'> {
	const track: ProgramTrackView = {
		kind: 'track',
		id: trackId,
		name: 'AI',
		accent: 'sea',
		status: 'active',
		version: 1,
		usage: { currentReferences: 1, historicalPins: 0 },
		deleteAvailability: { kind: 'available' }
	};
	const format: ProgramFormatView = {
		kind: 'format',
		id: id(51),
		name: 'Talk',
		status: 'active',
		version: 1,
		usage: { currentReferences: 0, historicalPins: 0 },
		deleteAvailability: { kind: 'available' }
	};
	return {
		source: { kind: 'live' },
		tracks: async () => [track],
		formats: async () => [format]
	};
}

function emptyVocabulary(): Pick<ProgramVocabularySettingsPort, 'source' | 'tracks' | 'formats'> {
	return { source: { kind: 'live' }, tracks: async () => [], formats: async () => [] };
}

function session(state: SessionItem['state']): SessionItem {
	return {
		id: id(70),
		title: 'Panel picks',
		speakers: [],
		trackId,
		formatId: id(51),
		durationMin: 30,
		state
	};
}

function scheduleWith(sessions: SessionItem[]): { state(): Promise<ScheduleState> } {
	return {
		state: async () => ({
			days: [],
			rooms: [],
			dayStart: '09:00',
			slotMinutes: 30,
			slotsPerDay: 0,
			sessions,
			placements: [],
			breaks: [],
			published: false
		})
	};
}

function pagePort(overrides: {
	readonly schedule?: { state(): Promise<ScheduleState> };
	readonly review?: ReviewCorePort;
	readonly vocabulary?: Pick<ProgramVocabularySettingsPort, 'source' | 'tracks' | 'formats'>;
} = {}) {
	const roster = rosterPort();
	const page = createLiveReviewersPagePort({
		roster: roster.port,
		review: overrides.review ?? reviewPort(),
		vocabulary: overrides.vocabulary ?? vocabulary(),
		now: () => NOW,
		...(overrides.schedule ? { schedule: overrides.schedule } : {})
	});
	return { page, rosterCalls: roster.calls };
}

async function liveErrorCode(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		if (error instanceof ReviewersPageLiveError) return error.code;
		throw error;
	}
	throw new Error('Expected a ReviewersPageLiveError.');
}

describe('live tuned Reviewers page port', () => {
	test('refuses any non-live composed source', () => {
		const sampleSource = {
			kind: 'sample' as const,
			label: 'Sample data' as const,
			scenario: { key: 'k', name: 'n', description: 'd' }
		};
		expect(() => createLiveReviewersPagePort({
			roster: { ...rosterPort().port, source: sampleSource },
			review: reviewPort(),
			vocabulary: vocabulary()
		})).toThrow(new TypeError('live_reviewer_roster_source_required'));
		expect(() => createLiveReviewersPagePort({
			roster: rosterPort().port,
			review: { ...reviewPort(), source: sampleSource },
			vocabulary: vocabulary()
		})).toThrow(new TypeError('live_reviewer_roster_source_required'));
		expect(() => createLiveReviewersPagePort({
			roster: rosterPort().port,
			review: reviewPort(),
			vocabulary: {
				...vocabulary(),
				source: { kind: 'sample', label: 'Sample data', resettable: true }
			}
		})).toThrow(new TypeError('live_reviewer_roster_source_required'));
	});

	test('serves the roster with plan-summed loads, subject-keyed identity, and the proven-empty coverage claim', async () => {
		// Coverage's empty claim is provable here: an empty live vocabulary and
		// a composed schedule serving no sessions.
		const { page } = pagePort({ vocabulary: emptyVocabulary(), schedule: scheduleWith([]) });
		const roster = await page.reviewers.list();

		expect(roster.reviewers).toEqual([{
			id: adaId,
			name: 'Ada Bell',
			// The canonical roster discloses no email address; absence stays absent.
			email: '',
			status: 'active',
			scope: [{ kind: 'track', id: trackId }],
			// Summed by the one recorded counting module across the non-discarded
			// plans only: 4+2 assigned, 4+1 done — never the discarded round's 9.
			assigned: 6,
			done: 5,
			steppedBack: 1,
			awaitingReassignment: 1
		}, {
			id: benId,
			name: '',
			email: '',
			status: 'invited',
			scope: [],
			assigned: 0,
			done: 0,
			steppedBack: 0,
			awaitingReassignment: 0
		}, {
			id: caraId,
			name: 'Cara Diaz',
			email: '',
			status: 'active',
			scope: [],
			// Named in no plan across the whole served plan population: true zeros.
			assigned: 0,
			done: 0,
			steppedBack: 0,
			awaitingReassignment: 0
		}]);
		// Revoked members are the tuned roster's removed records.
		expect(roster.reviewers.some((row) => row.id === danId)).toBe(false);
		// Active reviewers with no scope; the invited generalist is not counted.
		expect(roster.generalists).toBe(1);
		// [] is served only as this proven positive claim: no active track,
		// format, or collecting-session target exists.
		expect(roster.coverage).toEqual([]);
	});

	test('refuses load counts from a reviewer-scoped review snapshot instead of zeroing other members', async () => {
		// The fixture rows still carry Ada's counts on purpose: the refusal
		// rides the served viewer discriminator, never row shape, because a
		// reviewer-served snapshot filters hidden-identity rounds to the
		// viewer's own row without disclosing which rounds were filtered.
		const { page } = pagePort({
			review: reviewPort(reviewSnapshot({ kind: 'reviewer', reviewerId: adaId })),
			vocabulary: emptyVocabulary(),
			schedule: scheduleWith([])
		});
		expect(await liveErrorCode(page.reviewers.list())).toBe('review_load_population_partial');
	});

	test('refuses coverage whenever a target exists or the empty claim is unprovable', async () => {
		// The same port serves AI/Talk live, so coverage targets exist — and
		// their required per-target submissions count has no live owner.
		const withVocab = pagePort({ schedule: scheduleWith([]) });
		expect(await liveErrorCode(withVocab.page.reviewers.list())).toBe('reviewer_coverage');

		// No schedule delegate: the collecting-session population is unknowable,
		// so [] cannot be proven even with an empty vocabulary.
		const withoutSchedule = pagePort({ vocabulary: emptyVocabulary() });
		expect(await liveErrorCode(withoutSchedule.page.reviewers.list())).toBe('reviewer_coverage');

		// A collecting session is a coverage target of its own.
		const collecting = pagePort({
			vocabulary: emptyVocabulary(),
			schedule: scheduleWith([session('collecting')])
		});
		expect(await liveErrorCode(collecting.page.reviewers.list())).toBe('reviewer_coverage');

		// A retired track still named in a kept member's scope keeps its row.
		const base = vocabulary();
		const retired = pagePort({
			vocabulary: {
				...base,
				tracks: async () => (await base.tracks()).map((track) => ({
					...track,
					status: 'retired' as const
				})),
				formats: async () => []
			},
			schedule: scheduleWith([])
		});
		expect(await liveErrorCode(retired.page.reviewers.list())).toBe('reviewer_coverage');
	});

	test('serves the empty coverage claim past non-collecting sessions', async () => {
		// A programmed session is not a coverage target, so the population is
		// still provably empty.
		const { page } = pagePort({
			vocabulary: emptyVocabulary(),
			schedule: scheduleWith([session('programmed')])
		});
		expect((await page.reviewers.list()).coverage).toEqual([]);
	});

	test('refuses invite per line without invoking any operation', async () => {
		const { page, rosterCalls } = pagePort();
		const lines = await page.reviewers.invite(
			[{ email: 'ada@example.com' }, { email: 'ben@example.com', name: 'Ben' }],
			[{ kind: 'track', id: trackId }]
		);
		expect(lines).toEqual([
			{
				email: 'ada@example.com',
				ok: false,
				reason:
					'Inviting reviewers by email is not available in this live workspace yet. '
					+ 'Reviewer access is reserved through workspace member admission.'
			},
			{
				email: 'ben@example.com',
				ok: false,
				reason:
					'Inviting reviewers by email is not available in this live workspace yet. '
					+ 'Reviewer access is reserved through workspace member admission.'
			}
		]);
		expect(rosterCalls).toEqual([]);
	});

	test('refuses mutations instead of reporting a draft as a completed change', async () => {
		const { page, rosterCalls } = pagePort();
		expect((await page.reviewers.setScope(adaId, [])).ok).toBe(false);
		expect((await page.reviewers.remove(adaId)).ok).toBe(false);
		expect(await liveErrorCode(page.reviewers.restoreScope(adaId, []))).toBe(
			'reviewer_scope_change'
		);
		expect(await liveErrorCode(page.reviewers.restore(
			{
				id: adaId,
				name: 'Ada Bell',
				email: '',
				status: 'active',
				scope: [],
				assigned: 0,
				done: 0,
				steppedBack: 0,
				awaitingReassignment: 0
			},
			0
		))).toBe('reviewer_removal');
		expect(rosterCalls).toEqual([]);
	});

	test('delegates the one schedule read and refuses when no live owner is composed', async () => {
		const state: ScheduleState = {
			days: [],
			rooms: [],
			dayStart: '09:00',
			slotMinutes: 30,
			slotsPerDay: 0,
			sessions: [],
			placements: [],
			breaks: [],
			published: false
		};
		const { page } = pagePort({ schedule: { state: async () => state } });
		expect(await page.schedule.state()).toBe(state);

		const { page: without } = pagePort();
		expect(await liveErrorCode(without.schedule.state())).toBe('reviewer_scope_targets');
	});

	test('maps the live vocabulary without aliasing usage records', async () => {
		const { page } = pagePort();
		expect(await page.vocab.tracks()).toEqual([{
			id: trackId,
			name: 'AI',
			accent: 'sea',
			status: 'active',
			usage: { currentReferences: 1, historicalPins: 0 }
		}]);
		expect(await page.vocab.formats()).toEqual([{
			id: id(51),
			name: 'Talk',
			status: 'active',
			usage: { currentReferences: 0, historicalPins: 0 }
		}]);
	});

	test('propagates failed reads as typed failures, never as zeroed rosters', async () => {
		const failingRoster: ReviewerRosterCorePort = {
			...rosterPort().port,
			async readSnapshot() {
				return { kind: 'unavailable', operation: 'snapshot', reason: 'operation_not_registered' };
			}
		};
		const rosterDown = createLiveReviewersPagePort({
			roster: failingRoster,
			review: reviewPort(),
			vocabulary: vocabulary(),
			now: () => NOW
		});
		expect(await liveErrorCode(rosterDown.reviewers.list())).toBe('operation_not_registered');

		const failingReview: ReviewCorePort = {
			...reviewPort(),
			async readSnapshot() {
				return { kind: 'unavailable', operation: 'snapshot', reason: 'operation_not_registered' };
			}
		};
		const loadsDown = createLiveReviewersPagePort({
			roster: rosterPort().port,
			review: failingReview,
			vocabulary: vocabulary(),
			now: () => NOW
		});
		// An unavailable load counter is a failed roster load, never zeros.
		expect(await liveErrorCode(loadsDown.reviewers.list())).toBe('operation_not_registered');
	});
});
