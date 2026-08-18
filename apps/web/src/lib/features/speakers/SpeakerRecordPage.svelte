<script lang="ts">
	/**
	 * Everything the product holds on one person, ranked by what needs you.
	 *
	 * The operator app's first record route. The peek stays the glance, the
	 * roster expansion stays the in-pass summary, and every person-shaped link
	 * lands here — one fact, one door, one landing.
	 *
	 * ── Recognition-role inventory (run per the hierarchy record, before build)
	 *
	 * *The judgment:* on this page the organizer is repeatedly deciding **what
	 * this one person still needs from me, and whether anything about them is
	 * wrong.** One question, so one page.
	 *
	 * *The scan keys are person-independent*, because the person is the page's
	 * subject rather than a value repeated down rows:
	 *
	 * 1. **State words** — the engagement chip, the deliverable states, the
	 *    delivery outcomes, the decision states. Closed `Badge` vocabulary with
	 *    its glyphs; these are the money-equivalent facts here.
	 * 2. **Times and rooms** — due dates, placement slots, submitted-at,
	 *    accepted-at, send times. Quiet time hue, tabular figures, because
	 *    whether something is late or imminent is half of every judgment.
	 *
	 * *Deliberately not coloured:* the person hue is **absent from this page**.
	 * The restraint rule activates it only where identity is a declared scan key;
	 * here identity is the title, so the name takes full neutral ink as the
	 * subject and colouring it would collapse subject and role into one hue. No
	 * measure hue either — nothing on this record is compared down rows. Session
	 * titles, submission titles, and task names are subjects in their sections
	 * and stay neutral; provenance, hints, and refusals stay muted support.
	 *
	 * *No new colours were minted*, and every distinction survives with hue
	 * removed: labels, order, badge glyphs, and words carry it.
	 */
	import { onMount, tick } from 'svelte';
	import { Avatar, CopyValue, situationIcon, statusIcon } from '$lib/ui';
	import { LiveRead, type LiveReadState } from '$lib/api/live-read';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import SpeakerDeliverables from './SpeakerDeliverables.svelte';
	import { deliveryOutcomeBadge, engagementStateBadge } from './engagement-vocabulary';
	import {
		afterGapStatement,
		composeHref,
		continuityCue,
		deliverableViews,
		isTerminal,
		nextStep,
		provenanceSentence,
		quietSentence,
		scopedAttention,
		threadHref
	} from '$lib/api/speaker-record';
	import type { SpeakerRecordPort, SpeakerRecordSnapshot } from '$lib/api/speaker-record-port';

	let {
		port,
		engagementId
	}: { readonly port: SpeakerRecordPort; readonly engagementId: string } = $props();

	const api = $derived(port);

	let recordState = $state<LiveReadState<SpeakerRecordSnapshot | null>>({ kind: 'resolving' });
	const read = new LiveRead<SpeakerRecordSnapshot | null>({
		read: () => api.record.read(engagementId),
		fallback: 'This speaker record could not be loaded.',
		onChange: (state) => (recordState = state)
	});

	const snapshot = $derived(recordState.kind === 'resolved' ? recordState.value : null);

	onMount(() => {
		void read.read();
	});

	/** Re-read after a write: a fresh request every time, newest answer wins. */
	async function reread() {
		await read.refresh();
	}

	let busy = $state(false);
	let actionError = $state('');
	let announcement = $state('');
	let copied = $state('');

	const attention = $derived(snapshot ? scopedAttention(snapshot) : []);
	const deliverables = $derived(snapshot ? deliverableViews(snapshot) : []);
	const cue = $derived(snapshot ? continuityCue(snapshot) : []);
	const step = $derived(snapshot ? nextStep(snapshot) : null);
	const gap = $derived(snapshot ? afterGapStatement(snapshot) : undefined);
	const archived = $derived(snapshot ? isTerminal(snapshot.engagement.state) : false);
	const entries = $derived(snapshot?.thread?.entries ?? []);
	const noteShownInAttention = $derived(
		attention.some((row) => row.detail === snapshot?.engagement.note)
	);

	async function confirm() {
		if (!snapshot || busy) return;
		busy = true;
		actionError = '';
		try {
			const outcome = await api.engagement.recordConfirmation(snapshot.engagement.id);
			if (!outcome.ok) {
				actionError = outcome.reason;
				await reread();
				return;
			}
			announcement = `${snapshot.engagement.name} is now confirmed.`;
			await reread();
			await tick();
		} finally {
			busy = false;
		}
	}
</script>

<section class="record" aria-label="Speaker record">
	{#if recordState.kind === 'unavailable'}
		<p class="failed" role="alert">
			{recordState.message}
			{#if recordState.retryable}
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm"
					onclick={() => void read.refresh()}>Try again</button>
			{/if}
		</p>
	{:else if recordState.kind === 'resolving'}
		<!-- The resolver is the resolved composition's own markup with skeleton
		     fills, so the geometry cannot disagree with what arrives. Only the
		     header and the first section are placeholdered: what follows is
		     conditional, and a placeholder asserts "this will exist". -->
		<div class="rail" aria-hidden="true">
			<div class="header__identity">
				<span class="ui-skeleton sk-avatar"></span>
				<span class="header__names">
					<span class="ui-skeleton sk-name"></span>
					<span class="ui-skeleton sk-line"></span>
				</span>
			</div>
			<span class="ui-skeleton sk-line sk-line--cue"></span>
		</div>
		<span class="ui-sr-only" role="status">Loading the speaker record…</span>
	{:else if !snapshot}
		<!-- An address that names no engagement is answered as itself. Nothing is
		     invented, and the way back is the surface that lists them all. -->
		<div class="failed" role="alert">
			<h2>No speaker record matches this address</h2>
			<p>
				This engagement may have been removed, or the address may be mistyped. Every speaker on
				this event is on the roster.
			</p>
			<a class="ui-button ui-button--secondary ui-button--sm" href="/app/speakers">Open Speakers</a>
		</div>
	{:else}
		{@const person = snapshot.engagement}
		{@const badge = engagementStateBadge[person.state]}
		{@const Engagement = badge.icon}

		<div class="layout" class:layout--archived={archived}>
		<!-- The rail: who this is, in one glance, always beside the work. -->
		<aside class="rail" aria-label="Speaker">
			<div class="header__identity">
				<Avatar name={person.name} size="lg" />
				<div class="header__names">
					<!-- Subject: full neutral ink, strongest weight on the page. -->
					<h2 class="header__name">{person.name}</h2>
					<!-- `Name <address>`: the brackets make the boundary visible
					     without another label or hue. Copy carries the raw email. -->
					<p class="header__address">
						{person.name} &lt;{person.email}&gt;
						<CopyValue
							value={person.email}
							label={`${person.name}’s email address`}
							display=""
							oncopy={() => (copied = `${person.email} copied.`)} />
					</p>
				</div>
				<span class="ui-badge ui-badge--{badge.tone}" class:ui-badge--solid={badge.solid}
					><Engagement class="ui-badge__icon" aria-hidden="true" />{badge.label}</span>
			</div>

			<!-- The continuity cue: standing · when · where · publication, each arm
			     only when its fact exists. The cancellation walk opens on the same
			     line, so nobody loses the thread crossing into it. -->
			<p class="cue">
				{#each cue as arm, index (arm.key)}
					{#if index > 0}<span class="cue__sep" aria-hidden="true">·</span>{/if}<span
						class="cue__arm"
						class:cue__arm--time={arm.key === 'when'}>{arm.text}</span>
				{/each}
			</p>

			<div class="header__facts">
				{#if person.publiclyVisible}
					{@const Shown = statusIcon.published}
					<span class="ui-badge ui-badge--sea"
						><Shown class="ui-badge__icon" aria-hidden="true" />On the public lineup</span>
					{#if !person.contentApproved}
						<span class="header__tba">Shows as TBA until their content is approved</span>
					{/if}
				{:else}
					{@const Concealed = statusIcon.unpublished}
					<span class="ui-badge ui-badge--neutral"
						><Concealed class="ui-badge__icon" aria-hidden="true" />Not on the public lineup</span>
				{/if}
			</div>

			{#if snapshot.publicCard && !snapshot.publicCard.provisional}
				<!-- Their public face, where the reader looks for who this IS:
				     headline, place, links — the bio half the fold was hiding. -->
				<div class="rail__bio">
					{#if snapshot.publicCard.headline}<p class="rail__headline">{snapshot.publicCard.headline}</p>{/if}
					{#if snapshot.publicCard.location}<p class="rail__where">{snapshot.publicCard.location}</p>{/if}
					{#if snapshot.publicCard.links.length > 0}
						<ul class="published__links">
							{#each snapshot.publicCard.links as link (link.href)}
								<li><a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a></li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}

			<p class="header__provenance">{provenanceSentence(snapshot)}</p>


			{#if snapshot.otherEngagements.length > 0}
				<p class="header__others">
					Also on this event:
					{#each snapshot.otherEngagements as other, index (other.id)}
						{#if index > 0}<span aria-hidden="true">, </span>{/if}<a href={other.href}
							>{other.sessionTitles.join(', ') || 'another engagement'}</a>
					{/each}
				</p>
			{/if}

			{#if person.note && !noteShownInAttention}
				<!-- The roster note is one string with two jobs. When it is the
				     cancellation request's own words, the attention row directly
				     below states it with the situation it belongs to; repeating it
				     here would be the same sentence twice in one screen. -->
				<p class="header__note">{person.note}</p>
			{/if}

			{#if step && step.tone !== 'danger'}
				<div class="header__acts">
					{#if step.href}
						<a class="ui-button ui-button--sm ui-button--primary" href={step.href}>{step.label}</a>
					{:else}
						<button
							type="button"
							class="ui-button ui-button--primary ui-button--sm"
							disabled={busy}
							aria-busy={busy}
							onclick={confirm}>{step.label}</button>
					{/if}
					<p class="header__hint">{step.hint}</p>
				</div>
			{/if}

			{#if actionError}<p class="header__error" role="alert">{actionError}</p>{/if}
			<p class="ui-sr-only" role="status">{announcement}{copied}</p>
		</aside>

		<div class="work">
			<!-- Loud is tone and position, never area: each situation is one slim
			     strip, the cancellation carries the walk door on itself, and calm
			     is a single quiet line. -->
			<section class="alerts" aria-label="Needs attention">
				{#if attention.length === 0}
					{@const Calm = situationIcon.allClear}
					<p class="alerts__calm">
						<Calm size={15} aria-hidden="true" />{quietSentence(person.name, person.state)}
					</p>
				{:else}
					<ul class="alerts__list">
						{#each attention as row (row.reason)}
							<li class="strip strip--{row.tone}">
								<p class="strip__text">
									<strong class="strip__title">{row.title}</strong
									>{#if row.detail}<span class="strip__detail"> — {row.detail}</span>{/if}
								</p>
								{#if row.reason === 'cancel_requested' && step?.href && step.tone === 'danger'}
									<a class="ui-button ui-button--danger ui-button--sm" href={step.href}>{step.label}</a>
								{:else if row.door}
									<a class="ui-button ui-button--secondary ui-button--sm" href={row.door.href}
										>{row.door.label}</a>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
				{#if gap}<p class="strip strip--note" role="note">{gap}</p>{/if}
			</section>

		<!-- Deliverables, with their content ───────────────────────────── -->
		<SpeakerDeliverables views={deliverables} engagement={person} {port} onchanged={reread} />
		<!-- Speaking commitments ───────────────────────────────────────── -->
		<section class="section" aria-labelledby="record-commitments">
			<h3 class="section__title" id="record-commitments">Speaking commitments</h3>
			{#if snapshot.sessions.length === 0}
				<p class="calm">No session is linked to this engagement.</p>
			{:else}
				<ul class="sessions">
					{#each snapshot.sessions as session (session.id)}
						<li class="session">
							<a class="session__title" href={session.href}>{session.title}</a>
							{#if session.placement}
								<!-- Time and room: the peek's line, unabridged, in the quiet
								     time hue — the fact a cancellation makes urgent. -->
								<span class="session__slot"
									>{session.placement.day} · {session.placement.time} ·
									{session.placement.room}</span>
							{:else}
								<span class="session__unplaced"
									>Not placed yet — it waits in the schedule's unplaced pool.</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
		<!-- Proposals: their submissions and where each decision stands ────────────────────────────────────────────── -->
		<section class="section" aria-labelledby="record-program">
			<h3 class="section__title" id="record-program">Proposals</h3>

			{#if snapshot.submissions.length === 0}
				<p class="calm">
					{snapshot.submissionCoverage === 'linked_only'
						? `No accepted proposal is linked to this engagement.`
						: `No proposal on this event carries ${person.name}’s address.`}
				</p>
			{:else}
				<ul class="proposals">
					{#each snapshot.submissions as proposal (proposal.id)}
						<li class="proposal">
							<a class="proposal__title" href={proposal.href}>{proposal.title}</a>
							<span class="proposal__state">
								{#if proposal.decision === 'undecided'}
									<span class="ui-badge ui-badge--neutral">Decision needed</span>
								{:else if !proposal.notified}
									<span class="ui-badge ui-badge--warning">Result not sent</span>
								{:else}
									<span class="ui-badge ui-badge--success">Result sent</span>
								{/if}
							</span>
							<a class="proposal__door" href={proposal.decisionHref}>Open in Decisions</a>
						</li>
					{/each}
				</ul>
			{/if}
			{#if snapshot.submissionCoverage === 'linked_only'}
				<p class="calm">
					This record knows which proposals created {person.name}’s speaking commitments.
					Open <a href="/app/submissions">Submissions</a> to check for any other proposals
					from this person.
				</p>
			{/if}

		</section>
		<!-- Communications ─────────────────────────────────────────────── -->
		<section class="section" aria-labelledby="record-communications">
			<div class="section__head">
				<h3 class="section__title" id="record-communications">Communications</h3>
				{#if entries.length > 0}
					<a class="ui-button ui-button--soft ui-button--sm" href={threadHref(person.id)}
						>Open in Communications</a>
				{/if}
			</div>

			{#if person.state === 'cancel_requested'}
				<!-- The Tasks-matrix guard, beside the door it governs. -->
				<p class="guard">
					Nothing goes out to {person.name} until their cancellation request is settled.
				</p>
			{/if}

			{#if entries.length === 0}
				<p class="calm">Nothing has been sent to {person.name}.</p>
			{:else}
				<ul class="thread">
					{#each entries as entry (entry.id)}
						{@const outcome = deliveryOutcomeBadge[entry.outcome]}
						{@const Outcome = outcome.icon}
						<li class="thread__entry">
							<span class="ui-badge ui-badge--{outcome.tone}" class:ui-badge--solid={outcome.solid}
								><Outcome class="ui-badge__icon" aria-hidden="true" />{outcome.label}</span>
							<span class="thread__what">
								<span class="thread__subject">{entry.subject}</span>
								<span class="thread__meta"
									>{entry.purpose} · <time>{entry.at}</time></span>
							</span>
						</li>
					{/each}
				</ul>
			{/if}

			<!-- A GET opens the composer scoped to one person; the send stays an
			     explicit command with its own review. -->
			<a class="ui-button ui-button--secondary ui-button--sm compose" href={composeHref(person.id)}
				>Write to {person.name}</a>
		</section>
		<!-- History ────────────────────────────────────────────────────── -->
		<section class="section" aria-labelledby="record-history">
			<h3 class="section__title" id="record-history">History</h3>
			{#if snapshot.history.length === 0}
				<p class="calm">
					No person-linked changes have been recorded for {person.name}. Messages are above,
					and event-wide activity is on <a href="/app/pulse">Pulse</a>.
				</p>
			{:else}
				<ul class="history">
					{#each snapshot.history as entry (entry.id)}
						<li class="history__entry">
							<time>{entry.at}</time>
							<span>{entry.text}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
		</div>
		</div>
	{/if}
</section>

<CommitReceipt onUndone={reread} />

<style>
	/* Stacked cards at both reference widths. Section-to-section spacing is the
	   section tier, so the seven regions read as seven answers rather than one
	   long page. */
	.record {
		display: grid;
		gap: var(--je-space-5);
		align-content: start;
	}

	/* One glance, two jobs: the rail says who, the work column says what needs
	   you. Side by side where the viewport affords it; identity first, compact,
	   when it does not — so the alerts still sit above the fold. */
	.layout {
		display: grid;
		gap: var(--je-space-5);
		align-items: start;
	}

	@media (min-width: 1100px) {
		.layout {
			grid-template-columns: 300px minmax(0, 1fr);
		}

		.rail {
			position: sticky;
			inset-block-start: var(--je-space-5);
		}
	}

	.work {
		display: grid;
		gap: var(--je-space-5);
		min-inline-size: 0;
	}

	/* The alert band: importance carried by tone and edge, not by height. */
	.alerts {
		display: grid;
		gap: var(--je-space-2);
	}

	.alerts__list {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.alerts__calm {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.strip {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-3);
		margin: 0;
		padding: var(--je-space-2) var(--je-space-3);
		border-inline-start: 3px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface);
		font-size: var(--je-font-size-sm);
	}

	.strip--danger {
		border-inline-start-color: var(--je-color-danger);
		background: var(--je-color-danger-surface, var(--je-color-surface));
	}

	.strip--warning {
		border-inline-start-color: var(--je-color-warning, var(--je-color-border-strong));
	}

	.strip--note {
		border-inline-start-color: var(--je-color-border-strong);
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text-muted);
	}

	.strip__text {
		margin: 0;
		min-inline-size: 0;
	}

	.strip__title {
		font-weight: 600;
	}

	.strip__detail {
		color: var(--je-color-text-muted);
	}

	.rail,
	.section {
		display: grid;
		gap: var(--je-space-3);
		padding: var(--je-space-5);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.rail {
		align-content: start;
		gap: var(--je-space-2);
		min-block-size: 12rem;
	}

	.rail__bio {
		display: grid;
		gap: 2px;
	}

	.rail__headline {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text);
	}

	.rail__where {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* A terminal engagement is an archive: the header steps back so the record
	   reads as kept rather than current. Contrast is preserved — this is a
	   surface step, not a text-ink step. */
	.layout--archived .rail {
		background: var(--je-color-surface-sunken);
	}

	.header__identity {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-3);
	}

	.header__names {
		display: grid;
		gap: 2px;
		min-inline-size: 0;
		flex: 1 1 14rem;
	}

	.header__name {
		margin: 0;
		font-size: var(--je-font-size-xl);
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.header__address {
		display: flex;
		align-items: center;
		gap: var(--je-space-1);
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		overflow-wrap: anywhere;
	}

	.cue {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-2);
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.cue__sep {
		color: var(--je-color-text-subtle);
	}

	.cue__arm--time {
		color: var(--je-color-recognition-time);
		font-variant-numeric: tabular-nums;
	}

	.header__facts {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.header__tba,
	.header__provenance,
	.header__others,
	.header__hint {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.header__provenance,
	.header__others,
	.header__note,
	.header__hint {
		margin: 0;
		max-inline-size: 68ch;
	}

	.header__note {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text);
	}

	.header__acts {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-2) var(--je-space-4);
		margin-block-start: var(--je-space-2);
	}

	.header__error {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-danger);
	}

	.section__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-3);
	}

	.section__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.section__subtitle {
		margin: var(--je-space-4) 0 0;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	/* An ordinary paragraph: these sentences carry inline links, and a flex
	   container would make each one a flex item and shuffle the sentence out of
	   order around them. The one calm state that takes a mark keeps it inline. */
	.calm {
		margin: 0;
		max-inline-size: 68ch;
		color: var(--je-color-text-muted);
	}

	.calm :global(svg) {
		vertical-align: text-bottom;
		margin-inline-end: var(--je-space-2);
	}

	/* Marker rail plus content column, and the action takes its own line at
	   narrow widths rather than crushing the copy between two fixed neighbours. */
	.session,
	.proposal {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.session__title,
	.proposal__title {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.session__slot {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-recognition-time);
		font-variant-numeric: tabular-nums;
	}

	.session__unplaced {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.proposal__door {
		margin-inline-start: auto;
		font-size: var(--je-font-size-sm);
	}

	.thread__entry {
		display: flex;
		align-items: flex-start;
		gap: var(--je-space-3);
	}

	.thread__what {
		display: grid;
		gap: 2px;
		min-inline-size: 0;
	}

	.thread__subject {
		overflow-wrap: anywhere;
	}

	.thread__meta {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.thread__meta time,
	.history__entry time {
		color: var(--je-color-recognition-time);
		font-variant-numeric: tabular-nums;
	}

	.guard {
		margin: 0;
		padding: var(--je-space-2) var(--je-space-3);
		border-inline-start: 2px solid var(--je-color-danger);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
		font-size: var(--je-font-size-sm);
		max-inline-size: 68ch;
	}

	.compose {
		justify-self: start;
		margin-block-start: var(--je-space-2);
	}

	.published__links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-3);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--je-font-size-sm);
	}

	.history__entry {
		display: flex;
		gap: var(--je-space-3);
		font-size: var(--je-font-size-sm);
	}

	.failed {
		display: grid;
		justify-items: start;
		gap: var(--je-space-3);
		align-content: center;
		min-block-size: 12rem;
		padding: var(--je-space-6);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.failed h2 {
		margin: 0;
		font-size: var(--je-font-size-lg);
	}

	.failed p {
		margin: 0;
		max-inline-size: 58ch;
		color: var(--je-color-text-muted);
	}

	.sk-avatar {
		display: block;
		inline-size: 2.75rem;
		block-size: 2.75rem;
		border-radius: 50%;
	}

	.sk-name {
		display: block;
		inline-size: min(16rem, 70%);
		block-size: 1lh;
	}

	.sk-line {
		display: block;
		inline-size: min(22rem, 90%);
		block-size: 1lh;
	}

	.sk-line--cue {
		inline-size: min(28rem, 95%);
	}

	@media (max-width: 47.99rem) {
		.record {
			gap: var(--je-space-6);
		}

		.rail,
		.section {
			padding: var(--je-space-4);
		}

		/* A strip's door drops under its sentence at phone width, same order. */
		.strip {
			flex-wrap: wrap;
		}

		.proposal__door {
			margin-inline-start: 0;
		}
	}
</style>
