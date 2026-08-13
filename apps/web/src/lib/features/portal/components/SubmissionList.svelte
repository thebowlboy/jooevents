<script lang="ts">
	/**
	 * Everything this person has sent to this event, whatever became of it. A
	 * withdrawn or declined submission stays on the list: it is a record of what
	 * they said, and removing it would make the portal disagree with their memory.
	 *
	 * One row is one link to that record's own page — the row's whole area, so
	 * the target is the same size on a phone as it is under a mouse.
	 */
	import { Badge } from '$lib/ui';
	import type { PortalSubmissionView } from '$lib/api/portal/view-models';
	import { submissionStatusCopy } from '../copy';
	import { formatDay } from '../format';
	import StateBadge from './StateBadge.svelte';

	interface Props {
		submissions?: readonly PortalSubmissionView[];
		timezone?: string;
		/**
		 * Rows to stand in for while the read is in flight. They are this
		 * component's own markup with its text replaced by fills, so the list
		 * cannot change shape underneath someone when the answer arrives.
		 */
		placeholders?: number;
	}

	let { submissions = [], timezone = 'UTC', placeholders = 0 }: Props = $props();
</script>

<ul class="list">
	{#each Array.from({ length: placeholders }, (_, index) => index) as index (index)}
		<li>
			<div class="row row--waiting" aria-hidden="true">
				<span class="row__title"><span class="ui-skeleton row__fill"></span></span>
				<span class="row__states"><span class="ui-skeleton row__fill row__fill--badge"></span></span>
				<span class="row__meta"><span class="ui-skeleton row__fill row__fill--meta"></span></span>
			</div>
		</li>
	{/each}
	{#each submissions as submission (submission.id)}
		<li>
			<a class="row" href={`/portal/submissions/${submission.id}`}>
				<span class="row__title">{submission.title}</span>
				<span class="row__states">
					<StateBadge state={submissionStatusCopy[submission.status]} />
					{#if submission.late}<Badge tone="neutral">Sent late</Badge>{/if}
				</span>
				<span class="row__meta">
					Sent {formatDay(submission.submittedAt, timezone)}{#if submission.target.kind === 'collecting_session'}&nbsp;· for {submission.target.name}{/if}
				</span>
			</a>
		</li>
	{/each}
</ul>

<style>
	.list {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: var(--je-space-1) var(--je-space-3);
		padding: var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		color: inherit;
		text-decoration: none;
	}

	.row:hover {
		border-color: var(--je-color-border-strong);
		background: var(--je-color-surface-raised);
	}

	.row:active {
		background: var(--je-color-surface-selected);
	}

	.row__title {
		font-weight: 600;
		line-height: var(--je-leading-snug);
	}

	.row__states {
		display: flex;
		align-items: start;
		flex-wrap: wrap;
		gap: var(--je-space-1);
		justify-content: end;
	}

	.row__meta {
		grid-column: 1 / -1;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	/* Each fill is one line box inside the line it stands in for, so a waiting
	   row is exactly as tall as the row that replaces it. */
	.row__fill {
		display: inline-block;
		block-size: 1lh;
		inline-size: 70%;
		vertical-align: bottom;
	}

	.row__fill--badge {
		inline-size: 5rem;
	}

	.row__fill--meta {
		inline-size: 45%;
	}

	@media (max-width: 560px) {
		/* The states move under the title rather than squeezing it into a column
		   two words wide. */
		.row {
			grid-template-columns: 1fr;
		}

		.row__states {
			justify-content: start;
		}
	}
</style>
