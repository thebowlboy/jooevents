<script lang="ts">
	import { ALargeSmall, Minus, RotateCcw } from 'lucide-svelte';
	import { bodyFaces, displayFaces, rootSizes, type FaceOption } from './fonts';

	// Rests as a corner pill and expands only while choosing, matching the
	// scenario switcher, so neither tool sits on top of the page being judged.
	let open = $state(false);
	let root = $state<HTMLElement>();

	const STORE = 'je-dev-fonts';
	const DEFAULTS = { body: 'inter', display: 'merriweather', size: 16 };

	let body = $state(DEFAULTS.body);
	let display = $state(DEFAULTS.display);
	let size = $state<number>(DEFAULTS.size);
	let loading = $state<string | null>(null);

	// The chosen faces override the token layer from the document element, which
	// wins over every @layer without editing the stylesheet the app ships.
	function apply() {
		const el = document.documentElement;
		el.style.setProperty('--je-font-body', bodyFaces.find((f) => f.key === body)!.stack);
		el.style.setProperty('--je-font-display', displayFaces.find((f) => f.key === display)!.stack);
		el.style.setProperty('--je-font-size-root', `${size}px`);
		localStorage.setItem(STORE, JSON.stringify({ body, display, size }));
	}

	async function ensure(face: FaceOption) {
		if (!face.load) return;
		loading = face.key;
		try {
			await face.load();
		} finally {
			loading = null;
		}
	}

	async function pickBody(face: FaceOption) {
		await ensure(face);
		body = face.key;
		apply();
	}

	async function pickDisplay(face: FaceOption) {
		await ensure(face);
		display = face.key;
		apply();
	}

	function pickSize(next: number) {
		size = next;
		apply();
	}

	function reset() {
		body = DEFAULTS.body;
		display = DEFAULTS.display;
		size = DEFAULTS.size;
		const el = document.documentElement;
		el.style.removeProperty('--je-font-body');
		el.style.removeProperty('--je-font-display');
		el.style.removeProperty('--je-font-size-root');
		localStorage.removeItem(STORE);
	}

	// Restore on load so a choice survives navigation and reloads; the faces are
	// re-fetched because @font-face rules do not persist across a document.
	$effect(() => {
		const raw = localStorage.getItem(STORE);
		if (!raw) return;
		try {
			const saved = JSON.parse(raw) as { body: string; display: string; size: number };
			const b = bodyFaces.find((f) => f.key === saved.body);
			const d = displayFaces.find((f) => f.key === saved.display);
			if (!b || !d) return;
			body = b.key;
			display = d.key;
			size = saved.size ?? DEFAULTS.size;
			Promise.all([ensure(b), ensure(d)]).then(apply);
		} catch {
			localStorage.removeItem(STORE);
		}
	});

	// Every row is set in the face it offers, so the list is only a specimen
	// sheet once all of them are resolved. Loading on click would mean the list
	// silently previews the fallback until each option had been tried.
	let preloaded = $state(false);
	$effect(() => {
		if (!open || preloaded) return;
		preloaded = true;
		void Promise.all([...bodyFaces, ...displayFaces].map((face) => face.load?.()));
	});

	const dirty = $derived(
		body !== DEFAULTS.body || display !== DEFAULTS.display || size !== DEFAULTS.size
	);

	function onWindowPointerdown(event: PointerEvent) {
		if (open && root && !root.contains(event.target as Node)) open = false;
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (open && event.key === 'Escape') open = false;
	}
</script>

<svelte:window onpointerdown={onWindowPointerdown} onkeydown={onWindowKeydown} />

{#if open}
	<div class="fonts" role="group" aria-label="Typeface switcher (dev only)" bind:this={root}>
		<header class="fonts__head">
			<span class="fonts__title"><ALargeSmall size={14} aria-hidden="true" />Typefaces</span>
			{#if dirty}
				<button type="button" class="fonts__chrome" onclick={reset} aria-label="Reset to shipped typefaces">
					<RotateCcw size={13} />
				</button>
			{/if}
			<button type="button" class="fonts__chrome" aria-label="Collapse typeface switcher" onclick={() => (open = false)}>
				<Minus size={13} />
			</button>
		</header>

		<div class="fonts__group">
			<p class="fonts__legend">Body &amp; UI <span>every label, table cell, and form</span></p>
			<ul class="fonts__list">
				{#each bodyFaces as face (face.key)}
					<li>
						<button
							type="button"
							class="fonts__item"
							class:fonts__item--active={face.key === body}
							aria-pressed={face.key === body}
							onclick={() => pickBody(face)}>
							<span class="fonts__name" style="font-family: {face.stack}">
								{face.name}
								{#if loading === face.key}<span class="ui-spinner" aria-hidden="true"></span>{/if}
							</span>
							<span class="fonts__sample" style="font-family: {face.stack}">
								Waitlisted · 223 submissions · 62% · Il1O0
							</span>
							<span class="fonts__note">{face.note}</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>

		<div class="fonts__group">
			<p class="fonts__legend">Display <span>Merriweather’s slot: large headings only</span></p>
			<ul class="fonts__list">
				{#each displayFaces as face (face.key)}
					<li>
						<button
							type="button"
							class="fonts__item"
							class:fonts__item--active={face.key === display}
							aria-pressed={face.key === display}
							onclick={() => pickDisplay(face)}>
							<span class="fonts__name" style="font-family: {face.stack}">
								{face.name}
								{#if loading === face.key}<span class="ui-spinner" aria-hidden="true"></span>{/if}
							</span>
							<span class="fonts__note">{face.note}</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>

		<div class="fonts__size">
			<span class="fonts__legend">Root size <span>scales the whole rem ladder</span></span>
			<div class="ui-segmented" role="group" aria-label="Root font size">
				{#each rootSizes as option (option)}
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={size === option}
						onclick={() => pickSize(option)}>{option}px</button>
				{/each}
			</div>
		</div>

		<p class="fonts__hint">
			Applies live on every screen and survives navigation. Nothing here reaches a production build.
		</p>
	</div>
{:else}
	<button
		type="button"
		class="fonts fonts--pill"
		class:fonts--pill-dirty={dirty}
		aria-label="Open typeface switcher"
		onclick={() => (open = true)}>
		<ALargeSmall size={15} aria-hidden="true" />
	</button>
{/if}

<style>
	.fonts {
		position: fixed;
		inset-block-end: var(--je-space-4);
		/* Clears the scenario switcher, which owns the corner. */
		inset-inline-end: calc(var(--je-space-4) + 3rem);
		z-index: 90;
		inline-size: 20rem;
		max-block-size: min(72vh, 34rem);
		overflow-y: auto;
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		box-shadow: var(--je-shadow-lg);
		font-size: var(--je-font-size-sm);
	}

	.fonts--pill {
		inline-size: auto;
		display: grid;
		place-items: center;
		padding: var(--je-space-2);
		border-radius: var(--je-radius-round);
		color: var(--je-color-text-muted);
		cursor: pointer;
	}

	.fonts--pill:hover {
		color: var(--je-color-text);
	}

	/* A changed typeface is a state the page does not otherwise reveal. */
	.fonts--pill-dirty {
		border-color: var(--je-color-action);
		color: var(--je-color-action);
	}

	.fonts__head {
		position: sticky;
		inset-block-start: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		padding: var(--je-space-2) var(--je-space-3);
		background: var(--je-color-surface);
		border-block-end: 1px solid var(--je-color-border);
	}

	.fonts__title {
		flex: 1;
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		font-weight: 650;
	}

	.fonts__chrome {
		display: grid;
		place-items: center;
		border: 0;
		background: transparent;
		padding: var(--je-space-1);
		border-radius: var(--je-radius-xs);
		color: var(--je-color-text-muted);
		cursor: pointer;
	}

	.fonts__chrome:hover {
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text);
	}

	.fonts__group {
		border-block-end: 1px solid var(--je-color-border);
		padding-block-end: var(--je-space-2);
	}

	.fonts__legend {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-2);
		margin: 0;
		padding: var(--je-space-2) var(--je-space-3) var(--je-space-1);
		font-size: var(--je-font-size-2xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.fonts__legend span {
		font-weight: 500;
		text-transform: none;
		letter-spacing: 0;
		color: var(--je-color-text-subtle);
	}

	.fonts__list {
		list-style: none;
		margin: 0;
		padding: 0 var(--je-space-2);
		display: grid;
		gap: 2px;
	}

	.fonts__item {
		display: grid;
		gap: 1px;
		inline-size: 100%;
		text-align: start;
		padding: var(--je-space-2);
		border: 1px solid transparent;
		border-radius: var(--je-radius-control);
		background: transparent;
		cursor: pointer;
	}

	.fonts__item:hover {
		background: var(--je-color-page);
	}

	.fonts__item--active {
		border-color: var(--je-color-action);
		background: var(--je-color-surface-selected);
	}

	.fonts__name {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		font-size: var(--je-font-size-md);
		font-weight: 650;
		color: var(--je-color-text);
	}

	/* The row previews itself: the sample is set in the face it offers, at the
	   size the operator tables actually use. */
	.fonts__sample {
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-muted);
	}

	.fonts__note {
		font-size: var(--je-font-size-2xs);
		line-height: var(--je-leading-snug);
		color: var(--je-color-text-subtle);
	}

	.fonts__size {
		display: grid;
		gap: var(--je-space-1);
		padding: 0 var(--je-space-3) var(--je-space-2);
	}

	.fonts__size .fonts__legend {
		padding-inline: 0;
	}

	.fonts__hint {
		margin: 0;
		padding: var(--je-space-2) var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border);
		font-size: var(--je-font-size-2xs);
		line-height: var(--je-leading-snug);
		color: var(--je-color-text-muted);
	}
</style>
