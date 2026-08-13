import {
	changesetDiffDataSchema,
	changesetRevisionSelectorSchema,
	committedChangesetDataSchema,
	type ChangesetRevisionSelector
} from '@jooevents/contracts';
import type { OrganizerFormsPort } from '../view-models/intake-forms';
import { mapChangesetCommit, mapChangesetDiff } from './mapper';
import type {
	ChangesetReviewEffectInput,
	ChangesetReviewPort,
	ChangesetReviewResult
} from './port';

function unavailable<Data>(operation: 'diff' | 'propose' | 'commit'): ChangesetReviewResult<Data> {
	return { kind: 'unavailable', operation, reason: 'operation_not_registered' };
}

/** Adapts the resettable canonical Forms demo to the same generic review surface as live. */
export function createFormsSampleChangesetReviewPort(forms: OrganizerFormsPort): ChangesetReviewPort {
	return Object.freeze({
		source: Object.freeze({ kind: 'sample' as const, label: 'Sample data' as const }),
		async readDiff(
			selector: ChangesetRevisionSelector,
			options: { readonly signal?: AbortSignal } = {}
		) {
			options.signal?.throwIfAborted();
			const parsed = changesetRevisionSelectorSchema.parse(selector);
			const result = await forms.readDiff(parsed, options);
			if (result.kind !== 'success') return unavailable<ReturnType<typeof mapChangesetDiff>>('diff');
			const { approvalRequirement, ...diff } = result.data;
			const canonical = changesetDiffDataSchema.parse({
				...diff,
				approvalPolicy: {
					reference: { key: 'approval.form_ordinary', version: 1 },
					definitionDigestSha256: 'd'.repeat(64),
					requirement: approvalRequirement
				}
			});
			return {
				kind: 'success' as const,
				data: mapChangesetDiff(canonical),
				...(result.correlationId ? { correlationId: result.correlationId } : {})
			};
		},
		async propose(
			input: ChangesetReviewEffectInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		) {
			options.signal?.throwIfAborted();
			const result = await forms.propose(input, key, options);
			if (result.kind !== 'success') return unavailable<ReturnType<typeof mapChangesetDiff>>('propose');
			const { approvalRequirement, ...diff } = result.data;
			const canonical = changesetDiffDataSchema.parse({
				...diff,
				approvalPolicy: {
					reference: { key: 'approval.form_ordinary', version: 1 },
					definitionDigestSha256: 'd'.repeat(64),
					requirement: approvalRequirement
				}
			});
			return {
				kind: 'success' as const,
				data: mapChangesetDiff(canonical),
				...(result.correlationId ? { correlationId: result.correlationId } : {}),
				...(result.receipt ? { receipt: result.receipt } : {})
			};
		},
		async commit(
			input: ChangesetReviewEffectInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		) {
			options.signal?.throwIfAborted();
			const result = await forms.commit(input, key, options);
			if (result.kind !== 'success') return unavailable<ReturnType<typeof mapChangesetCommit>>('commit');
			const canonical = committedChangesetDataSchema.parse({
				schemaVersion: 1,
				action: 'commit',
				...result.data
			});
			return {
				kind: 'success' as const,
				data: mapChangesetCommit(canonical),
				...(result.correlationId ? { correlationId: result.correlationId } : {}),
				...(result.receipt ? { receipt: result.receipt } : {})
			};
		}
	});
}
