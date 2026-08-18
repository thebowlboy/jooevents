import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleFormsPagePort } from './forms-page-port.sample';

describe('sample tuned Forms page port', () => {
	test('projects the existing form, registry, target, and preview dependencies', async () => {
		const port = createSampleFormsPagePort(sampleWorkspaceGateway.api);
		const [forms, tracks, formats, sessions, surfaceId, publication] = await Promise.all([
			port.forms.list(),
			port.vocab.tracks(),
			port.vocab.formats(),
			port.schedule.sessions(),
			port.templates.applicationFormSurfaceId(),
			port.templates.applicationSurfacePublication()
		]);

		expect(forms.length).toBeGreaterThan(0);
		expect(tracks.length).toBeGreaterThan(0);
		expect(formats.length).toBeGreaterThan(0);
		expect(sessions.some((session) => session.state === 'collecting')).toBe(true);
		expect(surfaceId).toBeTruthy();
		expect(publication).toEqual({ kind: 'any' });
	});

	test('retains conditional rules across organizer edits', async () => {
		const port = createSampleFormsPagePort(sampleWorkspaceGateway.api);
		const form = (await port.forms.list())[0]!;
		const rows = await port.forms.fields(form.id);
		const source = rows?.find((row) => row.field.kind === 'checkbox');
		const target = rows?.find((row) => row.field.id !== source?.field.id);
		if (!source || !target) throw new Error('conditional_rule_fixture_missing');
		const rules = [{
			key: 'rule-consent-title',
			condition: { kind: 'checked_is' as const, sourceFieldId: source.field.id, value: true },
			effect: { kind: 'show' as const, targetFieldIds: [target.field.id] }
		}];
		expect(await port.forms.setRules(form.id, rules)).toEqual({ ok: true });
		expect(await port.forms.rules(form.id)).toEqual(rules);
	});
});
