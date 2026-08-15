<script lang="ts">
	/**
	 * The page's own sections, listed beside it. Plain anchors: without script it
	 * is a working list of in-page links, and with script the one being read
	 * carries the mark. It never moves focus — the reader keeps their place until
	 * they choose a destination themselves.
	 */
	import { activeAnchorId, type SettingsAnchor } from './sections';

	let { entries }: { readonly entries: readonly SettingsAnchor[] } = $props();

	/**
	 * How far below the rail's own top edge the reading line sits, as a share of
	 * what is left of the viewport. An anchor jump lands its target just under
	 * the sticky top bar (`scroll-padding-top` in the base layer), so a line at
	 * the very top edge would be decided by a few pixels; a quarter of the way
	 * down asks the question a reader would — which section fills the screen.
	 */
	const READING_LINE_SHARE = 0.25;

	let railElement = $state<HTMLElement>();
	let active = $state('');

	$effect(() => {
		const ids = entries.map((entry) => entry.id);
		let frame = 0;

		const measure = () => {
			frame = 0;
			const rail = railElement;
			if (!rail) return;
			const railTop = rail.getBoundingClientRect().top;
			const readingLine = railTop + (window.innerHeight - railTop) * READING_LINE_SHARE;
			const positions = ids.flatMap((id) => {
				const element = document.getElementById(id);
				return element ? [{ id, top: element.getBoundingClientRect().top }] : [];
			});
			active = activeAnchorId(positions, readingLine) ?? '';
		};

		const schedule = () => {
			if (frame === 0) frame = requestAnimationFrame(measure);
		};

		measure();
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		// Sections resolve after this rail mounts and change where every section
		// below them starts. Without watching the document's own box, the mark
		// would keep answering for a page that has since grown under the reader.
		const grew = new ResizeObserver(schedule);
		grew.observe(document.body);
		return () => {
			if (frame !== 0) cancelAnimationFrame(frame);
			grew.disconnect();
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
		};
	});
</script>

<nav class="rail" aria-label="On this page" bind:this={railElement}>
	<p class="rail__caption">On this page</p>
	<ul class="rail__list">
		{#each entries as entry (entry.id)}
			<li>
				<a
					class="rail__link"
					class:rail__link--current={active === entry.id}
					href={`#${entry.id}`}
					aria-current={active === entry.id ? 'true' : undefined}>{entry.label}</a>
			</li>
		{/each}
	</ul>
</nav>

<style>
	/* Costs content width, so it exists only where there is width to spend. The
	   page below that measure keeps the same sections in the same order — the
	   rail is a shortcut, never the only way to reach one. */
	.rail {
		display: none;
	}

	@media (min-width: 1180px) {
		.rail {
			position: sticky;
			inset-block-start: calc(var(--je-topbar-height) + var(--je-space-6));
			display: grid;
			align-content: start;
			gap: var(--je-space-2);
		}
	}

	.rail__caption {
		margin: 0;
		padding-inline: var(--je-space-2);
		font-size: var(--je-font-size-2xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.rail__list {
		display: grid;
		gap: 0;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.rail__link {
		display: block;
		padding: var(--je-space-1) var(--je-space-2);
		border-inline-start: 2px solid var(--je-color-border);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		text-decoration: none;
	}

	.rail__link:hover {
		color: var(--je-color-text);
		border-inline-start-color: var(--je-color-border-strong);
	}

	.rail__link:focus-visible {
		outline: 2px solid var(--je-color-focus);
		outline-offset: 2px;
	}

	/* Selected reads as chosen, not alarmed: full ink against the brand edge the
	   sidebar already uses for the destination you are on. */
	.rail__link--current {
		color: var(--je-color-text);
		font-weight: 600;
		border-inline-start-color: var(--je-color-action);
	}
</style>
