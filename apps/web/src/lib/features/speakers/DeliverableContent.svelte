<script lang="ts">
	/**
	 * What the speaker sent, rendered in place.
	 *
	 * The whole reason this record exists: until now an organizer could see that
	 * a travel-details form was `received` and could accept it, but could not
	 * read a word of it. Four shapes, one per completion mode, and each one
	 * mirrors the composition the material already has somewhere else in the
	 * product — form answers take the portal's `AnswerList` grammar (same fact,
	 * both sides of the fence, one visual grammar), an upload takes the file
	 * card, a confirmation is a receipt, a link is the link.
	 *
	 * Recognition roles applied here (page inventory, §4 of the record design):
	 * the submitted moment is a **time** value — when it arrived changes whether
	 * the organizer is late — so it takes the quiet time hue and tabular figures.
	 * Answer labels stay the neutral question; answer values stay neutral ink,
	 * because they are the evidence being read, not a value compared down rows.
	 * Nothing here takes the person hue: the person is the page's subject, not a
	 * scan key inside it.
	 */
	import { FileText } from 'lucide-svelte';
	import type { TaskSubmission } from '$lib/api/speaker-record-port';

	let {
		content
	}: {
		readonly content: Exclude<TaskSubmission, { kind: 'draft' }>;
	} = $props();

	/** A long answer gets the box it was written in; a short one does not. */
	const isLong = (value: string) => value.length > 90 || value.includes('\n');
</script>

<div class="content">
	<p class="content__when">
		Sent <time>{content.submittedAt}</time>
	</p>

	{#if content.kind === 'form'}
		<dl class="answers">
			{#each content.answers as answer (answer.fieldId)}
				<div class="answers__item" class:answers__item--long={isLong(answer.value)}>
					<dt class="answers__label">{answer.label}</dt>
					<!-- A blank answer is a fact about the form, not a missing row: the
					     question was asked and they passed on it, and hiding the row
					     would make a six-question form look like a five-question one. -->
					<dd class="answers__value" class:answers__value--blank={answer.value === ''}>
						{answer.value === '' ? 'They left this blank.' : answer.value}
					</dd>
				</div>
			{/each}
		</dl>
	{:else if content.kind === 'upload'}
		<ul class="files">
			{#each content.files as file (file.id)}
				<li class="file">
					<span class="file__mark" aria-hidden="true"><FileText size={16} /></span>
					<span class="file__body">
						<a class="file__name" href={file.href}>{file.name}</a>
						<span class="file__meta">{file.kindLabel} · {file.sizeLabel}</span>
					</span>
				</li>
			{/each}
		</ul>
	{:else if content.kind === 'confirm'}
		<p class="statement">{content.statement}</p>
	{:else}
		<p class="linked">
			<a href={content.href} target="_blank" rel="noopener noreferrer"
				>{content.label} <span class="ui-sr-only">— opens in new window</span></a>
		</p>
	{/if}

</div>

<style>
	/* An expansion is part of what opened it: the material sits on the sunken
	   surface inside the deliverable's own card, with a visible boundary, rather
	   than on the page background — which would read as a hole cut through it. */
	.content {
		margin-block-start: var(--je-space-3);
		padding: var(--je-space-3) var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
	}

	.content__when {
		margin: 0 0 var(--je-space-3);
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.content__when time {
		color: var(--je-color-recognition-time);
		font-variant-numeric: tabular-nums;
	}

	/* The portal's own answer composition, so a person and the organizer reading
	   the same submission read one shape. */
	.answers {
		display: grid;
		gap: var(--je-space-4);
		margin: 0;
	}

	.answers__item {
		display: grid;
		grid-template-columns: minmax(0, 12rem) minmax(0, 1fr);
		gap: var(--je-space-1) var(--je-space-4);
	}

	/* A long answer keeps its own reading measure under the label rather than
	   squeezing into a value column beside it. */
	.answers__item--long {
		grid-template-columns: minmax(0, 1fr);
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
		overflow-wrap: anywhere;
	}

	.answers__value--blank {
		color: var(--je-color-text-muted);
	}

	.files {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.file {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		min-block-size: 2.75rem;
		padding: var(--je-space-2) var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface);
	}

	.file__mark {
		display: grid;
		place-items: center;
		flex: none;
		color: var(--je-color-text-muted);
	}

	.file__body {
		display: grid;
		gap: 2px;
		min-inline-size: 0;
	}

	.file__name {
		overflow-wrap: anywhere;
	}

	.file__meta {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.statement,
	.linked {
		margin: 0;
		max-inline-size: 68ch;
		line-height: var(--je-leading-normal);
		overflow-wrap: anywhere;
	}

	/* Below the narrow breakpoint the label/value pair stacks rather than
	   holding a 12rem column that would leave the answer four words wide. */
	@media (max-width: 47.99rem) {
		.answers__item {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
