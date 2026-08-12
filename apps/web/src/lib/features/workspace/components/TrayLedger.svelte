<script lang="ts">
	import { trayIcon } from '$lib/ui';
	import type { TrayCount } from '$lib/api/types';

	let { trays = [] }: { trays?: TrayCount[] } = $props();

	/* A tray whose rows have a screen is a door; the rest are inventory. Nothing
	   here renders as a control it cannot honour. */
	const someUnreachable = $derived(trays.some((tray) => !tray.href));
</script>

<ul class="ledger">
	{#each trays as tray (tray.label)}
		{@const Kind = trayIcon[tray.kind]}
		<li>
			{#if tray.href}
				<a class="ledger__item ledger__item--link" href={tray.href}>
					<span class="ledger__kind" aria-hidden="true"><Kind size={13} /></span>
					<span class="ledger__count">{tray.count}</span>
					<span class="ledger__label">{tray.label}</span>
				</a>
			{:else}
				<span class="ledger__item">
					<span class="ledger__kind" aria-hidden="true"><Kind size={13} /></span>
					<span class="ledger__count">{tray.count}</span>
					<span class="ledger__label">{tray.label}</span>
				</span>
			{/if}
		</li>
	{/each}
</ul>

{#if someUnreachable}
	<!-- Said once for the region, not once per pill: the plain ones are counted
	     and kept, they simply have no screen to open yet.

	     "Tray" is our word for these holding places and it appears nowhere else
	     on this surface — the pills read "Late submissions", "Appeals awaiting
	     reply" — so a reader had no way to tell which ones the sentence covered.
	     The fix is to drop the word, not to teach it. -->
	<p class="ledger__note">
		Some of these have no screen of their own yet, so they are counted here but not
		linked.
	</p>
{/if}

<style>
	.ledger {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.ledger__item {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		padding: var(--je-space-1) var(--je-space-2);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-round);
		background: var(--je-color-surface);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		text-decoration: none;
	}

	/* Only the pills that lead somewhere carry the affordances of something that
	   leads somewhere. */
	.ledger__item--link {
		cursor: pointer;
	}

	.ledger__item--link:hover {
		border-color: var(--je-color-border-strong);
		color: var(--je-color-text);
	}

	.ledger__item--link:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	/* Names which kind of holding place this is. Subtle ink: the count is the
	   figure being read, the glyph only sorts one pill from its neighbours. */
	.ledger__kind {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		color: var(--je-color-text-subtle);
	}

	.ledger__item--link:hover .ledger__kind {
		color: var(--je-color-text-muted);
	}

	.ledger__count {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		color: var(--je-color-text);
	}

	.ledger__note {
		margin: var(--je-space-3) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}
</style>
