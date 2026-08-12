<script lang="ts">
	import { onMount } from 'svelte';
	import { ChevronDown } from 'lucide-svelte';
	import { CopyValue, Field, Modal, statusIcon, trackPending } from '$lib/ui';
	import type { IconComponent } from '$lib/ui';
	import ReviewSurface, {
		includedCount,
		templateDoor
	} from '$lib/features/workspace/components/ReviewSurface.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { applyParams, clearParams, paramFlag } from '$lib/features/workspace/url-state.svelte';
	import { useWorkspaceGateway } from '$lib/api/workspace-gateway';
	import type {
		EmailReadiness,
		MessageTemplate,
		OutboxMessage,
		OutboxState,
		ReadinessState
	} from '$lib/api/types';

	const { api } = useWorkspaceGateway();

	let messages = $state<OutboxMessage[] | null>(null);
	let readiness = $state<EmailReadiness | null>(null);
	/** Stored templates, read once: the compose select and the review door share them. */
	let templates = $state<MessageTemplate[] | null>(null);
	let expandedId = $state<string | null>(null);
	let busy = $state(false);

	let reviewId = $state<string | null>(null);
	let reviewOpen = $state(false);
	let reviewSubject = $state('');
	/** Announced politely after a send; the outbox row carries the visible result. */
	let sendNotice = $state('');

	let composeOpen = $state(false);
	let composeSubject = $state('');
	let composeAudience = $state('Confirmed speakers');
	/** Empty string is the blank start; otherwise the chosen template's id. */
	let composeTemplateId = $state('');

	/** Subjects rewritten while reviewing, kept against the row they belong to. */
	let subjectEdits = $state<Record<string, string>>({});

	const audiences = [
		{ label: 'Confirmed speakers', count: 18 },
		{ label: 'Reviewers', count: 6 },
		{ label: 'Accepted, un-notified', count: 12 }
	];

	const stateBadge: Record<
		OutboxState,
		{ label: string; tone: string; solid?: boolean; icon: IconComponent }
	> = {
		draft: { label: 'Draft', tone: 'neutral', icon: statusIcon.draft },
		scheduled: { label: 'Scheduled', tone: 'info', icon: statusIcon.scheduled },
		sending: { label: 'Sending', tone: 'info', icon: statusIcon.sending },
		sent: { label: 'Sent', tone: 'success', icon: statusIcon.sent },
		held: { label: 'Held', tone: 'warning', solid: true, icon: statusIcon.held }
	};

	const readinessBadge: Record<
		ReadinessState,
		{ label: string; tone: string; solid: boolean; icon: IconComponent } | null
	> = {
		ready: { label: 'Ready', tone: 'success', solid: false, icon: statusIcon.ready },
		action_required: {
			label: 'Action required',
			tone: 'warning',
			solid: true,
			icon: statusIcon.actionRequired
		},
		unknown: { label: 'Not checked', tone: 'neutral', solid: false, icon: statusIcon.notChecked },
		not_applicable: null
	};

	function rows(list: OutboxMessage[]): OutboxMessage[] {
		return list.map((message) => ({
			...message,
			subject: subjectEdits[message.id] ?? message.subject,
			bounces: message.bounces.map((bounce) => ({ ...bounce }))
		}));
	}

	// A send or a new draft re-reads the outbox, which can move a row between the
	// two groups. The rows a person is reading stay put and dim until the
	// replacement lands; the skeletons below are for the first load only.
	let refreshing = $state(false);
	const reload = trackPending(() => refreshing);

	async function load() {
		refreshing = true;
		try {
			const [outbox, delivery] = await Promise.all([
				api.messages.outbox(),
				api.messages.readiness()
			]);
			messages = rows(outbox);
			readiness = delivery;
		} finally {
			refreshing = false;
		}
	}

	onMount(() => {
		void load();
		void api.templates.list().then((list) => (templates = list.messages));
	});

	const checks = $derived(
		readiness
			? [
					{ key: 'outbound', label: 'Outbound sending', state: readiness.outbound },
					// Same name as the send review's row: one capability, one label.
					{ key: 'callbacks', label: 'Delivery reports', state: readiness.callbacks },
					{ key: 'inbound', label: 'Inbound replies', state: readiness.inbound }
				]
			: []
	);
	const setupNeeded = $derived(checks.some((check) => check.state === 'action_required'));

	/** A held send is queued evidence waiting on setup, so it groups with the work. */
	function waiting(message: OutboxMessage): boolean {
		return message.state === 'draft' || message.state === 'held' || message.bouncedCount > 0;
	}

	const needsAttention = $derived((messages ?? []).filter(waiting));
	const settled = $derived((messages ?? []).filter((message) => !waiting(message)));

	const reviewMessage = $derived(messages?.find((message) => message.id === reviewId) ?? null);
	const reviewCount = $derived(
		reviewMessage?.review ? includedCount(reviewMessage.review) : (reviewMessage?.audienceCount ?? 0)
	);
	const composeChoice = $derived(audiences.find((entry) => entry.label === composeAudience) ?? audiences[0]);
	const composeTemplate = $derived(
		templates?.find((template) => template.id === composeTemplateId) ?? null
	);
	// The one door on the review surface: its template fact links to the stored
	// template when the label maps to one (see `templateDoor`).
	const reviewDoor = $derived(templateDoor(reviewMessage?.review?.templateLabel, templates));

	function plural(count: number, singular: string, many = `${singular}s`) {
		return `${count} ${count === 1 ? singular : many}`;
	}

	function audienceLine(message: OutboxMessage) {
		return [message.audience, plural(message.audienceCount, 'recipient'), message.sentAt]
			.filter(Boolean)
			.join(' · ');
	}

	function openReview(message: OutboxMessage) {
		reviewId = message.id;
		reviewSubject = message.subject;
		sendNotice = '';
		reviewOpen = true;
	}

	/**
	 * Sending closes the dialog either way: an accepted send lands as a sent row,
	 * a refused one lands as a held row carrying its reason. The row is the
	 * evidence, so nothing is dismissed by acknowledging a message here.
	 */
	async function send() {
		const id = reviewId;
		if (!id || busy) return;
		const count = reviewCount;
		busy = true;
		subjectEdits = { ...subjectEdits, [id]: reviewSubject };
		messages =
			messages?.map((message) =>
				message.id === id ? { ...message, subject: reviewSubject, state: 'sending' } : message
			) ?? null;
		const outcome = await api.messages.send(id);
		await load();
		if (outcome.ok) {
			// The receipt is the visible acknowledgement and announces itself, so
			// the sr-only line stays for the refusal case only.
			sendNotice = '';
			recordAction({
				area: 'messages',
				label: `Sent “${reviewSubject}” to ${plural(count, 'recipient')}`,
				notUndoableReason: 'Email cannot be recalled after the provider accepts it.'
			});
		} else {
			sendNotice = `“${reviewSubject}” is held: ${outcome.reason}`;
		}
		busy = false;
		reviewOpen = false;
		reviewId = null;
	}

	// A link may open the compose dialog — `/app/messages?compose=1` — because a
	// GET may open a surface. The send stays a separate, deliberate command.
	const composeAsked = $derived(paramFlag('compose'));
	let composeHonoured = false;

	$effect(() => {
		if (!composeAsked) {
			composeHonoured = false;
			return;
		}
		if (composeHonoured) return;
		composeHonoured = true;
		openCompose();
	});

	// Closing the dialog leaves a clean address behind, so a reload does not
	// reopen a dialog the operator already dismissed.
	$effect(() => {
		if (!composeOpen && composeAsked && composeHonoured) void clearParams(['compose']);
	});

	function openCompose() {
		composeSubject = '';
		composeAudience = audiences[0].label;
		composeTemplateId = '';
		composeOpen = true;
	}

	/**
	 * The chosen template feeds the subject's default. A subject the operator
	 * already rewrote is theirs and stays; only an empty subject or the previous
	 * template's untouched default is replaced.
	 */
	function pickComposeTemplate(nextId: string) {
		const previousDefault = composeTemplate?.subject ?? '';
		composeTemplateId = nextId;
		const next = templates?.find((template) => template.id === nextId);
		if (composeSubject.trim() === '' || composeSubject === previousDefault) {
			composeSubject = next?.subject ?? '';
		}
	}

	async function createDraft() {
		const subject = composeSubject.trim();
		if (!subject || busy) return;
		busy = true;
		await api.messages.compose(subject, composeChoice.label, composeChoice.count);
		await load();
		busy = false;
		composeOpen = false;
	}
</script>

{#snippet outboxHead()}
	<header class="card__head">
		<h2 class="card__title">Outbox</h2>
		<button
			type="button"
			class="ui-button ui-button--primary ui-button--sm card__action"
			onclick={() => applyParams({ compose: '1' })}>
			Compose
		</button>
	</header>
{/snippet}

{#snippet messageRow(message: OutboxMessage)}
	{@const badge = stateBadge[message.state]}
	{@const open = expandedId === message.id}
	<li class="row" class:row--open={open}>
		<span class="ui-badge ui-badge--{badge.tone} row__state" class:ui-badge--solid={badge.solid}>
			{#if message.state === 'sending'}
				<span class="ui-spinner" aria-hidden="true"></span>
			{:else}
				{@const State = badge.icon}
				<State class="ui-badge__icon" aria-hidden="true" />
			{/if}
			{badge.label}
		</span>
		<div class="row__copy">
			<p class="row__subject">{message.subject}</p>
			<p class="row__audience">{audienceLine(message)}</p>
			{#if message.state === 'held' && message.heldReason}
				<p class="row__held">{message.heldReason}</p>
			{/if}
		</div>
		{#if message.state === 'sent'}
			<p class="row__metrics">
				<span>{message.deliveredCount} delivered</span>
				{#if message.bouncedCount > 0}
					<span class="row__bounced">{message.bouncedCount} bounced</span>
				{/if}
			</p>
		{/if}
		<div class="row__actions">
			{#if message.state === 'draft'}
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm"
					disabled={busy}
					onclick={() => openReview(message)}>
					Review &amp; send
				</button>
			{/if}
			{#if message.bounces.length > 0}
				<button
					type="button"
					class="ui-button ui-button--ghost ui-button--icon ui-button--sm row__expand"
					class:row__expand--open={open}
					aria-expanded={open}
					aria-controls={`bounces-${message.id}`}
					aria-label={`Bounces for “${message.subject}”`}
					onclick={() => (expandedId = open ? null : message.id)}>
					<ChevronDown size={15} />
				</button>
			{/if}
		</div>
		{#if open}
			<div class="bounces" id={`bounces-${message.id}`}>
				<h4 class="bounces__title">{plural(message.bounces.length, 'address', 'addresses')} to fix</h4>
				<ul class="bounces__list">
					{#each message.bounces as bounce (bounce.email)}
						<li class="bounce">
							<div class="bounce__copy">
								<p class="bounce__email"><CopyValue value={bounce.email} label="bounced address" /></p>
								<p class="bounce__reason">{bounce.reason}</p>
							</div>
							<button
								type="button"
								class="ui-button ui-button--secondary ui-button--sm"
								aria-label={`Edit address for ${bounce.email}`}>
								Edit address
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</li>
{/snippet}

{#snippet outbox()}
	<section
		class="card"
		class:is-refreshing={reload.visible}
		aria-busy={refreshing || undefined}
		aria-label="Outbox">
		{@render outboxHead()}
		<p class="ui-sr-only" role="status">{sendNotice}</p>
		{#if (messages ?? []).length === 0}
			<div class="empty">
				<p class="empty__title">Nothing sent yet.</p>
				<p class="empty__hint">
					Compose above for a one-off message. Decisions, task deadlines, and agent runs drop their
					drafts here too — every one waits for your review before it sends.
				</p>
			</div>
		{:else}
			{#if needsAttention.length > 0}
				<div class="group">
					<h3 class="group__title">Needs attention <span class="group__count">{needsAttention.length}</span></h3>
					<ul class="rows">
						{#each needsAttention as message (message.id)}
							{@render messageRow(message)}
						{/each}
					</ul>
				</div>
			{/if}
			{#if settled.length > 0}
				<div class="group">
					<h3 class="group__title">Everything else <span class="group__count">{settled.length}</span></h3>
					<ul class="rows">
						{#each settled as message (message.id)}
							{@render messageRow(message)}
						{/each}
					</ul>
				</div>
			{/if}
		{/if}
	</section>
{/snippet}

{#snippet delivery()}
	<section
		class="card"
		class:card--attention={setupNeeded}
		class:is-refreshing={reload.visible}
		aria-busy={refreshing || undefined}
		aria-label="Email delivery">
		<header class="card__head">
			<h2 class="card__title">Email delivery</h2>
			<span class="card__meta">via {readiness?.provider}</span>
		</header>
		{#if setupNeeded}
			<p class="card__note">
				Messages stay drafted until setup finishes — nothing is dropped in the meantime.
			</p>
		{/if}
		<ul class="checks">
			{#each checks as check (check.key)}
				{@const badge = readinessBadge[check.state]}
				<li class="check" class:check--action={check.state === 'action_required'}>
					<span class="check__label">{check.label}</span>
					{#if badge}
						{@const Readiness = badge.icon}
						<span class="ui-badge ui-badge--{badge.tone} check__state" class:ui-badge--solid={badge.solid}>
							<Readiness class="ui-badge__icon" aria-hidden="true" />
							{badge.label}
						</span>
					{:else}
						<span class="check__quiet">Not set up</span>
					{/if}
					{#if check.state === 'action_required'}
						<button
							type="button"
							class="ui-button ui-button--secondary ui-button--sm check__action"
							aria-label={`Continue setup for ${check.label.toLowerCase()}`}>
							Continue setup
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/snippet}

{#if !messages || !readiness}
	<section class="card" aria-label="Outbox">
		{@render outboxHead()}
		<!-- The outbox's own composition with skeleton fills: grouped rows, each
		     holding its state chip, its two lines, and its action. -->
		<div aria-hidden="true">
			{#each Array(2) as _, group (group)}
				<div class="group">
					<p class="group__title sk-head"><span class="ui-skeleton skeleton-line" style="inline-size: 7rem"></span></p>
					<ul class="rows">
						{#each Array(2) as _, index (index)}
							<li class="row">
								<span class="ui-skeleton skeleton-chip row__state"></span>
								<div class="row__copy">
									<p class="row__subject"><span class="ui-skeleton skeleton-line" style="inline-size: min(18rem, 100%)"></span></p>
									<p class="row__audience"><span class="ui-skeleton skeleton-line" style="inline-size: min(13rem, 100%)"></span></p>
								</div>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	</section>
	<section class="card" aria-label="Email delivery">
		<header class="card__head">
			<h2 class="card__title">Email delivery</h2>
			<span class="card__meta"><span class="ui-skeleton skeleton-line" style="inline-size: 4.5rem"></span></span>
		</header>
		<ul class="checks" aria-hidden="true">
			{#each Array(3) as _, index (index)}
				<li class="check">
					<span class="check__label"><span class="ui-skeleton skeleton-line" style="inline-size: 10rem"></span></span>
					<span class="ui-skeleton skeleton-chip check__state"></span>
				</li>
			{/each}
		</ul>
	</section>
{:else if setupNeeded}
	{@render delivery()}
	{@render outbox()}
{:else}
	{@render outbox()}
	{@render delivery()}
{/if}

<CommitReceipt onUndone={load} />

{#snippet subjectField()}
	<Field id="review-subject" label="Subject" description="The line every recipient sees first.">
		{#snippet children({ id, describedBy })}
			<input class="ui-control" type="text" {id} aria-describedby={describedBy} bind:value={reviewSubject} />
		{/snippet}
	</Field>
{/snippet}

<Modal bind:open={reviewOpen} title="Review &amp; send">
	{#if reviewMessage?.review}
		<ReviewSurface
			review={reviewMessage.review}
			{readiness}
			subject={subjectField}
			templateDoor={reviewDoor} />
		<p class="note note--spaced">
			This draft has not left the outbox. Sending is the deliberate step: delivery starts the moment
			you press send and cannot be recalled.
		</p>
	{:else if reviewMessage}
		<div class="form">
			{@render subjectField()}
			<div class="pair">
				<span class="pair__label">Audience</span>
				<span class="pair__value"
					>{reviewMessage.audience} · {plural(reviewMessage.audienceCount, 'recipient')}</span>
			</div>
			<div class="pair">
				<span class="pair__label">Provider readiness</span>
				<span class="pair__value states">
					{#each checks.slice(0, 2) as check (check.key)}
						{@const badge = readinessBadge[check.state]}
						<span class="state">
							{check.label}
							{#if badge}
								{@const Readiness = badge.icon}
								<span class="ui-badge ui-badge--{badge.tone}" class:ui-badge--solid={badge.solid}>
									<Readiness class="ui-badge__icon" aria-hidden="true" />
									{badge.label}
								</span>
							{:else}
								{@const NotConfigured = statusIcon.notConfigured}
								<span class="ui-badge ui-badge--neutral"
									><NotConfigured class="ui-badge__icon" aria-hidden="true" />Not set up</span
								>
							{/if}
						</span>
					{/each}
				</span>
			</div>
			<div class="preview">
				<p class="preview__label">Per-recipient preview</p>
				<p class="preview__subject">{reviewSubject || 'No subject yet'}</p>
				<p class="preview__body">
					Each recipient's own copy renders here, with their name and merge fields resolved, before
					anything leaves.
				</p>
			</div>
			<p class="note">
				This draft has not left the outbox. Sending is the deliberate step: delivery starts the moment
				you press send and cannot be recalled.
			</p>
		</div>
	{/if}
	{#snippet footer(close)}
		<button type="button" class="ui-button ui-button--ghost" disabled={busy} onclick={close}>Cancel</button>
		<button
			type="button"
			class="ui-button ui-button--primary"
			disabled={busy || !reviewSubject.trim()}
			aria-busy={busy || undefined}
			onclick={send}>
			{#if busy}<span class="ui-spinner" aria-hidden="true"></span>{/if}
			Send {plural(reviewCount, 'email')}
		</button>
	{/snippet}
</Modal>

<Modal bind:open={composeOpen} title="Compose message">
	<div class="form">
		<Field
			id="compose-template"
			label="Template"
			description="Starts the subject from the template; the subject stays editable.">
			{#snippet children({ id, describedBy })}
				<div class="tpl">
					<select
						class="ui-select tpl__select"
						{id}
						aria-describedby={describedBy}
						value={composeTemplateId}
						onchange={(event) => pickComposeTemplate(event.currentTarget.value)}>
						<option value="">Start blank</option>
						{#each templates ?? [] as template (template.id)}
							<option value={template.id}>{template.name}</option>
						{/each}
					</select>
					{#if composeTemplate}
						<!-- One fact, one door: the chosen template links to its editor. -->
						<a
							class="tpl__edit"
							href={`/app/templates?template=${composeTemplate.id}`}
							aria-label={`Edit template — ${composeTemplate.name}`}>
							Edit template
						</a>
					{/if}
				</div>
			{/snippet}
		</Field>
		<Field id="compose-subject" label="Subject" required>
			{#snippet children({ id, describedBy, invalid })}
				<input
					class="ui-control"
					type="text"
					{id}
					aria-describedby={describedBy}
					aria-invalid={invalid}
					placeholder="Travel and arrival details"
					bind:value={composeSubject} />
			{/snippet}
		</Field>
		<Field id="compose-audience" label="Audience" description="Counted from the current roster.">
			{#snippet children({ id, describedBy })}
				<select class="ui-select" {id} aria-describedby={describedBy} bind:value={composeAudience}>
					{#each audiences as audience (audience.label)}
						<option value={audience.label}>{audience.label} · {audience.count}</option>
					{/each}
				</select>
			{/snippet}
		</Field>
		<p class="note">
			This creates a draft in the outbox for {plural(composeChoice.count, 'recipient')}. Nothing sends
			until you review it.
		</p>
	</div>
	{#snippet footer(close)}
		<button type="button" class="ui-button ui-button--ghost" disabled={busy} onclick={close}>Cancel</button>
		<button
			type="button"
			class="ui-button ui-button--primary"
			disabled={busy || !composeSubject.trim()}
			aria-busy={busy || undefined}
			onclick={createDraft}>
			{#if busy}<span class="ui-spinner" aria-hidden="true"></span>{/if}
			Create draft
		</button>
	{/snippet}
</Modal>

<style>
	.card {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	/* Emphasis ring rather than a wash: this card sits against dense rows. */
	.card--attention {
		border: 2px solid var(--je-color-warning-fill);
		padding: calc(var(--je-space-4) - 1px);
	}

	.card__head {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-block-size: var(--je-control-height-sm);
		margin-block-end: var(--je-space-3);
	}

	.card__title {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.card__meta {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.card__action {
		margin-inline-start: auto;
	}

	.card__note {
		margin: 0 0 var(--je-space-3);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* A reload dims only the records being replaced; the card heading and the
	   Compose action stay live so the card never reads as frozen. */
	.card.is-refreshing .rows,
	.card.is-refreshing .checks,
	.card.is-refreshing .empty {
		opacity: 0.55;
		pointer-events: none;
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	.group + .group {
		margin-block-start: var(--je-space-6);
	}

	.group__title {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-2);
		margin: 0 0 var(--je-space-1);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.group__count {
		font-variant-numeric: tabular-nums;
		font-weight: 400;
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.row {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) max-content max-content;
		grid-template-areas: 'state copy metrics actions';
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
		padding-block: var(--je-space-3);
	}

	.row--open {
		grid-template-areas:
			'state copy metrics actions'
			'detail detail detail detail';
	}

	.row + .row {
		border-block-start: 1px solid var(--je-color-border);
	}

	.row__state {
		grid-area: state;
	}

	.row__copy {
		grid-area: copy;
		min-width: 0;
	}

	.row__subject {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.row__audience {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* A held send is queued, not failed: the reason states the remedy in the
	   attention tone and stays on the row until setup releases it. */
	.row__held {
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-warning);
	}

	.row__metrics {
		grid-area: metrics;
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--je-space-1) var(--je-space-2);
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-muted);
	}

	.row__bounced {
		color: var(--je-color-danger);
		font-weight: 600;
	}

	.row__actions {
		grid-area: actions;
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
	}

	.row__expand :global(svg) {
		transition: rotate var(--je-duration-fast) var(--je-ease);
	}

	.row__expand--open :global(svg) {
		rotate: 180deg;
	}

	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, a chip is badge-height, an action
	   is control-height. Free-standing sized rectangles drift; these cannot. */
	/* A heading's line box without the heading element: the placeholder keeps
	   the leading its resolved heading is given. */
	.sk-head {
		line-height: var(--je-leading-tight);
	}

	.skeleton-line {
		display: inline-block;
		block-size: 1em;
		/* One line box exactly: the line inherits the height it stands in for. */
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.skeleton-chip {
		display: inline-block;
		block-size: 1.35rem;
		inline-size: 4.5rem;
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 7.5rem;
		border-radius: var(--je-radius-control);
	}

	/* An inset disclosure belongs to the row that opened it: the sunken surface
	   plus its own boundary, so it reads as part of the card rather than a gap
	   cut through it. */
	.bounces {
		grid-area: detail;
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
	}

	.bounces__title {
		margin: 0 0 var(--je-space-1);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.bounces__list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.bounce {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
		padding-block: var(--je-space-2);
	}

	.bounce + .bounce {
		border-block-start: 1px solid var(--je-color-border);
	}

	.bounce__copy {
		min-width: 0;
	}

	.bounce__email {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.bounce__reason {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.empty {
		padding: var(--je-space-8) var(--je-space-4);
		text-align: center;
	}

	.empty__title {
		margin: 0;
		font-weight: 600;
	}

	.empty__hint {
		margin: var(--je-space-1) auto 0;
		max-inline-size: 34rem;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* Capped so a state stays visually attached to the row it reports on. */
	.checks {
		list-style: none;
		margin: 0;
		padding: 0;
		max-inline-size: 40rem;
	}

	.check {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content max-content;
		grid-template-areas: 'label state action';
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
		padding-block: var(--je-space-2);
		min-block-size: 2.35rem;
	}

	.check + .check {
		border-block-start: 1px solid var(--je-color-border);
	}

	.check__label {
		grid-area: label;
		font-size: var(--je-font-size-md);
	}

	.check__state {
		grid-area: state;
	}

	.check__quiet {
		grid-area: state;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.check__action {
		grid-area: action;
	}


	/* Dialogs */
	.form {
		display: grid;
		gap: var(--je-space-4);
	}

	.tpl {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
	}

	.tpl__select {
		flex: 1 1 auto;
		min-inline-size: 0;
	}

	.tpl__edit {
		flex: none;
		font-size: var(--je-font-size-sm);
	}

	.pair {
		display: grid;
		gap: 0.375rem;
	}

	.pair__label {
		font-size: var(--je-font-size-sm);
		font-weight: 650;
	}

	.pair__value {
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.states {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-3);
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		font-size: var(--je-font-size-sm);
	}

	.preview {
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
	}

	.preview__label {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.preview__subject {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.preview__body {
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.note {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.note--spaced {
		margin-block-start: var(--je-space-4);
	}

	/* Narrow widths restructure: the state and its counts share the first line,
	   the copy owns the second, and actions get their own line. */
	@media (max-width: 920px) {
		.row {
			grid-template-columns: max-content minmax(0, 1fr);
			grid-template-areas:
				'state metrics'
				'copy copy'
				'actions actions';
			align-items: start;
		}

		.row--open {
			grid-template-areas:
				'state metrics'
				'copy copy'
				'actions actions'
				'detail detail';
		}

		.row__actions:empty {
			display: none;
		}

		.check {
			grid-template-columns: minmax(0, 1fr) max-content;
			grid-template-areas: 'label state';
		}

		.check--action {
			grid-template-areas:
				'label state'
				'action action';
		}

		.check__action {
			justify-self: start;
		}

		.bounce {
			grid-template-columns: minmax(0, 1fr);
			justify-items: start;
		}
	}
</style>
