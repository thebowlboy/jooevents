import { describe, expect, test } from 'bun:test';
import { changesetRevisionSelectorSchema } from '@jooevents/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import flight from '../sample/flight';
import fresh from '../sample/fresh';
import { createSampleWorkspacePorts, projectSampleScenario } from './sample-workspace';

function selector(draft: {
	readonly changesetId: string;
	readonly revision: { readonly id: string; readonly digestSha256: string };
}) {
	return changesetRevisionSelectorSchema.parse({
		changesetId: draft.changesetId,
		revisionId: draft.revision.id,
		revisionDigest: draft.revision.digestSha256
	});
}

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

	test('keeps Program Vocabulary inert through draft and propose, commits once, and resets', async () => {
		const ports = createSampleWorkspacePorts(flight);
		const before = await ports.eventProgram.vocabulary.read();
		if (before.kind !== 'success') throw new TypeError('sample_vocabulary_unavailable');
		const drafted = await ports.eventProgram.vocabulary.draft({
			action: 'create',
			input: {
				kind: 'track',
				name: 'Platform engineering',
				expectedSetVersion: before.data.setVersion
			}
		}, { idempotencyKey: 'sample-platform-track-draft' });
		if (drafted.kind !== 'success') throw new TypeError('sample_draft_failed');
		const selected = selector(drafted.data);

		const afterDraft = await ports.eventProgram.vocabulary.read();
		expect(afterDraft.kind === 'success' ? afterDraft.data : afterDraft).toEqual(before.data);
		const diff = await ports.programChangesets.readDiff(selected);
		expect(diff).toMatchObject({
			kind: 'success',
			data: { status: { value: 'draft' }, groups: [{ operations: [{
				kind: 'program.vocabulary.mutate',
				safeDiff: { action: 'create', after: { name: 'Platform engineering' } }
			}] }] }
		});
		expect(await ports.programChangesets.propose(
			{ ...selected, expectedHeadVersion: 1 },
			'sample-platform-track-propose'
		)).toMatchObject({ kind: 'success', data: { status: { value: 'proposed' }, headVersion: 2 } });
		const afterPropose = await ports.eventProgram.vocabulary.read();
		expect(afterPropose.kind === 'success' ? afterPropose.data : afterPropose).toEqual(before.data);
		expect(await ports.programChangesets.commit(
			{ ...selected, expectedHeadVersion: 2 },
			'sample-platform-track-commit'
		)).toMatchObject({
			kind: 'success', data: { expectedHeadVersion: 2, committedHeadVersion: 3 }
		});

		const committed = await ports.eventProgram.vocabulary.read();
		if (committed.kind !== 'success') throw new TypeError('sample_commit_unavailable');
		expect(committed.data.tracks.map((track) => track.name)).toContain('Platform engineering');
		expect(committed.data.setVersion).toBe(before.data.setVersion + 1);

		ports.reset();
		const afterReset = await ports.eventProgram.vocabulary.read();
		expect(afterReset.kind === 'success' ? afterReset.data : afterReset).toEqual(before.data);
		expect(await ports.programChangesets.readDiff(selected)).toMatchObject({ kind: 'outcome' });
	});

	test('resets committed Form state through the same root-owned reset', async () => {
		const ports = createSampleWorkspacePorts(flight);
		const baseline = await ports.forms.list();
		if (baseline.kind !== 'success') throw new TypeError('sample_forms_unavailable');
		const open = baseline.data.forms.find((form) => form.status === 'open');
		if (!open) throw new TypeError('sample_open_form_missing');
		const drafted = await ports.forms.draftLifecycle({
			transition: 'close',
			formId: open.id,
			expectedDefinitionVersion: open.version
		}, 'sample-close-form-draft');
		if (drafted.kind !== 'success') throw new TypeError('sample_form_draft_failed');
		const selected = changesetRevisionSelectorSchema.parse({
			changesetId: drafted.data.changesetId,
			revisionId: drafted.data.revisionId,
			revisionDigest: drafted.data.revisionDigest
		});

		const afterDraft = await ports.forms.list();
		if (afterDraft.kind !== 'success') throw new TypeError('sample_forms_unavailable');
		expect(afterDraft.data.forms.find((form) => form.id === open.id)?.status).toBe('open');
		expect(await ports.formChangesets.propose(
			{ ...selected, expectedHeadVersion: 1 }, 'sample-close-form-propose'
		)).toMatchObject({ kind: 'success' });
		expect(await ports.formChangesets.commit(
			{ ...selected, expectedHeadVersion: 2 }, 'sample-close-form-commit'
		)).toMatchObject({ kind: 'success' });
		const changed = await ports.forms.list();
		if (changed.kind !== 'success') throw new TypeError('sample_forms_unavailable');
		expect(changed.data.forms.find((form) => form.id === open.id)?.status).toBe('closed');

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
			join('..', 'changesets', 'forms-sample.ts'),
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
