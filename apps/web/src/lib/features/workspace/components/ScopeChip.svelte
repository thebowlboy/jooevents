<script lang="ts">
	/**
	 * The scope a surface was opened with, named on the surface itself.
	 *
	 * A scoped link is only half an answer: the destination has to say out loud
	 * that it is showing part of a list, and it has to offer the way back to all
	 * of it in one action rather than sending the operator hunting for the filter
	 * that was applied on their behalf. Dismissing clears the scope from the
	 * address, so the Back button still returns to the scoped view.
	 */
	import { X } from 'lucide-svelte';

	let {
		label,
		onclear
	}: {
		/** Names the filter in the operator's words, e.g. `Overdue · Maya Lindqvist`. */
		label: string;
		onclear: () => void;
	} = $props();
</script>

<div class="scope">
	<span class="scope__lede">Showing</span>
	<span class="ui-badge ui-badge--info scope__chip">
		{label}
		<button
			type="button"
			class="scope__clear"
			aria-label={`Clear this filter: ${label}`}
			onclick={onclear}>
			<X size={12} aria-hidden="true" />
		</button>
	</span>
</div>

<style>
	.scope {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
	}

	.scope__lede {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.scope__chip {
		gap: var(--je-space-2);
		padding-inline-end: var(--je-space-1);
	}

	.scope__clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		inline-size: 1.25rem;
		block-size: 1.25rem;
		padding: 0;
		border: 0;
		border-radius: var(--je-radius-round);
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.scope__clear:hover {
		background: color-mix(in srgb, currentcolor 16%, transparent);
	}

	.scope__clear:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	@media (max-width: 920px), (pointer: coarse) {
		/* Touch-sized without changing the chip's height: the hit area grows past
		   the glyph rather than the pill growing around it. */
		.scope__clear {
			inline-size: 1.75rem;
			block-size: 1.75rem;
		}
	}
</style>
