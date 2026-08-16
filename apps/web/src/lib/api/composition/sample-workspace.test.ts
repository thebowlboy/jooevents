import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import flight from '../sample/flight';
import fresh from '../sample/fresh';
import { createSampleWorkspacePorts, projectSampleScenario } from './sample-workspace';

describe('resettable sample workspace composition', () => {
	test('projects the selected scenario through canonical event, vocabulary, and submissions ports', async () => {
		const ports = createSampleWorkspacePorts(flight);
		expect(ports.scenario).toEqual({
			key: 'flight',
			name: 'Mid-flight',
			description: flight.description
		});
		expect(ports.eventProgram.source).toMatchObject({
			kind: 'sample', label: 'Mid-flight', resettable: true
		});
		const event = await ports.eventProgram.event.read();
		expect(event).toMatchObject({
			kind: 'success',
			data: { kind: 'current_event', event: { name: flight.settings?.name } }
		});
		const vocabulary = await ports.eventProgram.vocabulary.read();
		const submissions = await ports.submissions.list();
		if (vocabulary.kind !== 'success' || submissions.kind !== 'success') {
			throw new TypeError('sample_projection_unavailable');
		}
		expect(submissions.data[0]?.target).toMatchObject({
			kind: 'category',
			categoryKind: 'track'
		});
		const firstTarget = submissions.data[0]?.target;
		expect(firstTarget?.kind === 'category'
			&& vocabulary.data.tracks.some((track) => track.id === firstTarget.categoryId)).toBe(true);
	});

	test('applies Program Vocabulary directly once with the caller key and resets', async () => {
		const ports = createSampleWorkspacePorts(flight);
		const before = await ports.eventProgram.vocabulary.read();
		if (before.kind !== 'success') throw new TypeError('sample_vocabulary_unavailable');
		const key = 'sample-platform-track-direct';
		const createInput = {
			kind: 'track' as const,
			name: 'Platform engineering',
			expectedSetVersion: before.data.setVersion
		};
		const applied = await ports.eventProgram.vocabulary.create(createInput, { idempotencyKey: key });
		const replay = await ports.eventProgram.vocabulary.create(createInput, { idempotencyKey: key });
		expect(replay).toEqual(applied);
		expect(applied).toMatchObject({
			kind: 'success',
			data: { action: 'create', kind: 'track', setVersion: before.data.setVersion + 1 },
			receipt: { operationName: 'program_vocabulary.create', operationVersion: 1 }
		});

		const committed = await ports.eventProgram.vocabulary.read();
		if (committed.kind !== 'success') throw new TypeError('sample_commit_unavailable');
		expect(committed.data.tracks.map((track) => track.name)).toContain('Platform engineering');
		expect(committed.data.setVersion).toBe(before.data.setVersion + 1);

		ports.reset();
		const afterReset = await ports.eventProgram.vocabulary.read();
		expect(afterReset.kind === 'success' ? afterReset.data : afterReset).toEqual(before.data);
	});

	test('resets committed Form state through the same root-owned reset', async () => {
		const ports = createSampleWorkspacePorts(flight);
		const baseline = await ports.forms.list();
		if (baseline.kind !== 'success') throw new TypeError('sample_forms_unavailable');
		const open = baseline.data.forms.find((form) => form.status === 'open');
		if (!open) throw new TypeError('sample_open_form_missing');
		const changed = await ports.forms.lifecycle({
			transition: 'close',
			formId: open.id,
			expectedDefinitionVersion: open.version
		}, 'sample-close-form');
		expect(changed).toMatchObject({ kind: 'success', data: { action: 'close' } });
		const afterChange = await ports.forms.list();
		if (afterChange.kind !== 'success') throw new TypeError('sample_forms_unavailable');
		expect(afterChange.data.forms.find((form) => form.id === open.id)?.status).toBe('closed');

		ports.reset();
		const restored = await ports.forms.list();
		if (restored.kind !== 'success') throw new TypeError('sample_forms_unavailable');
		expect(restored.data.forms.find((form) => form.id === open.id)?.status).toBe('open');
	});

	test('keeps the fresh scenario fresh and does not manufacture configured data', () => {
		const projected = projectSampleScenario(fresh);
		expect(projected.fixture).toMatchObject({
			key: 'fresh', currentEvent: { kind: 'no_event' }, vocabulary: null
		});
		expect(projected.submissionsDataset.submissions).toEqual([]);
	});
});

describe('sample source selection', () => {
	test('injects the migrated components and has no live transport or runtime fallback', () => {
		const files = [
			'operator-workspace-root.svelte',
			'operator-page.sample.svelte',
			'sample-workspace.ts',
			join('..', 'event-program', 'sample.ts'),
			join('..', 'sample', 'intake-forms.ts'),
			join('..', 'sample', 'intake-submissions.ts')
		];
		const source = files.map((file) => readFileSync(join(import.meta.dir, file), 'utf8')).join('\n');
		expect(source).not.toMatch(/(?:from|import\s*\()[^\n]*\blive(?:\.|\/)/u);
		expect(source).not.toContain('requestJson');
		expect(source).not.toMatch(/\bfetch\s*\(/u);
		expect(source).not.toContain("source.kind === 'live'");

		const page = readFileSync(join(import.meta.dir, 'operator-page.sample.svelte'), 'utf8');
		for (const component of [
			'OverviewDashboard',
			'SettingsPage',
			'FormsPage',
			'SubmissionsPage'
		]) expect(page).toContain(`<${component}`);
		expect(page).not.toContain('<EventOverview');
		expect(page).not.toContain('<ProgramVocabularyLivePage');
		expect(page).not.toContain('<OrganizerFormsLivePage');
		expect(page).not.toContain('<OrganizerSubmissionsLivePage');
	});
});
