<script lang="ts">
	import { themeStyleProperties } from '$lib/theme/theme-contract';
	import type { EventTheme, MessageTemplate } from '$lib/api/types';
	import { segmentMergeText, type MergeSegment } from './merge-fields';
	import { excerpt, unitAttributes } from './inline-edit';
	import { compileTextStyle } from './text-style';

	interface Props {
		template: MessageTemplate;
		theme: EventTheme;
		eventName: string;
		/** e.g. "Oct 12–14, 2026 · New York City"; empty hides the footer meta line. */
		eventMeta: string;
		/**
		 * Renders text runs and merge chips as addressable `data-edit` units for
		 * the template editor's click-to-edit host. Off by default so every other
		 * consumer of this preview stays inert.
		 */
		editable?: boolean;
	}

	let { template, theme, eventName, eventMeta, editable = false }: Props = $props();

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
		{/each}

		<footer class="email__footer">
			<p class="email__footer-event">{eventName}</p>
			{#if eventMeta}<p class="email__footer-meta">{eventMeta}</p>{/if}
			<p class="email__footer-note">
				You’re receiving this as a speaker/submitter of {eventName}.
			</p>
		</footer>
	</article>
</div>

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
