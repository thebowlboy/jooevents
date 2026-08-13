<script lang="ts">
	/**
	 * Where a speaker lands.
	 *
	 * The order is the order of their questions: which event is this and how long
	 * do I have, what is waiting on me, what am I speaking at, what do I still
	 * owe, what did I send. Nothing above the fold asks them to learn a word they
	 * do not already have.
	 */
	import { PENDING_MIN_VISIBLE_MS, Term, trackPending } from '$lib/ui';
	import { accessCopy, terms } from './copy';
	import { formatDeadline } from './format';
	import { portalActionItems } from './home-actions';
	import { usePortalStore } from './store.svelte';
	import ActionStrip from './components/ActionStrip.svelte';
	import EngagementPanel from './components/EngagementPanel.svelte';
	import ResourceList from './components/ResourceList.svelte';
	import SubmissionList from './components/SubmissionList.svelte';
	import TaskChecklist from './components/TaskChecklist.svelte';

	const store = usePortalStore();
	const now = Date.now();

	const snapshot = $derived(store.snapshot);
	const waiting = trackPending(() => store.snapshot === null && !store.failed, {
		minVisibleMs: PENDING_MIN_VISIBLE_MS
	});
	const actions = $derived(snapshot ? portalActionItems(snapshot, now) : []);
</script>

{#if snapshot}
	<!-- A re-read dims what is already here rather than replacing it: nobody is
	     sent back through a waiting state they have already passed. -->
	<div class="home" class:home--reloading={store.reloading} aria-busy={store.reloading || undefined}>
		<header class="event">
			<h1 class="event__name">{snapshot.event.name}</h1>
			<p class="event__call">
				The <Term term={terms.callForSpeakers.term} definition={terms.callForSpeakers.definition} />
				{snapshot.event.cfpOpen ? 'closes' : 'closed'} {formatDeadline(snapshot.event.cfpClosesAt, snapshot.event.timezone, now)}.
				<!-- Scoped to proposals, because it is only proposals this deadline
				     governs: a task below can still be open long after it passes. -->
				{#if snapshot.event.cfpOpen}
					You can still send another proposal, or correct one you already sent.
				{:else if snapshot.event.closePolicy === 'hard'}
					No new proposals, and no changes to the ones you sent.
				{/if}
			</p>
		</header>

		{#if actions.length > 0}
			<ActionStrip items={actions} />
		{/if}

		{#if snapshot.engagements.length > 0}
			<section class="section" aria-labelledby="sessions-heading">
				<h2 class="section__title" id="sessions-heading">Speaking at</h2>
				<div class="section__stack">
					{#each snapshot.engagements as engagement (engagement.id)}
						<EngagementPanel {engagement} />
					{/each}
				</div>
			</section>
		{/if}

		{#if snapshot.tasks.length > 0}
			<section class="section">
				<TaskChecklist tasks={snapshot.tasks} files={snapshot.files} />
			</section>
		{/if}

		<section class="section" aria-labelledby="submissions-heading">
			<h2 class="section__title" id="submissions-heading">What you sent</h2>
			{#if snapshot.submissions.length > 0}
				<SubmissionList submissions={snapshot.submissions} timezone={snapshot.event.timezone} />
			{:else}
				<p class="section__empty">
					Nothing yet. Anything you send to this event shows up here with where it stands.
				</p>
			{/if}
		</section>

		{#if snapshot.resources.length > 0}
			<section class="section" aria-labelledby="resources-heading">
				<h2 class="section__title" id="resources-heading">From the organizers</h2>
				<ResourceList resources={snapshot.resources} />
			</section>
		{/if}
	</div>
{:else if store.failed}
	<section class="failure" role="alert">
		<h1 class="event__name">{accessCopy.checkFailedTitle}</h1>
		<p class="section__empty">{accessCopy.checkFailedBody}</p>
		<button type="button" class="ui-button ui-button--primary" onclick={() => store.reload()}>
			Try again
		</button>
	</section>
{:else}
	<!-- The resolved composition, holding its own shape, with the text it does
	     not have yet left as fills. Below the grace tier nothing is drawn at all,
	     so a fast read leaves no trace. -->
	<div class="home" aria-busy="true">
		<header class="event">
			{#if waiting.visible}
				<!-- The name's own line, at its own size, with no heading claimed
				     until there is a name to head. -->
				<div class="event__name" aria-hidden="true"><span class="ui-skeleton event__fill"></span></div>
				<p class="event__call" aria-hidden="true"><span class="ui-skeleton event__fill event__fill--line"></span></p>
			{/if}
		</header>
		<section class="section">
			{#if waiting.visible}
				<h2 class="section__title">What you sent</h2>
				<SubmissionList placeholders={2} />
			{/if}
		</section>
		{#if waiting.phase === 'slow'}
			<p class="ui-sr-only" role="status">Loading your submissions.</p>
		{/if}
	</div>
{/if}

<style>
	.home {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-8);
		/* The column keeps its footprint through every state, so resolving cannot
		   collapse the page and expand it again. */
		min-block-size: 28rem;
		transition: opacity var(--je-duration-normal) var(--je-ease);
	}

	.home--reloading {
		opacity: 0.62;
	}

	.event {
		display: grid;
		gap: var(--je-space-2);
	}

	.event__name {
		margin: 0;
		font-size: var(--je-font-size-2xl);
		line-height: var(--je-leading-tight);
	}

	.event__call {
		margin: 0;
		max-inline-size: 62ch;
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.event__fill {
		display: inline-block;
		block-size: 1lh;
		inline-size: min(22rem, 80%);
		vertical-align: bottom;
	}

	.event__fill--line {
		inline-size: min(30rem, 95%);
	}

	.section {
		display: grid;
		gap: var(--je-space-3);
	}

	.section__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
	}

	.section__stack {
		display: grid;
		gap: var(--je-space-3);
	}

	.section__empty {
		margin: 0;
		max-inline-size: 62ch;
		color: var(--je-color-text-muted);
	}

	.failure {
		display: grid;
		justify-items: start;
		align-content: center;
		gap: var(--je-space-3);
		min-block-size: 20rem;
	}
</style>
