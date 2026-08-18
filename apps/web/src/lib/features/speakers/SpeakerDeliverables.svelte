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

	/**
	 * Outstanding first, because the section answers "what have they NOT done
	 * yet". Within it: material waiting on the organizer outranks a speaker who
	 * is late, which outranks quiet not-due work — ordered by whose move it is.
	 * Settled rows are one press away rather than gone: this is not a ceremony
	 * surface, and the archive reading (every settled row with its material)
	 * stays intact behind the disclosure.
	 */
	const OUTSTANDING_ORDER: Record<string, number> = { received: 0, overdue: 1, quiet: 2 };
	const outstanding = $derived(
		views
			.filter((view) => view.tone !== 'settled')
			.toSorted((a, b) => (OUTSTANDING_ORDER[a.tone] ?? 3) - (OUTSTANDING_ORDER[b.tone] ?? 3))
	);
	const settled = $derived(views.filter((view) => view.tone === 'settled'));
	let settledOpen = $state(false);

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
			settledOpen = true;
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
		{#if outstanding.length === 0}
			<p class="calm">Everything asked of {engagement.name} is settled.</p>
		{/if}
		<ul class="rows">
			{#each outstanding as view (view.def.id)}
				{@render deliverableRow(view)}
			{/each}
		</ul>

		{#if settled.length > 0}
			<!-- Settled work is archive, not attention: one press away, never gone.
			     The count keeps the denominator honest while closed. -->
			<div class="settled">
				<button
					type="button"
					class="ui-button ui-button--ghost ui-button--sm"
					aria-expanded={settledOpen}
					onclick={() => (settledOpen = !settledOpen)}
					>{settledOpen ? 'Hide settled' : `Settled · ${settled.length}`}</button>
				{#if settledOpen}
					<ul class="rows">
						{#each settled as view (view.def.id)}
							{@render deliverableRow(view)}
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	{/if}
</section>

{#snippet deliverableRow(view: DeliverableView)}
				<li class="row" class:row--waiting={view.tone === 'received'}>
					<!-- Four aligned columns, shared down the list through the grid the
					     list owns: what was asked · state · due · the row's one small act.
					     The old free-wrap head put these anywhere the widths fell. -->
					<span class="row__name"
						>{view.def.name}{#if !view.def.required}<span class="row__optional"> · Optional</span
							>{/if}</span>
					<span class="row__state">
						{#if true}{@const badge = view.tone === 'overdue' ? overdueBadge : assignmentStateBadge[view.state]}{@const State = badge.icon}<span
								class="ui-badge ui-badge--{badge.tone}"
								class:ui-badge--solid={badge.solid}
								><State class="ui-badge__icon" aria-hidden="true" />{badge.label}</span>{/if}
					</span>
					<span class="row__due">
						{#if view.due}<span class="ui-sr-only">Due </span>{view.due}{/if}
					</span>
					<span class="row__act">
						{#if view.waivable && !view.acceptable && !view.acceptRefusal}
							<button
								type="button"
								class="ui-button ui-button--ghost ui-button--sm"
								disabled={busyId !== null}
								aria-busy={busyId === view.def.id}
								onclick={() => waive(view)}>Mark waived</button>
						{/if}
					</span>

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

					{#if view.acceptable || view.acceptRefusal}
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

							{#if view.waivable && (view.acceptable || view.acceptRefusal)}
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
{/snippet}

<style>
	.settled {
		display: grid;
		gap: var(--je-space-3);
		justify-items: start;
	}

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

	/* The list owns the columns; every row aligns to them through subgrid, so
	   name, state, due, and act sit in real columns down the whole section. */
	.rows {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content max-content max-content;
		row-gap: var(--je-space-3);
		column-gap: var(--je-space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: subgrid;
		align-items: center;
		row-gap: var(--je-space-2);
		padding: var(--je-space-2) 0 0;
		border-block-start: 1px solid var(--je-color-border-subtle);
	}

	/* Everything below the head line spans the row. */
	.row > :global(:not(.row__name):not(.row__state):not(.row__due):not(.row__act)) {
		grid-column: 1 / -1;
	}

	.row__state {
		justify-self: start;
	}

	.row__act {
		justify-self: end;
		min-block-size: 1px;
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
		justify-self: end;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-recognition-time);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
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
		/* Two aligned columns at phone width: name beside state, due beside the
		   act on the line below — still columns, never a free wrap. */
		.rows {
			grid-template-columns: minmax(0, 1fr) max-content;
		}

		.row__due {
			grid-column: 1;
			grid-row: 2;
			justify-self: start;
		}

		.row__act {
			grid-column: 2;
			grid-row: 2;
		}

		.row > :global(:not(.row__name):not(.row__state):not(.row__due):not(.row__act)) {
			grid-row: auto;
		}
	}
</style>
