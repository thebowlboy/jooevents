<script lang="ts">
	/**
	 * What can be added here, listed by name.
	 *
	 * Press-anchored to whichever affordance opened it — an edge hairline, the
	 * document's end control, or the open editor's Add above/below — so the menu
	 * appears where the section will land. It offers the vocabulary and nothing
	 * else: the kinds are the ceiling that keeps every email decent, so there is
	 * no free-form option to escape into.
	 *
	 * Choosing inserts and hands back the kind; the host opens the new section's
	 * editor immediately, which is what makes insert-then-type one gesture.
	 */
	import { ANCHOR_EDGE, lower, placeNear, raise } from '$lib/ui/anchored.svelte';
	import { sectionKinds, type SectionKind } from '$lib/api/template-kinds';

	interface Props {
		/** The element the menu belongs to; it is placed against this. */
		anchor: HTMLElement;
		onpick: (kind: SectionKind) => void;
		oncancel: () => void;
	}

	let { anchor, onpick, oncancel }: Props = $props();

	let panel = $state<HTMLElement>();
	let placed = $state(false);

	$effect(() => {
		if (!panel) return;
		raise(panel);
		placeNear(anchor, panel);
		const box = panel.getBoundingClientRect();
		const over = box.bottom - (window.innerHeight - ANCHOR_EDGE);
		if (over > 0) panel.style.top = `${parseFloat(panel.style.top || '0') - over}px`;
		placed = true;
		return () => lower(panel);
	});

	// Focus lands in the menu, so the keyboard path continues where it pressed.
	$effect(() => {
		if (!placed) return;
		panel?.querySelector<HTMLButtonElement>('[data-kind]')?.focus();
	});

	function onWindowPointerdown(event: PointerEvent) {
		const target = event.target;
		if (!(target instanceof Node)) return;
		if (panel?.contains(target) || anchor.contains(target)) return;
		oncancel();
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.stopPropagation();
		oncancel();
	}

	/** Up/Down walk the list; the menu is short enough that nothing else is owed. */
	function onListKeydown(event: KeyboardEvent) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		const items = Array.from(
			panel?.querySelectorAll<HTMLButtonElement>('[data-kind]') ?? []
		);
		const at = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
		items[(next + items.length) % items.length]?.focus();
	}
</script>

<svelte:window onpointerdown={onWindowPointerdown} onkeydown={onWindowKeydown} />

<div
	class="menu"
	class:menu--placed={placed}
	role="menu"
	aria-label="Add a section"
	tabindex="-1"
	bind:this={panel}
	onkeydown={onListKeydown}>
	{#each sectionKinds as entry (entry.kind)}
		<button
			type="button"
			class="menu__item"
			role="menuitem"
			data-kind={entry.kind}
			onclick={() => onpick(entry.kind)}>
			<span class="menu__label">{entry.label}</span>
			{#if entry.hint}<span class="menu__hint">{entry.hint}</span>{/if}
		</button>
	{/each}
</div>

<style>
	/* Positioned by the shared anchored machinery; hidden until it has a place,
	   so it never flashes at the origin first. */
	.menu {
		position: fixed;
		z-index: 1;
		display: grid;
		gap: 1px;
		min-inline-size: 12rem;
		padding: var(--je-space-1);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-md);
		opacity: 0;
	}

	.menu--placed {
		opacity: 1;
	}

	.menu__item {
		display: grid;
		gap: 0.1rem;
		margin: 0;
		padding: var(--je-space-2) var(--je-space-3);
		border: 0;
		border-radius: var(--je-radius-control);
		background: none;
		font: inherit;
		text-align: start;
		cursor: pointer;
	}

	.menu__item:hover {
		background: var(--je-color-surface-sunken);
	}

	.menu__item:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.menu__label {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text);
	}

	.menu__hint {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}
</style>
