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
import type { WorkspaceTeamSnapshotView } from './view-models/workspace-team';
import type {
	WorkspaceTeamSettingsPort,
	WorkspaceTeamSettingsReadResult
} from './workspace-team-settings-adapter';

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
			accessSubject: reservation(id(12)),
			authority: {
				schemaVersion: 1,
				scope,
				rosterSubject: reservation(id(12)),
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

function teamSnapshot(): WorkspaceTeamSnapshotView {
	const reviewerRole = {
		key: 'speaker_reviewer' as const,
		name: 'Speaker Reviewer' as const,
		version: 1 as const
	};
	return {
		schemaVersion: 1,
		version: 3,
		digestSha256: digest('f'),
		roles: [reviewerRole],
		members: [{
			id: id(11),
			kind: 'member',
			name: 'Ada Bell',
			email: 'ada@example.test',
			role: reviewerRole,
			version: 2,
			hasAdditionalAccess: false,
			subject: { kind: 'member', membershipId: id(11), version: 2 },
			status: 'active',
			userId: id(13)
		}, {
			id: id(21),
			kind: 'invitation',
			name: 'Pending invitation',
			email: 'ben@example.test',
			role: reviewerRole,
			version: 1,
			hasAdditionalAccess: false,
			subject: { kind: 'invitation', reservationId: id(21), version: 1 },
			status: 'invited',
			delivery: 'awaiting_activation'
		}]
	};
}

function teamPort(
	result: WorkspaceTeamSettingsReadResult = {
		kind: 'success',
		data: teamSnapshot(),
		correlationId
	}
): Pick<WorkspaceTeamSettingsPort, 'source' | 'members'> {
	return {
		source: { kind: 'live' },
		members: async () => result
	};
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
	readonly team?: Pick<WorkspaceTeamSettingsPort, 'source' | 'members'>;
	readonly vocabulary?: Pick<ProgramVocabularySettingsPort, 'source' | 'tracks' | 'formats'>;
} = {}) {
	const roster = rosterPort();
	const page = createLiveReviewersPagePort({
		roster: roster.port,
		review: overrides.review ?? reviewPort(),
		team: overrides.team ?? teamPort(),
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
			team: teamPort(),
			vocabulary: vocabulary()
		})).toThrow(new TypeError('live_reviewer_roster_source_required'));
		expect(() => createLiveReviewersPagePort({
			roster: rosterPort().port,
			review: { ...reviewPort(), source: sampleSource },
			team: teamPort(),
			vocabulary: vocabulary()
		})).toThrow(new TypeError('live_reviewer_roster_source_required'));
		expect(() => createLiveReviewersPagePort({
			roster: rosterPort().port,
			review: reviewPort(),
			team: { ...teamPort(), source: sampleSource as never },
			vocabulary: vocabulary()
		})).toThrow(new TypeError('live_reviewer_roster_source_required'));
		expect(() => createLiveReviewersPagePort({
			roster: rosterPort().port,
			review: reviewPort(),
			team: teamPort(),
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
			// Joined by the current membership subject, even though the roster was
			// originally registered against the now-consumed reservation.
			email: 'ada@example.test',
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
			name: 'Pending invitation',
			email: 'ben@example.test',
			status: 'invited',
			scope: [],
			assigned: 0,
			done: 0,
			steppedBack: 0,
			awaitingReassignment: 0
		}, {
			id: caraId,
			name: 'Cara Diaz',
			status: 'active',
			scope: [],
			// Named in no plan across the whole served plan population: true zeros.
			assigned: 0,
			done: 0,
			steppedBack: 0,
			awaitingReassignment: 0
		}]);
		// Cara has a roster identity but no matching Team row. Contact absence is
		// represented by the missing property, never an empty string sentinel.
		expect('email' in roster.reviewers[2]!).toBe(false);
		// Revoked members are the tuned roster's removed records.
		expect(roster.reviewers.some((row) => row.id === danId)).toBe(false);
		// Active reviewers with no scope; the invited generalist is not counted.
		expect(roster.generalists).toBe(1);
		// [] is served only as this proven positive claim: no active track,
		// format, or collecting-session target exists.
		expect(roster.coverage).toEqual({ kind: 'served', rows: [] });
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

	test('declines coverage whenever a target exists or the empty claim is unprovable', async () => {
		// The reviewed copy itself, pinned: this string is what the panel prints.
		const declined = {
			kind: 'unavailable' as const,
			reason: 'Review coverage is not available in this live workspace yet.'
		};

		// The same port serves AI/Talk live, so coverage targets exist — and
		// their required per-target submissions count has no live owner.
		const withVocab = pagePort({ schedule: scheduleWith([]) });
		expect((await withVocab.page.reviewers.list()).coverage).toEqual(declined);

		// No schedule delegate: the collecting-session population is unknowable,
		// so [] cannot be proven even with an empty vocabulary.
		const withoutSchedule = pagePort({ vocabulary: emptyVocabulary() });
		expect((await withoutSchedule.page.reviewers.list()).coverage).toEqual(declined);

		// A collecting session is a coverage target of its own.
		const collecting = pagePort({
			vocabulary: emptyVocabulary(),
			schedule: scheduleWith([session('collecting')])
		});
		expect((await collecting.page.reviewers.list()).coverage).toEqual(declined);

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
		expect((await retired.page.reviewers.list()).coverage).toEqual(declined);
	});

	/**
	 * A surface decides whether to offer a retry from this flag. An unmounted
	 * capability is permanent for this composition, so offering "Try again"
	 * would dress a settled absence as a transient wait — the same conflation
	 * as an eternal skeleton, one step later.
	 */
	test('an unmounted capability declares itself unretryable', async () => {
		const { page } = pagePort();
		try {
			await page.schedule.state();
			throw new Error('Expected the unmounted scope-target read to reject.');
		} catch (error) {
			expect(error).toBeInstanceOf(ReviewersPageLiveError);
			expect((error as ReviewersPageLiveError).code).toBe('reviewer_scope_targets');
			expect((error as ReviewersPageLiveError).retryable).toBe(false);
		}
	});

	/**
	 * The eternal-loading regression. Coverage is one panel beside the roster;
	 * throwing its absence out of `list()` failed the roster read itself, and the
	 * page — which had no failure branch — held skeleton rows forever waiting on
	 * an answer the port had already decided never to give.
	 */
	test('a declined coverage projection still serves the roster it sits beside', async () => {
		const { page } = pagePort({ schedule: scheduleWith([]) });
		const roster = await page.reviewers.list();

		expect(roster.coverage.kind).toBe('unavailable');
		// The spine survives: rows, identities, and the generalist count are all
		// still served, so the surface has something true to render.
		expect(roster.reviewers.length).toBeGreaterThan(0);
		expect(roster.reviewers.every((row) => row.id.length > 0)).toBe(true);
		expect(typeof roster.generalists).toBe('number');
	});

	test('serves the empty coverage claim past non-collecting sessions', async () => {
		// A programmed session is not a coverage target, so the population is
		// still provably empty.
		const { page } = pagePort({
			vocabulary: emptyVocabulary(),
			schedule: scheduleWith([session('programmed')])
		});
		expect((await page.reviewers.list()).coverage).toEqual({ kind: 'served', rows: [] });
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
			team: teamPort(),
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
			team: teamPort(),
			vocabulary: vocabulary(),
			now: () => NOW
		});
		// An unavailable load counter is a failed roster load, never zeros.
		expect(await liveErrorCode(loadsDown.reviewers.list())).toBe('operation_not_registered');

		const teamDown = pagePort({
			team: teamPort({
				kind: 'unavailable', operation: 'members', reason: 'operation_not_registered'
			})
		});
		expect(await liveErrorCode(teamDown.page.reviewers.list())).toBe('operation_not_registered');
	});
});
