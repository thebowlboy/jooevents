<script lang="ts" module>
	export interface DescribedOption<V extends string = string> {
		value: V;
		label: string;
		/** One or two short sentences: what this choice does, then its key limit. */
		description?: string;
	}
</script>

<script lang="ts" generics="V extends string">
	import { onDestroy, tick } from 'svelte';
	import { Check, ChevronDown, X } from 'lucide-svelte';
	import { lower, placeNear, raise } from './anchored.svelte';

	interface Props {
		value?: V;
		options: readonly DescribedOption<V>[];
		/** Names the option list for assistive tech and the touch sheet header. */
		label: string;
		id?: string;
		describedBy?: string;
		invalid?: boolean;
		disabled?: boolean;
		onchange?: (value: V) => void;
	}

	let {
		value = $bindable(),
		options,
		label,
		id,
		describedBy,
		invalid = false,
		disabled = false,
		onchange
	}: Props = $props();

	const uid = $props.id();
	const listboxId = `${uid}-listbox`;

	let open = $state(false);
	let placed = $state(false);
	let activeIndex = $state(0);
	let root = $state<HTMLElement>();
	let trigger = $state<HTMLButtonElement>();
	let scrim = $state<HTMLElement>();
	let panel = $state<HTMLElement>();

	const selected = $derived(options.find((option) => option.value === value));
	const activeOption = $derived(options[activeIndex]);

	// Touch gets a viewport-fixed sheet; anchored placement goes stale there.
	const coarsePointer =
		typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

	let typed = '';
	let typedClearer: ReturnType<typeof setTimeout> | undefined;

	function place() {
		if (!root || !panel) return;
		if (coarsePointer) {
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

	async function openPanel() {
		if (disabled || open) return;
		open = true;
		placed = false;
		await tick();
		// The scrim must enter the top layer before the panel so that inside an
		// open modal dialog it still dims the page yet stays under the list.
		raise(scrim);
		raise(panel);
		place();
		const selectedIndex = options.findIndex((option) => option.value === value);
		activeIndex = selectedIndex < 0 ? 0 : selectedIndex;
		scrollActiveIntoView('center');
	}

	function closePanel({ refocus = false } = {}) {
		if (!open) return;
		lower(panel);
		lower(scrim);
		open = false;
		placed = false;
		if (refocus) tick().then(() => trigger?.focus());
	}

	function choose(option: DescribedOption<V>) {
		if (option.value !== value) {
			value = option.value;
			onchange?.(option.value);
		}
		closePanel({ refocus: true });
	}

	function moveActive(delta: number) {
		if (!options.length) return;
		activeIndex = (activeIndex + delta + options.length) % options.length;
		scrollActiveIntoView();
	}

	/** First-letters typeahead, cycling past the active option on repeats. */
	function typeahead(character: string) {
		clearTimeout(typedClearer);
		typed += character.toLocaleLowerCase('en');
		typedClearer = setTimeout(() => (typed = ''), 600);
		const start = typed.length === 1 ? activeIndex + 1 : activeIndex;
		for (let step = 0; step < options.length; step += 1) {
			const index = (start + step) % options.length;
			if (options[index].label.toLocaleLowerCase('en').startsWith(typed)) {
				activeIndex = index;
				scrollActiveIntoView();
				return;
			}
		}
	}

	function onTriggerKeydown(event: KeyboardEvent) {
		if (!open) {
			if (
				event.key === 'ArrowDown' ||
				event.key === 'ArrowUp' ||
				event.key === 'Enter' ||
				event.key === ' '
			) {
				event.preventDefault();
				void openPanel();
			} else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
				void openPanel().then(() => typeahead(event.key));
			}
			return;
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveActive(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveActive(-1);
		} else if (event.key === 'Home') {
			event.preventDefault();
			activeIndex = 0;
			scrollActiveIntoView();
		} else if (event.key === 'End') {
			event.preventDefault();
			activeIndex = options.length - 1;
			scrollActiveIntoView();
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			if (activeOption) choose(activeOption);
		} else if (event.key === 'Escape') {
			// Swallowed so an enclosing modal dialog does not also cancel.
			event.preventDefault();
			event.stopPropagation();
			closePanel({ refocus: true });
		} else if (event.key === 'Tab') {
			closePanel();
		} else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault();
			typeahead(event.key);
		}
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
		window.visualViewport?.addEventListener('resize', reposition);
		return () => {
			document.removeEventListener('scroll', reposition, { capture: true });
			window.removeEventListener('resize', reposition);
			window.visualViewport?.removeEventListener('resize', reposition);
		};
	});

	onDestroy(() => {
		clearTimeout(typedClearer);
		lower(panel);
		lower(scrim);
	});
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

<div class="dsel" bind:this={root} onfocusout={onRootFocusout}>
	<button
		type="button"
		class="ui-control dsel__trigger"
		role="combobox"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-controls={listboxId}
		aria-activedescendant={open && activeOption ? `${uid}-option-${activeIndex}` : undefined}
		aria-describedby={describedBy}
		aria-invalid={invalid || undefined}
		{id}
		{disabled}
		bind:this={trigger}
		onclick={() => (open ? closePanel({ refocus: true }) : void openPanel())}
		onkeydown={onTriggerKeydown}>
		<span class="dsel__value" class:dsel__value--placeholder={!selected}>
			{selected?.label ?? 'Choose…'}
		</span>
		<span class="dsel__chevron" class:dsel__chevron--open={open} aria-hidden="true">
			<ChevronDown size={15} />
		</span>
	</button>

	{#if open}
		{#if coarsePointer}
			<button
				type="button"
				class="dsel__scrim"
				aria-hidden="true"
				tabindex={-1}
				bind:this={scrim}
				onclick={() => closePanel()}></button>
		{/if}
		<div
			class="dsel__panel"
			class:dsel__panel--placed={placed}
			class:dsel__panel--sheet={coarsePointer}
			bind:this={panel}>
			{#if coarsePointer}
				<div class="dsel__head">
					<span class="dsel__title">{label}</span>
					<button
						type="button"
						class="dsel__close"
						aria-label={`Close ${label.toLocaleLowerCase('en')} list`}
						onclick={() => closePanel({ refocus: true })}>
						<X size={17} aria-hidden="true" />
					</button>
				</div>
			{/if}
			<div class="dsel__options" id={listboxId} role="listbox" aria-label={label}>
				{#each options as option, index (option.value)}
					<button
						type="button"
						class="dsel__option"
						class:dsel__option--active={index === activeIndex}
						class:dsel__option--selected={option.value === value}
						id={`${uid}-option-${index}`}
						role="option"
						tabindex="-1"
						aria-selected={option.value === value}
						onpointermove={() => (activeIndex = index)}
						onclick={() => choose(option)}>
						<span class="dsel__copy">
							<strong>{option.label}</strong>
							{#if option.description}<small>{option.description}</small>{/if}
						</span>
						{#if option.value === value}<span class="dsel__check"><Check size={15} aria-hidden="true" /></span>{/if}
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.dsel {
		position: relative;
		min-inline-size: 0;
	}

	.dsel__trigger {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		text-align: start;
		cursor: pointer;
	}

	.dsel__trigger:disabled {
		cursor: not-allowed;
	}

	.dsel__value {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dsel__value--placeholder {
		color: var(--je-color-text-subtle);
	}

	.dsel__chevron {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		color: var(--je-color-text-muted);
		transition: rotate var(--je-duration-fast) var(--je-ease);
	}

	.dsel__chevron--open {
		rotate: 180deg;
	}

	@media (prefers-reduced-motion: reduce) {
		.dsel__chevron {
			transition: none;
		}
	}

	.dsel__panel {
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

	.dsel__panel--placed {
		visibility: visible;
	}

	.dsel__panel--sheet {
		inset: 0.5rem 0.5rem auto;
		/* The popover UA style is fit-content with auto margins; the sheet
		   stretches edge to edge instead. */
		inline-size: auto;
		margin: 0;
		max-inline-size: none;
	}

	.dsel__scrim {
		position: fixed;
		inset: 0;
		/* Raised into the top layer, the popover UA style would shrink this to
		   fit-content; explicit auto sizing keeps it covering the viewport. */
		inline-size: auto;
		block-size: auto;
		margin: 0;
		/* Fallback ordering where the Popover API is unavailable. */
		z-index: 59;
		border: 0;
		padding: 0;
		background: var(--je-color-scrim);
	}

	.dsel__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-1);
		padding: var(--je-space-1) var(--je-space-1) var(--je-space-1) var(--je-space-2);
	}

	.dsel__title {
		font-size: var(--je-font-size-sm);
		font-weight: 650;
	}

	.dsel__close {
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

	.dsel__close:hover {
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text);
	}

	.dsel__close:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.dsel__options {
		display: grid;
		/* Overflowing auto rows collapse to the item minimum in Chromium;
		   max-content keeps multi-line option content visible. */
		grid-auto-rows: max-content;
		gap: 2px;
		min-block-size: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.dsel__option {
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

	.dsel__option--active,
	.dsel__option:hover {
		background: var(--je-color-surface-sunken);
	}

	.dsel__option--selected {
		background: var(--je-color-mark-surface);
	}

	.dsel__option--selected.dsel__option--active,
	.dsel__option--selected:hover {
		background: color-mix(in srgb, var(--je-color-mark-surface) 70%, var(--je-color-surface-sunken));
	}

	.dsel__option:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.dsel__copy {
		display: grid;
		gap: 2px;
		min-inline-size: 0;
	}

	.dsel__copy strong {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.dsel__copy small {
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-snug);
		color: var(--je-color-text-muted);
		transition: color var(--je-duration-fast) var(--je-ease);
	}

	.dsel__option--active .dsel__copy small,
	.dsel__option:hover .dsel__copy small {
		color: var(--je-color-text);
	}

	.dsel__check {
		display: grid;
		place-items: center;
		color: var(--je-color-mark-ink);
	}
</style>
