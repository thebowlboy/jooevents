<script lang="ts">
	/**
	 * The maker's byline, placed at the edge of a surface rather than inside it.
	 *
	 * The line reads as attributes of one subject — this product's provenance:
	 * who makes it, where to find them, who holds the rights — so it takes the
	 * interpunct rather than the hairline rule, which this product reserves for
	 * distinct records. Separators are their own `aria-hidden` elements and the
	 * items are separate nodes, so a screen reader hears three facts and the
	 * handle can be a link without re-splitting a string.
	 *
	 * `links` is what separates a surface someone chose to visit from one they
	 * were sent to: the sign-in screen carries the X link, the participant portal
	 * carries only the words. Nothing here is interactive by default.
	 */
	import { COPYRIGHT_SHORT, MAKER, SOURCE_URL } from './attribution';

	let { links = false, class: className = '' }: { links?: boolean; class?: string } = $props();
</script>

<footer class="maker {className}">
	<span class="maker__by">{MAKER.signature}</span>
	{#if links}
		<span class="maker__sep" aria-hidden="true">·</span>
		<a class="maker__link" href={MAKER.x.href} target="_blank" rel="me noopener" aria-label={MAKER.x.label}
			>{MAKER.x.handle}</a>
	{/if}
	{#if links && SOURCE_URL}
		<span class="maker__sep" aria-hidden="true">·</span>
		<a class="maker__link" href={SOURCE_URL} target="_blank" rel="noopener">Source</a>
	{/if}
	<span class="maker__sep" aria-hidden="true">·</span>
	<span>{COPYRIGHT_SHORT}</span>
</footer>

<style>
	/* Wraps as a group rather than a paragraph so a narrow viewport breaks
	   between facts instead of mid-fact, and the separators never begin a line. */
	.maker {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: center;
		gap: var(--je-space-2);
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-snug);
	}

	.maker__by {
		font-weight: 500;
	}

	/* Recessive but not faint: the design record records a separator that went
	   effectively invisible as the defect that motivated the separator rules. */
	.maker__sep {
		color: var(--je-color-text-subtle);
	}

	.maker__link {
		color: inherit;
		text-decoration: underline;
		text-decoration-color: var(--je-color-border-strong);
		text-underline-offset: 0.2em;
		border-radius: var(--je-radius-sm);
	}

	.maker__link:hover {
		color: var(--je-color-action-hover);
		text-decoration-color: currentColor;
	}

	.maker__link:focus-visible {
		outline: 2px solid var(--je-color-focus);
		outline-offset: 2px;
	}
</style>
