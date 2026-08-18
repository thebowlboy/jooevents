import { describe, expect, test } from 'bun:test';
import { audiencePreviewRows, reachSentence, unionAudienceGroups } from './audience-union';
import type { RecipientRow } from './types';

/**
 * Combining audiences. The load-bearing claim is that a combination is a set of
 * people, not a sum of group sizes — so every case here is really asking the
 * same question: does the number match the list underneath it.
 */

function person(name: string, email: string, over: Partial<RecipientRow> = {}): RecipientRow {
	return { name, email, state: 'included', ...over };
}

describe('unioning selected audiences', () => {
	test('a person in two groups is written once, and the reach is not the sum', () => {
		const union = unionAudienceGroups([
			{ label: 'Confirmed speakers', rows: [person('Ada', 'ada@x.test'), person('Bo', 'bo@x.test')] },
			{ label: 'Reviewers', rows: [person('Ada', 'ada@x.test'), person('Cy', 'cy@x.test')] }
		]);
		expect(union.recipients.map((row) => row.name)).toEqual(['Ada', 'Bo', 'Cy']);
		expect(union.reach).toBe(3);
		expect(union.overlap).toBe(1);
		expect(union.label).toBe('Confirmed speakers + Reviewers');
	});

	test('the address is the identity, case and surrounding space included', () => {
		const union = unionAudienceGroups([
			{ label: 'A', rows: [person('Ada Lovelace', 'Ada@X.test')] },
			{ label: 'B', rows: [person('A. Lovelace', '  ada@x.test  ')] }
		]);
		expect(union.recipients).toHaveLength(1);
		expect(union.overlap).toBe(1);
	});

	// Two people who spell their names alike are two people. Nothing but the
	// address may merge them.
	test('a shared name is not a shared person', () => {
		const union = unionAudienceGroups([
			{ label: 'A', rows: [person('Alex Kim', 'alex.kim@x.test')] },
			{ label: 'B', rows: [person('Alex Kim', 'akim@y.test')] }
		]);
		expect(union.recipients).toHaveLength(2);
		expect(union.overlap).toBe(0);
	});

	test('rows with no address are never merged into one unknown person', () => {
		const union = unionAudienceGroups([
			{ label: 'A', rows: [person('No Address', ''), person('Also None', '   ')] }
		]);
		expect(union.recipients).toHaveLength(2);
	});

	test('the first group to claim a person owns the copy they receive', () => {
		const union = unionAudienceGroups([
			{ label: 'Confirmed speakers', rows: [person('Ada', 'ada@x.test', { mergeSample: 'Hello Ada' })] },
			{
				label: 'Accepted',
				rows: [
					person('Ada', 'ada@x.test', {
						mergeSample: 'Congratulations Ada',
						mergeValues: { 'submission.title': 'Talk' }
					})
				]
			}
		]);
		expect(union.recipients[0]!.mergeSample).toBe('Hello Ada');
		// Not blended: rendering a message from a context nobody picked would be
		// worse than rendering the one they did.
		expect(union.recipients[0]!.mergeValues).toBeUndefined();
	});

	// A combination may only ever be more careful than its parts.
	test('a state that keeps someone out wins over one that lets them in, with its own reason', () => {
		const union = unionAudienceGroups([
			{ label: 'A', rows: [person('Ada', 'ada@x.test')] },
			{ label: 'B', rows: [person('Ada', 'ada@x.test', { state: 'excluded', reason: 'Unsubscribed' })] }
		]);
		expect(union.recipients[0]!.state).toBe('excluded');
		expect(union.recipients[0]!.reason).toBe('Unsubscribed');
		expect(union.reach).toBe(0);
	});

	test('a block outranks an exclusion however the groups are ordered', () => {
		const blocked = person('Ada', 'ada@x.test', { state: 'blocked', reason: 'No session to name' });
		const excluded = person('Ada', 'ada@x.test', { state: 'excluded', reason: 'Unsubscribed' });
		for (const rows of [[blocked, excluded], [excluded, blocked]]) {
			const union = unionAudienceGroups([
				{ label: 'A', rows: [rows[0]!] },
				{ label: 'B', rows: [rows[1]!] }
			]);
			expect(union.recipients[0]!.state).toBe('blocked');
			expect(union.recipients[0]!.reason).toBe('No session to name');
		}
	});

	// Someone listed twice inside one group — two accepted submissions, say — is
	// one person in one group, not an overlap between groups.
	test('a duplicate inside a single group is deduped without becoming an overlap', () => {
		const union = unionAudienceGroups([
			{ label: 'Accepted', rows: [person('Ada', 'ada@x.test'), person('Ada', 'ada@x.test')] }
		]);
		expect(union.recipients).toHaveLength(1);
		expect(union.reach).toBe(1);
		expect(union.overlap).toBe(0);
	});

	test('reach counts who is actually sent to, not who is listed', () => {
		const union = unionAudienceGroups([
			{
				label: 'A',
				rows: [
					person('In', 'in@x.test'),
					person('Out', 'out@x.test', { state: 'excluded', reason: 'Unsubscribed' }),
					person('Broken', 'broken@x.test', { state: 'blocked', reason: 'No session' })
				]
			}
		]);
		expect(union.recipients).toHaveLength(3);
		expect(union.reach).toBe(1);
	});

	test('no groups is an empty union rather than a guess', () => {
		const union = unionAudienceGroups([]);
		expect(union).toEqual({ recipients: [], label: '', reach: 0, overlap: 0 });
	});
});

describe('the pick-time projection', () => {
	test('carries who and whether, and never the address or the copy', () => {
		const union = unionAudienceGroups([
			{
				label: 'A',
				rows: [
					person('Ada', 'ada@x.test', { mergeSample: 'Hello Ada' }),
					person('Bo', 'bo@x.test', { state: 'excluded', reason: 'Unsubscribed' })
				]
			}
		]);
		expect(audiencePreviewRows(union)).toEqual([
			{ name: 'Ada' as string, state: 'included' },
			{ name: 'Bo', state: 'excluded', reason: 'Unsubscribed' }
		]);
	});
});

describe('the reach line', () => {
	test('states the count alone when nothing overlaps', () => {
		expect(reachSentence({ reach: 42, overlap: 0 })).toBe('Reaches 42 people.');
	});

	test('adds the overlap clause only when there is one, and agrees with itself', () => {
		expect(reachSentence({ reach: 42, overlap: 3 })).toBe(
			'Reaches 42 people · 3 are in more than one group, counted once.'
		);
		expect(reachSentence({ reach: 42, overlap: 1 })).toBe(
			'Reaches 42 people · 1 is in more than one group, counted once.'
		);
	});

	test('one person is a person', () => {
		expect(reachSentence({ reach: 1, overlap: 0 })).toBe('Reaches 1 person.');
		expect(reachSentence({ reach: 0, overlap: 0 })).toBe('Reaches 0 people.');
	});
});

/**
 * The same union through the sample port: the read an operator sees while
 * picking and the rows a draft freezes come from one resolution, so the two can
 * never state different numbers for the same selection.
 */
describe('the sample composer port', () => {
	type Api = typeof import('./workspace').api;

	// The sample db is module state and other suites mutate its roster, so each
	// case counts against its own instance rather than whatever ran first.
	let instance = 0;
	async function freshApi(): Promise<Api> {
		const loaded = (await import(`./workspace?audience-union=${(instance += 1)}`)) as { api: Api };
		return loaded.api;
	}

	test('a combination reaches fewer people than the chips add up to', async () => {
		const api = await freshApi();
		const [speakers, reviewers] = await Promise.all([
			api.communications.previewRecipients(['confirmed-speakers']),
			api.communications.previewRecipients(['reviewers'])
		]);
		const both = await api.communications.previewRecipients(['confirmed-speakers', 'reviewers']);

		expect(both.label).toBe('Confirmed speakers + Reviewers');
		expect(both.overlap).toBeGreaterThan(0);
		// The whole point: the combined figure is resolved, not added.
		expect(both.reach).toBe(speakers.reach + reviewers.reach - both.overlap);
		expect(both.rows).toHaveLength(both.reach);
		// Nobody appears twice in the list the number describes.
		expect(new Set(both.rows.map((row) => row.name)).size).toBe(both.rows.length);
	});

	test('the pick-time list discloses no addresses', async () => {
		const api = await freshApi();
		const preview = await api.communications.previewRecipients(['confirmed-speakers']);
		expect(preview.rows.length).toBeGreaterThan(0);
		for (const row of preview.rows) {
			expect(Object.keys(row).sort()).toEqual(['name', 'state']);
		}
	});

	test('an empty or unknown selection resolves to nothing rather than a substitute', async () => {
		const api = await freshApi();
		expect(await api.communications.previewRecipients([])).toEqual({
			rows: [],
			reach: 0,
			overlap: 0,
			label: ''
		});
		// An id that no longer resolves is dropped; it never silently becomes the
		// first audience on the list.
		expect((await api.communications.previewRecipients(['no-such-audience'])).reach).toBe(0);
	});

	test('the draft freezes the same union the reach line stated', async () => {
		const api = await freshApi();
		const ids = ['confirmed-speakers', 'reviewers'];
		const preview = await api.communications.previewRecipients(ids);
		const draft = await api.communications.compose({ subject: 'Travel details', audienceIds: ids });

		expect(draft.audience).toBe('Confirmed speakers + Reviewers');
		expect(draft.review?.audienceLabel).toBe('Confirmed speakers + Reviewers (current snapshot)');
		// The count beside the review and the count under the chips agree.
		expect(draft.audienceCount).toBe(preview.reach);
		expect(draft.review?.recipients).toHaveLength(preview.rows.length);
		expect(draft.review?.recipients.map((row) => row.name)).toEqual(
			preview.rows.map((row) => row.name)
		);
	});

	test('a person-scoped compose unions that person with any group added beside them', async () => {
		const api = await freshApi();
		const scoped = (await api.communications.audiences('spk-4'))[0]!;
		expect(scoped.personId).toBe('spk-4');

		const alone = await api.communications.previewRecipients([scoped.id]);
		expect(alone.reach).toBe(1);

		// spk-4 is Sofia Berg, a confirmed speaker — so adding that group must
		// absorb her rather than reach her twice.
		const withGroup = await api.communications.previewRecipients([
			scoped.id,
			'confirmed-speakers'
		]);
		const groupOnly = await api.communications.previewRecipients(['confirmed-speakers']);
		expect(withGroup.reach).toBe(groupOnly.reach);
		expect(withGroup.overlap).toBe(1);
		expect(withGroup.label).toBe(`${scoped.label} + Confirmed speakers`);
	});
});
