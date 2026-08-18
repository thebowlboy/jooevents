<script lang="ts">
	import { themeStyleProperties } from '$lib/theme/theme-contract';
	import type { EventTheme, MessageTemplate, TemplateBlock } from '$lib/api/types';
	import { segmentMergeText, type MergeSegment } from './merge-fields';
	import { excerpt, unitAttributes } from './inline-edit';
	import { compileTextStyle } from './text-style';

	interface Props {
		template: MessageTemplate;
		theme: EventTheme;
		eventName: string;
		/** e.g. "12–14 Oct 2026 · New York City"; empty hides the footer meta line. */
		eventMeta: string;
		/**
		 * Renders text runs and merge chips as addressable `data-edit` units for
		 * the template editor's click-to-edit host. Off by default so every other
		 * consumer of this preview stays inert.
		 */
		editable?: boolean;
		/**
		 * Mounts section insertion over this preview: the rest-invisible edge
		 * affordances and the persistent end control, both reporting the index a
		 * new section would take and the element the add menu should anchor to.
		 *
		 * Optional and off by default, so a preview that only edits wording — or
		 * one that is purely an artifact — renders exactly as it did.
		 */
		onInsert?: (index: number, anchor: HTMLElement) => void;
	}

	let {
		template,
		theme,
		eventName,
		eventMeta,
		editable = false,
		onInsert
	}: Props = $props();

	/** Insertion is an editable-mode affordance, and only where a host wants it. */
	const insertable = $derived(editable && onInsert !== undefined);

	/** Segments with each merge chip's ordinal, the index its `data-edit` path addresses. */
	function segmentsOf(text: string): { segment: MergeSegment; mergeIndex: number }[] {
		let count = 0;
		return segmentMergeText(text, template.mergeFields).map((segment) => ({
			segment,
			mergeIndex: segment.kind === 'field' ? count++ : -1
		}));
	}

	/** The unit's visible words — merge samples included — for its accessible name. */
	function excerptOf(text: string): string {
		return excerpt(
			segmentMergeText(text, template.mergeFields)
				.map((segment) => (segment.kind === 'field' ? segment.sample : segment.text))
				.join('')
		);
	}

	// The event brand is applied as custom properties on this component's root
	// only, so every --je-* consumption inside the preview resolves to the brand
	// while the surrounding operator app keeps its own theme untouched.
	const brandStyle = $derived(
		Object.entries(themeStyleProperties(theme))
			.map(([token, value]) => `${token}: ${value}`)
			.join('; ')
	);

	const markText = $derived(theme.markText || eventName.trim().charAt(0).toUpperCase());
</script>

{#snippet mergeText(text: string, chipBase: string | null = null)}
	{#each segmentsOf(text) as entry, index (index)}
		{#if entry.segment.kind === 'field'}{#if editable && chipBase !== null}<span
					class="email__chip ui-editable"
					data-edit={`${chipBase}.merge.${entry.mergeIndex}`}
					role="button"
					tabindex="0"
					aria-label={`Edit: ${entry.segment.label}`}>{entry.segment.sample}</span
				>{:else}<span class="email__chip" aria-label={`Merge field: ${entry.segment.label}`}
					>{entry.segment.sample}</span
				>{/if}{:else}{entry.segment.text}{/if}
	{/each}
{/snippet}

<div class="email" style={brandStyle}>
	<article class="email__card">
		<header class="email__brand">
			{#if markText}<span class="email__mark" aria-hidden="true">{markText}</span>{/if}
			<span class="email__event">{eventName}</span>
		</header>

		<p class="email__subject">{@render mergeText(template.subject)}</p>

		{#each template.blocks as block, index (index)}
			{#if insertable}
				<!-- The section wrapper exists only while insertion is mounted. It
				     carries no box of its own — no border, no padding, no margin —
				     so the blocks inside keep the exact spacing they collapse to
				     without it, and the affordances hang off it absolutely. -->
				<div class="email__section">
					{@render edge(index, 'above')}
					{@render body(block, index)}
					{@render edge(index + 1, 'below')}
				</div>
			{:else}
				{@render body(block, index)}
			{/if}
		{/each}

		{#if insertable}
			<!-- The entry a first-time author actually finds. Persistent rather
			     than hover-revealed, and rendered only while the preview is
			     editable — the same discipline the teaching line follows, so the
			     artifact at rest is still exactly the email. -->
			<p class="email__add">
				<button
					type="button"
					class="email__add-control"
					onclick={(event) => onInsert?.(template.blocks.length, event.currentTarget)}>
					+ Add section
				</button>
			</p>
		{/if}

		<footer class="email__footer">
			<p class="email__footer-event">{eventName}</p>
			{#if eventMeta}<p class="email__footer-meta">{eventMeta}</p>{/if}
			<p class="email__footer-note">
				You’re receiving this as a speaker/submitter of {eventName}.
			</p>
		</footer>
	</article>
</div>

{#snippet edge(at: number, side: 'above' | 'below')}
	<!-- Rest-invisible, fading in on a fine pointer over its own block. It is
	     out of the tab order on purpose: the keyboard path to insertion is the
	     block editor's own Add above/Add below, and 2N tab stops across a
	     document would be a worse answer than one reachable pair. -->
	<button
		type="button"
		class="email__insert email__insert--{side}"
		tabindex="-1"
		aria-label={`Add a section ${side} this one`}
		onclick={(event) => onInsert?.(at, event.currentTarget)}>
		<span class="email__insert-mark" aria-hidden="true">+</span>
	</button>
{/snippet}

{#snippet body(block: TemplateBlock, index: number)}
	{#if true}
		{#if block.type === 'heading'}
				<p
					{...unitAttributes(editable, 'email__heading', `blocks.${index}.text`, excerptOf(block.text))}
					style={compileTextStyle('heading', block.style)}>
					{@render mergeText(block.text)}
				</p>
			{:else if block.type === 'paragraph'}
				<p
					{...unitAttributes(editable, 'email__paragraph', `blocks.${index}.text`, excerptOf(block.text))}
					style={compileTextStyle('paragraph', block.style)}>
					{@render mergeText(block.text, `blocks.${index}`)}
				</p>
			{:else if block.type === 'details'}
				<dl class="email__details">
					{#each block.rows as row, rowIndex (rowIndex)}
						<div class="email__details-row">
							<dt {...unitAttributes(editable, '', `blocks.${index}.rows.${rowIndex}.label`, excerpt(row.label))}>
								{row.label}
							</dt>
							<dd {...unitAttributes(editable, '', `blocks.${index}.rows.${rowIndex}.value`, excerptOf(row.value))}>
								{@render mergeText(row.value)}
							</dd>
						</div>
					{/each}
				</dl>
			{:else if block.type === 'button'}
				<!-- A preview of the recipient's button, not a control: the real message
				     resolves the symbolic reference; here nothing is pressable — in
				     editable mode a press edits its wording, never follows it. -->
				<p class="email__cta">
					<span {...unitAttributes(editable, 'email__button', `blocks.${index}.label`, excerpt(block.label), 'block')}>
						{block.label}
					</span>
				</p>
			{:else if block.type === 'divider'}
				<hr class="email__divider" />
			{/if}
	{/if}
{/snippet}

<style>
	/* The muted backdrop reads as an email client's viewport around the message,
	   tinted from the brand's own canvas so a wild recipe stays coherent. */
	.email {
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-8) var(--je-space-4);
	}

	/*
	 * The card carries its own type scale, in px, and deliberately does not use
	 * the `--je-font-size-*` tokens the rest of the app runs on.
	 *
	 * Those tokens scale with the operator's density setting, so this preview
	 * shrank and grew with a preference the recipient cannot see — an organizer
	 * switching their own UI to compact made the *email* render two points
	 * smaller. Nothing about a mail client knows or cares about that. What this
	 * shows has to be the artifact, not the app around it.
	 *
	 * 16px body is the size mail clients actually render at, which is also why
	 * the preview read as small before: it was showing a 13px email nobody will
	 * ever receive.
	 */
	.email__card {
		display: grid;
		gap: var(--je-space-4);
		max-inline-size: 560px;
		margin-inline: auto;
		background: var(--je-color-surface);
		color: var(--je-color-text);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		box-shadow: var(--je-shadow-sm);
		padding: var(--je-space-8) var(--je-space-6);
		font-family: var(--je-font-body);
		font-size: 16px;
		line-height: 1.5;
	}

	.email__brand {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		margin-block-end: var(--je-space-2);
	}

	.email__mark {
		display: grid;
		place-items: center;
		inline-size: 2.25rem;
		block-size: 2.25rem;
		flex-shrink: 0;
		background: var(--je-color-action);
		color: var(--je-color-action-contrast);
		border-radius: var(--je-radius-control);
		font-size: 0.875em;
		font-weight: 750;
		letter-spacing: 0.02em;
	}

	.email__event {
		font-size: 0.875em;
		font-weight: 650;
		color: var(--je-color-text-muted);
	}

	.email__subject {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: 1.5em;
		font-weight: 700;
		line-height: var(--je-leading-tight);
		text-wrap: balance;
	}

	/* 24px at the card's 16px body — the heading kind's unstyled base size.
	   The size ladder's identity depends on this: an absent size tag and an
	   explicit 24 must render the same artifact. */
	.email__heading {
		margin: 0;
		font-size: 1.5em;
		font-weight: 650;
		line-height: var(--je-leading-snug);
	}

	.email__paragraph {
		margin: 0;
		font-size: 1em;
		line-height: var(--je-leading-normal);
	}

	/*
	 * A merge value reads at the size of the sentence it is part of.
	 *
	 * It used to render a step smaller, to stop the chip's padding deepening the
	 * line box. That cost was never real: the chip is an inline element, and
	 * vertical padding on an inline box does not contribute to line box height —
	 * measured, the paragraph is the same height with the chip at 0.75em, at
	 * 1em, and with its vertical padding removed entirely.
	 *
	 * So the shrink bought nothing and cost the thing that matters most. The
	 * merge value is the only part of the message that differs per recipient —
	 * their name, their session, their deadline — and it was the smallest text
	 * on the card. The tint and the weight are enough to say "this is filled in
	 * per person"; the size should say what it always says.
	 */
	.email__chip {
		background: var(--je-color-surface-selected);
		border-radius: var(--je-radius-xs);
		/* The tint needs a little room, but the padding must not push the words
		   around it: at full size a 0.35em pad opened a word-space between the
		   value and its neighbouring punctuation, so a sentence ended `2026 .`
		   and quotes floated off their titles. The negative margin gives the
		   padding back, leaving the line's advance identical to plain text —
		   which is what the recipient will actually receive. */
		padding: 0.12em 0.2em;
		margin-inline: -0.2em;
		/* Size and weight both inherit, so the only thing marking a merge value is
		   the tint. Bolding it as well encoded one fact twice — the rule the badge
		   dot already lost to the glyph — and it made a merge-heavy sentence read
		   as three dark blocks with prose between them. It also cost fidelity:
		   these are ordinary words in the message that arrives. */
		font-size: 1em;
		font-weight: inherit;
		-webkit-box-decoration-break: clone;
		box-decoration-break: clone;
	}

	.email__details {
		display: grid;
		margin: 0;
		border-block: 1px solid var(--je-color-border);
	}

	.email__details-row {
		display: grid;
		grid-template-columns: 7rem minmax(0, 1fr);
		gap: var(--je-space-3);
		align-items: baseline;
		padding-block: var(--je-space-2);
	}

	.email__details-row + .email__details-row {
		border-block-start: 1px solid var(--je-color-border);
	}

	.email__details dt {
		font-size: 0.875em;
		color: var(--je-color-text-muted);
	}

	.email__details dd {
		margin: 0;
		font-size: 0.875em;
		font-weight: 650;
	}

	.email__cta {
		display: flex;
		justify-content: center;
		margin: var(--je-space-2) 0;
	}

	.email__button {
		display: inline-flex;
		align-items: center;
		block-size: var(--je-control-height);
		padding-inline: var(--je-space-6);
		background: var(--je-color-action);
		color: var(--je-color-action-contrast);
		border-radius: var(--je-radius-control);
		font-size: 1em;
		font-weight: 650;
	}

	.email__divider {
		inline-size: 100%;
		margin: var(--je-space-1) 0;
		border: 0;
		border-block-start: 1px solid var(--je-color-border);
	}

	/* ------------------------------------------------------------- insertion */

	/* No box of its own, so the blocks inside keep the spacing they had before
	   the wrapper existed; it is here only to be the affordances' containing
	   block. */
	.email__section {
		position: relative;
		margin: 0;
		padding: 0;
		border: 0;
	}

	/* Invisible at rest — the artifact is the email, not a workbench — and
	   absolutely positioned over the gap so fading in moves nothing. */
	.email__insert {
		position: absolute;
		inset-inline: 0;
		display: grid;
		place-items: center;
		block-size: 1rem;
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		opacity: 0;
		cursor: pointer;
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	.email__insert--above {
		inset-block-start: -0.5rem;
	}

	.email__insert--below {
		inset-block-end: -0.5rem;
	}

	/* The hairline it sits on, in the muted ink the editable outline uses. */
	.email__insert::before {
		content: '';
		position: absolute;
		inset-inline: 0;
		inset-block-start: 50%;
		border-block-start: 1px dashed var(--je-color-text-muted);
	}

	.email__insert-mark {
		position: relative;
		display: grid;
		place-items: center;
		inline-size: 1rem;
		block-size: 1rem;
		border-radius: var(--je-radius-round);
		background: var(--je-color-surface);
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		line-height: 1;
	}

	/* A fine pointer only. On touch the same insertion lives in the block
	   editor's own Add above/Add below, so nothing here is the sole carrier. */
	@media (hover: hover) and (pointer: fine) {
		.email__section:hover .email__insert {
			opacity: 1;
		}
	}

	.email__insert:focus-visible {
		opacity: 1;
		outline: none;
		box-shadow: var(--je-focus-ring);
		border-radius: var(--je-radius-xs);
	}

	/* The persistent end control: a ghost inside the editable surface, quiet
	   enough not to read as part of the message. */
	.email__add {
		margin: var(--je-space-4) 0 0;
		text-align: center;
	}

	.email__add-control {
		margin: 0;
		padding: var(--je-space-2) var(--je-space-3);
		border: 1px dashed var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		background: none;
		color: var(--je-color-text-muted);
		font: inherit;
		font-size: var(--je-font-size-sm);
		cursor: pointer;
	}

	.email__add-control:hover {
		border-color: var(--je-color-text-muted);
		color: var(--je-color-text);
	}

	.email__add-control:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.email__footer {
		display: grid;
		gap: var(--je-space-1);
	}

	.email__footer-event {
		margin: 0;
		font-size: 0.875em;
		font-weight: 650;
	}

	.email__footer-meta {
		margin: 0;
		font-size: 0.8125em;
		color: var(--je-color-text-muted);
	}

	.email__footer-note {
		margin: 0;
		font-size: 0.8125em;
		color: var(--je-color-text-muted);
	}

	@media (max-width: 560px) {
		.email {
			padding: var(--je-space-4) var(--je-space-2);
		}

		.email__card {
			padding: var(--je-space-6) var(--je-space-4);
		}

		.email__details-row {
			grid-template-columns: 5.5rem minmax(0, 1fr);
		}
	}
</style>
