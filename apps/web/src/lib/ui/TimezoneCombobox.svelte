<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { Check, ChevronDown, Search, X } from 'lucide-svelte';
	import { lower, placeNear, raise } from './anchored.svelte';
	import {
		browseTimezoneOptions,
		deviceTimezoneOption,
		searchTimezones,
		timezoneOffsetLabel,
		timezoneOptionFor,
		type TimezoneOption
	} from './timezone-search';

	interface Props {
		/** Canonical IANA timezone identifier, such as `America/New_York`. */
		value?: string;
		id?: string;
		describedBy?: string;
		invalid?: boolean;
		disabled?: boolean;
		onchange?: (value: string) => void;
	}

	let {
		value = $bindable(''),
		id,
		describedBy,
		invalid = false,
		disabled = false,
		onchange
	}: Props = $props();

	const uid = $props.id();
	const listboxId = `${uid}-listbox`;
	const device = deviceTimezoneOption();

	let open = $state(false);
	let placed = $state(false);
	let query = $state('');
	let activeIndex = $state(0);
	let root = $state<HTMLElement>();
	let trigger = $state<HTMLButtonElement>();
	let searchEl = $state<HTMLInputElement>();
	let scrim = $state<HTMLElement>();
	let panel = $state<HTMLElement>();

	const selected = $derived(timezoneOptionFor(value));
	const selectedId = $derived(selected?.id ?? value);

	// Browse mode leads with the device's own zone as the quiet best guess, then
	// the complete catalog ordered by GMT offset; no headings — the offset column
	// makes the order speak for itself, and nothing is hidden behind search.
	const flatOptions = $derived.by(() => {
		if (query.trim()) return searchTimezones(query);
		const all = browseTimezoneOptions();
		if (!device) return all;
		return [device, ...all.filter((option) => option.id !== device.id)];
	});
	const activeOption = $derived(flatOptions[activeIndex]);

	// Touch keyboards would cover the list; there the search field waits until tapped.
	const coarsePointer =
		typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

	function place() {
		if (!root || !panel) return;
		if (coarsePointer) {
			// A fixed top sheet instead of anchored placement: the virtual keyboard
			// resizes the visual viewport after we have placed, so the sheet tracks
			// that height and the pinned search field never sinks behind the keys.
			const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
			panel.style.width = '';
			panel.style.top = '';
			panel.style.left = '';
			panel.style.maxBlockSize = `${Math.max(160, viewportHeight - 16)}px`;
			placed = true;
			return;
		}
		const available = Math.max(0, window.innerWidth - 16);
		panel.style.width = `${Math.min(Math.max(root.getBoundingClientRect().width, 320), available)}px`;
		placeNear(root, panel);
		placed = true;
	}

	function scrollActiveIntoView(block: ScrollLogicalPosition = 'nearest') {
		tick().then(() => {
			document.getElementById(`${uid}-option-${activeIndex}`)?.scrollIntoView({ block });
		});
	}

	async function openPanel(seed = '') {
		if (disabled || open) return;
		query = seed;
		open = true;
		placed = false;
		await tick();
		// The scrim enters the top layer before the panel so that inside an open
		// modal dialog it still dims the page yet stays under the list.
		raise(scrim);
		raise(panel);
		place();
		const selectedIndex = flatOptions.findIndex((option) => option.id === selectedId);
		activeIndex = seed || selectedIndex < 0 ? 0 : selectedIndex;
		// The panel stays hidden until placed, and a hidden input refuses focus;
		// wait for placement to reach the DOM before moving focus into it.
		await tick();
		if (!coarsePointer) searchEl?.focus();
		scrollActiveIntoView('center');
	}

	function closePanel({ refocus = false } = {}) {
		if (!open) return;
		lower(panel);
		lower(scrim);
		open = false;
		placed = false;
		query = '';
		if (refocus) tick().then(() => trigger?.focus());
	}

	function choose(option: TimezoneOption) {
		if (option.id !== selectedId) {
			value = option.id;
			onchange?.(option.id);
		}
		closePanel({ refocus: true });
	}

	function moveActive(delta: number) {
		if (!flatOptions.length) return;
		activeIndex = (activeIndex + delta + flatOptions.length) % flatOptions.length;
		scrollActiveIntoView();
	}

	function onTriggerKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
			if (!open) {
				event.preventDefault();
				void openPanel();
			}
		} else if (event.key === 'Escape' && open) {
			event.preventDefault();
			closePanel({ refocus: true });
		} else if (
			event.key.length === 1 &&
			event.key !== ' ' &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			!open
		) {
			event.preventDefault();
			void openPanel(event.key);
		}
	}

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveActive(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveActive(-1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (activeOption) choose(activeOption);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closePanel({ refocus: true });
		} else if (event.key === 'Tab') {
			event.preventDefault();
			closePanel({ refocus: true });
		}
	}

	// Every row keeps the two-line shape so the eye reads one kind of thing;
	// UTC's id equals its label, so it carries its full name instead.
	function optionDetail(option: TimezoneOption): string {
		return option.id === option.label ? 'Coordinated Universal Time' : option.id;
	}

	function onRootFocusout(event: FocusEvent) {
		const next = event.relatedTarget as Node | null;
		if (open && root && next && !root.contains(next)) closePanel();
	}

	function onWindowPointerdown(event: PointerEvent) {
		if (open && root && !root.contains(event.target as Node)) closePanel();
	}

	$effect(() => {
		if (!open) return;
		const reposition = () => place();
		document.addEventListener('scroll', reposition, { capture: true, passive: true });
		window.addEventListener('resize', reposition);
		// The keyboard appearing or leaving changes only the visual viewport.
		window.visualViewport?.addEventListener('resize', reposition);
		return () => {
			document.removeEventListener('scroll', reposition, { capture: true });
			window.removeEventListener('resize', reposition);
			window.visualViewport?.removeEventListener('resize', reposition);
		};
	});

	onDestroy(() => {
		lower(panel);
		lower(scrim);
	});
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

<div class="tzc" bind:this={root} onfocusout={onRootFocusout}>
	<button
		type="button"
		class="ui-control tzc__trigger"
		role="combobox"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-controls={listboxId}
		aria-describedby={describedBy}
		aria-invalid={invalid || undefined}
		{id}
		{disabled}
		bind:this={trigger}
		onclick={() => (open ? closePanel({ refocus: true }) : void openPanel())}
		onkeydown={onTriggerKeydown}>
		<span class="tzc__value" class:tzc__value--placeholder={!selectedId}>
			{selected?.label ?? (value || 'Choose a timezone')}
		</span>
		{#if selected}
			<span class="tzc__offset">{timezoneOffsetLabel(selected.id)}</span>
		{/if}
		<span class="tzc__chevron" class:tzc__chevron--open={open} aria-hidden="true">
			<ChevronDown size={15} />
		</span>
	</button>

	{#if open}
		{#if coarsePointer}
			<button
				type="button"
				class="tzc__scrim"
				aria-hidden="true"
				tabindex={-1}
				bind:this={scrim}
				onclick={() => closePanel()}></button>
		{/if}
		<div
			class="tzc__panel"
			class:tzc__panel--placed={placed}
			class:tzc__panel--sheet={coarsePointer}
			bind:this={panel}>
			<div class="tzc__top">
				<div class="ui-input-wrap ui-input-wrap--leading tzc__search">
					<Search class="ui-input-wrap__icon" size={15} aria-hidden="true" />
					<input
						class="ui-control"
						type="text"
						role="combobox"
						autocomplete="off"
						spellcheck="false"
						placeholder="Search city, country, or GMT offset"
						aria-label="Search timezones"
						aria-autocomplete="list"
						aria-expanded="true"
						aria-controls={listboxId}
						aria-activedescendant={activeOption ? `${uid}-option-${activeIndex}` : undefined}
						bind:this={searchEl}
						bind:value={query}
						oninput={() => (activeIndex = 0)}
						onkeydown={onSearchKeydown} />
				</div>
				{#if coarsePointer}
					<button
						type="button"
						class="tzc__close"
						aria-label="Close timezone list"
						onclick={() => closePanel({ refocus: true })}>
						<X size={17} aria-hidden="true" />
					</button>
				{/if}
			</div>
			{#if flatOptions.length}
				<div class="tzc__options" id={listboxId} role="listbox" aria-label="Timezones">
					{#each flatOptions as option, index (option.id)}
						<button
							type="button"
							class="tzc__option"
							class:tzc__option--active={index === activeIndex}
							class:tzc__option--selected={option.id === selectedId}
							id={`${uid}-option-${index}`}
							role="option"
							tabindex="-1"
							aria-selected={option.id === selectedId}
							onpointermove={() => (activeIndex = index)}
							onclick={() => choose(option)}>
							<span class="tzc__copy">
								<strong>{option.label}</strong>
								<small>{optionDetail(option)}</small>
							</span>
							<span class="tzc__side">
								<span class="tzc__side-offset">{timezoneOffsetLabel(option.id)}</span>
								{#if option.id === selectedId}<span class="tzc__check"><Check size={15} aria-hidden="true" /></span>{/if}
							</span>
						</button>
					{/each}
				</div>
			{:else}
				<p class="tzc__empty">
					No timezone found. Try a city, a country, or an offset such as “GMT+2”.
				</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.tzc {
		position: relative;
		min-inline-size: 0;
	}

	.tzc__trigger {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		text-align: start;
		cursor: pointer;
	}

	.tzc__trigger:disabled {
		cursor: not-allowed;
	}

	.tzc__value {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tzc__value--placeholder {
		color: var(--je-color-text-subtle);
	}

	.tzc__offset {
		flex-shrink: 0;
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-muted);
	}

	.tzc__chevron {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		color: var(--je-color-text-muted);
		transition: rotate var(--je-duration-fast) var(--je-ease);
	}

	.tzc__chevron--open {
		rotate: 180deg;
	}

	@media (prefers-reduced-motion: reduce) {
		.tzc__chevron {
			transition: none;
		}
	}

	.tzc__panel {
		position: fixed;
		inset: auto;
		z-index: 60;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		max-inline-size: calc(100vw - 1rem);
		max-block-size: min(24rem, calc(100vh - 1rem));
		margin: 0;
		padding: var(--je-space-1);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-md);
		visibility: hidden;
	}

	.tzc__panel--placed {
		visibility: visible;
	}

	/* Coarse pointers get a viewport-fixed top sheet: no anchor arithmetic to go
	   stale when the keyboard appears, and the search row stays at the top edge. */
	.tzc__panel--sheet {
		inset: 0.5rem 0.5rem auto;
		/* The popover UA style is fit-content with auto margins; the sheet
		   stretches edge to edge instead. */
		inline-size: auto;
		margin: 0;
		max-inline-size: none;
	}

	.tzc__scrim {
		position: fixed;
		inset: 0;
		/* Raised into the top layer, the popover UA style would shrink this to
		   fit-content; explicit auto sizing keeps it covering the viewport. */
		inline-size: auto;
		block-size: auto;
		margin: 0;
		z-index: 59;
		border: 0;
		padding: 0;
		background: var(--je-color-scrim);
	}

	.tzc__top {
		display: flex;
		align-items: center;
		gap: var(--je-space-1);
		padding: var(--je-space-1);
	}

	.tzc__search {
		flex: 1;
		min-inline-size: 0;
	}

	.tzc__close {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		inline-size: var(--je-control-height);
		block-size: var(--je-control-height);
		border: 0;
		border-radius: var(--je-radius-control);
		background: transparent;
		color: var(--je-color-text-muted);
		cursor: pointer;
	}

	.tzc__close:hover {
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text);
	}

	.tzc__close:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.tzc__options {
		display: grid;
		/* When the list overflows its constrained panel row, auto rows collapse
		   to the option's minimum; max-content keeps both text lines visible. */
		grid-auto-rows: max-content;
		gap: 2px;
		min-block-size: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.tzc__option {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--je-space-2);
		min-block-size: var(--je-control-height);
		padding: var(--je-space-2);
		border: 0;
		border-radius: var(--je-radius-control);
		background: transparent;
		font: inherit;
		color: var(--je-color-text);
		text-align: start;
		cursor: pointer;
	}

	.tzc__option--active,
	.tzc__option:hover {
		background: var(--je-color-surface-sunken);
	}

	.tzc__option--selected {
		background: var(--je-color-surface-selected);
	}

	.tzc__option--selected.tzc__option--active,
	.tzc__option--selected:hover {
		background: color-mix(in srgb, var(--je-color-surface-selected) 70%, var(--je-color-surface-sunken));
	}

	.tzc__option:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.tzc__copy {
		display: grid;
		gap: 2px;
		min-inline-size: 0;
	}

	.tzc__copy strong {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.tzc__copy small {
		overflow: hidden;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
		transition: color var(--je-duration-fast) var(--je-ease);
	}

	.tzc__option--active .tzc__copy small,
	.tzc__option:hover .tzc__copy small {
		color: var(--je-color-text);
	}

	.tzc__side {
		display: flex;
		align-items: center;
		gap: var(--je-space-1);
	}

	.tzc__side-offset {
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-muted);
	}

	.tzc__check {
		display: grid;
		place-items: center;
		color: var(--je-color-action);
	}

	.tzc__empty {
		margin: 0;
		padding: var(--je-space-4) var(--je-space-3);
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}
</style>
