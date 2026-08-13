import { describe, expect, test } from 'bun:test';
import { changesetDiffDataSchema } from '@jooevents/contracts';
import { changesetStableKeyLabel, mapChangesetDiff } from './mapper';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

describe('changeset browser view-model mapper', () => {
	test('groups the ordered neutral operations without interpreting domain safe diffs', () => {
		const data = changesetDiffDataSchema.parse({
			changesetId: id(1),
			headVersion: 2,
			status: 'proposed',
			revisionId: id(2),
			revisionNumber: 1,
			revisionDigest: 'a'.repeat(64),
			riskTier: 'consequential',
			approvalPolicy: {
				reference: { key: 'approval.event_change', version: 1 },
				definitionDigestSha256: 'b'.repeat(64),
				requirement: 'distinct_current_human'
			},
			operations: [
				{
					kind: 'event.title.update',
					version: 1,
					riskTier: 'normal',
					dependencyGroup: 'event_identity',
					safeDiff: { before: { title: 'Old' }, after: { title: 'New' } },
					consequences: ['event_changed', 'public_projection_changed']
				},
				{
					kind: 'event.slug.update',
					version: 1,
					riskTier: 'consequential',
					dependencyGroup: 'event_identity',
					safeDiff: { before: { slug: 'old' }, after: { slug: 'new' } },
					consequences: ['public_projection_changed']
				},
				{
					kind: 'event.timezone.update',
					version: 1,
					riskTier: 'normal',
					dependencyGroup: 'event_timing',
					safeDiff: { before: 'UTC', after: 'Asia/Singapore' },
					consequences: []
				}
			]
		});

		const view = mapChangesetDiff(data);
		expect(view).toMatchObject({
			headVersion: 2,
			status: { value: 'proposed', label: 'Proposed' },
			risk: { value: 'consequential', label: 'Consequential' },
			approval: {
				requirement: 'distinct_current_human',
				label: 'Separate approval required'
			},
			operationCount: 3
		});
		expect(view.groups.map((group) => group.key)).toEqual(['event_identity', 'event_timing']);
		expect(view.groups[0]).toMatchObject({
			label: 'Event identity',
			risk: { value: 'consequential' },
			consequences: ['event_changed', 'public_projection_changed'],
			consequenceLabels: ['Event changed', 'Public projection changed']
		});
		expect(view.groups[0]?.operations[0]?.safeDiff).toEqual(data.operations[0]?.safeDiff);
		expect(view.groups[0]?.operations[0]?.safeDiffText).toBe(JSON.stringify(data.operations[0]?.safeDiff, null, 2));
	});

	test('turns only stable identifiers into quiet display labels', () => {
		expect(changesetStableKeyLabel('program-vocabulary.track_add')).toBe('Program vocabulary track add');
		expect(changesetStableKeyLabel('')).toBe('Change');
	});
});
