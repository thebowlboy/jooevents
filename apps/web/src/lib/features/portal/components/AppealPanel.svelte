<script lang="ts">
	/**
	 * Asking the organizers to look at a decision again.
	 *
	 * One request per submission, and a ceiling across the event — a run of
	 * declines must not become a run of requests. Both limits are the operation's
	 * to enforce; this surface's job is to say what happened in words, and to
	 * keep what was written visible afterwards so nobody has to remember whether
	 * they sent it.
	 */
	import { Field } from '$lib/ui';
	import type { PortalSubmissionView } from '$lib/api/portal/view-models';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { applyParams, paramFlag } from '$lib/features/workspace/url-state.svelte';
	import { refusalCopy } from '../copy';
	import { formatInstant } from '../format';
	import { usePortalStore } from '../store.svelte';
	import RefusalNote from './RefusalNote.svelte';

	let { submission }: { submission: PortalSubmissionView } = $props();

	const store = usePortalStore();
	const timezone = $derived(store.snapshot?.event.timezone ?? 'UTC');
	const open = $derived(paramFlag('appeal'));

	// Keyed to the record, so nothing breaks where more than one panel is shown.
	const headingId = $derived(`appeal-${submission.id}-heading`);
	const reasonId = $derived(`appeal-${submission.id}-reason`);

	let reason = $state('');
	let busy = $state(false);
	let refusal = $state('');

	async function send() {
		if (busy || reason.trim() === '') return;
		busy = true;
		refusal = '';
		const outcome = await store.api.appealDecision({
			submissionId: submission.id,
			reason: reason.trim()
		});
		busy = false;
		if (!outcome.ok) {
			refusal = refusalCopy[outcome.reason];
			return;
		}
		recordAction({
			label: `Asked for another look at “${submission.title}”`,
			area: 'Portal',
			notUndoableReason: 'The organizers have it. There is one request per submission.'
		});
		reason = '';
		await applyParams({ appeal: null });
		await store.reload();
	}
</script>

{#if submission.appeal.kind === 'submitted'}
	<section class="appeal" aria-labelledby={headingId}>
		<h2 class="appeal__title" id={headingId}>You asked for another look</h2>
		<p class="appeal__line">
			Sent {formatInstant(submission.appeal.submittedAt, timezone)}. The organizers decide whether to
			re-open it; there is no obligation on them to reply.
		</p>
		<blockquote class="appeal__quote">{submission.appeal.reason}</blockquote>
	</section>
{:else if submission.appeal.kind === 'available'}
	<section class="appeal" aria-labelledby={headingId}>
		<h2 class="appeal__title" id={headingId}>Ask for another look</h2>
		<p class="appeal__line">
			You can ask the organizers to reconsider this one, once. Say what you think was missed — they
			read it beside the submission itself.
		</p>
		{#if open}
			<Field
				id={reasonId}
				label="What should they know?"
				description="A few sentences is plenty.">
				{#snippet children({ id, describedBy })}
					<textarea
						{id}
						class="ui-textarea"
						rows="4"
						aria-describedby={describedBy}
						disabled={busy}
						bind:value={reason}></textarea>
				{/snippet}
			</Field>
			<div class="appeal__actions">
				<button
					type="button"
					class="ui-button ui-button--primary"
					disabled={busy || reason.trim() === ''}
					aria-busy={busy || undefined}
					onclick={send}>
					{busy ? 'Sending…' : 'Send this to the organizers'}
				</button>
				<button
					type="button"
					class="ui-button ui-button--ghost"
					disabled={busy}
					onclick={() => applyParams({ appeal: null })}>
					Cancel
				</button>
			</div>
		{:else}
			<div class="appeal__actions">
				<button
					type="button"
					class="ui-button ui-button--secondary"
					onclick={() => applyParams({ appeal: '1' })}>
					Ask for another look
				</button>
			</div>
		{/if}
		{#if refusal}
			<RefusalNote message={refusal} tone="refused" />
		{/if}
	</section>
{/if}

<style>
	.appeal {
		display: grid;
		gap: var(--je-space-3);
		padding: var(--je-space-5);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.appeal__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
	}

	.appeal__line {
		margin: 0;
		color: var(--je-color-text-muted);
		max-inline-size: 62ch;
		line-height: var(--je-leading-normal);
	}

	.appeal__quote {
		margin: 0;
		padding-inline-start: var(--je-space-3);
		border-inline-start: 2px solid var(--je-color-border-strong);
		white-space: pre-wrap;
		line-height: var(--je-leading-normal);
		max-inline-size: 62ch;
	}

	.appeal__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}
</style>
