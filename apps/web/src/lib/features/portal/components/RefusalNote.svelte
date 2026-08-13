<script lang="ts">
	/**
	 * Why something cannot be done, in place.
	 *
	 * One component renders it whether the answer was predicted before the press
	 * or returned by the operation afterwards: a refusal the surface saw coming
	 * and a refusal the server sent back mean the same thing to the reader, so
	 * they must not look like two different kinds of event. Appearing is the
	 * announcement, which is why the visible sentence carries the live region
	 * instead of a second hidden copy of itself.
	 */
	interface Props {
		message: string;
		/** A refused attempt is louder than a reason stated in advance. */
		tone?: 'stated' | 'refused';
	}

	let { message, tone = 'stated' }: Props = $props();
</script>

<p class="note" class:note--refused={tone === 'refused'} role="status">{message}</p>

<style>
	.note {
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		max-inline-size: 62ch;
	}

	.note--refused {
		color: var(--je-color-danger);
	}
</style>
