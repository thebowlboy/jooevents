import { describe, expect, test } from 'bun:test';
import {
	ACCELEVENTS_LOCATIONS_HEADER,
	computeAcceleventsPreflight,
	createSampleAcceleventsExportPort,
	locationsCsv,
	type AcceleventsExportPort,
	type AcceleventsExportView
} from './accelevents-export-port';

async function resolveEveryBlocker(port: AcceleventsExportPort): Promise<AcceleventsExportView> {
	await port.setSessionType('IN_PERSON');
	await port.mapFormat('format-talk', 'REGULAR_SESSION');
	await port.mapFormat('format-keynote', 'MAIN_STAGE_SESSION');
	await port.setSpeakerName('person-ayodele', 'Ayodele', 'Adeyemi');
	await port.setSpeakerName('person-mary', 'Mary Ann', 'van der Berg');
	await port.setSpeakerName('person-jonas', 'Jonas', 'Weber');
	await port.bindRoom('room-main', { kind: 'remote', locationId: 118 });
	await port.bindRoom('room-4', { kind: 'remote', locationId: 119 });
	return port.bindRoom('room-studio', { kind: 'no_location' });
}

describe('sample export view', () => {
	test('is internally coherent with its selected release', async () => {
		const view = await createSampleAcceleventsExportPort().read();
		const release = view.releases.find((option) => option.id === view.selectedReleaseId);
		expect(release).toBeDefined();
		expect(release!.speakerCount).toBe(view.speakers.length);
		expect(release!.roomCount).toBe(view.rooms.length);
	});

	test('pre-fills names only from exactly two-word display names', async () => {
		const view = await createSampleAcceleventsExportPort().read();
		const maya = view.speakers.find((speaker) => speaker.personId === 'person-maya')!;
		expect(maya).toMatchObject({ firstName: 'Maya', lastName: 'Chen', prefilled: true });
		for (const personId of ['person-ayodele', 'person-mary']) {
			const speaker = view.speakers.find((row) => row.personId === personId)!;
			expect(speaker.firstName).toBe('');
			expect(speaker.lastName).toBe('');
			expect(speaker.prefilled).toBe(false);
		}
	});
});

describe('preflight', () => {
	test('reports every opening blocker with the records it concerns', async () => {
		const view = await createSampleAcceleventsExportPort().read();
		const preflight = computeAcceleventsPreflight(view);
		expect(preflight.ready).toBe(false);
		const byId = new Map(preflight.blockers.map((blocker) => [blocker.id, blocker]));
		expect([...byId.keys()].sort()).toEqual(['formats', 'locations', 'names', 'session-type']);
		expect(byId.get('formats')!.summary).toContain('Talk');
		expect(byId.get('formats')!.summary).toContain('Keynote');
		expect(byId.get('names')!.summary).toContain('Ayodele');
		expect(byId.get('names')!.summary).toContain('Mary Ann van der Berg');
		expect(byId.get('locations')!.summary).toContain('Main Hall');
	});

	test('a speaker without an email blocks the package and sends the reader to Speakers', async () => {
		const view = await createSampleAcceleventsExportPort().read();
		const doctored = {
			...view,
			speakers: view.speakers.map((speaker) =>
				speaker.personId === 'person-jonas' ? { ...speaker, hasApprovedEmail: false } : speaker
			)
		};
		const blocker = computeAcceleventsPreflight(doctored).blockers.find((item) => item.id === 'emails');
		expect(blocker?.summary).toContain('Jonas Weber');
		expect(blocker?.anchor).toBe('/app/speakers');
	});

	test('becomes ready once every blocker is resolved, and counts what the package contains', async () => {
		const port = createSampleAcceleventsExportPort();
		const view = await resolveEveryBlocker(port);
		const preflight = computeAcceleventsPreflight(view);
		expect(preflight.blockers).toEqual([]);
		expect(preflight.ready).toBe(true);
		expect(preflight.contains).toMatchObject({ locations: 2, speakers: 11, sessionRows: 14 });
		expect(preflight.leftOut.map((note) => note.id)).toContain('unplaced-session-lightning');
	});

	test('an unresolved release selection reports nothing but not-ready', async () => {
		const view = await createSampleAcceleventsExportPort().read();
		const preflight = computeAcceleventsPreflight({ ...view, selectedReleaseId: null });
		expect(preflight).toMatchObject({ blockers: [], contains: null, ready: false });
	});

	test('choosing a primary speaker states the remote authority consequence', async () => {
		const port = createSampleAcceleventsExportPort();
		const view = await port.setPrimary('occurrence-panel', 'person-nadia');
		const consequences = computeAcceleventsPreflight(view).consequences;
		const primary = consequences.find((note) => note.id === 'primary-occurrence-panel');
		expect(primary?.summary).toContain('Nadia Osei');
		expect(primary?.summary).toContain('Post-quantum readiness');
	});
});

describe('generate', () => {
	test('refuses while blockers remain', async () => {
		const port = createSampleAcceleventsExportPort();
		await expect(port.generate()).rejects.toThrow('accelevents_export_blocked');
	});

	test('records the generation and then warns about repeat imports', async () => {
		const now = Date.parse('2026-08-17T12:00:00.000Z');
		const port = createSampleAcceleventsExportPort(() => now);
		await resolveEveryBlocker(port);
		const view = await port.generate();
		expect(view.lastGenerated).toEqual({ at: '2026-08-17T12:00:00.000Z', releaseNumber: 4 });
		const repeat = computeAcceleventsPreflight(view).consequences.find((note) => note.id === 'repeat');
		expect(repeat?.summary).toContain('duplicate');
	});
});

describe('locations.csv', () => {
	test('keeps the exact vendor header and safe defaults', async () => {
		const view = await createSampleAcceleventsExportPort().read();
		expect(view.locationsCsvPath).toStartWith('data:text/csv');
		const text = decodeURIComponent(view.locationsCsvPath!.split(',').slice(1).join(','));
		const lines = text.split('\r\n');
		expect(lines[0]).toBe(ACCELEVENTS_LOCATIONS_HEADER);
		expect(lines[1]).toBe('Main Hall,,N');
	});

	test('quotes reserved characters and drops rooms marked as having no location', () => {
		const text = locationsCsv([
			{ roomId: 'a', name: 'Hall "A", East Wing', occurrenceCount: 1, binding: null },
			{ roomId: 'b', name: 'Skipped', occurrenceCount: 1, binding: { kind: 'no_location' } }
		]);
		expect(text).toBe(`${ACCELEVENTS_LOCATIONS_HEADER}\r\n"Hall ""A"", East Wing",,N\r\n`);
	});
});
