<script lang="ts">
	import { tick } from 'svelte';
	import type {
		ProgramVocabularyDirectData,
		ProgramVocabularyMergePublishInput,
		ProgramVocabularyMergeReviewData
	} from '@jooevents/contracts';
	import type { EventProgramEffectResult, EventProgramPort } from '$lib/api/event-program/port';
	import { Button } from '$lib/ui';
	import ProgramVocabularyPanel from './ProgramVocabularyPanel.svelte';
	import { programVocabularyDiffRows } from './program-vocabulary-diff';

	let { port }: { readonly port: EventProgramPort } = $props();
	let selected = $state<ProgramVocabularyMergeReviewData | null>(null);
	let refreshGeneration = $state(0);
	let pending = $state(false);
	let message = $state('');
	let publishKey = $state('');
	let reviewHeading = $state<HTMLElement>();

	async function reviewDraft(draft: ProgramVocabularyMergeReviewData) {
		selected = draft;
		publishKey = crypto.randomUUID();
		message = '';
		await tick();
		reviewHeading?.focus();
	}

	function selector(draft: ProgramVocabularyMergeReviewData): ProgramVocabularyMergePublishInput {
		return {
			draftId: draft.draftId,
			revisionId: draft.revision.id,
			revisionDigestSha256: draft.revision.digestSha256
		};
	}

	function publishError(
		result: Exclude<EventProgramEffectResult<ProgramVocabularyDirectData>, { kind: 'success' }>
	): string {
		if (result.kind === 'unavailable') return 'Publishing this merge is not available in this build.';
		if (result.kind === 'transport_error') {
			return result.error.retryable
				? 'The merge could not reach JooEvents. Try again when the connection is back.'
				: 'The merge request was not accepted.';
		}
		if (result.outcome.class === 'stale_revision') {
			return 'Program vocabulary changed after this review was prepared. Cancel and review the merge again.';
		}
		return 'JooEvents could not merge these categories.';
	}

	async function publish() {
		if (!selected || pending || !publishKey) return;
		pending = true;
		message = '';
		try {
			const result = await port.vocabulary.publishMerge(selector(selected), {
				idempotencyKey: publishKey
			});
			if (result.kind !== 'success') {
				message = publishError(result);
				return;
			}
			selected = null;
			publishKey = '';
			refreshGeneration += 1;
		} finally {
			pending = false;
		}
	}

	function cancel() {
		selected = null;
		publishKey = '';
		message = '';
	}
</script>

<div class="program-vocabulary-live">
	{#key refreshGeneration}
		<ProgramVocabularyPanel {port} ondraft={reviewDraft} />
	{/key}

	{#if selected}
		<section class="review-card" aria-labelledby="program-merge-review-title" aria-busy={pending}>
			<div>
				<h2 id="program-merge-review-title" tabindex="-1" bind:this={reviewHeading}>Review merge</h2>
				<p>Review the affected references below. Nothing has changed yet.</p>
			</div>
			<dl class="review-diff">
				{#each programVocabularyDiffRows(selected.safeDiff) as row (row.key)}
					<div><dt>{row.label}</dt><dd>{row.before} → {row.after}</dd></div>
				{/each}
			</dl>
			<p class="status" role="status">{message}</p>
			<div class="review-actions">
				<Button loading={pending} disabled={pending} onclick={publish}>Merge categories</Button>
				<Button variant="ghost" disabled={pending} onclick={cancel}>Cancel</Button>
			</div>
		</section>
	{/if}
</div>

<style>
	.program-vocabulary-live { display: grid; gap: var(--je-space-6); }
	.review-card { display: grid; gap: var(--je-space-4); padding: var(--je-space-5); border: 1px solid var(--je-color-border); border-radius: var(--je-radius-md); background: var(--je-color-surface); }
	.review-card h2, .review-card p { margin: 0; }
	.review-card > div > p { margin-block-start: var(--je-space-1); color: var(--je-color-text-muted); }
	.review-diff { display: grid; gap: var(--je-space-2); margin: 0; }
	.review-diff div { display: grid; grid-template-columns: minmax(9rem, .45fr) minmax(0, 1fr); gap: var(--je-space-3); padding-block: var(--je-space-1); }
	.review-diff dt { color: var(--je-color-text-muted); font-size: var(--je-font-size-sm); }
	.review-diff dd { margin: 0; overflow-wrap: anywhere; }
	.status { min-block-size: 1.25rem; color: var(--je-color-danger); font-size: var(--je-font-size-sm); }
	.review-actions { display: flex; flex-wrap: wrap; gap: var(--je-space-2); }
	@media (max-width: 36rem) {
		.review-diff div { grid-template-columns: 1fr; gap: var(--je-space-1); }
		.review-actions { display: grid; grid-template-columns: 1fr; }
	}
</style>
