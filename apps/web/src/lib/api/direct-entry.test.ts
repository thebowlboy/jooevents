import { describe, expect, test } from 'bun:test';
import { api } from './workspace';

/**
 * Organizer direct entry: the submissions-side door. An entry lands where the
 * disposition says — the review inbox as an undecided candidate, or accepted
 * at creation, graduating into the program — carrying attribution from the
 * signed-in member, never from the caller's input.
 *
 * These run against the loaded scenario's live working copy, so each test
 * compensates through `removeDirectEntry` — the same write the add receipt's
 * undo performs — and asserts the workspace returns to where it started.
 */

const baseInput = {
	title: 'Provenance Under Pressure',
	speakers: [{ name: 'Noor Haddad', email: 'noor@directentry.example' }],
	trackId: 'trk-web',
	formatId: 'fmt-talk'
} as const;

describe('inbox disposition', () => {
	test('lands undecided in the inbox, attributed, newest first', async () => {
		// Copied: the sample API serves its live counts object, and a held
		// reference would silently read the post-mutation values.
		const totalsBefore = { ...(await api.submissions.list({})).trayTotals };
		const created = await api.submissions.addDirectEntry({
			...baseInput,
			speakers: [...baseInput.speakers],
			disposition: 'inbox'
		});

		expect(created.source).toBe('direct_entry');
		expect(created.tray).toBe('inbox');
		expect(created.decision).toBe('undecided');
		expect(created.submittedAt).toBe('Today');
		// Attribution is the signed-in member's name, stated by the server.
		expect(created.enteredBy).toBe('Jere K.');
		// The abstract can wait; absence is an empty string the UI names.
		expect(created.abstract).toBe('');

		const page = await api.submissions.list({ tray: 'inbox' });
		expect(page.rows[0]?.id).toBe(created.id);
		expect(page.trayTotals.inbox).toBe(totalsBefore.inbox + 1);

		await api.submissions.removeDirectEntry(created.id);
		const after = await api.submissions.list({});
		expect(after.rows.some((row) => row.id === created.id)).toBe(false);
		expect(after.trayTotals).toEqual(totalsBefore);
	});
});

describe('accepted disposition', () => {
	test('graduates into the program at creation; undo reverses the graduation', async () => {
		const sessionsBefore = (await api.schedule.state()).sessions.length;
		const created = await api.submissions.addDirectEntry({
			...baseInput,
			speakers: [...baseInput.speakers],
			abstract: 'Invited talk, agreed out-of-band.',
			disposition: 'accepted'
		});

		expect(created.decision).toBe('accepted');
		const spawned = (await api.schedule.state()).sessions.find((session) =>
			(session.originSubmissionIds ?? []).includes(created.id)
		);
		expect(spawned?.title).toBe(created.title);
		// Graduation seeds the person onto the operational roster.
		expect(
			(await api.speakers.list()).some((row) => row.email === 'noor@directentry.example')
		).toBe(true);

		await api.submissions.removeDirectEntry(created.id);
		expect((await api.schedule.state()).sessions.length).toBe(sessionsBefore);
		expect(
			(await api.submissions.list({})).rows.some((row) => row.id === created.id)
		).toBe(false);
		// The person this add introduced leaves with it — no phantom roster row.
		expect(
			(await api.speakers.list()).some((row) => row.email === 'noor@directentry.example')
		).toBe(false);
	});
});

describe('compensation guards', () => {
	test('removal only answers for direct entries', async () => {
		const before = await api.submissions.list({});
		const cfpRow = before.rows.find((row) => row.source === 'cfp');
		expect(cfpRow).toBeDefined();
		await api.submissions.removeDirectEntry(cfpRow!.id);
		const after = await api.submissions.list({});
		expect(after.rows.some((row) => row.id === cfpRow!.id)).toBe(true);
	});
});
