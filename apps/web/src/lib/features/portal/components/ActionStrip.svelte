<script lang="ts">
	/**
	 * The things that are actually waiting on this person, and nothing else.
	 *
	 * Every entry can be finished today: an invitation with no answer, a task
	 * that still accepts work, a decision still open to one more request. States
	 * that need nothing — read, waitlisted, already answered — stay with their
	 * records further down. That restraint is the whole value of the strip; a
	 * list of everything would just be the page again, in a louder font.
	 *
	 * Each entry carries one action, and it lands on the record's own controls
	 * rather than committing from here, so a change is always made in the one
	 * place that shows its consequences.
	 */
	import { ChevronRight } from 'lucide-svelte';
	import { applyParams } from '$lib/features/workspace/url-state.svelte';
	import type { PortalActionItem } from '../home-actions';

	let { items }: { items: readonly PortalActionItem[] } = $props();

	const headingId = $props.id();

	/**
	 * Tone follows the loudest entry. An unanswered invitation or a passed
	 * deadline is somebody waiting; a decision still open to one more request is
	 * an option that costs nothing to leave. Painting the second like the first
	 * is how a colour stops meaning anything.
	 */
	const pressing = $derived(items.some((item) => item.kind !== 'appeal'));

	/** The address carries which record was asked for, so the target can mark itself. */
	function reveal(item: PortalActionItem) {
		return applyParams(
			item.kind === 'task' ? { task: item.targetId } : { engagement: item.targetId }
		);
	}
</script>

<section class="strip" class:strip--pressing={pressing} aria-labelledby={headingId}>
	<h2 class="strip__title" id={headingId}>
		{pressing ? 'Waiting on you' : 'Still open to you'}
	</h2>
	<ul class="strip__list">
		{#each items as item (item.id)}
			<li class="strip__item">
				<div class="strip__copy">
					<p class="strip__headline">{item.headline}</p>
					{#if item.detail}<p class="strip__detail">{item.detail}</p>{/if}
				</div>
				{#if item.href}
					<a class="ui-button ui-button--primary ui-button--sm strip__action" href={item.href}>
						{item.actionLabel}
					</a>
				{:else}
					<button
						type="button"
						class="ui-button ui-button--primary ui-button--sm strip__action"
						onclick={() => reveal(item)}>
						{item.actionLabel}<ChevronRight size={14} aria-hidden="true" />
					</button>
				{/if}
			</li>
		{/each}
	</ul>
</section>

<style>
	.strip {
		display: grid;
		gap: var(--je-space-3);
		padding: var(--je-space-5);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
	}

	.strip--pressing {
		background: var(--je-color-warning-soft);
		border-color: var(--je-color-warning);
	}

	.strip__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 650;
	}

	.strip__list {
		display: grid;
		gap: var(--je-space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.strip__item {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-2) var(--je-space-4);
	}

	.strip__copy {
		flex: 1;
		min-inline-size: min(100%, 18rem);
		display: grid;
		gap: 0.15rem;
	}

	.strip__headline {
		margin: 0;
		line-height: var(--je-leading-snug);
	}

	.strip__detail {
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.strip__action {
		flex: 0 0 auto;
	}
</style>
