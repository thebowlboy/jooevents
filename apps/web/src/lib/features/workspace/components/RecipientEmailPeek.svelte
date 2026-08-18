<script lang="ts">
	/**
	 * What one named person receives, rendered as the email they will actually
	 * get. Every send ceremony shows this by default rather than behind a
	 * disclosure: a send is authorized by seeing the thing being sent, and a
	 * ceremony that only names a template asks someone to vouch for content they
	 * were never shown.
	 */
	import EmailRender from '$lib/features/templates/EmailRender.svelte';
	import { recipientTemplate } from './recipient-preview';
	import type { EventTheme, MessageTemplate, RecipientRow } from '$lib/api/types';

	interface Props {
		template: MessageTemplate;
		theme: EventTheme;
		eventName: string;
		eventMeta: string;
		/** Whose copy this is; names the region and titles the panel. */
		recipient: Pick<RecipientRow, 'name' | 'mergeValues'>;
		/** The live subject line, when the ceremony lets one be edited. */
		subject?: string;
		/** How to see somebody else's copy; omitted when there is only one. */
		hint?: string;
	}

	let { template, theme, eventName, eventMeta, recipient, subject, hint }: Props = $props();

	const resolved = $derived(recipientTemplate(template, recipient, subject));
</script>

<section class="peek" aria-label={`Email preview for ${recipient.name}`}>
	<header class="peek__head">
		<h3 class="peek__title">What {recipient.name} receives</h3>
		{#if hint}<p class="peek__hint">{hint}</p>{/if}
	</header>
	<EmailRender template={resolved} {theme} {eventName} {eventMeta} />
</section>

<style>
	/* The opened recipient's artifact, below the evidence table it came from. */
	.peek {
		margin-block-start: var(--je-space-5);
	}

	.peek__head {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--je-space-1) var(--je-space-3);
		margin-block-end: var(--je-space-2);
	}

	.peek__title {
		margin: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.peek__hint {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-subtle);
	}
</style>
