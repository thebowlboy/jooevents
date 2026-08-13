<script lang="ts">
	import {
		changesetRevisionSelectorSchema,
		programVocabularySafeDiffSchema,
		type ChangesetRevisionSelector
	} from '@jooevents/contracts';
	import type { ChangesetReviewOperationView, ChangesetReviewPort } from '$lib/api/changesets';
	import type { EventProgramPort } from '$lib/api/event-program/port';
	import type { ProgramVocabularyDraftView } from '$lib/api/view-models/program-vocabulary';
	import { ChangesetReview } from '$lib/features/changesets';
	import ProgramVocabularyPanel from './ProgramVocabularyPanel.svelte';
	import { programVocabularyDiffRows } from './program-vocabulary-diff';

	let {
		port,
		changesets
	}: {
		readonly port: EventProgramPort;
		readonly changesets: ChangesetReviewPort;
	} = $props();

	let selected = $state<ChangesetRevisionSelector | null>(null);
	let refreshGeneration = $state(0);

	function reviewDraft(draft: ProgramVocabularyDraftView) {
		selected = changesetRevisionSelectorSchema.parse({
			changesetId: draft.changesetId,
			revisionId: draft.revision.id,
			revisionDigest: draft.revision.digestSha256
		});
	}

	function committed() {
		selected = null;
		refreshGeneration += 1;
	}

	function canonicalVocabularyDiff(operation: ChangesetReviewOperationView) {
		const parsed = programVocabularySafeDiffSchema.safeParse(operation.safeDiff);
		return parsed.success ? parsed.data : null;
	}
</script>

<div class="program-vocabulary-live">
	{#key refreshGeneration}
		<ProgramVocabularyPanel {port} ondraft={reviewDraft} />
	{/key}

	{#if selected}
		<ChangesetReview
			port={changesets}
			selector={selected}
			title="Review vocabulary change"
			onCommitted={committed}
		>
			{#snippet operationDetail(operation)}
				{@const diff = canonicalVocabularyDiff(operation)}
				{#if diff}
					<dl class="review-diff">
						{#each programVocabularyDiffRows(diff) as row (row.key)}
							<div><dt>{row.label}</dt><dd>{row.before} → {row.after}</dd></div>
						{/each}
					</dl>
				{/if}
			{/snippet}
		</ChangesetReview>
	{/if}
</div>

<style>
	.program-vocabulary-live {
		display: grid;
		gap: var(--je-space-6);
	}
	.review-diff { display: grid; gap: var(--je-space-2); margin: 0; }
	.review-diff div { display: grid; grid-template-columns: minmax(9rem, .45fr) minmax(0, 1fr); gap: var(--je-space-3); padding-block: var(--je-space-1); }
	.review-diff dt { color: var(--je-color-text-muted); font-size: var(--je-font-size-sm); }
	.review-diff dd { margin: 0; overflow-wrap: anywhere; }
	@media (max-width: 36rem) { .review-diff div { grid-template-columns: 1fr; gap: var(--je-space-1); } }
</style>
