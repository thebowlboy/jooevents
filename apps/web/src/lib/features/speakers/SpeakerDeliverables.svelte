<script lang="ts">
	/**
	 * Every task assigned to this person, with the material behind it.
	 *
	 * The section the record was designed around. A row states what was asked,
	 * when it is due, and what condition it is in; a row with committed material
	 * renders that material in place; and the acts that close it — accept, waive
	 * — commit through the same registered operations the task matrix uses, so
	 * one act has one meaning and one compensator wherever it is pressed.
	 *
	 * The rule the composition exists to keep: **no accept control renders above
	 * unviewable content.** Where the material cannot be read, the control stays
	 * visible and carries its refusal, because hiding it would delete the reason
	 * and accepting unread work is exactly what this page ends.
	 */
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import DeliverableContent from './DeliverableContent.svelte';
	import { assignmentStateBadge, overdueBadge } from './engagement-vocabulary';
	import { composeHref, tasksHref } from '$lib/api/speaker-record';
	import type { DeliverableView } from '$lib/api/speaker-record';
	import type { SpeakerRecordPort } from '$lib/api/speaker-record-port';
	import type { SpeakerRow } from '$lib/api/types';

	let {
		views,
		engagement,
		port,
		onchanged
	}: {
		readonly views: readonly DeliverableView[];
		readonly engagement: SpeakerRow;
		readonly port: SpeakerRecordPort;
		readonly onchanged: () => Promise<void>;
	} = $props();

	let busyId = $state<string | null>(null);
	let actionError = $state('');
	let announcement = $state('');

	async function accept(view: DeliverableView) {
		if (busyId) return;
		busyId = view.def.id;
		actionError = '';
		const before = { state: view.state, overdue: view.overdue };
		try {
			const outcome = await port.deliverables.accept(view.def.id, engagement.id);
			if (!outcome.ok) {
				// A refused act stays on screen with its reason: the assignment
				// moved under this page, and re-reading is what tells the reader
				// where it moved to.
				actionError = outcome.reason;
				await onchanged();
				return;
			}
			recordAction({
				area: 'speakers',
				label: `Accepted “${view.def.name}” from ${engagement.name}`,
				undo: async () => {
					await port.deliverables.restore(
						view.def.id,
						engagement.id,
						before.state,
						before.overdue
					);
					await onchanged();
				}
			});
			announcement = `${view.def.name} accepted as complete for ${engagement.name}.`;
			await onchanged();
		} finally {
			busyId = null;
		}
	}

	async function waive(view: DeliverableView) {
		if (busyId) return;
		busyId = view.def.id;
		actionError = '';
		const before = { state: view.state, overdue: view.overdue };
		try {
			await port.deliverables.waive(view.def.id, engagement.id);
			recordAction({
				area: 'speakers',
				label: `Waived “${view.def.name}” for ${engagement.name}`,
				undo: async () => {
					await port.deliverables.restore(
						view.def.id,
						engagement.id,
						before.state,
						before.overdue
					);
					await onchanged();
				}
			});
			announcement = `${view.def.name} waived for ${engagement.name}.`;
			await onchanged();
		} finally {
			busyId = null;
		}
	}
</script>

<section class="section" aria-labelledby="record-deliverables">
	<div class="section__head">
		<h3 class="section__title" id="record-deliverables">Deliverables</h3>
		{#if views.length > 0}
			<a class="ui-button ui-button--soft ui-button--sm" href={tasksHref(engagement.id, false)}
				>Open in Tasks</a>
		{/if}
	</div>

	<p class="ui-sr-only" role="status">{announcement}</p>
	{#if actionError}
		<p class="section__error" role="alert">{actionError}</p>
	{/if}

	{#if views.length === 0}
		<p class="calm">
			Nothing has been asked of {engagement.name} yet.
			<a href="/app/tasks">Assign speaker tasks</a>
		</p>
	{:else}
		<ul class="rows">
			{#each views as view (view.def.id)}
				{@const badge = view.tone === 'overdue' ? overdueBadge : assignmentStateBadge[view.state]}
				{@const State = badge.icon}
				<li class="row" class:row--waiting={view.tone === 'received'}>
					<div class="row__head">
						<!-- Subject: what was asked. Neutral ink, strongest local
						     weight — every other value on the row is read relative
						     to it. -->
						<span class="row__name">{view.def.name}</span>
						<!-- State: the row's scan key, in the closed badge vocabulary.
						     Overdue outranks the assignment's own state because being
						     late is what changes what the reader does next. -->
						<span class="ui-badge ui-badge--{badge.tone}" class:ui-badge--solid={badge.solid}
							><State class="ui-badge__icon" aria-hidden="true" />{badge.label}</span>
						{#if !view.def.required}
							<span class="row__optional">Optional</span>
						{/if}
						{#if view.due}
							<!-- Time: due date takes the quiet time hue and tabular
							     figures — whether it has passed is half the judgment.
							     Absent where the state already carries the timing. -->
							<span class="row__due"><span class="ui-sr-only">Due </span>{view.due}</span>
						{/if}
					</div>

					{#if view.notYetSubmitted}
						<!-- A portal autosave is the speaker's own workspace. The
						     organizer sees material only from the submit commit
						     onward, so the row says exactly that and shows nothing. -->
						<p class="row__none">Not yet submitted.</p>
					{:else if view.content}
						<DeliverableContent content={view.content} />
					{/if}

					{#if view.settlement}
						<p class="row__settled">
							{view.state === 'waived' ? 'Waived' : 'Accepted'} by {view.settlement.by} ·
							<time>{view.settlement.at}</time>
						</p>
					{/if}

					{#if view.acceptable || view.acceptRefusal || view.waivable}
						<div class="row__acts">
							{#if view.acceptable}
								<button
									type="button"
									class="ui-button ui-button--primary ui-button--sm"
									disabled={busyId !== null}
									aria-busy={busyId === view.def.id}
									onclick={() => accept(view)}>Accept as complete</button>
							{:else if view.acceptRefusal}
								<button
									type="button"
									class="ui-button ui-button--primary ui-button--sm"
									aria-disabled="true">Accept as complete</button>
							{/if}

							{#if view.acceptable || view.acceptRefusal}
								<!-- Returning work to a speaker has no recorded act yet, so
								     the control says so where somebody would press it and
								     names the path that does exist. -->
								<button type="button" class="ui-button ui-button--secondary ui-button--sm" aria-disabled="true"
									>Send back</button>
							{/if}

							{#if view.waivable}
								<button
									type="button"
									class="ui-button ui-button--ghost ui-button--sm"
									disabled={busyId !== null}
									aria-busy={busyId === view.def.id}
									onclick={() => waive(view)}>Mark waived</button>
							{/if}
						</div>

						{#if view.acceptRefusal}
							<p class="row__reason">{view.acceptRefusal}</p>
						{/if}
						{#if view.acceptable || view.acceptRefusal}
							<p class="row__reason">
								Sending it back is not built yet — ask for a correction in a message instead.
								<a href={composeHref(engagement.id)}>Write to {engagement.name}</a>
							</p>
						{/if}
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.section {
		display: grid;
		gap: var(--je-space-3);
		padding: var(--je-space-5);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
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

	.section__error {
		margin: 0;
		color: var(--je-color-danger);
		font-size: var(--je-font-size-sm);
	}

	.rows {
		display: grid;
		gap: var(--je-space-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: grid;
		gap: var(--je-space-2);
		padding: var(--je-space-3) 0 0;
		border-block-start: 1px solid var(--je-color-border-subtle);
	}

	.row:first-child {
		border-block-start: 0;
		padding-block-start: 0;
	}

	/* Work waiting on the organizer keeps the strong semantic border the review
	   queue gives unfinished cards; settled work steps down to ordinary ink. */
	.row--waiting {
		border-inline-start: 2px solid var(--je-color-border-strong);
		padding-inline-start: var(--je-space-3);
	}

	.row__head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.row__name {
		min-inline-size: 0;
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.row__optional,
	.row__none,
	.row__settled,
	.row__reason {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.row__due {
		margin-inline-start: auto;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-recognition-time);
		font-variant-numeric: tabular-nums;
	}

	.row__none,
	.row__settled,
	.row__reason {
		margin: 0;
		max-inline-size: 68ch;
	}

	.row__settled time {
		color: var(--je-color-recognition-time);
		font-variant-numeric: tabular-nums;
	}

	.row__acts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-1);
	}

	.calm {
		margin: 0;
		color: var(--je-color-text-muted);
	}

	/* At a phone width the due date leaves the head row's trailing edge and
	   takes its own line under the name, so the state badge is never crushed
	   between two things competing for the same inline space. */
	@media (max-width: 47.99rem) {
		.row__due {
			margin-inline-start: 0;
			flex-basis: 100%;
		}
	}
</style>
