<script lang="ts">
	/**
	 * The journey strip: how far along its line one submission is, as five dots
	 * the eye can compare straight down the column — and, one press away, the
	 * breakdown naming each step's own fact.
	 *
	 * Information, never status: the dots spend neutral ink only (done at full
	 * ink, the current step ringed, the rest recessive), because "how far" is
	 * not "how good" — verdicts keep their worded badges one column over.
	 * The disclosure opens on hover for a fine pointer (owner call,
	 * 2026-08-15: "hover for desktop, click for phones") and on press/tap
	 * everywhere — hover is an accelerator on top of the universal press path,
	 * so the hover law holds: nothing here is carried by hover alone.
	 */
	import { Popover } from '$lib/ui';
	import type { JourneyStep } from './submission-view';

	let {
		steps,
		context,
		onreveal
	}: {
		readonly steps: JourneyStep[];
		/** The submission's title, for the disclosure's accessible name. */
		readonly context: string;
		/** Mirrors the breakdown to the polite live region, like the signals do. */
		readonly onreveal?: () => void;
	} = $props();

	const doneCount = $derived(steps.filter((step) => step.state === 'done').length);
	const applicable = $derived(steps.filter((step) => step.state !== 'skipped').length);
	const current = $derived(steps.find((step) => step.state === 'current'));
	const summary = $derived(
		`${doneCount} of ${applicable} steps done${current ? ` — next: ${current.label.toLowerCase()}` : ''}`
	);
</script>

<Popover label={`Progress on “${context}” — ${summary}`} kind="figure" hoverOpen {onreveal}>
	{#snippet trigger()}
		<span class="dots" aria-hidden="true">
			{#each steps as step (step.key)}
				<span class="dot dot--{step.state}"></span>
			{/each}
		</span>
	{/snippet}
	{#snippet children()}
		<p class="lede">{summary}</p>
		<ul class="list">
			{#each steps as step (step.key)}
				<li class="row row--{step.state}">
					<span class="dot dot--{step.state}"></span>
					<span class="row__label">{step.label}</span>
					{#if step.note}
						<span class="row__note">{step.note}</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/snippet}
</Popover>

<style>
	/* A row of five, tall enough to press: the padding buys the target without
	   growing the ink. */
	.dots {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: var(--je-space-2) 2px;
	}

	.dot {
		inline-size: 7px;
		block-size: 7px;
		border-radius: 50%;
		flex: 0 0 auto;
	}

	/* The arrivals-plot grammar: what is behind recedes to muted ink, and only
	   the step in progress holds full ink — so thirteen strips down a page read
	   as texture with one emphasized mark each, instead of five bold points per
	   row competing with the titles. Status colours would lie here (a declined
	   line completes without being good news), and the recognition vocabulary
	   is closed — so the hierarchy is ink, not hue. */
	.dot--done {
		background: var(--je-color-text-muted);
	}

	.dot--current {
		border: 2px solid var(--je-color-text);
		inline-size: 9px;
		block-size: 9px;
	}

	.dot--upcoming {
		border: 1px solid var(--je-color-border-strong);
	}

	/* A step this row's line does not pass through: present, so the strip keeps
	   one geometry down the column, and visibly out of play. */
	.dot--skipped {
		border: 1px dashed var(--je-color-border);
	}

	.lede {
		margin: 0 0 var(--je-space-2);
		font-weight: 600;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--je-space-1);
	}

	/* The dot belongs to the step's NAME, not to the row's box: centered
	   against a note that wraps to two lines it floated between them. Pinned
	   to the first line instead — top-aligned, nudged to that line's own
	   optical middle. */
	.row {
		display: flex;
		align-items: flex-start;
		gap: var(--je-space-2);
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
	}

	.row .dot {
		margin-block-start: calc((1lh - 7px) / 2);
	}

	.row .dot--current {
		margin-block-start: calc((1lh - 9px) / 2);
	}

	.row__label {
		font-weight: 600;
		white-space: nowrap;
	}

	.row--skipped .row__label,
	.row--upcoming .row__label {
		color: var(--je-color-text-muted);
		font-weight: 400;
	}

	.row__note {
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-xs);
	}
</style>
