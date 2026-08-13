import type { ChangesetDiffData } from '@jooevents/contracts';
import type {
	ChangesetCommitView,
	ChangesetDiffView,
	ChangesetReviewGroupView,
	ChangesetReviewOperationView,
	ChangesetReviewRisk,
	ChangesetReviewRiskView,
	ChangesetReviewStatus,
	ChangesetReviewStatusView
} from './port';

const riskOrder: Readonly<Record<ChangesetReviewRisk, number>> = Object.freeze({
	low: 0,
	normal: 1,
	consequential: 2
});

export function changesetStableKeyLabel(value: string): string {
	const words = value.split(/[._-]+/u).filter(Boolean);
	if (words.length === 0) return 'Change';
	const label = words.join(' ');
	return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

export function mapChangesetRisk(value: ChangesetReviewRisk): ChangesetReviewRiskView {
	return Object.freeze({
		value,
		label: value === 'low' ? 'Low risk' : value === 'normal' ? 'Normal risk' : 'Consequential',
		tone: value === 'consequential' ? 'warning' : value === 'normal' ? 'info' : 'neutral'
	});
}

export function mapChangesetStatus(value: ChangesetReviewStatus): ChangesetReviewStatusView {
	return Object.freeze({
		value,
		label: value === 'draft'
			? 'Draft'
			: value === 'proposed'
				? 'Proposed'
				: value === 'committed'
					? 'Committed'
					: 'Discarded',
		tone: value === 'committed' ? 'success' : value === 'proposed' ? 'info' : 'neutral'
	});
}

function highestRisk(values: readonly ChangesetReviewRisk[]): ChangesetReviewRisk {
	return values.reduce<ChangesetReviewRisk>(
		(highest, candidate) => riskOrder[candidate] > riskOrder[highest] ? candidate : highest,
		'low'
	);
}

function uniqueInOrder(values: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(values)]);
}

function mapOperation(
	operation: ChangesetDiffData['operations'][number],
	index: number
): ChangesetReviewOperationView {
	const consequences = uniqueInOrder(operation.consequences);
	return Object.freeze({
		key: `${operation.dependencyGroup}:${index}`,
		kind: operation.kind,
		kindLabel: changesetStableKeyLabel(operation.kind),
		version: operation.version,
		risk: mapChangesetRisk(operation.riskTier),
		dependencyGroup: operation.dependencyGroup,
		safeDiff: operation.safeDiff,
		safeDiffText: JSON.stringify(operation.safeDiff, null, 2),
		consequences,
		consequenceLabels: Object.freeze(consequences.map(changesetStableKeyLabel))
	});
}

export function mapChangesetDiff(data: ChangesetDiffData): ChangesetDiffView {
	const operations = data.operations.map(mapOperation);
	const mutableGroups = new Map<string, ChangesetReviewOperationView[]>();
	for (const operation of operations) {
		const group = mutableGroups.get(operation.dependencyGroup);
		if (group) group.push(operation);
		else mutableGroups.set(operation.dependencyGroup, [operation]);
	}

	const groups: readonly ChangesetReviewGroupView[] = Object.freeze(
		[...mutableGroups.entries()].map(([key, groupedOperations]) => {
			const consequences = uniqueInOrder(groupedOperations.flatMap((operation) => operation.consequences));
			return Object.freeze({
				key,
				label: changesetStableKeyLabel(key),
				risk: mapChangesetRisk(highestRisk(groupedOperations.map((operation) => operation.risk.value))),
				operations: Object.freeze(groupedOperations),
				consequences,
				consequenceLabels: Object.freeze(consequences.map(changesetStableKeyLabel))
			});
		})
	);

	return Object.freeze({
		selector: Object.freeze({
			changesetId: data.changesetId,
			revisionId: data.revisionId,
			revisionDigest: data.revisionDigest
		}),
		headVersion: data.headVersion,
		status: mapChangesetStatus(data.status),
		revisionNumber: data.revisionNumber,
		risk: mapChangesetRisk(data.riskTier),
		approval: Object.freeze({
			requirement: data.approvalPolicy.requirement,
			label: data.approvalPolicy.requirement === 'none'
				? 'No separate approval required'
				: 'Separate approval required'
		}),
		operationCount: operations.length,
		groups
	});
}

export function mapChangesetCommit(data: {
	readonly changesetId: string;
	readonly expectedHeadVersion: number;
	readonly committedHeadVersion: number;
	readonly revisionId: string;
	readonly revisionDigest: string;
}): ChangesetCommitView {
	return Object.freeze({
		changesetId: data.changesetId,
		expectedHeadVersion: data.expectedHeadVersion,
		committedHeadVersion: data.committedHeadVersion,
		revisionId: data.revisionId,
		revisionDigest: data.revisionDigest
	});
}
