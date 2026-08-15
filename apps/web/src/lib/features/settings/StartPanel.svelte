<script lang="ts">
	/**
	 * What every settings section holds instead of itself until an event exists.
	 * The event is what the sections describe, so none of them can be answered
	 * before there is one — and saying so once is better than four empty forms.
	 */
	let { loading = false }: { readonly loading?: boolean } = $props();
</script>

{#if loading}
	<section class="panel start" aria-label="Loading event setup">
		<p class="start__title sk-head"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></p>
		<p class="start__copy">
			<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
			<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
			<span class="ui-skeleton skeleton-line" style="inline-size: 55%"></span>
		</p>
		<div class="start__actions">
			<span class="ui-skeleton skeleton-action"></span>
			<span class="ui-skeleton skeleton-action"></span>
		</div>
		<p class="start__hint"><span class="ui-skeleton skeleton-line" style="inline-size: 14rem"></span></p>
	</section>
{:else}
	<section class="panel start" aria-label="No event yet">
		<h2 class="start__title">No event yet</h2>
		<p class="start__copy">
			An event holds the name, dates, location, timezone, and venue note every other screen reads.
			Describe the event in your own words and the setup is drafted for you, or fill the fields in
			yourself.
		</p>
		<div class="start__actions">
			<button type="button" class="ui-button ui-button--primary ui-button--sm" disabled>
				Describe the event
			</button>
			<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled>
				Fill in the fields myself
			</button>
		</div>
		<p class="start__hint">Event creation arrives with the setup slice</p>
	</section>
{/if}

<style>
	/* A heading's line box without the heading element: the placeholder keeps
	   the leading its resolved heading is given. */
	.sk-head {
		line-height: var(--je-leading-tight);
	}

	.skeleton-line {
		display: inline-block;
		block-size: 1em;
		/* One line box exactly: the line inherits the height it stands in for. */
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 6.5rem;
		border-radius: var(--je-radius-control);
		vertical-align: bottom;
	}

	.panel {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.start {
		display: grid;
		justify-items: start;
		gap: var(--je-space-3);
		align-content: center;
		min-block-size: 16rem;
		padding: var(--je-space-8);
	}

	.start__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 600;
	}

	.start__copy {
		margin: 0;
		max-inline-size: 58ch;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.start__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.start__hint {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	@media (max-width: 920px) {
		.start {
			padding: var(--je-space-6) var(--je-space-4);
		}

		.start__actions {
			display: grid;
			grid-template-columns: 1fr;
			inline-size: 100%;
		}
	}
</style>
