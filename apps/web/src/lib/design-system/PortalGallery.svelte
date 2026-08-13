<script lang="ts">
	/**
	 * The participant surface's own reference: every state a speaker can meet on
	 * the portal, rendered by the shipped components rather than redrawn here.
	 *
	 * Where a specimen can act, it acts for real against a sample world, so a
	 * state on this page cannot describe behaviour the product does not have.
	 */
	import { Receipt } from '$lib/ui';
	import accepted from '$lib/api/portal/sample/accepted';
	import declined from '$lib/api/portal/sample/declined';
	import type { PortalTaskView, PortalTimelineEventView } from '$lib/api/portal/view-models';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import {
		engagementStatusCopy,
		submissionStatusCopy,
		taskStateCopy,
		type StateCopy
	} from '$lib/features/portal/copy';
	import ActionStrip from '$lib/features/portal/components/ActionStrip.svelte';
	import AppealPanel from '$lib/features/portal/components/AppealPanel.svelte';
	import StateBadge from '$lib/features/portal/components/StateBadge.svelte';
	import TaskChecklist from '$lib/features/portal/components/TaskChecklist.svelte';
	import TimelineList from '$lib/features/portal/components/TimelineList.svelte';
	import type { PortalActionItem } from '$lib/features/portal/home-actions';
	import PortalScope from './PortalScope.svelte';
	import SectionHeading from './SectionHeading.svelte';
	import ShowcaseCard from './ShowcaseCard.svelte';

	const zone = 'America/New_York';

	const families: { readonly name: string; readonly states: readonly StateCopy[] }[] = [
		{ name: 'A submission you sent', states: Object.values(submissionStatusCopy) },
		{ name: 'Something on your checklist', states: Object.values(taskStateCopy) },
		{ name: 'A session you were invited to', states: Object.values(engagementStatusCopy) }
	];

	/* One record's whole life, so the envelope can be read as a sequence: who
	   acted, when, and what changed — including the entries the participant
	   made themselves. */
	const timeline: readonly PortalTimelineEventView[] = [
		{
			id: 'tl-1',
			occurredAt: '2026-06-11T13:02:00-04:00',
			actor: 'you',
			kind: 'submitted',
			summary: 'You submitted this talk.'
		},
		{
			id: 'tl-2',
			occurredAt: '2026-06-14T09:41:00-04:00',
			actor: 'you',
			kind: 'edited',
			summary: 'You edited this submission.'
		},
		{
			id: 'tl-3',
			occurredAt: '2026-07-02T17:20:00-04:00',
			actor: 'organizers',
			kind: 'status_communicated',
			summary: 'The organizers told you this talk was accepted.'
		},
		{
			id: 'tl-4',
			occurredAt: '2026-07-02T17:21:00-04:00',
			actor: 'organizers',
			kind: 'engagement_invited',
			summary: 'You were invited to speak at “Context Caching Without Tears”.'
		},
		{
			id: 'tl-5',
			occurredAt: '2026-07-03T08:12:00-04:00',
			actor: 'you',
			kind: 'engagement_responded',
			summary: 'You confirmed you can speak.'
		},
		{
			id: 'tl-6',
			occurredAt: '2026-08-01T08:44:00-04:00',
			actor: 'you',
			kind: 'task_completed',
			summary: 'You sent a headshot.'
		}
	];

	/* The one row nobody can act on: a hard close that ran out of time. It keeps
	   its control so the reason has something to belong to. */
	const closedTask: readonly PortalTaskView[] = [
		{
			id: 'tsk-reference-closed',
			title: 'Signed speaker agreement',
			required: true,
			completion: { mode: 'upload', acceptedTypes: ['application/pdf'], receivedFileId: null },
			state: 'late',
			dueAt: '2026-08-03T23:59:00-04:00',
			timezone: zone,
			closePolicy: 'hard',
			sessionId: null,
			acceptsLateCompletion: false
		}
	];

	const waiting: readonly PortalActionItem[] = [
		{
			id: 'reference-engagement',
			kind: 'engagement',
			headline: 'Confirm you can speak at “Context Caching Without Tears”',
			detail: 'The organizers asked for an answer by Aug 20, 23:59 EDT.',
			actionLabel: 'Confirm',
			href: null,
			targetId: 'eng-101'
		},
		{
			id: 'reference-task',
			kind: 'task',
			headline: '“AV requirements” was due Aug 8, 23:59 EDT',
			detail: 'You can still send it; it will be marked late.',
			actionLabel: 'Go to this task',
			href: null,
			targetId: 'tsk-av'
		}
	];

	/* The held-still specimens answer a press the way the real dock does: the
	   control goes busy for as long as the compensating change would take. */
	let undoingSpecimen = $state(false);

	function demonstrateUndo() {
		if (undoingSpecimen) return;
		undoingSpecimen = true;
		setTimeout(() => (undoingSpecimen = false), 900);
	}

	const stillOpen: readonly PortalActionItem[] = [
		{
			id: 'reference-appeal',
			kind: 'appeal',
			headline: '“Retries Considered Harmful” was not accepted',
			detail: 'You can ask the organizers to look at it once more.',
			actionLabel: 'Ask for another look',
			href: '/design-system/participant-portal#another-look',
			targetId: 'sub-302'
		}
	];
</script>

<div class="portal-ds">
	<header class="portal-ds__hero">
		<p class="ds-kicker"><span></span> Participant surface · sample worlds</p>
		<h1>What a speaker sees<br />about their own work.</h1>
		<p>
			One column, default density, no operator vocabulary. Every state below is the shipped
			component; the ones that can act are wired to a sample world and behave exactly as they do
			in the portal.
		</p>
		<nav class="portal-ds__links" aria-label="Related references">
			<a href="/design-system/portal-shell">The portal, whole →</a>
			<a href="/design-system/entry-links">Sign-in link states →</a>
			<a href="/design-system">Component reference →</a>
		</nav>
	</header>

	<section class="ds-section" id="states">
		<SectionHeading
			index="01"
			title="State vocabulary"
			description="Every lifecycle state is a badge carrying its own word and its own glyph, plus the sentence that explains it where there is room to say it." />
		<div class="ds-showcase-grid">
			{#each families as family (family.name)}
				<ShowcaseCard title={family.name} description="Tone is assigned once, here, and never per screen.">
					<dl class="state-map">
						{#each family.states as state (state.label)}
							<div>
								<dt><StateBadge {state} /></dt>
								<dd>{state.meaning}</dd>
							</div>
						{/each}
					</dl>
				</ShowcaseCard>
			{/each}
		</div>
	</section>

	<section class="ds-section" id="waiting">
		<SectionHeading
			index="02"
			title="What is waiting"
			description="The strip lists only what can be finished today, and takes its tone from the loudest entry — somebody waiting, or an option that costs nothing to leave." />
		<div class="ds-showcase-grid">
			<ShowcaseCard
				title="Somebody is waiting"
				eyebrow="Pressing"
				description="An unanswered invitation or a passed deadline. Each entry lands on the record's own controls rather than committing from here.">
				<ActionStrip items={waiting} />
			</ShowcaseCard>
			<ShowcaseCard
				title="Still open, not owed"
				eyebrow="Quiet"
				description="A decision with one request left. Painting this like the row above is how a colour stops meaning anything.">
				<ActionStrip items={stillOpen} />
			</ShowcaseCard>
		</div>
	</section>

	<section class="ds-section" id="checklist">
		<SectionHeading
			index="03"
			title="The checklist"
			description="Every completion mode and every state a row can be in. Nothing moves without an explicit press, which is what makes the state worth trusting on both sides." />
		<div class="ds-showcase-grid">
			<ShowcaseCard
				title="A speaker's real checklist"
				eyebrow="Live sample world"
				description="Done, received-and-being-checked, still to do, past due but still accepting, an optional external errand, and a form this build does not serve. These act for real."
				full>
				<PortalScope dataset={accepted}>
					{#snippet children(snapshot)}
						<TaskChecklist tasks={snapshot.tasks} files={snapshot.files} />
					{/snippet}
				</PortalScope>
			</ShowcaseCard>
			<ShowcaseCard
				title="Closed against further work"
				eyebrow="Refusal in advance"
				description="A hard close that ran out of time. The control stays, disabled to assistive technology and pointing at the reason; removing it would delete the explanation with it."
				full>
				<PortalScope dataset={accepted}>
					{#snippet children()}
						<TaskChecklist tasks={closedTask} files={[]} filterable={false} />
					{/snippet}
				</PortalScope>
			</ShowcaseCard>
		</div>
	</section>

	<section class="ds-section" id="history">
		<SectionHeading
			index="04"
			title="What has happened"
			description="A forward-only timeline in the universal envelope: appended, never rewritten, with each entry naming who acted in its own sentence." />
		<div class="ds-showcase-grid">
			<ShowcaseCard
				title="One submission's life"
				description="Oldest first, the participant's own actions among the organizers'. No reviewer identities, no internal state, nothing undone."
				full>
				<TimelineList events={timeline} timezone={zone} />
			</ShowcaseCard>
		</div>
	</section>

	<section class="ds-section" id="another-look">
		<SectionHeading
			index="05"
			title="Asking for another look"
			description="One request per submission and a ceiling across the event. The limits are the operation's to enforce; the surface renders what it returns." />
		<div class="ds-showcase-grid">
			<ShowcaseCard
				title="Offered"
				eyebrow="Declined, one request left"
				description="Composing opens in place. Sending it here really calls the sample operation — send twice across the two panels and the ceiling refuses structurally.">
				<PortalScope dataset={declined}>
					{#snippet children(snapshot)}
						{@const open = snapshot.submissions.find((entry) => entry.appeal.kind === 'available')}
						{#if open}<AppealPanel submission={open} />{/if}
					{/snippet}
				</PortalScope>
			</ShowcaseCard>
			<ShowcaseCard
				title="Already sent"
				eyebrow="Declined, request used"
				description="What was written stays visible afterwards, so nobody has to remember whether they sent it.">
				<PortalScope dataset={declined}>
					{#snippet children(snapshot)}
						{@const sent = snapshot.submissions.find((entry) => entry.appeal.kind === 'submitted')}
						{#if sent}<AppealPanel submission={sent} />{/if}
					{/snippet}
				</PortalScope>
			</ShowcaseCard>
		</div>
	</section>

	<section class="ds-section" id="receipt">
		<SectionHeading
			index="06"
			title="Commit receipt"
			description="One primitive, two placements: beside the operator rail, or centered on the portal's single column. It always offers a way back or the reason there is none." />
		<div class="ds-showcase-grid">
			<ShowcaseCard
				title="At the page's own edge"
				eyebrow="Live"
				description="Press either one: the dock is the shipped component, reading the same receipt bus every commit in the product records to.">
				<div class="receipt-demo">
					<button
						type="button"
						class="ui-button ui-button--secondary"
						onclick={() =>
							recordAction({
								label: 'Saved your changes to “Typed Tool Contracts”',
								area: 'Reference',
								undo: async () => undefined
							})}>
						Record an undoable change
					</button>
					<button
						type="button"
						class="ui-button ui-button--secondary"
						onclick={() =>
							recordAction({
								label: 'Withdrew “What We Broke Migrating”',
								area: 'Reference',
								notUndoableReason: 'The organizers have been told. Email them if this was a mistake.'
							})}>
						Record one that cannot be undone
					</button>
				</div>
			</ShowcaseCard>
			<ShowcaseCard
				title="Both answers, held still"
				description="The undoable and the final form, out of their fixed placement so the two can be compared. The undo control answers a press with its busy state.">
				<div class="receipt-static">
					<Receipt
						label="Saved your changes to “Typed Tool Contracts”"
						undoing={undoingSpecimen}
						onundo={demonstrateUndo} />
					<Receipt
						label="Withdrew “What We Broke Migrating”"
						finalNote="The organizers have been told. Email them if this was a mistake." />
				</div>
			</ShowcaseCard>
		</div>
	</section>
</div>

<CommitReceipt placement="column" />

<style>
	.portal-ds {
		max-inline-size: var(--je-page-max);
		margin-inline: auto;
		padding-inline: clamp(1.25rem, 2.5vw, 2.75rem);
	}

	.portal-ds__hero {
		display: grid;
		gap: var(--je-space-4);
		justify-items: start;
		padding-block: clamp(2.5rem, 6vw, 5rem);
		border-block-end: 1px solid var(--je-color-border);
	}

	.portal-ds__hero h1 {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: var(--je-font-size-3xl);
		font-weight: 400;
		letter-spacing: -0.025em;
		line-height: var(--je-leading-tight);
	}

	.portal-ds__hero p {
		max-inline-size: 52ch;
		margin: 0;
		color: var(--je-color-text-muted);
	}

	.portal-ds__links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-4);
	}

	.portal-ds__links a {
		color: var(--je-color-link);
		font-size: var(--je-font-size-sm);
	}

	.state-map {
		display: grid;
		gap: var(--je-space-3);
		margin: 0;
	}

	.state-map > div {
		display: grid;
		grid-template-columns: minmax(7rem, auto) minmax(0, 1fr);
		align-items: baseline;
		gap: var(--je-space-3);
	}

	.state-map dt,
	.state-map dd {
		margin: 0;
	}

	.state-map dd {
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
	}

	.receipt-demo {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	/* The dock is fixed in the product; here the two forms are pinned in flow so
	   they can be read side by side. Geometry is the primitive's own. */
	.receipt-static {
		position: relative;
		display: grid;
		gap: var(--je-space-3);
	}

	.receipt-static :global(.receipt) {
		position: static;
		inline-size: fit-content;
		max-inline-size: 100%;
		margin-inline: 0;
	}

	@media (max-width: 60rem) {
		.state-map > div {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--je-space-1);
		}
	}
</style>
