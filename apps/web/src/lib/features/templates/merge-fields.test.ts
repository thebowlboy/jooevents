import { describe, expect, test } from 'bun:test';
import { segmentMergeText } from './merge-fields';
import type { MergeFieldDef } from '../../api/types';

const fields: MergeFieldDef[] = [
	{ key: 'speaker.name', label: 'Speaker name', sample: 'Maya Lindqvist' },
	{ key: 'event.name', label: 'Event name', sample: 'AI Engineer NYC 2026' }
];

describe('segmentMergeText', () => {
	test('plain text stays one literal segment', () => {
		expect(segmentMergeText('No tokens here.', fields)).toEqual([
			{ kind: 'text', text: 'No tokens here.' }
		]);
	});

	test('resolves declared tokens with label and sample, keeping literal runs', () => {
		expect(segmentMergeText('Hi {{speaker.name}}, welcome to {{event.name}}!', fields)).toEqual([
			{ kind: 'text', text: 'Hi ' },
			{ kind: 'field', key: 'speaker.name', label: 'Speaker name', sample: 'Maya Lindqvist' },
			{ kind: 'text', text: ', welcome to ' },
			{ kind: 'field', key: 'event.name', label: 'Event name', sample: 'AI Engineer NYC 2026' },
			{ kind: 'text', text: '!' }
		]);
	});

	test('a token may open the text and whitespace inside braces is tolerated', () => {
		expect(segmentMergeText('{{ speaker.name }} speaks.', fields)).toEqual([
			{ kind: 'field', key: 'speaker.name', label: 'Speaker name', sample: 'Maya Lindqvist' },
			{ kind: 'text', text: ' speaks.' }
		]);
	});

	test('adjacent tokens produce no empty literal between them', () => {
		expect(segmentMergeText('{{speaker.name}}{{event.name}}', fields)).toEqual([
			{ kind: 'field', key: 'speaker.name', label: 'Speaker name', sample: 'Maya Lindqvist' },
			{ kind: 'field', key: 'event.name', label: 'Event name', sample: 'AI Engineer NYC 2026' }
		]);
	});

	test('an undeclared token stays literal text, never an invented value', () => {
		expect(segmentMergeText('Due {{task.due}} for {{speaker.name}}.', fields)).toEqual([
			{ kind: 'text', text: 'Due {{task.due}} for ' },
			{ kind: 'field', key: 'speaker.name', label: 'Speaker name', sample: 'Maya Lindqvist' },
			{ kind: 'text', text: '.' }
		]);
	});
});
