<script lang="ts">
	import { onMount } from 'svelte';
	import { statusIcon } from '$lib/ui';
	import type { IconComponent } from '$lib/ui';
	import type { SpeakersPagePort } from '$lib/api/speakers-page-port';
	import { LiveRead, type LiveReadState } from '$lib/api/live-read';
	import type { CommunicationThread } from '$lib/api/types';

	/**
	 * The roster row's communications tail: the last few things this person was
	 * sent, each with their own outcome, and one door to the full thread on the
	 * Communications page. The expansion answers "recently"; anything longer is
	 * page-weight and navigates.
	 */
	interface Props {
		port: SpeakersPagePort;
		speakerId: string;
	}

	let { port, speakerId }: Props = $props();

	const api = $derived(port);

	/** The tail keeps the expansion an overview; the full log is the page's job. */
	const TAIL = 3;

	// A rejected thread read used to leave `loaded` false with nothing in
	// flight, so this expansion showed two skeleton lines for as long as the row
	// stayed open. The failure is now stated where the entries would have been.
	let threadState = $state<LiveReadState<CommunicationThread | null>>({ kind: 'resolving' });
	const threadRead = new LiveRead<CommunicationThread | null>({
		read: () => api.communications.thread(speakerId),
		fallback: 'This speaker’s message history could not be loaded.',
		onChange: (state) => (threadState = state)
	});
	const thread = $derived(threadState.kind === 'resolved' ? threadState.value : null);

	onMount(() => {
		void threadRead.read();
	});

	const outcomeBadge: Record<
		CommunicationThread['entries'][number]['outcome'],
		{ label: string; tone: string; solid?: boolean; icon: IconComponent }
	> = {
		delivered: { label: 'Delivered', tone: 'success', icon: statusIcon.delivered },
		sent: { label: 'Sent', tone: 'success', icon: statusIcon.sent },
		bounced: { label: 'Bounced', tone: 'danger', solid: true, icon: statusIcon.bounced },
		scheduled: { label: 'Scheduled', tone: 'info', icon: statusIcon.scheduled }
	};

	const entries = $derived(thread?.entries.slice(0, TAIL) ?? []);
</script>

<div class="head">
	<h3 class="head__title">Communications</h3>
	<a class="ui-button ui-button--soft ui-button--sm" href={`/app/messages?person=${speakerId}`}>
		Open in Communications
	</a>
</div>
{#if threadState.kind === 'unavailable'}
	<p class="none" role="alert">
		{threadState.message}
		{#if threadState.retryable}
			<button type="button" class="ui-button ui-button--ghost ui-button--sm" onclick={() => void threadRead.refresh()}>
				Try again
			</button>
		{/if}
	</p>
{:else if threadState.kind === 'resolving'}
	<ul class="tail" aria-hidden="true">
		{#each Array(2) as _, index (index)}
			<li class="entry">
				<span class="ui-skeleton sk-chip"></span>
				<span class="entry__what"><span class="ui-skeleton sk-line" style="inline-size: min(14rem, 100%)"></span></span>
			</li>
		{/each}
	</ul>
{:else if entries.length === 0}
	<p class="none">Nothing has been sent to this speaker yet.</p>
{:else}
	<ul class="tail">
		{#each entries as entry (entry.id)}
			{@const badge = outcomeBadge[entry.outcome]}
			{@const Outcome = badge.icon}
			<li class="entry">
				<span class="ui-badge ui-badge--{badge.tone}" class:ui-badge--solid={badge.solid}
					><Outcome class="ui-badge__icon" aria-hidden="true" />{badge.label}</span>
				<span class="entry__what">{entry.purpose} · {entry.at}</span>
			</li>
		{/each}
	</ul>
{/if}

<style>
	/* Mirrors the expansion's own section grammar (heading + adjacent action)
	   without reaching into the parent's scoped classes. */
	.head {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-4);
	}

	.head__title {
		margin: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.tail {
		list-style: none;
		margin: var(--je-space-2) 0 0;
		padding: 0;
	}

	.entry {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		padding-block: 0.3rem;
		min-block-size: 1.75rem;
	}

	.entry__what {
		min-width: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.none {
		margin: var(--je-space-2) 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.sk-line {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.sk-chip {
		display: inline-block;
		block-size: 1.35rem;
		inline-size: 4.5rem;
	}
</style>
