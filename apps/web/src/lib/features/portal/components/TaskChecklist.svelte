<script lang="ts">
	/**
	 * The checklist: everything the event asks of one speaker, each row carrying
	 * its own deadline, its own state, and exactly one thing to press.
	 *
	 * Completion is always explicit. Opening a row, reading it, or closing the
	 * page changes nothing — the only way a task moves is someone deciding it
	 * has, which is what makes the state worth trusting on both sides.
	 */
	import { arrival, Badge, situationIcon } from '$lib/ui';
	import type { PortalFileView, PortalTaskView } from '$lib/api/portal/view-models';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { applyParams, param, paramIn } from '$lib/features/workspace/url-state.svelte';
	import { refusalCopy, taskActionLabel, taskDoneLabel, taskStateCopy, unavailableCopy } from '../copy';
	import { formatDeadline, formatFileSize, formatInstant } from '../format';
	import { isOutstanding } from '../home-actions';
	import { usePortalStore } from '../store.svelte';
	import RefusalNote from './RefusalNote.svelte';
	import StateBadge from './StateBadge.svelte';

	interface Props {
		tasks: readonly PortalTaskView[];
		files: readonly PortalFileView[];
		/** Below this many rows a filter has nothing to hide, so none is offered. */
		filterable?: boolean;
	}

	let { tasks, files, filterable = true }: Props = $props();

	const store = usePortalStore();
	const now = Date.now();

	const scopes = ['all', 'outstanding'] as const;
	const scope = $derived(paramIn('tasks', scopes, 'all'));
	const askedTask = $derived(param('task'));

	const done = $derived(tasks.filter((task) => !isOutstanding(task.state)).length);
	const shown = $derived(
		filterable && scope === 'outstanding'
			? tasks.filter((task) => isOutstanding(task.state))
			: tasks
	);
	const offersFilter = $derived(filterable && tasks.length >= 3 && done > 0 && done < tasks.length);

	let busyTask = $state<string | null>(null);
	let refusals = $state<Record<string, string>>({});

	function versionsFor(taskId: string): PortalFileView[] {
		return files
			.filter((file) => file.taskId === taskId)
			.slice()
			.sort((left, right) => right.version - left.version);
	}

	/** A soft close keeps accepting work and labels it; a hard close does not. */
	function closedAgainstWork(task: PortalTaskView): boolean {
		return task.state === 'late' && !task.acceptsLateCompletion;
	}

	async function complete(task: PortalTaskView, fileName?: string) {
		if (busyTask !== null) return;
		busyTask = task.id;
		refusals = { ...refusals, [task.id]: '' };
		const outcome = await store.api.completeTask(
			fileName === undefined ? { taskId: task.id } : { taskId: task.id, fileName }
		);
		busyTask = null;
		if (!outcome.ok) {
			refusals = { ...refusals, [task.id]: refusalCopy[outcome.reason] };
			return;
		}
		recordAction({
			label: fileName ? `Sent “${fileName}” for “${task.title}”` : `Marked “${task.title}” done`,
			area: 'Portal',
			notUndoableReason: 'The organizers have it already.'
		});
		await store.reload();
	}

	function onFile(task: PortalTaskView, event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = '';
		if (file) void complete(task, file.name);
	}
</script>

<div class="checklist">
	<div class="checklist__head">
		<h2 class="checklist__title">Your checklist</h2>
		<p class="checklist__count">{done} of {tasks.length} done</p>
		{#if offersFilter}
			<div class="ui-segmented checklist__filter" role="group" aria-label="Which tasks to show">
				{#each scopes as key (key)}
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={scope === key}
						onclick={() => applyParams({ tasks: key === 'all' ? null : key })}>
						{key === 'all' ? 'All' : 'Still to do'}
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<ul class="checklist__list">
		{#each shown as task (task.id)}
			{@const versions = versionsFor(task.id)}
			{@const busy = busyTask === task.id}
			<li class="task" {@attach arrival(task.id === askedTask, { block: 'center' })}>
				<div class="task__head">
					<h3 class="task__title">{task.title}</h3>
					<StateBadge state={taskStateCopy[task.state]} />
					{#if !task.required}
						<Badge tone="neutral">Optional</Badge>
					{/if}
				</div>

				{#if task.dueAt}
					<p class="task__due">
						{task.state === 'complete' || task.state === 'received_pending_check'
							? `Was due ${formatInstant(task.dueAt, task.timezone)}`
							: `Due ${formatDeadline(task.dueAt, task.timezone, now)}`}
					</p>
				{/if}

				{#if task.state === 'received_pending_check'}
					<p class="task__state-note">{taskStateCopy.received_pending_check.meaning}</p>
				{:else if task.state === 'late' && task.acceptsLateCompletion}
					<p class="task__state-note">Deadline passed — you can still send it; it will be marked late.</p>
				{:else if closedAgainstWork(task)}
					<p class="task__state-note" id={`closed-${task.id}`}>{refusalCopy.task_closed}</p>
				{/if}

				{#if versions.length > 0}
					<ul class="task__versions">
						{#each versions as file (file.id)}
							<li class="task__version">
								<span class="task__file-name">{file.name}</span>
								<span class="task__file-meta">
									Version {file.version} · {formatFileSize(file.sizeBytes)} · sent
									{formatInstant(file.uploadedAt, task.timezone)}
								</span>
							</li>
						{/each}
					</ul>
				{/if}

				{#if task.state === 'todo' || task.state === 'late'}
					<div class="task__actions">
						{#if closedAgainstWork(task)}
							<!-- Still a control, still focusable, carrying the reason it will
							     not act. Removing it would delete the explanation with it. -->
							<button
								type="button"
								class="ui-button ui-button--primary ui-button--sm"
								aria-disabled="true"
								aria-describedby={`closed-${task.id}`}>
								{taskActionLabel(task.completion)}
							</button>
						{:else if task.completion.mode === 'upload'}
							<input
								id={`upload-${task.id}`}
								class="ui-sr-only task__file"
								type="file"
								accept={task.completion.acceptedTypes.join(',')}
								disabled={busy}
								onchange={(event) => onFile(task, event)} />
							<label
								class="ui-button ui-button--primary ui-button--sm task__upload"
								for={`upload-${task.id}`}
								aria-disabled={busy || undefined}>
								{#if busy}Sending…{:else if versions.length > 0}Send a new version{:else}Upload{/if}
							</label>
						{:else if task.completion.mode === 'form_fill'}
							<!-- The questions live in a form this build does not serve. The
							     control stays, carrying the reason beside it, rather than
							     vanishing and taking the explanation with it. -->
							<button
								type="button"
								class="ui-button ui-button--primary ui-button--sm"
								aria-disabled="true"
								aria-describedby={`form-${task.id}`}>
								{taskActionLabel(task.completion)}
							</button>
							<p class="task__state-note task__reason" id={`form-${task.id}`}>
								{unavailableCopy.taskForm}
							</p>
						{:else if task.completion.mode === 'external'}
							<a
								class="ui-button ui-button--primary ui-button--sm"
								href={task.completion.url}
								target="_blank"
								rel="noreferrer noopener">
								{taskActionLabel(task.completion)}
							</a>
							<button
								type="button"
								class="ui-button ui-button--secondary ui-button--sm"
								disabled={busy}
								aria-busy={busy || undefined}
								onclick={() => complete(task)}>
								{busy ? 'Saving…' : taskDoneLabel}
							</button>
						{:else}
							<button
								type="button"
								class="ui-button ui-button--primary ui-button--sm"
								disabled={busy}
								aria-busy={busy || undefined}
								onclick={() => complete(task)}>
								{busy ? 'Saving…' : taskActionLabel(task.completion)}
							</button>
						{/if}
					</div>
				{/if}

				{#if refusals[task.id]}
					<RefusalNote message={refusals[task.id]} tone="refused" />
				{/if}
			</li>
		{/each}
	</ul>

	{#if shown.length === 0}
		{@const AllClear = situationIcon.allClear}
		<p class="checklist__empty">
			<AllClear size={16} aria-hidden="true" />
			Nothing outstanding. Everything on your checklist is done.
		</p>
	{/if}

</div>

<style>
	.checklist {
		display: grid;
		gap: var(--je-space-4);
	}

	.checklist__head {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.checklist__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
	}

	.checklist__count {
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
	}

	.checklist__filter {
		margin-inline-start: auto;
	}

	.checklist__list {
		display: grid;
		gap: var(--je-space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.task {
		display: grid;
		gap: var(--je-space-2);
		padding: var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.task__head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.task__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.task__due,
	.task__state-note {
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		max-inline-size: 62ch;
	}

	.task__versions {
		display: grid;
		gap: var(--je-space-1);
		margin: 0;
		padding: var(--je-space-2) var(--je-space-3);
		list-style: none;
		background: var(--je-color-surface-sunken);
		border-radius: var(--je-radius-md);
	}

	.task__version {
		display: grid;
		gap: 0.1rem;
	}

	.task__file-name {
		font-size: var(--je-font-size-sm);
		overflow-wrap: anywhere;
	}

	.task__file-meta {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.task__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-1);
	}

	/* The reason sits under the control it belongs to, on its own line, so the
	   two are read together rather than found separately. */
	.task__reason {
		flex-basis: 100%;
	}

	/* The control is the label; the input stays reachable so the keyboard and a
	   screen reader get the same affordance the pointer does. */
	.task__file:focus-visible + .task__upload {
		box-shadow: var(--je-focus-ring);
	}

	.task__upload {
		cursor: pointer;
	}

	/* Calm is not a success event: the all-clear mark stays on the ink ladder
	   rather than arriving as a green celebration. */
	.checklist__empty {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		margin: 0;
		color: var(--je-color-text-muted);
	}

</style>
