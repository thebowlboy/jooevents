<script lang="ts">
	/**
	 * The dock that says what a commit just did.
	 *
	 * It names the exact object and then offers one of two things, never
	 * neither: a way to take the change back, or the reason there is none. A
	 * confirmation that cannot be answered is only decoration, and a change with
	 * no stated way back is the one people ask about afterwards.
	 *
	 * Placement is the only thing that varies between the surfaces that use it —
	 * a rail-bearing workspace clears the rail, a single column centers — so the
	 * words, the states, and the geometry are settled here rather than per
	 * surface.
	 */
	import { Undo2, X } from 'lucide-svelte';

	interface Props {
		/** What happened, specific enough to recognise without looking away. */
		label: string;
		/** `rail` clears the workspace navigation; `column` centers on the page. */
		placement?: 'rail' | 'column';
		/** Scoped address of where the result landed; rendered with `hrefLabel`. */
		href?: string;
		/** The door's short verb phrase, e.g. `Place them`. */
		hrefLabel?: string;
		/** Given when the change can be taken back; omitted when it cannot. */
		onundo?: () => void;
		undoing?: boolean;
		/** Why there is no way back. Shown when `onundo` is absent. */
		finalNote?: string;
		/** Clears the fixed dock without changing or undoing its recorded action. */
		ondismiss?: () => void;
	}

	let {
		label,
		placement = 'rail',
		href,
		hrefLabel,
		onundo,
		undoing = false,
		finalNote,
		ondismiss
	}: Props = $props();
</script>

<div class="receipt receipt--{placement}" role="status">
	<p class="receipt__label">{label}</p>
	{#if href && hrefLabel}
		<!-- The way onward sits between what happened and the way back: a quiet
		     link, so Undo stays the receipt's one emphasised control. -->
		<a class="ui-button ui-button--ghost ui-button--sm" {href}>{hrefLabel}</a>
	{/if}
	{#if onundo}
		<button
			type="button"
			class="ui-button ui-button--secondary ui-button--sm"
			disabled={undoing}
			aria-busy={undoing || undefined}
			onclick={onundo}>
			<Undo2 size={13} aria-hidden="true" />{undoing ? 'Undoing…' : 'Undo'}
		</button>
	{:else if finalNote}
		<p class="receipt__final">{finalNote}</p>
	{/if}
	{#if ondismiss}
		<button
			type="button"
			class="ui-button ui-button--ghost ui-button--sm ui-button--icon receipt__dismiss"
			aria-label="Dismiss confirmation"
			onclick={ondismiss}>
			<X size={14} aria-hidden="true" />
		</button>
	{/if}
</div>

<style>
	.receipt {
		position: fixed;
		inset-block-end: var(--je-space-4);
		z-index: 70;
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		max-inline-size: min(34rem, calc(100vw - 2rem));
		padding: var(--je-space-2) var(--je-space-3);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		box-shadow: var(--je-shadow-md);
	}

	.receipt--rail {
		inset-inline-start: calc(var(--je-sidebar-width) + var(--je-space-6));
	}

	.receipt--column {
		inset-inline: var(--je-space-3);
		margin-inline: auto;
		inline-size: fit-content;
	}

	.receipt__label {
		margin: 0;
		min-inline-size: 0;
		font-size: var(--je-font-size-sm);
	}

	.receipt__final {
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-xs);
	}

	.receipt__dismiss {
		flex: 0 0 auto;
		margin-inline-start: auto;
	}

	/* Below the rail's breakpoint there is no rail to clear. */
	@media (max-width: 920px) {
		.receipt--rail {
			inset-inline-start: var(--je-space-3);
			inset-inline-end: var(--je-space-3);
		}
	}

	@media (pointer: coarse) {
		.receipt__dismiss {
			min-inline-size: 2.75rem;
			min-block-size: 2.75rem;
		}
	}
</style>
