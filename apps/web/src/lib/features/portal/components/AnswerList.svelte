<script lang="ts">
	/**
	 * What was submitted, as it was submitted.
	 *
	 * The questions and their order come from the form version pinned to this
	 * record, so correcting an answer never reshapes the record: the same
	 * questions stay, in the same order, and only the text inside them moves.
	 * Reading and correcting therefore share one composition rather than two.
	 */
	import { Field } from '$lib/ui';
	import type { PortalAnswerView } from '$lib/api/portal/view-models';

	interface Props {
		answers: readonly PortalAnswerView[];
		/** Present while the record is being corrected; absent while it is being read. */
		draft?: Record<string, string> | null;
		onedit?: (fieldId: string, value: string) => void;
		busy?: boolean;
	}

	let { answers, draft = null, onedit, busy = false }: Props = $props();

	/** A long answer gets the box it was written in; a short one does not. */
	const isLong = (answer: PortalAnswerView) =>
		answer.value.length > 90 || answer.value.includes('\n');
</script>

{#if draft}
	<div class="answers answers--editing">
		{#each answers as answer (answer.fieldId)}
			<Field id={`answer-${answer.fieldId}`} label={answer.label}>
				{#snippet children({ id, describedBy })}
					{#if isLong(answer)}
						<textarea
							{id}
							class="ui-textarea"
							rows="5"
							aria-describedby={describedBy}
							disabled={busy}
							value={draft[answer.fieldId] ?? ''}
							oninput={(event) => onedit?.(answer.fieldId, event.currentTarget.value)}
						></textarea>
					{:else}
						<input
							{id}
							class="ui-control"
							type="text"
							aria-describedby={describedBy}
							disabled={busy}
							value={draft[answer.fieldId] ?? ''}
							oninput={(event) => onedit?.(answer.fieldId, event.currentTarget.value)} />
					{/if}
				{/snippet}
			</Field>
		{/each}
	</div>
{:else}
	<dl class="answers">
		{#each answers as answer (answer.fieldId)}
			<div class="answers__item">
				<dt class="answers__label">{answer.label}</dt>
				<dd class="answers__value" class:answers__value--blank={answer.value === ''}>
					{answer.value === '' ? 'You left this blank.' : answer.value}
				</dd>
			</div>
		{/each}
	</dl>
{/if}

<style>
	.answers {
		display: grid;
		gap: var(--je-space-5);
		margin: 0;
	}

	.answers--editing {
		gap: var(--je-space-4);
	}

	.answers__item {
		display: grid;
		gap: var(--je-space-1);
	}

	.answers__label {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.answers__value {
		margin: 0;
		white-space: pre-wrap;
		line-height: var(--je-leading-normal);
		max-inline-size: 68ch;
	}

	.answers__value--blank {
		color: var(--je-color-text-muted);
	}
</style>
