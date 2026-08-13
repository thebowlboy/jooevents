import { describe, expect, test } from 'bun:test';
import { api } from './workspace';
import {
	coverageRows,
	isGeneralist,
	planLoad,
	scopeMatches,
	scopeRefCount,
	sessionCoveredBy,
	type CoverageSource
} from './reviewers';
import { removalBlockReason } from './vocab';
import type { ReviewerInviteLine, ReviewPlan, Reviewer, ScopeRef } from './types';
import flight from './sample/flight';
import opening from './sample/opening';
import crunch from './sample/crunch';
import quiet from './sample/quiet';
import fresh from './sample/fresh';

const scenarios = [flight, opening, crunch, quiet, fresh];

function admitted(line: ReviewerInviteLine): Reviewer {
	if (!line.ok) throw new Error(`expected an admitted line, got: ${line.reason}`);
	return line.reviewer;
}

describe('scope matching', () => {
	const submission = { trackId: 'trk-a', formatId: 'fmt-b' };

	test('a scope set is a union: any matching ref puts the submission in scope', () => {
		expect(scopeMatches([{ kind: 'track', id: 'trk-a' }], submission)).toBe(true);
		expect(scopeMatches([{ kind: 'format', id: 'fmt-b' }], submission)).toBe(true);
		expect(
			scopeMatches(
				[
					{ kind: 'track', id: 'trk-other' },
					{ kind: 'format', id: 'fmt-b' }
				],
				submission
			)
		).toBe(true);
		expect(
			scopeMatches(
				[
					{ kind: 'track', id: 'trk-other' },
					{ kind: 'format', id: 'fmt-other' }
				],
				submission
			)
		).toBe(false);
	});

	test('generalist is the absence of scope: the empty set matches everything', () => {
		expect(scopeMatches([], submission)).toBe(true);
		expect(isGeneralist({ scope: [] })).toBe(true);
		expect(isGeneralist({ scope: [{ kind: 'track', id: 'trk-a' }] })).toBe(false);
	});

	test('a session ref matches no submission while the seam carries no target link', () => {
		expect(scopeMatches([{ kind: 'session', id: 'ses-1' }], submission)).toBe(false);
	});
});

describe('implied session coverage', () => {
	const session = { id: 'ses-1', trackId: 'trk-a', formatId: 'fmt-b' };

	test('a direct session ref covers the session', () => {
		expect(sessionCoveredBy([{ kind: 'session', id: 'ses-1' }], session)).toBe(true);
		expect(sessionCoveredBy([{ kind: 'session', id: 'ses-other' }], session)).toBe(false);
	});

	test('a track ref covers the sessions carrying that track', () => {
		expect(sessionCoveredBy([{ kind: 'track', id: 'trk-a' }], session)).toBe(true);
		expect(sessionCoveredBy([{ kind: 'track', id: 'trk-other' }], session)).toBe(false);
	});

	test('a format ref covers the sessions carrying that format', () => {
		expect(sessionCoveredBy([{ kind: 'format', id: 'fmt-b' }], session)).toBe(true);
		expect(sessionCoveredBy([{ kind: 'format', id: 'fmt-other' }], session)).toBe(false);
	});

	test('a union covers through any ref, and a ref to a retired entry keeps covering', () => {
		// Retirement lives on the referenced entity; the ref itself keeps
		// filtering, so a scope naming a retired track still covers its sessions.
		expect(
			sessionCoveredBy(
				[
					{ kind: 'track', id: 'trk-retired' },
					{ kind: 'format', id: 'fmt-b' }
				],
				{ id: 'ses-2', trackId: 'trk-retired', formatId: 'fmt-b' }
			)
		).toBe(true);
		expect(
			sessionCoveredBy([{ kind: 'track', id: 'trk-retired' }], {
				id: 'ses-2',
				trackId: 'trk-retired',
				formatId: 'fmt-other'
			})
		).toBe(true);
	});

	test('the empty scope implies nothing: a generalist covers via the generalist count, not this predicate', () => {
		expect(sessionCoveredBy([], session)).toBe(false);
	});
});

describe('load numbers', () => {
	test('are sums across every plan naming the reviewer', () => {
		const plans: ReviewPlan[] = [
			{
				id: 'p1',
				name: 'Round 1',
				scaleMax: 5,
				deadlineRelative: 'closed',
				anonymized: true,
				done: 15,
				total: 20,
				antiAnchoring: true,
				reviewers: [
					{ id: 'mem-a', name: 'A', assigned: 10, done: 8, steppedBack: 2, awaitingReassignment: 1 },
					{ id: 'mem-b', name: 'B', assigned: 10, done: 7, steppedBack: 0, awaitingReassignment: 0 }
				]
			},
			{
				id: 'p2',
				name: 'Round 2',
				scaleMax: 5,
				deadlineRelative: 'open',
				anonymized: false,
				done: 3,
				total: 5,
				antiAnchoring: true,
				reviewers: [
					{ id: 'mem-a', name: 'A', assigned: 5, done: 3, steppedBack: 1, awaitingReassignment: 1 }
				]
			}
		];
		expect(planLoad('mem-a', plans)).toEqual({
			assigned: 15,
			done: 11,
			steppedBack: 3,
			awaitingReassignment: 2
		});
		expect(planLoad('mem-b', plans)).toEqual({
			assigned: 10,
			done: 7,
			steppedBack: 0,
			awaitingReassignment: 0
		});
		// A reviewer no plan names — invited, not yet arrived — carries zeros.
		expect(planLoad('mem-c', plans)).toEqual({
			assigned: 0,
			done: 0,
			steppedBack: 0,
			awaitingReassignment: 0
		});
	});
});

describe('coverage projection', () => {
	function fixture(): CoverageSource {
		return {
			tracks: [
				{ id: 'trk-a', name: 'Track A' },
				{ id: 'trk-old', name: 'Retired Track', status: 'retired' },
				{ id: 'trk-gone', name: 'Retired, unscoped', status: 'retired' }
			],
			formats: [{ id: 'fmt-a', name: 'Format A' }],
			sessions: [
				{
					id: 'ses-open',
					title: 'Collecting panel',
					speakers: [],
					trackId: 'trk-a',
					formatId: 'fmt-a',
					durationMin: 45,
					state: 'collecting'
				},
				{
					id: 'ses-set',
					title: 'Programmed talk',
					speakers: [{ name: 'A', email: 'a@fixture.test' }],
					trackId: 'trk-a',
					formatId: 'fmt-a',
					durationMin: 30,
					state: 'programmed'
				}
			],
			submissions: [
				{ trackId: 'trk-a', formatId: 'fmt-a' },
				{ trackId: 'trk-a', formatId: 'fmt-other' },
				{ trackId: 'trk-old', formatId: 'fmt-a' }
			],
			reviewers: [
				{ status: 'active', scope: [{ kind: 'track', id: 'trk-a' }] },
				{ status: 'active', scope: [{ kind: 'track', id: 'trk-old' }] },
				// Invited: on the roster, not covering anything yet.
				{ status: 'invited', scope: [{ kind: 'track', id: 'trk-a' }] },
				// A generalist is not folded into any scoped count.
				{ status: 'active', scope: [] }
			]
		};
	}

	test('rows cover active tracks and formats plus collecting sessions, counting active scoped reviewers', () => {
		const rows = coverageRows(fixture());
		const byId = new Map(rows.map((row) => [row.ref.id, row]));

		expect(byId.get('trk-a')).toEqual({
			ref: { kind: 'track', id: 'trk-a' },
			label: 'Track A',
			reviewers: 1,
			submissions: 2
		});
		expect(byId.get('fmt-a')).toEqual({
			ref: { kind: 'format', id: 'fmt-a' },
			label: 'Format A',
			reviewers: 0,
			submissions: 2
		});
		// The collecting session is a row; the programmed one is not. Its
		// reviewer count includes implied coverage — the active trk-a holder
		// covers this trk-a session — while the invited holder and the
		// generalist stay out. Its submission count stays 0 until the
		// submission→target link exists.
		expect(byId.get('ses-open')).toEqual({
			ref: { kind: 'session', id: 'ses-open' },
			label: 'Collecting panel',
			reviewers: 1,
			submissions: 0
		});
		expect(byId.has('ses-set')).toBe(false);
	});

	test('session rows count implied coverage across the seeded scenarios', () => {
		// Flight: the collecting infrastructure panel is covered by Jonas
		// (track ref) and Tomás (track ref and the session ref itself — one
		// reviewer, counted once). The collecting lightning slot's only
		// implying holder is Priya, still invited, so it stays at 0.
		const flightRows = coverageRows({
			tracks: flight.tracks,
			formats: flight.formats,
			sessions: flight.schedule.sessions,
			submissions: flight.submissions,
			reviewers: flight.reviewers
		});
		const panel = flightRows.find((row) => row.ref.kind === 'session' && row.ref.id === 'ses-11');
		expect(panel?.reviewers).toBe(2);
		const lightning = flightRows.find(
			(row) => row.ref.kind === 'session' && row.ref.id === 'ses-12'
		);
		expect(lightning?.reviewers).toBe(0);

		// Crunch: nobody holds the eval track or the panel format, so the
		// collecting eval panel honestly shows zero scoped coverage.
		const crunchRows = coverageRows({
			tracks: crunch.tracks,
			formats: crunch.formats,
			sessions: crunch.schedule.sessions,
			submissions: crunch.submissions,
			reviewers: crunch.reviewers
		});
		const evalPanel = crunchRows.find(
			(row) => row.ref.kind === 'session' && row.ref.id === 'ses-19'
		);
		expect(evalPanel?.reviewers).toBe(0);
	});

	test('a retired entry keeps a row only while a scope still names it, flagged for re-scoping', () => {
		const rows = coverageRows(fixture());
		const retired = rows.find((row) => row.ref.id === 'trk-old');
		expect(retired?.retired).toBe(true);
		expect(retired?.reviewers).toBe(1);
		expect(rows.some((row) => row.ref.id === 'trk-gone')).toBe(false);
	});

	test('quiet seeds a scope ref to a retired format: it keeps rendering, flagged, never re-offered', () => {
		// The ref outlives the entry's retirement (VocabStatus contract).
		const tomas = quiet.reviewers.find((reviewer) => reviewer.id === 'mem-8');
		expect(tomas?.scope).toContainEqual({ kind: 'format', id: 'fmt-lightning' });
		expect(quiet.formats.find((format) => format.id === 'fmt-lightning')?.status).toBe('retired');

		// Coverage keeps the row while a scope names it, flagged for re-scoping.
		const rows = coverageRows({
			tracks: quiet.tracks,
			formats: quiet.formats,
			sessions: quiet.schedule.sessions,
			submissions: quiet.submissions,
			reviewers: quiet.reviewers
		});
		const lightning = rows.find((row) => row.ref.kind === 'format' && row.ref.id === 'fmt-lightning');
		expect(lightning?.retired).toBe(true);
		expect(lightning?.reviewers).toBe(1);
	});

	test('crunch is the pressure case: a track with zero scoped reviewers beside two generalists', () => {
		expect(scopeRefCount('track', 'trk-ai', crunch.reviewers)).toBe(0);
		expect(crunch.reviewers.filter((r) => r.status === 'active' && isGeneralist(r)).length).toBe(2);
	});
});

describe('scenario coherence', () => {
	test('reviewer ids are member ids, and plan rosters point at reviewer records', () => {
		for (const scenario of scenarios) {
			const memberIds = new Set(scenario.members.map((member) => member.id));
			const reviewerIds = new Set(scenario.reviewers.map((reviewer) => reviewer.id));
			for (const reviewer of scenario.reviewers) {
				expect(memberIds.has(reviewer.id)).toBe(true);
			}
			for (const plan of scenario.reviewPlans) {
				for (const row of plan.reviewers) {
					expect(reviewerIds.has(row.id)).toBe(true);
				}
			}
		}
	});

	test('every scope ref resolves to a record that exists in its scenario', () => {
		for (const scenario of scenarios) {
			const known: Record<ScopeRef['kind'], Set<string>> = {
				track: new Set(scenario.tracks.map(({ id }) => id)),
				format: new Set(scenario.formats.map(({ id }) => id)),
				session: new Set(scenario.schedule.sessions.map(({ id }) => id))
			};
			for (const reviewer of scenario.reviewers) {
				for (const ref of reviewer.scope) {
					expect(known[ref.kind].has(ref.id)).toBe(true);
				}
			}
		}
	});

	test('plan meters are their roster sums, and awaiting reassignment never exceeds stepped back', () => {
		for (const scenario of scenarios) {
			for (const plan of scenario.reviewPlans) {
				const assigned = plan.reviewers.reduce((sum, row) => sum + row.assigned, 0);
				const done = plan.reviewers.reduce((sum, row) => sum + row.done, 0);
				expect(assigned).toBe(plan.total);
				expect(done).toBe(plan.done);
				for (const row of plan.reviewers) {
					expect(row.done).toBeLessThanOrEqual(row.assigned);
					expect(row.awaitingReassignment).toBeLessThanOrEqual(row.steppedBack);
				}
			}
		}
	});

	test('an uncovered review stays in assigned: the flight badge counts awaiting reassignment, denominators unmoved', () => {
		const plan = flight.reviewPlans[0];
		const awaiting = plan.reviewers.reduce((sum, row) => sum + row.awaitingReassignment, 0);
		expect(awaiting).toBe(3);
		expect(flight.summary.attention.find((item) => item.id === 'needs-reviewer')?.title).toBe(
			`${awaiting} reviews need another reviewer`
		);
	});

	// A collecting session may hold a planned slot on the grid (placement is
	// orthogonal to state); what it may never hold is people — the roster is
	// written only at acceptance, and acceptance graduates the session.
	test('a collecting session never carries a roster', () => {
		for (const scenario of scenarios) {
			for (const session of scenario.schedule.sessions) {
				if (session.state === 'collecting') expect(session.speakers).toEqual([]);
			}
		}
	});

	test('the datasets never say "recused" — step-back vocabulary only', () => {
		expect(JSON.stringify(scenarios)).not.toMatch(/recus/i);
	});
});

describe('reviewers namespace', () => {
	test('the roster read: loads summed across plans, generalists counted, coverage server-side', async () => {
		const roster = await api.reviewers.list();
		expect(roster.reviewers.length).toBe(6);
		expect(roster.generalists).toBe(2);

		const sofia = roster.reviewers.find((reviewer) => reviewer.id === 'mem-2');
		expect(sofia).toMatchObject({ assigned: 72, done: 68, steppedBack: 0, awaitingReassignment: 0 });

		// Invited and in no plan roster yet: zeros, not blanks or guesses.
		const priya = roster.reviewers.find((reviewer) => reviewer.status === 'invited');
		expect(priya).toMatchObject({ id: 'mem-5', assigned: 0, done: 0 });

		const infra = roster.coverage.find(
			(row) => row.ref.kind === 'track' && row.ref.id === 'trk-infra'
		);
		expect(infra?.reviewers).toBe(2);
		expect(infra?.submissions).toBe(
			flight.submissions.filter((submission) => submission.trackId === 'trk-infra').length
		);

		// Evals & Reliability has only an invited scope-holder, so its scoped
		// count is honestly 0 — the generalist count answers for it.
		const ai = roster.coverage.find((row) => row.ref.kind === 'track' && row.ref.id === 'trk-ai');
		expect(ai?.reviewers).toBe(0);

		const collecting = roster.coverage.filter((row) => row.ref.kind === 'session');
		expect(collecting.map((row) => row.ref.id).sort()).toEqual(['ses-11', 'ses-12']);
		expect(collecting.every((row) => row.submissions === 0)).toBe(true);
		// The door numbers carry implied coverage: track-scoped Jonas and Tomás
		// cover the infrastructure panel; the lightning slot's only implying
		// holder is invited, so it stays 0.
		expect(collecting.find((row) => row.ref.id === 'ses-11')?.reviewers).toBe(2);
		expect(collecting.find((row) => row.ref.id === 'ses-12')?.reviewers).toBe(0);
	});

	test('setScope refuses refs to nothing, replaces the set, and restoreScope puts the prior set back', async () => {
		const refused = await api.reviewers.setScope('mem-2', [{ kind: 'track', id: 'trk-missing' }]);
		expect(refused).toEqual({ ok: false, reason: 'Scope names a track that does not exist' });

		const outcome = await api.reviewers.setScope('mem-2', [{ kind: 'session', id: 'ses-11' }]);
		expect(outcome).toEqual({ ok: true });
		let roster = await api.reviewers.list();
		expect(roster.generalists).toBe(1);

		await api.reviewers.restoreScope('mem-2', []);
		roster = await api.reviewers.list();
		expect(roster.reviewers.find((reviewer) => reviewer.id === 'mem-2')?.scope).toEqual([]);
		expect(roster.generalists).toBe(2);
	});

	test('invite reports per line and admits reviewers as members — one system, no parallel roster', async () => {
		const lines = await api.reviewers.invite(
			[
				{ email: 'dana@reviewcraft.example', name: 'Dana Whitfield' },
				{ email: 'not-an-address' },
				{ email: 'sofia@perfpanel.se' }
			],
			[{ kind: 'track', id: 'trk-ai' }]
		);
		expect(lines.length).toBe(3);

		const dana = admitted(lines[0]);
		expect(dana.status).toBe('invited');
		expect(dana.scope).toEqual([{ kind: 'track', id: 'trk-ai' }]);
		expect(dana).toMatchObject({ assigned: 0, done: 0 });

		expect(lines[1]).toEqual({
			email: 'not-an-address',
			ok: false,
			reason: 'Not a valid email address'
		});
		expect(lines[2]).toEqual({
			email: 'sofia@perfpanel.se',
			ok: false,
			reason: 'Already on the reviewer roster'
		});

		// The admitted address is now a member reservation with the preset.
		const members = await api.settings.members();
		const member = members.find((entry) => entry.email === 'dana@reviewcraft.example');
		expect(member).toMatchObject({ id: dana.id, role: 'Speaker Reviewer', status: 'invited' });
	});

	test('inviting an existing member gains them the reviewer record under the same id', async () => {
		const membersBefore = (await api.settings.members()).length;
		const lines = await api.reviewers.invite([{ email: 'linnea@aie-demo.example' }]);
		const linnea = admitted(lines[0]);
		expect(linnea.id).toBe('mem-4');
		expect(linnea.status).toBe('active');
		expect((await api.settings.members()).length).toBe(membersBefore);
	});

	test('an unresolvable initial scope refuses every line rather than storing a ref to nothing', async () => {
		const lines = await api.reviewers.invite([{ email: 'new@reviewcraft.example' }], [
			{ kind: 'session', id: 'ses-missing' }
		]);
		expect(lines).toEqual([
			{
				email: 'new@reviewcraft.example',
				ok: false,
				reason: 'Scope names a session that does not exist'
			}
		]);
	});

	test('remove takes a reviewer off the roster; restore puts them back and recounts their load from the plans', async () => {
		const roster = await api.reviewers.list();
		const index = roster.reviewers.findIndex((reviewer) => reviewer.id === 'mem-8');
		const marc = roster.reviewers[index];
		expect(marc.assigned).toBe(72);

		expect(await api.reviewers.remove('mem-8')).toEqual({ ok: true });
		const without = await api.reviewers.list();
		expect(without.reviewers.some((reviewer) => reviewer.id === 'mem-8')).toBe(false);

		await api.reviewers.restore(marc, index);
		const restored = await api.reviewers.list();
		expect(restored.reviewers[index]?.id).toBe('mem-8');
		// The load came back from the plans, not from the carried record.
		expect(restored.reviewers[index]?.done).toBe(25);
	});
});

describe('scope refs join the removal guards', () => {
	const unused = { submissions: 0, sessions: 0, placements: 0 };

	test('a ref in someone\'s scope blocks removal and the reason counts the scopes; nothing at all stays removable', () => {
		expect(removalBlockReason('track', unused, 'active', 2)).toBe(
			'This track is in 2 reviewer scopes. Retire it to stop new use — everything already using it keeps rendering.'
		);
		expect(removalBlockReason('format', unused, 'active', 1)).toBe(
			'This format is in 1 reviewer scope. Retire it to stop new use — everything already using it keeps rendering.'
		);
		expect(removalBlockReason('track', unused, 'active', 0)).toBeNull();
	});

	test('usage and scopes compose into one sentence', () => {
		const reason = removalBlockReason(
			'track',
			{ submissions: 3, sessions: 1, placements: 0 },
			'active',
			2
		);
		expect(reason).toBe(
			'4 submissions and sessions reference this track, and it is in 2 reviewer scopes. Retire it to stop new use — everything already using it keeps rendering.'
		);
	});

	test('the api refuses removing a scoped track and still allows retiring it', async () => {
		expect(scopeRefCount('track', 'trk-infra', flight.reviewers)).toBe(2);
		const removal = await api.vocab.removeTrack('trk-infra');
		expect(removal.ok).toBe(false);
		if (!removal.ok) expect(removal.reason).toContain('2 reviewer scopes');

		const retirement = await api.vocab.retireTrack('trk-infra');
		expect(retirement).toEqual({ ok: true });
		await api.vocab.restoreTrack('trk-infra');
	});
});
