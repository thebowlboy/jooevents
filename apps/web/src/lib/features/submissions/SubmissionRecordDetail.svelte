<script lang="ts">
	/**
	 * One submission, opened.
	 *
	 * Two surfaces share it — the triage queue and the decision board — and it
	 * is the same content in two presentations: inline beside the list on
	 * desktop, a full-screen sheet on a phone. That split belongs to
	 * `RecordDetail`; what belongs here is *what the record says and in which
	 * order*.
	 *
	 * The order is the deliberation's own (owner rework, 2026-08-15): the
	 * record opens like the proposal it is — who is behind it, then the
	 * abstract, then the materials, then what review and the signal layer have
	 * said about it. Opening a row is a request for the evidence the row could
	 * not carry, so the evidence leads. Classification and provenance the row
	 * already shows (track, format, state) close the record as a consultable
	 * ledger instead of standing between the reader and the abstract — the
	 * previous order spent six labelled lines restating the visible row before
	 * saying anything new, and left Materials looking like an afterthought at
	 * the panel's bottom edge.
	 *
	 * Every value still carries its label. The measured defect that rule closed
	 * was a bare "Ingrid Halvorsen" sitting under a timestamp with no term in
	 * front of it: a value nobody could place and nobody needed twice.
	 */
	import type { Snippet } from 'svelte';
	import { formatInstantDate } from '@jooevents/contracts';
	import {
		Badge,
		ClampedText,
		CopyValue,
		RecordDetail,
		RecordField,
		TrackChip,
		badgeFor
	} from '$lib/ui';
	import ResourceList from '$lib/features/workspace/components/ResourceList.svelte';
	import { scoreTone } from '$lib/features/workspace/components/score-tone';
	import { formatArrival } from '$lib/features/workspace/recency';
	import {
		awaitsNotice,
		decisionStatusFor,
		noticeStatus,
		reviewSummary,
		signalTone,
		type VocabLabel
	} from './submission-view';
	import type { Submission, SubmissionOrigin, SubmissionReview } from '$lib/api/types';

	interface Props {
		submission: Submission;
		/** The row's track, already resolved against the event's vocabulary. */
		track: VocabLabel;
		/**
		 * The row's format, resolved the same way. Omitted where the surface does
		 * not read the format vocabulary at all — an unread name is not an absent
		 * one, and "Not known yet" would be a claim about the record rather than
		 * about this screen.
		 */
		format?: VocabLabel;
		/** The event's track order, so the accent matches the row's own chip. */
		trackOrder?: readonly string[];
		/**
		 * The event's zone, when the surface knows it. With it, Received carries
		 * the absolute anchor beside the relative; without it the relative stands
		 * alone rather than claiming a calendar day in nobody's timezone.
		 */
		timezone?: string;
		/**
		 * Committed reviews: omitted = this surface does not offer them,
		 * 'loading' = the read is in flight and the block holds its footprint,
		 * an array = resolved.
		 */
		reviews?: SubmissionReview[] | 'loading';
		/** The review scale's top mark, for inking each score chip. */
		scaleMax?: number;
		/**
		 * Where an accepted submission went — the session it became (spawn) or
		 * joined (attach), with the door there. Omitted = this surface does not
		 * offer the fact or the read has not landed; null = answered, and it
		 * went nowhere (graduation reversed), which renders nothing.
		 */
		origin?: SubmissionOrigin | null;
		/** Surface-specific actions on the record as a whole. */
		actions?: Snippet;
		/** What either action costs, stated at the point of action. */
		footnote?: Snippet;
		/**
		 * Dismissal of the sheet. The page must clear its own expanded state
		 * here, or the row stays open behind a sheet nobody can see.
		 */
		onclose?: () => void;
		/**
		 * Passed through to `RecordDetail`. A host that is already a dialog —
		 * the deciding room — pins `inline`, because promoting to a sheet
		 * inside a dialog would stack one modal in another.
		 */
		presentation?: 'auto' | 'inline' | 'sheet';
	}

	const {
		submission,
		track,
		format,
		trackOrder,
		timezone,
		reviews,
		scaleMax = 5,
		origin,
		actions,
		footnote,
		onclose,
		presentation = 'auto'
	}: Props = $props();

	const decision = $derived(decisionStatusFor(submission));
	const owedNotice = $derived(awaitsNotice(submission));
	const speakerLabel = $derived(submission.speakers.length === 1 ? 'Speaker' : 'Speakers');
	/* The arrival, anchored: the relative for the reader deliberating now, the
	   calendar day for the reader recalling later — a relative string stops
	   being a record of anything after a couple of days. Day precision, not the
	   clock: which morning a proposal landed changes no judgment here, and the
	   exact instant stays in the record for audit surfaces. The anchor joins
	   only when the event's zone is known, because "19 Jul" is a claim about a
	   particular midnight. "Submitted" belongs to submitters; an organizer
	   keying a talk in has entered it, and that provenance rides the value. */
	const received = $derived.by(() => {
		const relative = formatArrival(submission.submittedAt);
		const day = timezone
			? formatInstantDate(submission.submittedAt, timezone, { fallback: '' })
			: '';
		const when = day ? `${relative} · ${day}` : relative;
		return submission.source === 'direct_entry' && submission.enteredBy
			? `${when} · entered by ${submission.enteredBy}`
			: when;
	});
</script>

{#snippet fields()}
	<!-- The byline: the one identity fact the row could not carry is the
	     address, and it opens the record the way a proposal reads — title,
	     then who is behind it, then the work itself. -->
	<RecordField label={speakerLabel} role="person">
		<ul class="people">
			{#each submission.speakers as speaker (speaker.email)}
				<li class="person">
					<span class="person__name">{speaker.name}</span>
					{#if speaker.email}
						<CopyValue value={speaker.email} display={`<${speaker.email}>`} label="email address" />
					{/if}
				</li>
			{/each}
		</ul>
	</RecordField>
{/snippet}

{#snippet blocks()}
	<RecordField label="Abstract" prose emphasis="primary">
		{#if submission.abstract}
			{submission.abstract}
		{:else}
			<!-- An organizer-lax direct entry may carry no abstract yet; the absence
			     is named so the blank never reads as a rendering failure. -->
			<span class="absent">No abstract yet.</span>
		{/if}
	</RecordField>

	<!-- Materials sit with the abstract because they are the same thing: what
	     the submitter put forward to be judged. Their old place — last block,
	     bottom edge of the panel — read as an appendix, and a reviewer who
	     stopped at the abstract never learned a talk had its slides attached. -->
	<RecordField label="Materials" block>
		<ResourceList resources={submission.resources} />
	</RecordField>

	{#if reviews !== undefined}
		<RecordField label="Committed reviews" block>
			{#if reviews === 'loading'}
				<!-- Two representative rows at the resolved composition's own metrics,
				     so the read lands in place instead of pushing the block down. -->
				<ul class="reviews" aria-hidden="true">
					{#each Array(2) as _, index (index)}
						<li class="review">
							<p class="review__head">
								<span class="ui-skeleton skeleton-score"></span>
								<span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span>
							</p>
							<p class="review__body">
								<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
							</p>
						</li>
					{/each}
				</ul>
			{:else if reviews.length === 0}
				<span class="absent">No committed reviews yet.</span>
			{:else}
				<ul class="reviews">
					{#each reviews as review (review.reviewer)}
						<li class="review">
							<p class="review__head">
								<span class="ui-badge {scoreTone(review.score, scaleMax)}">{review.score}</span>
								<span class="review__who">{review.reviewer}</span>
								<span class="review__when">· {review.committedAt}</span>
								{#if review.amendedFrom !== undefined}
									<!-- Calibration evidence, not an alarm: the change was made after
									     peer scores were visible, and the prior mark says how far it moved. -->
									<span class="review__amended">revised from {review.amendedFrom} after unlock</span>
								{/if}
							</p>
							{#if review.comment}
								<div class="review__body">
									<ClampedText lines={2} label={`review by ${review.mine ? 'you' : review.reviewer}`}>
										{review.comment}
									</ClampedText>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</RecordField>
	{/if}

	{#if submission.signals.length > 0}
		<RecordField label="Signals" block>
			<ul class="signals">
				{#each submission.signals as signal (signal.key)}
					<li>
						<Badge tone={signalTone[signal.family]} value={signal.label} />
						<p class="signal__rationale">{signal.rationale}</p>
						<p class="signal__source">{signal.source}</p>
					</li>
				{/each}
			</ul>
		</RecordField>
	{/if}
{/snippet}

{#snippet meta()}
	<!-- The closing ledger: classification, clocks, and state — consulted, not
	     read. On desktop the open row is one line above and already shows most
	     of these; on the phone sheet the row is off-screen, so the record still
	     carries them and the information architecture does not fork. -->
	<RecordField label="Track">
		{#if track.kind === 'named'}
			<TrackChip name={track.name} id={submission.trackId} order={trackOrder} />
		{:else if track.kind === 'none'}
			<!-- Said in words, on the quietest rung. An empty capsule was the defect;
			     silence would be the same defect with better manners. -->
			<span class="absent">No track</span>
		{:else}
			<span class="absent">Not known yet</span>
		{/if}
	</RecordField>

	{#if format}
		<RecordField label="Format">
			{#if format.kind === 'named'}
				{format.name}
			{:else if format.kind === 'none'}
				<span class="absent">No format</span>
			{:else}
				<span class="absent">Not known yet</span>
			{/if}
		</RecordField>
	{/if}

	<RecordField label="Received" role="time">{received}</RecordField>

	<RecordField label="Reviews" role="measure">{reviewSummary(submission)}</RecordField>

	<RecordField label="Decision">
		<span class="states">
			<Badge {...badgeFor(decision.key)} value={decision.label} />
			{#if owedNotice}
				<Badge {...badgeFor(noticeStatus.key)} value={noticeStatus.label} />
			{/if}
		</span>
	</RecordField>

	{#if origin}
		<!-- The graduated row's way back to what it became: acceptance landed
		     somewhere visible, and this is the durable door there — the receipt's
		     "Place it" already expired with its toast. -->
		<RecordField label={origin.kind === 'spawn' ? 'Became' : 'Joined'}>
			<a class="detail__origin" href={`/app/schedule?session=${origin.sessionId}`}
				>“{origin.title}”</a>
		</RecordField>
	{/if}

	{#if submission.appealCount}
		<RecordField label="Appeals">
			{submission.appealCount} from this submitter
		</RecordField>
	{/if}
{/snippet}

<RecordDetail title={submission.title} {onclose} {fields} {blocks} {meta} {actions} {footnote} {presentation} />

<style>
	/* One person per line. The conventional angle brackets separate name from
	   address at a glance; CopyValue still transports only the raw address. */
	.people {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--je-space-1);
	}

	.person {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-2);
	}

	.person__name {
		font-weight: 600;
	}

	/* An absence is a value too, and it descends to the quietest rung rather
	   than leaving the label pointing at nothing. */
	.absent {
		color: var(--je-color-text-subtle);
	}

	.states {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1);
	}

	.detail__origin {
		color: var(--je-color-action);
		font-weight: 600;
		text-decoration: none;
	}

	.detail__origin:hover {
		text-decoration: underline;
	}

	.reviews {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--je-space-3);
	}

	.review__head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-1) var(--je-space-2);
		margin: 0;
		font-size: var(--je-font-size-sm);
	}

	.review__who {
		font-weight: 600;
	}

	.review__when {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-subtle);
		white-space: nowrap;
	}

	.review__amended {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-warning);
		white-space: nowrap;
	}

	.review__body {
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-sm);
		white-space: normal;
	}

	/* Skeleton fills borrow real metrics: the score fill is badge-height, the
	   lines are one line box each, so the resolved list lands without a shift. */
	.skeleton-score {
		display: inline-block;
		block-size: 1.35rem;
		inline-size: 1.75rem;
	}

	.skeleton-line {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.signals {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--je-space-3);
	}

	.signal__rationale {
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-sm);
		white-space: normal;
	}

	.signal__source {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}
</style>
