import { describe, expect, test } from 'bun:test';
import type { OrganizerEngagementFilesView } from '$lib/api/files/view-models';
import { filterReceivedFiles, receivedSessionChoices } from './received-files-filter';

const groups = [
	{
		engagementId: 'eng-1',
		label: { speaker: 'Ada', session: 'Opening keynote' },
		openRequestCount: 0,
		items: [
			{ kind: 'file', name: 'Final deck.pdf', attachmentId: 'a' },
			{ kind: 'link', label: 'Demo recording', attachmentId: 'b' }
		]
	},
	{
		engagementId: 'eng-2',
		label: { speaker: 'Grace', session: 'Closing keynote' },
		openRequestCount: 0,
		items: [{ kind: 'file', name: 'Notes.pdf', attachmentId: 'c' }]
	}
] as unknown as readonly OrganizerEngagementFilesView[];

describe('received files filters', () => {
	test('composes file and session filters and keeps only matching items', () => {
		const filtered = filterReceivedFiles(groups, { file: 'deck', session: 'Opening keynote' });
		expect(filtered.map((group) => group.engagementId)).toEqual(['eng-1']);
		expect(filtered[0]?.items.map((item) => item.attachmentId)).toEqual(['a']);
		expect(filterReceivedFiles(groups, { file: 'notes', session: 'Opening keynote' })).toEqual([]);
	});

	test('offers stable unique session choices', () => {
		expect(receivedSessionChoices(groups)).toEqual(['Closing keynote', 'Opening keynote']);
	});
});
