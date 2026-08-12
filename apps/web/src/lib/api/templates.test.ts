import { describe, expect, test } from 'bun:test';
import { api } from './workspace';
import { starterTemplates } from './sample/templates';
import crunch from './sample/crunch';
import fresh from './sample/fresh';
import type { AnyTemplate, MessageTemplate, ReviseProgress, SurfaceTemplate, TemplateBlock } from './types';

/** Every `{{token}}` used anywhere in a template's subject or blocks. */
function tokensOf(template: MessageTemplate): string[] {
	const texts: string[] = [template.subject];
	for (const block of template.blocks) {
		if (block.type === 'heading' || block.type === 'paragraph') texts.push(block.text);
		else if (block.type === 'details') for (const row of block.rows) texts.push(row.label, row.value);
		else if (block.type === 'button') texts.push(block.label);
	}
	const found = new Set<string>();
	for (const text of texts) {
		for (const match of text.matchAll(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi)) found.add(match[1]);
	}
	return [...found];
}

function buttonOf(blocks: TemplateBlock[]) {
	return blocks.find((block) => block.type === 'button');
}

describe('starter template set', () => {
	const starters = starterTemplates();

	test('ships the six base templates under their stable keys', () => {
		expect(starters.map((template) => template.key)).toEqual([
			'decision-accepted',
			'decision-waitlisted',
			'decision-declined',
			'speaker-invitation',
			'task-reminder',
			'schedule-announcement'
		]);
		for (const template of starters) {
			expect(template.revision).toBe(1);
			expect(template.revisions).toEqual([
				{ number: 1, at: 'At event creation', by: 'you', note: 'Starter' }
			]);
		}
	});

	test('every merge token used is declared, and every sample is realistic', () => {
		for (const template of starters) {
			const declared = template.mergeFields.map((field) => field.key);
			for (const token of tokensOf(template)) expect(declared).toContain(token);
			for (const field of template.mergeFields) {
				expect(field.label.length).toBeGreaterThan(0);
				expect(field.sample.length).toBeGreaterThan(0);
				// A sample is a resolved value, never a token itself.
				expect(field.sample).not.toContain('{{');
			}
		}
	});

	test('each template carries one CTA whose href is a symbolic ref, not a URL', () => {
		for (const template of starters) {
			const buttons = template.blocks.filter((block) => block.type === 'button');
			expect(buttons).toHaveLength(1);
			expect(buttons[0].href).toMatch(/^[a-z]+\.[a-z]+$/);
		}
	});

	test('details blocks sit where they earn their place', () => {
		const withDetails = starters
			.filter((template) => template.blocks.some((block) => block.type === 'details'))
			.map((template) => template.key);
		expect(withDetails).toEqual([
			'decision-accepted',
			'decision-waitlisted',
			'decision-declined',
			'task-reminder'
		]);
	});

	test('usedBy names the flow each template serves', () => {
		expect(Object.fromEntries(starters.map((template) => [template.key, template.usedBy]))).toEqual({
			'decision-accepted': ['Decision notification'],
			'decision-waitlisted': ['Decision notification'],
			'decision-declined': ['Decision notification'],
			'speaker-invitation': ['Speaker onboarding'],
			'task-reminder': ['Task reminders'],
			'schedule-announcement': ['Schedule publish']
		});
	});

	test('crunch seeds one agent revision on the acceptance template; fresh seeds none at all', () => {
		const accepted = crunch.templates.find((template) => template.key === 'decision-accepted');
		expect(accepted?.revision).toBe(2);
		expect(accepted?.revisions).toEqual([
			{ number: 1, at: 'At event creation', by: 'you', note: 'Starter' },
			{ number: 2, at: '2 h ago', by: 'agent', note: 'Tightened for the notify-by deadline' }
		]);

		expect(fresh.templates).toEqual([]);
		expect(fresh.summary.lockedAreas).toContain('templates');
		expect(fresh.theme.markText).toBe('');
	});
});

describe('classify routing', () => {
	test('a short wording instruction runs as a quick touch', async () => {
		expect(await api.templates.classify('tpl-task-reminder', 'Make the greeting warmer')).toEqual({
			scope: 'quick',
			profileLabel: 'Quick touch · Claude Haiku',
			reason: 'Wording-only change',
			chosenBy: 'auto'
		});
	});

	test('structural wording runs as a full pass', async () => {
		const result = await api.templates.classify(
			'tpl-decision-accepted',
			'Rework this and add section about travel'
		);
		expect(result.scope).toBe('comprehensive');
		expect(result.profileLabel).toBe('Full pass · Claude Sonnet');
		expect(result.reason).toBe('Structural change across blocks');
		expect(result.chosenBy).toBe('auto');
	});

	test('a long instruction is comprehensive even without structural keywords', async () => {
		const long =
			'Please make this message feel a bit more personal to every single accepted speaker we notify';
		expect((await api.templates.classify('tpl-decision-accepted', long)).scope).toBe('comprehensive');
	});
});

describe('model choices', () => {
	test('auto leads the list and every choice is presentable', async () => {
		const choices = await api.templates.modelChoices();
		expect(choices[0]).toEqual({
			id: 'auto',
			label: 'Auto',
			sub: 'Routes each request to the lightest model that can do it'
		});
		expect(choices.length).toBeGreaterThanOrEqual(4);
		for (const choice of choices) {
			expect(choice.id.length).toBeGreaterThan(0);
			expect(choice.label.length).toBeGreaterThan(0);
		}
		expect(new Set(choices.map((choice) => choice.id)).size).toBe(choices.length);
	});

	test('a manual pick bypasses routing and echoes the pick', async () => {
		const choices = await api.templates.modelChoices();
		const pick = choices.find((choice) => choice.id !== 'auto')!;
		expect(
			await api.templates.classify('tpl-decision-accepted', 'Make the greeting warmer', pick.id)
		).toEqual({
			scope: 'quick',
			profileLabel: pick.label,
			reason: 'Your pick',
			chosenBy: 'you'
		});

		// The scope heuristic still sizes the run; only the routing is bypassed.
		const structural = await api.templates.classify(
			'tpl-decision-accepted',
			'Rework this and add a section about travel',
			pick.id
		);
		expect(structural.scope).toBe('comprehensive');
		expect(structural.profileLabel).toBe(pick.label);
		expect(structural.chosenBy).toBe('you');
	});

	test('passing auto explicitly routes exactly as no pick at all', async () => {
		expect(
			await api.templates.classify('tpl-decision-accepted', 'Make the greeting warmer', 'auto')
		).toEqual(await api.templates.classify('tpl-decision-accepted', 'Make the greeting warmer'));
	});

	test(
		'a pinned model shifts pacing: the same quick edit streams more tokens on the slow pick',
		async () => {
			const progress: ReviseProgress[] = [];
			await api.templates.revise(
				'tpl-decision-accepted',
				'Tighter wording please',
				(p) => progress.push({ ...p }),
				'opus-5'
			);
			const done = progress.at(-1)!;
			expect(done.status).toBe('done');
			// The routed default streams 140 tokens for a quick edit (proved above).
			expect(done.tokens).toBeGreaterThan(140);
		},
		15000
	);
});

/*
 * These run against the loaded scenario through the same facade a screen uses,
 * in order: revise proves the stored template is untouched, apply commits a
 * draft and then refuses it stale, revert restores what apply replaced.
 */
describe('revise, apply, revert', () => {
	test('revise streams monotonically and returns a draft without touching the db', async () => {
		// The facade accepts either template kind; these ids name message templates.
		const before = structuredClone(
			await api.templates.get('tpl-decision-accepted')
		) as MessageTemplate | null;
		const progress: ReviseProgress[] = [];
		const { draft, note } = (await api.templates.revise(
			'tpl-decision-accepted',
			'Tighter wording please',
			(p) => progress.push({ ...p })
		)) as { draft: MessageTemplate; note: string };

		expect(progress[0]).toEqual({ status: 'classifying', tokens: 0 });
		expect(progress.at(-1)).toEqual({ status: 'done', tokens: 140 });
		expect(progress.filter((p) => p.status === 'drafting').length).toBeGreaterThan(3);
		for (let i = 1; i < progress.length; i += 1) {
			expect(progress[i].tokens).toBeGreaterThanOrEqual(progress[i - 1].tokens);
		}

		// The draft is a new revision with a visible, attributed change...
		expect(draft.revision).toBe((before?.revision ?? 0) + 1);
		expect(draft.revisions.at(-1)).toEqual({
			number: draft.revision,
			at: 'Just now',
			by: 'agent',
			note
		});
		expect(note).toBe('Trimmed each paragraph to its first sentence.');
		const beforeOpening = before?.blocks.find((block) => block.type === 'paragraph');
		const draftOpening = draft.blocks.find((block) => block.type === 'paragraph');
		expect(draftOpening?.text.length ?? 0).toBeLessThan(beforeOpening?.text.length ?? 0);

		// ...and the stored template has not moved at all.
		expect(await api.templates.get('tpl-decision-accepted')).toEqual(before);
	});

	test('applyRevision commits once and refuses the same draft stale', async () => {
		const original = structuredClone(
			(await api.templates.get('tpl-task-reminder')) as MessageTemplate
		);
		const { draft } = await api.templates.revise('tpl-task-reminder', 'Rename the button');

		expect(await api.templates.applyRevision('tpl-task-reminder', draft)).toEqual({ ok: true });
		const stored = (await api.templates.get('tpl-task-reminder')) as MessageTemplate;
		expect(stored.revision).toBe(original.revision + 1);
		expect(buttonOf(stored.blocks)?.label).toBe('Take the next step');

		// The stored template moved on, so the same draft is now stale.
		expect(await api.templates.applyRevision('tpl-task-reminder', draft)).toEqual({
			ok: false,
			reason: 'This template changed while you were editing'
		});
	});

	test('revertTo restores the prior revision’s content as a new revision', async () => {
		const stored = (await api.templates.get('tpl-task-reminder')) as MessageTemplate;
		const startRevision = stored.revision;
		expect(buttonOf(stored.blocks)?.label).toBe('Take the next step');

		expect(await api.templates.revertTo('tpl-task-reminder', startRevision - 1)).toEqual({ ok: true });
		const reverted = (await api.templates.get('tpl-task-reminder')) as MessageTemplate;
		expect(buttonOf(reverted.blocks)?.label).toBe('Open your checklist');
		expect(reverted.blocks).toEqual(
			starterTemplates().find((template) => template.key === 'task-reminder')!.blocks
		);
		expect(reverted.revision).toBe(startRevision + 1);
		expect(reverted.revisions.at(-1)).toEqual({
			number: reverted.revision,
			at: 'Just now',
			by: 'you',
			note: `Reverted to revision ${startRevision - 1}`
		});

		// A revision that was never applied left no content to restore.
		expect(await api.templates.revertTo('tpl-task-reminder', 99)).toEqual({
			ok: false,
			reason: 'No stored copy of revision 99 to restore'
		});
	});
});

/*
 * Every starter suggestion must be wording revise() genuinely acts on: pressing
 * one yields a draft whose blocks differ from the stored template — never dead
 * example copy. One representative template per kind.
 */
describe('suggestions drive real revisions', () => {
	async function expectEverySuggestionRevises(id: string, expected: string[]): Promise<void> {
		const suggestions = await api.templates.suggestions(id);
		expect(suggestions.map((suggestion) => suggestion.text)).toEqual(expected);
		for (const suggestion of suggestions) {
			const stored = (await api.templates.get(id)) as AnyTemplate;
			const { draft } = await api.templates.revise(id, suggestion.text);
			expect(draft.blocks).not.toEqual(stored.blocks);
			expect(draft.revision).toBe(stored.revision + 1);
		}
	}

	test(
		'message suggestions each change the draft',
		() =>
			expectEverySuggestionRevises('tpl-decision-accepted', [
				'Warmer tone',
				'Tighten it',
				'Add a deadline row'
			]),
		20000
	);

	test(
		'schedule surface suggestions each change the draft',
		() =>
			expectEverySuggestionRevises('srf-schedule', [
				'Group by track',
				'More compact cards',
				'Hide rooms'
			]),
		20000
	);

	test(
		'the application form chips are field work, and each one revises',
		async () => {
			const suggestions = await api.templates.suggestions('srf-application-form');
			expect(suggestions.map((suggestion) => suggestion.text)).toEqual([
				'Add a travel question',
				'Ask about dietary needs',
				'Make headline optional'
			]);
			// A form chip's change can live in the field pool alone (a requiredness
			// flip moves no block), so the comparison covers both.
			for (const suggestion of suggestions) {
				const stored = (await api.templates.get('srf-application-form')) as SurfaceTemplate;
				const { draft } = await api.templates.revise('srf-application-form', suggestion.text);
				const revised = draft as SurfaceTemplate;
				expect({ blocks: revised.blocks, fields: revised.fields }).not.toEqual({
					blocks: stored.blocks,
					fields: stored.fields
				});
				expect(revised.revision).toBe(stored.revision + 1);
			}
		},
		20000
	);

	test('an unknown id yields no suggestions', async () => {
		expect(await api.templates.suggestions('tpl-nope')).toEqual([]);
	});
});
