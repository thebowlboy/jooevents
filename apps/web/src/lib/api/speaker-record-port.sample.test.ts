import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleSpeakerRecordPort } from './speaker-record-port.sample';
import { deliverableView, deliverableViews, provenanceSentence } from './speaker-record';

const port = createSampleSpeakerRecordPort(sampleWorkspaceGateway.api);

/** The flight scenario is what the test environment loads. */
const LUKAS = 'spk-5';
const ELENA = 'spk-7';
const DANIEL = 'spk-8';

describe('sample speaker record port', () => {
	test('answers one engagement whole, and answers nothing for an id that names none', async () => {
		expect(await port.record.read('spk-never-existed')).toBeNull();

		const snapshot = await port.record.read(LUKAS);
		if (!snapshot) throw new Error('the flight scenario must seed spk-5');

		expect(snapshot.engagement.name).toBe('Lukas Brandt');
		expect(snapshot.sessions.length).toBeGreaterThan(0);
		expect(snapshot.deliverables.length).toBeGreaterThan(0);
		expect(snapshot.thread?.personId).toBe(LUKAS);
		// The record's own submission provenance, joined through the session's
		// origin link rather than guessed from the address.
		expect(provenanceSentence(snapshot)).toBe('Direct entry by Linnea Koski.');
	});

	test('the placement is joined from the grid, not stored on the roster row', async () => {
		const snapshot = await port.record.read(LUKAS);
		const placed = snapshot?.sessions.find((session) => session.placement);
		expect(placed?.placement?.room.length).toBeGreaterThan(0);
		expect(placed?.placement?.time).toContain('–');
		expect(placed?.href).toBe(`/app/schedule?session=${placed?.id}`);
	});

	test('a received form arrives with the answers behind it', async () => {
		const snapshot = await port.record.read(LUKAS);
		if (!snapshot) throw new Error('missing snapshot');

		const travel = snapshot.deliverables.find((entry) => entry.def.id === 'task-travel');
		expect(travel?.assignment.state).toBe('received');
		expect(travel?.submission?.kind).toBe('form');
		if (travel?.submission?.kind !== 'form') throw new Error('travel details must be a form');
		expect(travel.submission.answers.map((answer) => answer.label)).toContain('Dietary requirements');

		const view = deliverableView(travel, snapshot.engagement.state);
		expect(view.acceptable).toBe(true);
	});

	test('a received assignment whose material cannot be read refuses the accept in place', async () => {
		const snapshot = await port.record.read(ELENA);
		if (!snapshot) throw new Error('the flight scenario must seed spk-7');

		const slides = snapshot.deliverables.find((entry) => entry.def.id === 'task-slides');
		expect(slides?.assignment.state).toBe('received');
		expect(slides?.submission).toBeNull();

		const view = deliverableView(slides!, snapshot.engagement.state);
		expect(view.acceptable).toBe(false);
		expect(view.acceptRefusal).toContain('nothing to accept');
	});

	test('a portal draft never reaches the record’s rendering model', async () => {
		const snapshot = await port.record.read(ELENA);
		if (!snapshot) throw new Error('missing snapshot');

		const headshot = snapshot.deliverables.find((entry) => entry.def.id === 'task-headshot');
		// The fixture holds Elena's unsubmitted autosave on purpose…
		expect(headshot?.submission?.kind).toBe('draft');
		// …and the view discards it. The type already forbids a draft reaching
		// `content`, so the runtime check is that no rendered material anywhere on
		// this record is the draft object the fixture holds.
		const views = deliverableViews(snapshot);
		expect(views.some((view) => view.content === headshot?.submission)).toBe(false);
		const headshotView = views.find((view) => view.def.id === 'task-headshot');
		expect(headshotView?.content).toBeNull();
		expect(headshotView?.notYetSubmitted).toBe(true);
	});

	test('a waived assignment carries who waived it and when, and claims no content', async () => {
		const snapshot = await port.record.read(DANIEL);
		if (!snapshot) throw new Error('the flight scenario must seed spk-8');

		const slides = snapshot.deliverables.find((entry) => entry.def.id === 'task-slides');
		expect(slides?.assignment.state).toBe('waived');
		expect(slides?.settlement?.by.length).toBeGreaterThan(0);
		expect(deliverableView(slides!, snapshot.engagement.state).content).toBeNull();
	});

	test('accepting commits through the registered act and restores exactly', async () => {
		const before = await port.record.read(LUKAS);
		const travelBefore = before?.deliverables.find((entry) => entry.def.id === 'task-travel');
		if (!travelBefore) throw new Error('missing travel assignment');

		expect(await port.deliverables.accept('task-travel', LUKAS)).toEqual({ ok: true });

		const after = await port.record.read(LUKAS);
		const travelAfter = after?.deliverables.find((entry) => entry.def.id === 'task-travel');
		expect(travelAfter?.assignment.state).toBe('complete');
		// The material survives acceptance — the archive is the point.
		expect(travelAfter?.submission?.kind).toBe('form');
		expect(travelAfter?.settlement?.by).toBe('you');

		// A second accept is refused rather than silently completing twice.
		const repeat = await port.deliverables.accept('task-travel', LUKAS);
		expect(repeat.ok).toBe(false);

		await port.deliverables.restore(
			'task-travel',
			LUKAS,
			travelBefore.assignment.state,
			travelBefore.assignment.overdue
		);
		const restored = await port.record.read(LUKAS);
		const travelRestored = restored?.deliverables.find((entry) => entry.def.id === 'task-travel');
		expect(travelRestored?.assignment.state).toBe('received');
		expect(travelRestored?.settlement).toBeUndefined();
	});
});
