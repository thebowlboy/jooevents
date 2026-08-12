<script lang="ts">
	/**
	 * A term of art, carrying its own definition.
	 *
	 * Product vocabulary is a loan against future exposure. It pays off for
	 * people who return — a chair meets *track* and *waitlist* every cycle, so
	 * learning them once is a good trade. It never pays off for people who
	 * visit once: a reviewer is an expert in their own field, pulled in for one
	 * round, gone in three weeks. They are charged the tuition and never collect
	 * on it. So a word may be a term of art here, but then it owes its meaning
	 * on the surface where it is used, not in a glossary someone has to go find.
	 *
	 * The definition rides the existing word affordance rather than a new one.
	 * Dotted underline at rest, going solid on hover, focus, and while open —
	 * the product's typographic flow grammar, where solid-and-action-coloured
	 * takes you somewhere and dotted-and-ink tells you more right here.
	 *
	 * Everything else is `Popover`: the button, the open state, Escape,
	 * outside-press, the top layer, and the one placement this app has. This
	 * component adds a resting affordance and a body, and nothing more — a
	 * second implementation of any of that is how two disclosures start behaving
	 * differently on the same page.
	 *
	 * Deliberately not a `title` tooltip and deliberately not hover-opened. A
	 * native tooltip is the thing this component tree refuses everywhere, and
	 * hover-carried meaning never arrives at all on a touch device. Hover already
	 * answers by going solid; the meaning itself costs a press, on every pointer.
	 *
	 * Two consequences of being a real button inside running text:
	 *
	 * - **A term is atomic.** Engines coerce a `<button>` to `inline-block`, so
	 *   it moves to the next line whole rather than breaking across one. That
	 *   suits a term — an underline split over two lines reads as two marks —
	 *   but a term must be short enough for the narrowest column it appears in.
	 * - **Its target is the size of the word**, and cannot be grown the way a
	 *   standalone control's can: an invisible taller hit area would sit over the
	 *   lines above and below and swallow drags meant for them, which would cost
	 *   more than it bought. This is the case WCAG 2.5.8 exempts explicitly —
	 *   a target in a sentence, sized by the text it is part of.
	 */
	import Popover from './Popover.svelte';

	interface Props {
		/** The words exactly as they read in the sentence. */
		term: string;
		/** One line: what the reader needs to act correctly, and nothing else. */
		definition: string;
		/** Written-out form when the term is an abbreviation ("CFP"). */
		expansion?: string;
		/** Lets the surface mirror the definition to its own live region. */
		onreveal?: () => void;
	}

	let { term, definition, expansion, onreveal }: Props = $props();
</script>

<!-- The accessible name opens with the visible words, so speech input can reach
     the term by saying it, and the name still contains the label (WCAG 2.5.3). -->
<Popover label={`${term} — what this means`} kind="word" {onreveal}>
	{#snippet trigger()}<span class="term">{term}</span>{/snippet}
	{#snippet children()}
		{#if expansion}
			<p class="term__expansion">{expansion}</p>
		{/if}
		<p class="term__definition">{definition}</p>
	{/snippet}
</Popover>

<style>
	/* The resting hint. Without it the term is indistinguishable from the words
	   around it and the definition is undiscoverable — which is the whole defect
	   this component exists to fix. `Popover` owns the hover and open states. */
	.term {
		font: inherit;
		color: inherit;
		text-decoration: underline dotted;
		text-decoration-color: var(--je-color-border-strong);
		text-underline-offset: 0.15em;
	}

	.term__expansion {
		margin: 0;
		font-weight: 600;
	}

	.term__definition {
		margin: 0;
		color: var(--je-color-text-muted);
	}
</style>
