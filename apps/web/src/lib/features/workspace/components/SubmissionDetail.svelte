<script lang="ts" module>
	/**
	 * Signal family tones, exported so a surface that renders signal chips in
	 * its own rows (the submissions queue) draws them from the same map as the
	 * expansion — one fact, one ink.
	 */
	export const signalTone: Record<string, string> = {
		quality: 'sea',
		draw: 'lavender',
		integrity: 'warning'
	};
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ClampedText, CopyValue } from '$lib/ui';
	import ResourceList from './ResourceList.svelte';
	import { scoreTone } from './score-tone';
	import { formatArrival } from '../recency';
	import type { Submission, SubmissionOrigin, SubmissionReview } from '$lib/api/types';

	interface Props {
		submission: Submission;
		/**
		 * Committed reviews for the side column: omitted = this surface does not
		 * offer them, 'loading' = the read is in flight and the block holds its
		 * footprint, an array = resolved.
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
		/** Surface-specific actions at the end of the side column. */
		actions?: Snippet;
		/** Consequence copy under the actions. */
		footnote?: Snippet;
	}

	const { submission, reviews, scaleMax = 5, origin, actions, footnote }: Props = $props();
</script>

<div class="detail">
	<div class="detail__main">
		<h3 class="detail__heading">Abstract</h3>
		{#if submission.abstract}
			<p class="detail__abstract">{submission.abstract}</p>
		{:else}
			<!-- An organizer-lax direct entry may carry no abstract yet; the absence
			     is named so the blank never reads as a rendering failure. -->
			<p class="detail__none">No abstract yet.</p>
		{/if}
		{#if submission.source === 'direct_entry' && submission.enteredBy}
			<!-- The verb honestly names the act: "submitted" belongs to submitters. -->
			<p class="detail__meta">
				Entered directly by {submission.enteredBy} · {formatArrival(submission.submittedAt)}
			</p>
		{:else}
			<p class="detail__meta">Submitted {formatArrival(submission.submittedAt)}</p>
		{/if}
		{#if origin}
			<!-- The graduated row's way back to what it became: acceptance landed
			     somewhere visible, and this is the durable door there — the
			     receipt's "Place it" already expired with its toast. -->
			<p class="detail__meta">
				{origin.kind === 'spawn' ? 'Became' : 'Joined'}
				<a class="detail__origin" href={`/app/schedule?session=${origin.sessionId}`}
					>“{origin.title}”</a>
				in the program.
			</p>
		{/if}
		<ul class="detail__people">
			{#each submission.speakers as speaker (speaker.email)}
				<li class="person">
					<span class="person__name">{speaker.name}</span>
					<CopyValue value={speaker.email} display={`<${speaker.email}>`} label="email address" />
				</li>
			{/each}
		</ul>
		<h3 class="detail__heading detail__heading--materials">Materials</h3>
		<ResourceList resources={submission.resources} />
	</div>
	<div class="detail__side">
		{#if reviews !== undefined}
			<h3 class="detail__heading">Reviews</h3>
			{#if reviews === 'loading'}
				<!-- Two representative rows at the resolved composition's own metrics,
				     so the read lands in place instead of pushing the column down. -->
				<ul class="reviews" aria-hidden="true">
					{#each Array(2) as _, index (index)}
						<li class="review">
							<p class="review__head">
								<span class="ui-skeleton skeleton-score"></span>
								<span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span>
							</p>
							<p class="review__body"><span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span></p>
						</li>
					{/each}
				</ul>
			{:else if reviews.length === 0}
				<p class="reviews__none">No committed reviews yet.</p>
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
		{/if}
		{#if submission.signals.length > 0}
			<h3 class="detail__heading">Signals</h3>
			<ul class="detail__signals">
				{#each submission.signals as signal (signal.key)}
					<li>
						<span class="ui-badge ui-badge--{signalTone[signal.family]}">{signal.label}</span>
						<p class="detail__rationale">{signal.rationale}</p>
						<p class="detail__source">{signal.source}</p>
					</li>
				{/each}
			</ul>
		{/if}
		{#if submission.appealCount}
			<p class="detail__appeal">{submission.appealCount} appeal from this submitter</p>
		{/if}
		{#if actions}
			<div class="detail__actions">
				{@render actions()}
			</div>
		{/if}
		{#if footnote}
			<p class="detail__fates">
				{@render footnote()}
			</p>
		{/if}
	</div>
</div>

<style>
	.detail {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: var(--je-space-6);
		padding: var(--je-space-3) var(--je-space-2) var(--je-space-4);
	}

	.detail__heading {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.detail__abstract {
		margin: 0;
		font-size: var(--je-font-size-md);
		line-height: var(--je-leading-normal);
		white-space: normal;
	}

	.detail__none {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-subtle);
	}

	.detail__meta {
		margin: var(--je-space-3) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.detail__origin {
		color: var(--je-color-action);
		font-weight: 600;
		text-decoration: none;
	}

	.detail__origin:hover {
		text-decoration: underline;
	}

	/* One person per line. An address is a value someone transports, so it gets its
	   own selectable run instead of sitting between angle brackets inside a
	   sentence — and the interpunct goes back to separating one item's attributes. */
	.detail__people {
		list-style: none;
		margin: var(--je-space-1) 0 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}

	.person {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-2);
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.person__name {
		color: var(--je-color-text);
	}

	.detail__heading--materials {
		margin-block-start: var(--je-space-4);
	}

	.reviews {
		list-style: none;
		margin: 0 0 var(--je-space-4);
		padding: 0;
		display: grid;
		gap: var(--je-space-3);
	}

	.reviews__none {
		margin: 0 0 var(--je-space-4);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-subtle);
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

	.detail__signals {
		list-style: none;
		margin: 0 0 var(--je-space-3);
		padding: 0;
		display: grid;
		gap: var(--je-space-3);
	}

	.detail__rationale {
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-sm);
		white-space: normal;
	}

	.detail__source {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.detail__appeal {
		margin: 0 0 var(--je-space-3);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-warning);
		font-weight: 600;
	}

	.detail__fates {
		margin: var(--je-space-2) 0 0;
		max-inline-size: 46ch;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.detail__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	@media (max-width: 920px) {
		.detail {
			grid-template-columns: 1fr;
			gap: var(--je-space-4);
		}
	}
</style>
