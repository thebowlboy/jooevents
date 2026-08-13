<script lang="ts">
	import { DatePicker, Field, Modal, Switch } from '$lib/ui';
	import type { ReviewPagePort } from '$lib/api/review-page-port';
	import { ANONYMIZED_MEANS } from './copy';
	import type { ReviewPlan, ReviewRoundSetup } from '$lib/api/types';

	/**
	 * The one path review setup has today: open round 1. The hand-out rule is
	 * fixed — every submission in the inbox goes to each reviewer whose scope
	 * covers it — so the dialog asks only what the rule cannot decide: the
	 * deadline and the blinding. Scale and peer-lock take their defaults and
	 * are stated, not asked.
	 */
	interface Props {
		port: ReviewPagePort;
		open?: boolean;
		/** Counted by the API; null while loading. */
		setup: ReviewRoundSetup | null;
		/** Called with the opened round, so the page reloads and records it. */
		onOpened: (plan: ReviewPlan) => void | Promise<void>;
	}

	let { port, open = $bindable(false), setup, onOpened }: Props = $props();

	const api = $derived(port);

	function inTwoWeeks(): string {
		const date = new Date();
		date.setDate(date.getDate() + 14);
		return date.toISOString().slice(0, 10);
	}

	const todayIso = new Date().toISOString().slice(0, 10);

	let deadline = $state('');
	let anonymized = $state(true);
	let busy = $state(false);

	// Opening resets the sheet: a round setup is not a resumable draft.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			deadline = inTwoWeeks();
			anonymized = true;
		}
		wasOpen = open;
	});

	function plural(count: number, singular: string, many = `${singular}s`) {
		return `${count} ${count === 1 ? singular : many}`;
	}

	async function openRound() {
		if (!deadline || busy) return;
		busy = true;
		const plan = await api.review.openRound({ deadlineIso: deadline, anonymized });
		await onOpened(plan);
		busy = false;
		open = false;
	}
</script>

<Modal bind:open title="Open the review round">
	<div class="form">
		{#if setup}
			<section class="handout" aria-label="The hand-out">
				<h3 class="handout__title">The hand-out</h3>
				<p class="handout__rule">
					{plural(setup.submissions, 'submission')} in the inbox, each to every reviewer whose scope
					covers it — later arrivals join the same way.
				</p>
				<ul class="handout__rows">
					{#each setup.perReviewer as reviewer (reviewer.id)}
						<li class="handout__row">
							<span class="handout__name">{reviewer.name}</span>
							<span class="handout__load">{plural(reviewer.assigned, 'submission')}</span>
						</li>
					{/each}
				</ul>
				{#if setup.invitedReviewers > 0}
					<p class="handout__note">
						{plural(setup.invitedReviewers, 'invited reviewer')} has not accepted yet and is not in
						this hand-out.
					</p>
				{/if}
			</section>

			<Field id="round-deadline" label="Reviews due" description="Anchored to the event; reminders and pace read from it.">
				{#snippet children({ id, describedBy })}
					<DatePicker {id} {describedBy} label="review deadline" min={todayIso} bind:value={deadline} />
				{/snippet}
			</Field>

			<Switch
				label="Anonymized"
				description={ANONYMIZED_MEANS}
				checked={anonymized}
				onchange={(next) => (anonymized = next)} />

			<p class="note">
				Scores are 1–5 with anchored meanings, Pass to Must-have. Peer reviews stay hidden from each
				reviewer until they commit their own.
			</p>
		{/if}
	</div>
	{#snippet footer(close)}
		<button type="button" class="ui-button ui-button--ghost" disabled={busy} onclick={close}>Cancel</button>
		<button
			type="button"
			class="ui-button ui-button--primary"
			disabled={busy || !deadline || !setup || setup.expectedReviews === 0}
			aria-busy={busy || undefined}
			onclick={openRound}>
			{#if busy}<span class="ui-spinner" aria-hidden="true"></span>{/if}
			Open round 1 · {plural(setup?.expectedReviews ?? 0, 'review')}
		</button>
	{/snippet}
</Modal>

<style>
	.form {
		display: grid;
		gap: var(--je-space-4);
	}

	/* The hand-out is the dialog's evidence: who gets what, stated as rows
	   rather than asserted as a count. */
	.handout {
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
	}

	.handout__title {
		margin: 0 0 var(--je-space-1);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.handout__rule {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.handout__rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.handout__row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--je-space-3);
		padding-block: var(--je-space-1);
	}

	.handout__row + .handout__row {
		border-block-start: 1px solid var(--je-color-border);
	}

	.handout__name {
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.handout__load {
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-muted);
	}

	.handout__note {
		margin: var(--je-space-2) 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.note {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}
</style>
