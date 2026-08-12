import { describe, expect, test } from 'bun:test';
import { diffAnyTemplate, diffBlocks, diffSurfaceTemplate, diffTemplate } from './template-diff';
import type {
	MessageTemplate,
	SurfaceBlock,
	SurfaceField,
	SurfaceTemplate,
	TemplateBlock
} from '../../api/types';

const baseBlocks: TemplateBlock[] = [
	{ type: 'heading', text: 'You’re in, {{speaker.name}}' },
	{ type: 'paragraph', text: 'First paragraph. Second sentence.' },
	{
		type: 'details',
		rows: [
			{ label: 'Session', value: '{{submission.title}}' },
			{ label: 'Format', value: '{{submission.format}}' }
		]
	},
	{ type: 'button', label: 'Confirm your session', href: 'portal.tasks' },
	{ type: 'divider' }
];

function template(subject: string, blocks: TemplateBlock[]): MessageTemplate {
	return {
		id: 'tpl-x',
		key: 'x',
		name: 'X',
		purpose: 'p',
		subject,
		blocks,
		mergeFields: [],
		revision: 1,
		revisions: [],
		usedBy: []
	};
}

describe('diffBlocks', () => {
	test('identical arrays yield no entries', () => {
		expect(diffBlocks(baseBlocks, structuredClone(baseBlocks))).toEqual([]);
	});

	test('an edited paragraph pairs before and after text', () => {
		const draft = structuredClone(baseBlocks);
		draft[1] = { type: 'paragraph', text: 'First paragraph.' };
		expect(diffBlocks(baseBlocks, draft)).toEqual([
			{
				kind: 'edited',
				target: 'Paragraph',
				before: 'First paragraph. Second sentence.',
				after: 'First paragraph.'
			}
		]);
	});

	test('an inserted details block reads as added with its row text', () => {
		const draft = structuredClone(baseBlocks);
		draft.splice(3, 0, { type: 'details', rows: [{ label: 'Due', value: '{{task.due}}' }] });
		expect(diffBlocks(baseBlocks, draft)).toEqual([
			{ kind: 'added', target: 'Details', after: 'Due: {{task.due}}' }
		]);
	});

	test('a removed button reads as removed with the label it carried', () => {
		const draft = structuredClone(baseBlocks);
		draft.splice(3, 1);
		expect(diffBlocks(baseBlocks, draft)).toEqual([
			{ kind: 'removed', target: 'Button', before: 'Confirm your session' }
		]);
	});

	test('a row added to an existing details block reads as an edit', () => {
		const draft = structuredClone(baseBlocks);
		draft[2] = {
			type: 'details',
			rows: [
				{ label: 'Session', value: '{{submission.title}}' },
				{ label: 'Format', value: '{{submission.format}}' },
				{ label: 'Due', value: '{{task.due}}' }
			]
		};
		const entries = diffBlocks(baseBlocks, draft);
		expect(entries).toHaveLength(1);
		expect(entries[0].kind).toBe('edited');
		expect(entries[0].target).toBe('Details');
		expect(entries[0].after).toContain('Due: {{task.due}}');
	});
});

describe('diffTemplate', () => {
	test('a subject change leads the list', () => {
		const base = template('Original subject', baseBlocks);
		const draft = template('Quick word — original subject', structuredClone(baseBlocks));
		expect(diffTemplate(base, draft)).toEqual([
			{
				kind: 'edited',
				target: 'Subject',
				before: 'Original subject',
				after: 'Quick word — original subject'
			}
		]);
	});
});

const surfaceFields: SurfaceField[] = [
	{ id: 'name', label: 'Your name', kind: 'text', required: true },
	{ id: 'notes', label: 'Anything else?', kind: 'textarea', required: false }
];

const surfaceBlocks: SurfaceBlock[] = [
	{ type: 'hero', title: 'Schedule', intro: 'Every session in one place.' },
	{
		type: 'schedule-days',
		grouping: 'day',
		showRoom: true,
		showTrack: true,
		showSpeakers: true,
		density: 'cozy'
	},
	{ type: 'form-section', title: 'About you', fieldRefs: ['name'] },
	{ type: 'note', text: 'Sessions are recorded.' }
];

function surface(blocks: SurfaceBlock[], fields?: SurfaceField[]): SurfaceTemplate {
	return {
		id: 'srf-x',
		kind: 'schedule',
		name: 'X',
		purpose: 'p',
		blocks,
		...(fields ? { fields } : {}),
		revision: 1,
		revisions: [],
		usedBy: []
	};
}

describe('diffSurfaceTemplate', () => {
	test('identical surfaces yield no entries', () => {
		expect(
			diffSurfaceTemplate(surface(surfaceBlocks, surfaceFields), surface(structuredClone(surfaceBlocks), surfaceFields))
		).toEqual([]);
	});

	test('a regrouped listing lists the edited option, not the whole block', () => {
		const draft = structuredClone(surfaceBlocks);
		draft[1] = { ...draft[1], grouping: 'track' } as SurfaceBlock;
		expect(diffSurfaceTemplate(surface(surfaceBlocks), surface(draft))).toEqual([
			{ kind: 'edited', target: 'Schedule layout · grouping', before: 'day', after: 'track' }
		]);
	});

	test('a display toggle reads on → off', () => {
		const draft = structuredClone(surfaceBlocks);
		draft[1] = { ...draft[1], showRoom: false } as SurfaceBlock;
		expect(diffSurfaceTemplate(surface(surfaceBlocks), surface(draft))).toEqual([
			{ kind: 'edited', target: 'Schedule layout · showRoom', before: 'on', after: 'off' }
		]);
	});

	test('a question added to a section is named by its label', () => {
		const draft = structuredClone(surfaceBlocks);
		draft[2] = { type: 'form-section', title: 'About you', fieldRefs: ['name', 'notes'] };
		expect(
			diffSurfaceTemplate(surface(surfaceBlocks, surfaceFields), surface(draft, surfaceFields))
		).toEqual([{ kind: 'added', target: 'Section: About you', after: 'Anything else?' }]);
	});

	test('a new section reads as added with its questions listed by label', () => {
		const draft = structuredClone(surfaceBlocks);
		draft.push({ type: 'form-section', title: 'One more thing', fieldRefs: ['notes'] });
		expect(
			diffSurfaceTemplate(surface(surfaceBlocks, surfaceFields), surface(draft, surfaceFields))
		).toEqual([{ kind: 'added', target: 'Section: One more thing', after: 'Anything else?' }]);
	});

	test('a style-only heading edit names the changed property in px, defaults filled', () => {
		const draft = structuredClone(baseBlocks);
		draft[0] = { type: 'heading', text: 'You’re in, {{speaker.name}}', style: { size: 28 } };
		expect(diffBlocks(baseBlocks, draft)).toEqual([
			{ kind: 'edited', target: 'Heading · size', before: '24px', after: '28px' }
		]);
	});

	test('a text-and-style paragraph edit lists both changes', () => {
		const draft = structuredClone(baseBlocks);
		draft[1] = {
			type: 'paragraph',
			text: 'First paragraph.',
			style: { weight: 'semibold', align: 'center' }
		};
		expect(diffBlocks(baseBlocks, draft)).toEqual([
			{
				kind: 'edited',
				target: 'Paragraph',
				before: 'First paragraph. Second sentence.',
				after: 'First paragraph.'
			},
			{ kind: 'edited', target: 'Paragraph · weight', before: 'regular', after: 'semibold' },
			{ kind: 'edited', target: 'Paragraph · align', before: 'start', after: 'center' }
		]);
	});

	test('a hero title style tag diffs under its own unit', () => {
		const draft = structuredClone(surfaceBlocks);
		draft[0] = {
			type: 'hero',
			title: 'Schedule',
			intro: 'Every session in one place.',
			titleStyle: { size: 36 }
		};
		expect(diffSurfaceTemplate(surface(surfaceBlocks), surface(draft))).toEqual([
			{ kind: 'edited', target: 'Hero · title · size', before: '28px', after: '36px' }
		]);
	});

	test('a question requiredness flip in the pool reads as an edit by label', () => {
		const flipped = structuredClone(surfaceFields);
		flipped[0] = { ...flipped[0], required: false };
		expect(
			diffSurfaceTemplate(surface(surfaceBlocks, surfaceFields), surface(structuredClone(surfaceBlocks), flipped))
		).toEqual([{ kind: 'edited', target: 'Question: Your name', before: 'required', after: 'optional' }]);
	});

	test('a hero intro edit pairs before and after under its field', () => {
		const draft = structuredClone(surfaceBlocks);
		draft[0] = { type: 'hero', title: 'Schedule', intro: 'In short: every session.' };
		expect(diffSurfaceTemplate(surface(surfaceBlocks), surface(draft))).toEqual([
			{
				kind: 'edited',
				target: 'Hero · intro',
				before: 'Every session in one place.',
				after: 'In short: every session.'
			}
		]);
	});
});

describe('diffAnyTemplate', () => {
	test('dispatches on the template kind', () => {
		const base = template('S', baseBlocks);
		const draft = template('S2', structuredClone(baseBlocks));
		expect(diffAnyTemplate(base, draft)[0]?.target).toBe('Subject');

		const surfaceDraft = structuredClone(surfaceBlocks);
		surfaceDraft[1] = { ...surfaceDraft[1], density: 'compact' } as SurfaceBlock;
		expect(diffAnyTemplate(surface(surfaceBlocks), surface(surfaceDraft))).toEqual([
			{ kind: 'edited', target: 'Schedule layout · density', before: 'cozy', after: 'compact' }
		]);
	});
});
