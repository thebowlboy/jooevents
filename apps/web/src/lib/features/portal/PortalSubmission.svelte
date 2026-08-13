<script lang="ts">
	/**
	 * One submission, as the person who wrote it sees it.
	 *
	 * The record is the spine: what they said, when it arrived, and what has
	 * happened to it since. Corrections are allowed while the call is open, and
	 * they are corrections — the questions stay fixed to the form version this
	 * was sent against, so an answer can be fixed without the record quietly
	 * becoming a different one.
	 *
	 * The decision shown here is the decision they were told. There is no state
	 * on this page the organizers have not communicated.
	 */
	import { ArrowLeft } from 'lucide-svelte';
	import { Badge, PENDING_MIN_VISIBLE_MS, trackPending } from '$lib/ui';
	import type { PortalAnswerView } from '$lib/api/portal/view-models';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { applyParams, paramFlag } from '$lib/features/workspace/url-state.svelte';
	import { editLockCopy, refusalCopy, submissionStatusCopy } from './copy';
	import { formatDay, formatInstant } from './format';
	import { engagementForSubmission, tasksForSession } from './home-actions';
	import { usePortalStore } from './store.svelte';
	import AnswerList from './components/AnswerList.svelte';
	import AppealPanel from './components/AppealPanel.svelte';
	import EngagementPanel from './components/EngagementPanel.svelte';
	import RefusalNote from './components/RefusalNote.svelte';
	import StateBadge from './components/StateBadge.svelte';
	import TaskChecklist from './components/TaskChecklist.svelte';
	import TimelineList from './components/TimelineList.svelte';

	let { id }: { id: string } = $props();

	const store = usePortalStore();

	const snapshot = $derived(store.snapshot);
	const submission = $derived(snapshot?.submissions.find((candidate) => candidate.id === id) ?? null);
	const timezone = $derived(snapshot?.event.timezone ?? 'UTC');
	const engagement = $derived(
		snapshot && submission ? engagementForSubmission(snapshot, submission.id) : null
	);
	const sessionTasks = $derived(
		snapshot && engagement ? tasksForSession(snapshot, engagement.sessionId) : []
	);
	const waiting = trackPending(() => store.snapshot === null && !store.failed, {
		minVisibleMs: PENDING_MIN_VISIBLE_MS
	});

	const editable = $derived(submission?.editability.kind === 'open');
	const editing = $derived(paramFlag('edit') && editable);
	const withdrawable = $derived(
		submission?.status === 'submitted' || submission?.status === 'in_review'
	);

	let draft = $state<Record<string, string> | null>(null);
	let saving = $state(false);
	let withdrawArmed = $state(false);
	let withdrawing = $state(false);
	let refusal = $state('');

	function seed(answers: readonly PortalAnswerView[]): Record<string, string> {
		return Object.fromEntries(answers.map((answer) => [answer.fieldId, answer.value]));
	}

	// A deep link can arrive already asking to edit, so the draft is seeded from
	// whichever route opened it rather than only from the button.
	$effect(() => {
		if (editing && draft === null && submission) draft = seed(submission.answers);
		if (!editing && draft !== null) draft = null;
	});

	async function startEdit() {
		if (submission) draft = seed(submission.answers);
		await applyParams({ edit: '1' });
	}

	async function cancelEdit() {
		await applyParams({ edit: null });
	}

	/**
	 * A correction is a small commit: it happens in place, it says what it did,
	 * and it hands back the compensating change that puts the previous words
	 * back — the same operation, run with what was there before.
	 */
	async function save() {
		if (!submission || !draft || saving) return;
		const previous = submission.answers.map((answer) => ({
			fieldId: answer.fieldId,
			value: answer.value
		}));
		const next = Object.entries(draft).map(([fieldId, value]) => ({ fieldId, value }));
		saving = true;
		refusal = '';
		const outcome = await store.api.editAnswers({ submissionId: submission.id, answers: next });
		saving = false;
		if (!outcome.ok) {
			refusal = refusalCopy[outcome.reason];
			return;
		}
		const title = submission.title;
		recordAction({
			label: `Saved your changes to “${title}”`,
			area: 'Portal',
			undo: async () => {
				await store.api.editAnswers({ submissionId: id, answers: previous });
				await store.reload();
			}
		});
		await applyParams({ edit: null });
		await store.reload();
	}

	async function withdraw() {
		if (!submission || withdrawing) return;
		withdrawing = true;
		refusal = '';
		const outcome = await store.api.withdrawSubmission(submission.id);
		withdrawing = false;
		withdrawArmed = false;
		if (!outcome.ok) {
			refusal = refusalCopy[outcome.reason];
			return;
		}
		recordAction({
			label: `Withdrew “${submission.title}”`,
			area: 'Portal',
			notUndoableReason: 'The organizers have been told. Email them if this was a mistake.'
		});
		await store.reload();
	}
</script>

<div class="detail" class:detail--reloading={store.reloading} aria-busy={store.reloading || undefined}>
	<a class="back" href="/portal">
		<ArrowLeft size={14} aria-hidden="true" />What you sent
	</a>

	{#if submission}
		{@const status = submissionStatusCopy[submission.status]}
		<header class="head">
			<h1 class="head__title">{submission.title}</h1>
			<div class="head__states">
				<StateBadge state={status} />
				{#if submission.late}<Badge tone="neutral">Sent late</Badge>{/if}
			</div>
			<p class="head__meaning">
				{status.meaning}
				{#if submission.statusNotifiedAt}
					You were told on {formatInstant(submission.statusNotifiedAt, timezone)}.
				{/if}
			</p>
			{#if submission.target.kind === 'collecting_session'}
				<p class="head__line">You sent this for <strong>{submission.target.name}</strong>.</p>
			{/if}
			{#if submission.sharedAuthority}
				<p class="head__line">
					With {submission.speakers
						.filter((speaker) => !speaker.isYou)
						.map((speaker) => speaker.displayName)
						.join(', ')}. Any of you can change or withdraw this, and the others are told.
				</p>
			{/if}
		</header>

		<section class="block" aria-labelledby="record-heading">
			<div class="block__head">
				<h2 class="block__title" id="record-heading">Your answers</h2>
				{#if editable && !editing}
					<button type="button" class="ui-button ui-button--secondary ui-button--sm" onclick={startEdit}>
						Correct an answer
					</button>
				{/if}
			</div>
			<p class="block__note">
				Sent {formatDay(submission.submittedAt, timezone)}. The questions are the ones you answered
				and do not change; only your answers can be corrected.
				{#if submission.editability.kind === 'open'}
					You can correct them until {formatInstant(submission.editability.closesAt, timezone)}.
				{/if}
			</p>

			{#if submission.editability.kind === 'locked'}
				<RefusalNote message={editLockCopy(submission.editability)} />
			{/if}

			<AnswerList
				answers={submission.answers}
				draft={editing ? draft : null}
				busy={saving}
				onedit={(fieldId, value) => {
					if (draft) draft = { ...draft, [fieldId]: value };
				}} />

			{#if editing}
				<div class="block__actions">
					<button
						type="button"
						class="ui-button ui-button--primary"
						disabled={saving}
						aria-busy={saving || undefined}
						onclick={save}>
						{saving ? 'Saving…' : 'Save these changes'}
					</button>
					<button type="button" class="ui-button ui-button--ghost" disabled={saving} onclick={cancelEdit}>
						Cancel
					</button>
				</div>
			{/if}

			{#if refusal}
				<RefusalNote message={refusal} tone="refused" />
			{/if}
		</section>

		{#if engagement}
			<section class="block" aria-labelledby="engagement-heading">
				<h2 class="block__title" id="engagement-heading">Your session</h2>
				<EngagementPanel {engagement} />
			</section>
		{/if}

		{#if sessionTasks.length > 0}
			<section class="block">
				<TaskChecklist tasks={sessionTasks} files={snapshot?.files ?? []} filterable={false} />
			</section>
		{/if}

		{#if submission.status === 'declined'}
			<AppealPanel {submission} />
		{/if}

		<section class="block" aria-labelledby="history-heading">
			<h2 class="block__title" id="history-heading">What has happened</h2>
			<TimelineList events={submission.timeline} {timezone} />
		</section>

		{#if withdrawable}
			<section class="block block--quiet" aria-labelledby="withdraw-heading">
				<h2 class="block__title block__title--sm" id="withdraw-heading">Withdraw this</h2>
				<p class="block__note">
					Withdrawing takes it out of consideration and tells the organizers. It stays on your list
					as a record of what you sent.
				</p>
				{#if withdrawArmed}
					<div class="block__actions" role="group" aria-label="Withdraw this submission?">
						<button
							type="button"
							class="ui-button ui-button--danger"
							disabled={withdrawing}
							aria-busy={withdrawing || undefined}
							onclick={withdraw}>
							{withdrawing ? 'Withdrawing…' : 'Yes, withdraw it'}
						</button>
						<button
							type="button"
							class="ui-button ui-button--ghost"
							disabled={withdrawing}
							onclick={() => (withdrawArmed = false)}>
							Keep it in
						</button>
					</div>
				{:else}
					<div class="block__actions">
						<button
							type="button"
							class="ui-button ui-button--secondary"
							onclick={() => (withdrawArmed = true)}>
							Withdraw
						</button>
					</div>
				{/if}
			</section>
		{/if}
	{:else if snapshot}
		<section class="missing">
			<h1 class="head__title">We could not find that submission</h1>
			<p class="block__note">
				It may belong to another event, or the address may be incomplete. Your portal lists what
				you sent to this event.
			</p>
			<a class="ui-button ui-button--primary" href="/portal">Back to your portal</a>
		</section>
	{:else}
		<!-- The same composition, holding the same space, with fills where the
		     record's own words will be. -->
		<div class="head">
			{#if waiting.visible}
				<div class="head__title" aria-hidden="true"><span class="ui-skeleton head__fill"></span></div>
				<p class="head__meaning" aria-hidden="true"><span class="ui-skeleton head__fill head__fill--line"></span></p>
			{/if}
		</div>
		{#if waiting.phase === 'slow'}
			<p class="ui-sr-only" role="status">Loading this submission.</p>
		{/if}
	{/if}
</div>

<style>
	.detail {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-8);
		min-block-size: 28rem;
		transition: opacity var(--je-duration-normal) var(--je-ease);
	}

	.detail--reloading {
		opacity: 0.62;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		align-self: start;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		text-decoration: none;
	}

	.back:hover {
		color: var(--je-color-text);
		text-decoration: underline;
	}

	.head {
		display: grid;
		gap: var(--je-space-2);
	}

	.head__title {
		margin: 0;
		font-size: var(--je-font-size-2xl);
		line-height: var(--je-leading-tight);
		max-inline-size: 30ch;
	}

	.head__states {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.head__meaning,
	.head__line {
		margin: 0;
		max-inline-size: 62ch;
		color: var(--je-color-text-muted);
		line-height: var(--je-leading-normal);
	}

	.head__fill {
		display: inline-block;
		block-size: 1lh;
		inline-size: min(24rem, 85%);
		vertical-align: bottom;
	}

	.head__fill--line {
		inline-size: min(32rem, 95%);
	}

	.block {
		display: grid;
		gap: var(--je-space-3);
	}

	.block--quiet {
		padding-block-start: var(--je-space-5);
		border-block-start: 1px solid var(--je-color-border);
	}

	.block__head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-3);
	}

	.block__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
	}

	.block__title--sm {
		font-size: var(--je-font-size-md);
	}

	.block__head .block__title {
		margin-inline-end: auto;
	}

	.block__note {
		margin: 0;
		max-inline-size: 62ch;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
	}

	.block__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.missing {
		display: grid;
		justify-items: start;
		gap: var(--je-space-3);
		min-block-size: 20rem;
		align-content: center;
	}
</style>
