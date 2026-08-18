<script lang="ts">
	/**
	 * What a lane sends when what it sends is not a template.
	 *
	 * Some lanes mail a fixed plain-text body rather than rendering stored copy.
	 * Naming a template beside such a send would describe something the lane
	 * never reads, so the ceremony shows the body verbatim instead — the exact
	 * string the sender will use, from the same owner the sender consumes, so
	 * the two cannot drift.
	 *
	 * It reads as email body text rather than as code: this is prose a person
	 * will receive, and a monospace block would dress it as a payload.
	 */
	interface Props {
		subject: string;
		body: string;
		/**
		 * The honest sentence about this lane, when one is needed — that the copy
		 * is fixed, or that it is worded for another audience.
		 */
		note?: string;
		/**
		 * The renderer's own reservations about this copy. Surfaced rather than
		 * swallowed — a warning nobody sees is a warning that did not happen.
		 */
		warningCodes?: readonly string[];
	}

	let { subject, body, note, warningCodes = [] }: Props = $props();
</script>

<section class="verbatim" aria-label="What this sends">
	<header class="verbatim__head">
		<h3 class="verbatim__title">What this sends</h3>
		{#if note}<p class="verbatim__note">{note}</p>{/if}
	</header>
	{#if warningCodes.length > 0}
		<ul class="verbatim__warnings">
			{#each warningCodes as code (code)}
				<li><span class="ui-badge ui-badge--warning">{code}</span></li>
			{/each}
		</ul>
	{/if}
	<div class="verbatim__paper">
		<p class="verbatim__subject">{subject}</p>
		<!-- Verbatim: the sender's own string, wrapped as written. Never markup —
		     this lane's body is plain text and is shown as plain text. -->
		<p class="verbatim__body">{body}</p>
	</div>
</section>

<style>
	.verbatim {
		margin-block-start: var(--je-space-5);
	}

	.verbatim__head {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--je-space-1) var(--je-space-3);
		margin-block-end: var(--je-space-2);
	}

	.verbatim__title {
		margin: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.verbatim__note {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-subtle);
	}

	.verbatim__warnings {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-1);
		margin: 0 0 var(--je-space-2);
		padding: 0;
	}

	/* Bounded and scrollable: a long body never pushes the send control out of
	   reach, and it is never collapsed behind a disclosure either. */
	.verbatim__paper {
		max-block-size: 22rem;
		overflow-y: auto;
		padding: var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.verbatim__subject {
		margin: 0 0 var(--je-space-3);
		padding-block-end: var(--je-space-2);
		border-block-end: 1px solid var(--je-color-border);
		font-weight: 600;
	}

	.verbatim__body {
		margin: 0;
		/* The sender's own line breaks, kept. */
		white-space: pre-wrap;
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text);
	}
</style>
