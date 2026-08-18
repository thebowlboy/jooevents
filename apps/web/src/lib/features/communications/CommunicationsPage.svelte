<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ChevronDown, X } from 'lucide-svelte';
	import { CopyValue, Field, Modal, revealTarget, statusIcon, trackPending } from '$lib/ui';
	import type { IconComponent } from '$lib/ui';
	import ReviewSurface, {
		includedCount,
		templateDoor
	} from '$lib/features/workspace/components/ReviewSurface.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { applyParams, clearParams, param, paramFlag } from '$lib/features/workspace/url-state.svelte';
	import { destinationLabel } from '$lib/features/workspace/navigation';
	import type { CommunicationsPagePort } from '$lib/api/communications-page-port';
	import { LiveRead, type LiveReadState } from '$lib/api/live-read';
	import RecipientEmailPeek from '$lib/features/workspace/components/RecipientEmailPeek.svelte';
	import ComposerShell from './ComposerShell.svelte';
	import type {
		CommunicationAttentionItem,
		CommunicationMessage,
		CommunicationState,
		CommunicationThread,
		EmailReadiness,
		EventTheme,
		MessageTemplate,
		ReadinessState,
		RecipientRow
	} from '$lib/api/types';

	interface Props {
		port: CommunicationsPagePort;
	}

	let { port }: Props = $props();
	const api = $derived(port);

	/**
	 * The queue's one read. Its three parts arrive together and fail together,
	 * so they are held as one value beside one failure. A rejection used to
	 * leave all three null with nothing in flight, and the page renders
	 * skeleton rows whenever any of them is null — a permanent loading queue.
	 */
	type MessageQueue = {
		readonly messages: CommunicationMessage[];
		readonly readiness: EmailReadiness;
		readonly attention: CommunicationAttentionItem[];
		readonly thread: CommunicationThread | null;
	};
	let queueState = $state<LiveReadState<MessageQueue>>({ kind: 'resolving' });
	const queue = $derived(queueState.kind === 'resolved' ? queueState.value : null);
	/**
	 * Ids showing as sending until the re-read lands. The optimistic frame is an
	 * overlay on the served rows rather than a write into them, so the next
	 * answer replaces it wholesale instead of being merged with a guess.
	 */
	let sendingIds = $state<string[]>([]);
	const messages = $derived<CommunicationMessage[] | null>(
		queue
			? queue.messages.map((message) => ({
					...message,
					subject: subjectEdits[message.id] ?? message.subject,
					...(sendingIds.includes(message.id) ? { state: 'sending' as const } : {})
				}))
			: null
	);
	const readiness = $derived<EmailReadiness | null>(queue?.readiness ?? null);
	const attention = $derived<CommunicationAttentionItem[] | null>(queue?.attention ?? null);
	/** The scoped person's own entries, present only while `?person=` names one. */
	const thread = $derived<CommunicationThread | null>(queue?.thread ?? null);
	/**
	 * Stored templates: the review door and the composer share them. Re-read
	 * rather than read once, because the composer can now mint one and edit one,
	 * and both surfaces answer to the same store.
	 */
	let templates = $state<MessageTemplate[] | null>(null);

	async function loadTemplates(): Promise<void> {
		try {
			templates = (await api.templates.list()).messages;
		} catch {
			templates = [];
		}
	}
	let expandedId = $state<string | null>(null);
	let busy = $state(false);

	let reviewId = $state<string | null>(null);
	let reviewOpen = $state(false);
	let reviewSubject = $state('');
	/** Announced politely after a send; the history row carries the visible result. */
	let sendNotice = $state('');
	let composeOpen = $state(false);

	/** Subjects rewritten while reviewing, kept against the row they belong to. */
	let subjectEdits = $state<Record<string, string>>({});

	const stateBadge: Record<
		CommunicationState,
		{ label: string; tone: string; solid?: boolean; icon: IconComponent }
	> = {
		draft: { label: 'Draft', tone: 'neutral', icon: statusIcon.draft },
		scheduled: { label: 'Scheduled', tone: 'info', icon: statusIcon.scheduled },
		sending: { label: 'Sending', tone: 'info', icon: statusIcon.sending },
		sent: { label: 'Sent', tone: 'success', icon: statusIcon.sent },
		held: { label: 'Held', tone: 'warning', solid: true, icon: statusIcon.held }
	};

	const outcomeBadge: Record<
		CommunicationThread['entries'][number]['outcome'],
		{ label: string; tone: string; solid?: boolean; icon: IconComponent }
	> = {
		delivered: { label: 'Delivered', tone: 'success', icon: statusIcon.delivered },
		sent: { label: 'Sent', tone: 'success', icon: statusIcon.sent },
		bounced: { label: 'Bounced', tone: 'danger', solid: true, icon: statusIcon.bounced },
		scheduled: { label: 'Scheduled', tone: 'info', icon: statusIcon.scheduled }
	};

	/** Same words and tones as the Overview queue: one severity, one name. */
	const severityBadge: Record<
		CommunicationAttentionItem['severity'],
		{ label: string; tone: string }
	> = {
		action: { label: 'Act now', tone: 'danger' },
		soon: { label: 'Soon', tone: 'warning' }
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

	function rows(list: CommunicationMessage[]): CommunicationMessage[] {
		return list.map((message) => ({
			...message,
			subject: subjectEdits[message.id] ?? message.subject,
			bounces: message.bounces.map((bounce) => ({ ...bounce }))
		}));
	}

	// A send or a new draft re-reads the page, which can move work between the
	// queue and history. The rows a person is reading stay put and dim until the
	// replacement lands; the skeletons below are for the first load only.
	let refreshing = $state(false);
	const reload = trackPending(() => refreshing);

	/** The person the address scopes history to; empty means the whole event. */
	const personId = $derived(param('person'));

	const queueRead = new LiveRead<MessageQueue>({
		read: async () => {
			const person = personId;
			const [list, delivery, waiting, personThread] = await Promise.all([
				api.communications.list(),
				api.communications.readiness(),
				api.communications.attention(),
				person ? api.communications.thread(person) : Promise.resolve(null)
			]);
			return {
				messages: rows(list),
				readiness: delivery,
				attention: waiting,
				thread: personThread
			};
		},
		fallback: 'The message queue could not be loaded.',
		onChange: (state) => (queueState = state)
	});

	/**
	 * Every trigger — the first load, a person-scope change, a send, a new draft
	 * — is one fresh request whose answer supersedes any still open, so a slow
	 * read of the previous scope can never repaint the queue of the new one.
	 */
	async function load() {
		refreshing = true;
		try {
			await queueRead.refresh();
		} finally {
			refreshing = false;
		}
	}

	// A plain let, deliberately outside the graph: the initial load and every
	// person-scope change share one read path without double-fetching on mount.
	let loadedPerson: string | null | undefined = undefined;

	$effect(() => {
		const person = personId ?? null;
		if (person === loadedPerson) return;
		loadedPerson = person;
		void load();
	});

	// The brand behind every rendered email preview, read once per session: the
	// artifact belongs to the event, not the operator app.
	let theme = $state<EventTheme | null>(null);
	let eventName = $state('Your event');
	let eventMeta = $state('');

	/*
	 * Composer furniture, not the queue: the composer already renders a template
	 * list it is still waiting for, and a preview that says so. A failure here
	 * leaves those exactly as they read before any answer — which is the honest
	 * picture — while the queue below keeps its own, louder failure. What must
	 * not happen is an unhandled rejection escaping into nothing, which is what
	 * an uncaught `void promise.then(...)` did.
	 */
	onMount(() => {
		void loadTemplates();
		void Promise.all([api.theme.get(), api.workspace.summary()]).then(
			([brand, summary]) => {
				theme = brand;
				if (summary.event) {
					eventName = summary.event.name;
					eventMeta = `${summary.event.dates} · ${summary.event.location}`;
				}
			},
			() => {
				// The event's own name is unknown rather than assumed; the default
				// stays, and no preview claims a brand it could not read.
				theme = null;
			}
		);
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

	/**
	 * History is the record of what was authorized to leave — scheduled, in
	 * flight, held behind setup, sent. Drafts have not happened yet; they wait
	 * in the attention queue until reviewed.
	 */
	const history = $derived.by(() => {
		const listed = (messages ?? []).filter((message) => message.state !== 'draft');
		const upcoming = listed.filter(
			(message) => message.state === 'scheduled' || message.state === 'sending'
		);
		const settled = listed.filter(
			(message) => message.state !== 'scheduled' && message.state !== 'sending'
		);
		return [...upcoming, ...settled];
	});

	const reviewMessage = $derived(messages?.find((message) => message.id === reviewId) ?? null);
	const reviewCount = $derived(
		reviewMessage?.review ? includedCount(reviewMessage.review) : (reviewMessage?.audienceCount ?? 0)
	);
	/**
	 * The one door on the review surface: a draft that names its stored template
	 * links straight to it; older label-only rows fall back to the label map.
	 */
	const reviewDoor = $derived.by(() => {
		const direct = templates?.find((template) => template.id === reviewMessage?.templateId);
		if (direct) return { href: `/app/templates?template=${direct.id}`, name: direct.name };
		return templateDoor(reviewMessage?.review?.templateLabel, templates);
	});

	/**
	 * The per-recipient rendered preview inside Review & send: pressing an
	 * included row's sample line shows that person's whole email. Available
	 * exactly when the draft names its stored template — without one there is
	 * no body to render, and the one-line sample stays the evidence.
	 */
	let previewEmail = $state<string | null>(null);
	/**
	 * The body this draft renders from: its stored template, or — for a message
	 * written from a blank start — the one-off frozen onto it. Every draft has
	 * one of the two, so the review always has an artifact to show.
	 */
	const reviewTemplate = $derived(
		templates?.find((template) => template.id === reviewMessage?.templateId) ??
			reviewMessage?.document ??
			null
	);
	const previewRecipient = $derived(
		reviewMessage?.review?.recipients.find(
			(recipient) => recipient.email === previewEmail && recipient.state === 'included'
		) ?? null
	);

	/**
	 * Whether there is a body to render at all. Resolving whose copy it is —
	 * the merge overlay — belongs to the shared peek, so every send ceremony
	 * resolves a recipient's artifact the same way.
	 */
	const previewedTemplate = $derived(reviewTemplate && previewRecipient ? reviewTemplate : null);

	/** Pressing a row switches whose copy is shown; the panel itself stays. */
	function selectPreview(recipient: RecipientRow) {
		previewEmail = recipient.email;
	}

	// Leaving the dialog leaves the preview behind: reopening reviews fresh.
	$effect(() => {
		if (!reviewOpen) previewEmail = null;
	});

	/**
	 * The dialog earns its inspection height exactly when there is an artifact
	 * to inspect; a review with nothing to render keeps the compact width.
	 */
	const reviewSize = $derived<'md' | 'lg'>(
		reviewMessage?.review && reviewTemplate && theme ? 'lg' : 'md'
	);

	/**
	 * The cause line's one door: when the causal rows live on another surface,
	 * the sentence ends with the way there. The label comes from the navigation
	 * model, so an unknown destination renders no door rather than a dead one.
	 */
	function causeDoor(message: CommunicationMessage): { href: string; label: string } | null {
		if (!message.causeHref) return null;
		const area = destinationLabel(message.causeHref.split('?')[0] ?? '');
		return area ? { href: message.causeHref, label: `Open ${area.toLowerCase()}` } : null;
	}

	function plural(count: number, singular: string, many = `${singular}s`) {
		return `${count} ${count === 1 ? singular : many}`;
	}

	function metaLine(message: CommunicationMessage) {
		return [message.audience, plural(message.audienceCount, 'recipient'), message.sentAt]
			.filter(Boolean)
			.join(' · ');
	}

	function openReview(message: CommunicationMessage) {
		reviewId = message.id;
		reviewSubject = message.subject;
		sendNotice = '';
		previewEmail = null;
		reviewOpen = true;
	}

	// The review answers "what will each person see" with a real copy from the
	// start: the first included recipient's email renders as soon as the stored
	// template is in hand — reactive rather than set on open, so a review opened
	// before the templates read resolves still gets its default preview.
	$effect(() => {
		if (!reviewOpen || !reviewTemplate || previewEmail) return;
		const first = reviewMessage?.review?.recipients.find(
			(recipient) => recipient.state === 'included'
		);
		if (first) previewEmail = first.email;
	});

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
		sendingIds = [...sendingIds, id];
		const outcome = await api.communications.send(id);
		await load();
		sendingIds = sendingIds.filter((entry) => entry !== id);
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

	// A link may open the composer — `/app/messages?compose=1` — because a GET
	// may open a surface. The send stays a separate, deliberate command.
	const composeAsked = $derived(paramFlag('compose'));
	let composeHonoured = false;

	$effect(() => {
		if (!composeAsked) {
			composeHonoured = false;
			return;
		}
		if (composeHonoured) return;
		composeHonoured = true;
		composeOpen = true;
	});

	// Closing the dialog leaves a clean address behind, so a reload does not
	// reopen a dialog the operator already dismissed.
	$effect(() => {
		if (!composeOpen && composeAsked && composeHonoured) void clearParams(['compose']);
	});

	/**
	 * Arriving from elsewhere: `?message=` lands on that send's history row —
	 * open, scrolled to, and marked — so an attention item or a thread entry
	 * keeps its promise instead of dropping someone at the top of the list.
	 */
	const askedMessage = $derived(param('message'));

	// Outside the graph: records which arrival has been answered, so a repaint
	// cannot steal the scroll position back a second time.
	let revealedMessage: string | null = null;

	/**
	 * Bring a target into view and keep the promise: the smooth scroll a reveal
	 * starts can be cancelled by the very layout work that just expanded the
	 * row (narrow widths hit this reliably), so a beat later the target is
	 * checked and, if it still sits outside the viewport, jumped to instantly.
	 */
	function reveal(element: HTMLElement | null) {
		if (!element) return;
		revealTarget(element);
		window.setTimeout(() => {
			const rect = element.getBoundingClientRect();
			if (rect.top < 0 || rect.top > window.innerHeight * 0.8) {
				element.scrollIntoView({ block: 'center', behavior: 'auto' });
			}
		}, 350);
	}

	$effect(() => {
		const id = askedMessage;
		const ready = messages;
		if (!ready || !id) {
			revealedMessage = null;
			return;
		}
		if (revealedMessage === id) return;
		revealedMessage = id;
		if (!ready.some((entry) => entry.id === id)) return;
		expandedId = id;
		void tick().then(() => reveal(document.querySelector<HTMLElement>(`[data-message="${id}"]`)));
	});

	function toggleRow(id: string) {
		expandedId = expandedId === id ? null : id;
		// The address named one send; the moment the operator opens or closes a
		// row themselves, what is showing is theirs rather than the link's.
		if (askedMessage && askedMessage !== expandedId) {
			void clearParams(['message'], { history: 'push' });
		}
	}

	let deliveryCard = $state<HTMLElement | null>(null);

	function onAttention(item: CommunicationAttentionItem) {
		if (item.action.kind === 'review' && item.messageId) {
			const message = messages?.find((entry) => entry.id === item.messageId);
			if (message) openReview(message);
			return;
		}
		if (item.action.kind === 'open-message' && item.messageId) {
			// The evidence row lives in the unscoped history, so the pointer clears
			// any person scope in the same navigation. A repeat press re-reveals
			// even when the address already names this row.
			if (askedMessage === item.messageId) {
				expandedId = item.messageId;
				reveal(document.querySelector<HTMLElement>(`[data-message="${item.messageId}"]`));
			} else {
				void applyParams({ message: item.messageId, person: null });
			}
			return;
		}
		reveal(deliveryCard);
	}

	/**
	 * One bounce editor at a time: which address is being corrected, the value
	 * as typed, and — rendered in place, never only announced — the reason a
	 * resend was refused.
	 */
	let editingBounce = $state<{ messageId: string; email: string; value: string; refusal: string } | null>(null);

	function openBounceEdit(messageId: string, email: string) {
		editingBounce = { messageId, email, value: email, refusal: '' };
	}

	/**
	 * The remedy the attention item promised: correct (or confirm) the one
	 * address and resend that person's copy. One recipient is the whole blast
	 * radius, so the labelled press is the deliberate step and the receipt is
	 * the record.
	 */
	async function resendBounced() {
		const editing = editingBounce;
		if (!editing || busy) return;
		const message = messages?.find((entry) => entry.id === editing.messageId);
		busy = true;
		const outcome = await api.communications.resendBounced(
			editing.messageId,
			editing.email,
			editing.value
		);
		if (outcome.ok) {
			await load();
			recordAction({
				area: 'messages',
				label: `Resent “${message?.subject ?? 'the message'}” to ${editing.value.trim()}`,
				notUndoableReason: 'Email cannot be recalled after the provider accepts it.'
			});
			editingBounce = null;
		} else {
			editingBounce = { ...editing, refusal: outcome.reason };
		}
		busy = false;
	}

	/** Leaving the person scope is one act; the chip is its one-action reversal. */
	function clearPerson() {
		void clearParams(['person']);
	}

	function openThreadEntry(messageId: string) {
		void applyParams({ person: null, message: messageId });
	}
</script>

{#snippet actorMark(actor: CommunicationMessage['actor'])}
	{#if actor === 'agent'}
		<span class="ui-badge ui-badge--lavender">Agent-drafted</span>
	{:else if actor === 'policy'}
		<span class="ui-badge ui-badge--neutral">Automatic</span>
	{/if}
{/snippet}

{#snippet attentionQueue()}
	<section
		class="card"
		class:is-refreshing={reload.visible}
		aria-busy={refreshing || undefined}
		aria-label="Needs attention">
		<header class="card__head">
			<h2 class="card__title">Needs attention</h2>
			{#if attention}
				<span class="card__count">{attention.length}</span>
			{/if}
		</header>
		<p class="ui-sr-only" role="status">{sendNotice}</p>
		{#if (attention ?? []).length === 0}
			<p class="calm">Nothing is waiting on you.</p>
		{:else}
			<ul class="queue">
				{#each attention ?? [] as item (item.id)}
					{@const severity = severityBadge[item.severity]}
					<li class="queue__row">
						<span class="ui-badge ui-badge--solid ui-badge--{severity.tone} queue__sev"
							>{severity.label}</span>
						<div class="queue__copy">
							<p class="queue__reason">{item.reason}</p>
							<p class="queue__detail">{item.detail}</p>
						</div>
						<button
							type="button"
							class="ui-button ui-button--secondary ui-button--sm queue__action"
							disabled={busy}
							onclick={() => onAttention(item)}>
							{item.action.label}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/snippet}

{#snippet messageRow(message: CommunicationMessage)}
	{@const badge = stateBadge[message.state]}
	{@const open = expandedId === message.id}
	{@const door = causeDoor(message)}
	<li class="row" class:row--open={open} data-message={message.id}>
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
			<p class="row__purpose">
				{message.purpose}
				{@render actorMark(message.actor)}
			</p>
			<p class="row__subject">{message.subject}</p>
			<p class="row__cause">
				{message.cause}{#if door}{' · '}<a class="row__cause-door" href={door.href}>{door.label}</a>{/if}
			</p>
			<p class="row__meta">{metaLine(message)}</p>
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
			{#if message.bounces.length > 0}
				<button
					type="button"
					class="ui-button ui-button--ghost ui-button--icon ui-button--sm row__expand"
					class:row__expand--open={open}
					aria-expanded={open}
					aria-controls={`bounces-${message.id}`}
					aria-label={`Bounces for “${message.subject}”`}
					onclick={() => toggleRow(message.id)}>
					<ChevronDown size={15} />
				</button>
			{/if}
		</div>
		{#if open && message.bounces.length > 0}
			<div class="bounces" id={`bounces-${message.id}`}>
				<h4 class="bounces__title">{plural(message.bounces.length, 'address', 'addresses')} to fix</h4>
				<ul class="bounces__list">
					{#each message.bounces as bounce (bounce.email)}
						{@const editing =
							editingBounce?.messageId === message.id && editingBounce.email === bounce.email
								? editingBounce
								: null}
						<li class="bounce" class:bounce--editing={editing}>
							{#if editing}
								<div class="fix">
									<Field
										id="bounce-fix"
										label={`Corrected address for ${bounce.email}`}
										description="A soft bounce may just retry the same address; a rejection wants a new one.">
										{#snippet children({ id, describedBy })}
											<!-- The press that opened this editor asked to type here. -->
											<!-- svelte-ignore a11y_autofocus -->
											<input
												class="ui-control"
												type="email"
												{id}
												aria-describedby={describedBy}
												aria-invalid={editing.refusal ? true : undefined}
												autofocus
												bind:value={editing.value} />
										{/snippet}
									</Field>
									{#if editing.refusal}
										<p class="fix__refusal" role="alert">{editing.refusal}</p>
									{/if}
									<div class="fix__actions">
										<button
											type="button"
											class="ui-button ui-button--primary ui-button--sm"
											disabled={busy || !editing.value.trim()}
											aria-busy={busy || undefined}
											onclick={resendBounced}>
											{#if busy}<span class="ui-spinner" aria-hidden="true"></span>{/if}
											Resend 1 email
										</button>
										<button
											type="button"
											class="ui-button ui-button--ghost ui-button--sm"
											disabled={busy}
											onclick={() => (editingBounce = null)}>
											Cancel
										</button>
										<span class="fix__note">Delivery starts the moment you press resend.</span>
									</div>
								</div>
							{:else}
								<div class="bounce__copy">
									<p class="bounce__email"><CopyValue value={bounce.email} label="bounced address" /></p>
									<p class="bounce__reason">{bounce.reason}</p>
								</div>
								<button
									type="button"
									class="ui-button ui-button--secondary ui-button--sm"
									aria-label={`Edit address for ${bounce.email}`}
									onclick={() => openBounceEdit(message.id, bounce.email)}>
									Edit address
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</li>
{/snippet}

{#snippet threadRows(current: CommunicationThread)}
	{#if current.entries.length === 0}
		<div class="empty">
			<p class="empty__title">Nothing has been sent to {current.personName} yet.</p>
			<p class="empty__hint">Their copies of future sends will collect here, each with its own outcome.</p>
		</div>
	{:else}
		<ul class="rows">
			{#each current.entries as entry (entry.id)}
				{@const badge = outcomeBadge[entry.outcome]}
				{@const Outcome = badge.icon}
				<li class="row row--thread">
					<span class="ui-badge ui-badge--{badge.tone} row__state" class:ui-badge--solid={badge.solid}>
						<Outcome class="ui-badge__icon" aria-hidden="true" />
						{badge.label}
					</span>
					<div class="row__copy">
						<p class="row__purpose">
							{entry.purpose}
							{@render actorMark(entry.actor)}
						</p>
						<p class="row__subject">{entry.subject}</p>
						<p class="row__meta">{entry.at}</p>
					</div>
					<div class="row__actions">
						{#if entry.messageId}
							<button
								type="button"
								class="ui-button ui-button--ghost ui-button--sm"
								onclick={() => openThreadEntry(entry.messageId ?? '')}>
								Open the send
							</button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#snippet historyCard()}
	<section
		class="card"
		class:is-refreshing={reload.visible}
		aria-busy={refreshing || undefined}
		aria-label="History">
		<header class="card__head">
			<h2 class="card__title">History</h2>
			{#if personId && thread}
				<!-- The scope came in through the address; the chip is its one-action
				     reversal, and Back restores it. -->
				<span class="scope">
					<span class="scope__label">{thread.personName}</span>
					<button type="button" class="scope__clear" aria-label={`Stop showing only ${thread.personName}`} onclick={clearPerson}>
						<X size={13} aria-hidden="true" />
					</button>
				</span>
			{/if}
			<button
				type="button"
				class="ui-button ui-button--primary ui-button--sm card__action"
				onclick={() => applyParams({ compose: '1' })}>
				Compose
			</button>
		</header>
		{#if personId}
			{#if thread}
				{@render threadRows(thread)}
			{:else}
				<div class="empty">
					<p class="empty__title">This person is not on the roster.</p>
					<p class="empty__hint">
						<button type="button" class="empty__link" onclick={clearPerson}>Show the whole event instead.</button>
					</p>
				</div>
			{/if}
		{:else if history.length === 0}
			<div class="empty">
				<p class="empty__title">Nothing has been sent yet.</p>
				<p class="empty__hint">
					Compose above for a one-off message. Decisions, task deadlines, and agent runs drop their
					drafts into the queue too — every one waits for your review before it sends.
				</p>
			</div>
		{:else}
			<ul class="rows">
				{#each history as message (message.id)}
					{@render messageRow(message)}
				{/each}
			</ul>
		{/if}
	</section>
{/snippet}

{#snippet delivery()}
	<section
		bind:this={deliveryCard}
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

{#if queueState.kind === 'unavailable'}
	<!-- The queue answered "no". Skeleton rows would keep claiming messages are
	     on their way when no request is open. -->
	<div class="empty" role="alert">
		<p class="empty__title">The message queue is unavailable</p>
		<p class="empty__hint">{queueState.message}</p>
		{#if queueState.retryable}
			<button
				type="button"
				class="ui-button ui-button--secondary ui-button--sm"
				aria-busy={refreshing || undefined}
				disabled={refreshing}
				onclick={() => void load()}>Try again</button>
		{/if}
	</div>
{:else if !messages || !readiness || !attention}
	<!-- First-load skeletons mirror the resolved composition: the queue with its
	     severity chip, copy, and action; history rows with their state chip and
	     four lines; the delivery checks. -->
	<section class="card" aria-label="Needs attention">
		<header class="card__head">
			<h2 class="card__title">Needs attention</h2>
		</header>
		<ul class="queue" aria-hidden="true">
			{#each Array(2) as _, index (index)}
				<li class="queue__row">
					<span class="ui-skeleton skeleton-chip queue__sev"></span>
					<div class="queue__copy">
						<p class="queue__reason"><span class="ui-skeleton skeleton-line" style="inline-size: min(19rem, 100%)"></span></p>
						<p class="queue__detail"><span class="ui-skeleton skeleton-line" style="inline-size: min(24rem, 100%)"></span></p>
					</div>
					<span class="ui-skeleton skeleton-action queue__action"></span>
				</li>
			{/each}
		</ul>
	</section>
	<section class="card" aria-label="History">
		<header class="card__head">
			<h2 class="card__title">History</h2>
			<button type="button" class="ui-button ui-button--primary ui-button--sm card__action" disabled>
				Compose
			</button>
		</header>
		<ul class="rows" aria-hidden="true">
			{#each Array(3) as _, index (index)}
				<li class="row">
					<span class="ui-skeleton skeleton-chip row__state"></span>
					<div class="row__copy">
						<p class="row__purpose"><span class="ui-skeleton skeleton-line" style="inline-size: 7rem"></span></p>
						<p class="row__subject"><span class="ui-skeleton skeleton-line" style="inline-size: min(18rem, 100%)"></span></p>
						<p class="row__cause"><span class="ui-skeleton skeleton-line" style="inline-size: min(22rem, 100%)"></span></p>
						<p class="row__meta"><span class="ui-skeleton skeleton-line" style="inline-size: min(13rem, 100%)"></span></p>
					</div>
				</li>
			{/each}
		</ul>
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
	{@render attentionQueue()}
	{@render historyCard()}
{:else}
	{@render attentionQueue()}
	{@render historyCard()}
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

<Modal bind:open={reviewOpen} title="Review &amp; send" size={reviewSize}>
	{#if reviewMessage?.review}
		<ReviewSurface
			review={reviewMessage.review}
			{readiness}
			subject={subjectField}
			templateDoor={reviewDoor}
			onPreview={reviewTemplate && theme ? selectPreview : undefined}
			previewingEmail={previewEmail} />
		{#if previewedTemplate && theme && previewRecipient}
			<RecipientEmailPeek
					template={previewedTemplate}
					{theme}
					{eventName}
					{eventMeta}
					recipient={previewRecipient}
					subject={reviewSubject}
					hint="Press any included recipient’s line above to see their copy." />
		{/if}
		<p class="note note--spaced">
			This draft has not been sent. Sending is the deliberate step: delivery starts the moment
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
			<p class="note">
				This draft has not been sent. Sending is the deliberate step: delivery starts the moment
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

<ComposerShell
	{port}
	bind:open={composeOpen}
	{templates}
	{theme}
	{eventName}
	{eventMeta}
	personId={personId ?? null}
	onCreated={load}
	onTemplatesChanged={loadTemplates} />

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

	.card__count {
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
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
	.card.is-refreshing .queue,
	.card.is-refreshing .checks,
	.card.is-refreshing .calm,
	.card.is-refreshing .empty {
		opacity: 0.55;
		pointer-events: none;
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	/* An empty queue is a claim, not a gap: the calm line keeps the card's
	   footprint so acting on the last item never collapses the surface. */
	.calm {
		margin: 0;
		padding-block: var(--je-space-2);
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.queue {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.queue__row {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) max-content;
		grid-template-areas: 'sev copy action';
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
		padding-block: var(--je-space-3);
	}

	.queue__row + .queue__row {
		border-block-start: 1px solid var(--je-color-border);
	}

	.queue__sev {
		grid-area: sev;
	}

	.queue__copy {
		grid-area: copy;
		min-width: 0;
	}

	.queue__reason {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.queue__detail {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.queue__action {
		grid-area: action;
	}

	/* The scope chip: sea marks "chosen", never a status. */
	.scope {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		padding: 0.1rem 0.3rem 0.1rem 0.55rem;
		border: 1px solid var(--je-color-mark-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-mark-surface);
		color: var(--je-color-mark-ink);
		font-size: var(--je-font-size-sm);
	}

	.scope__label {
		font-weight: 600;
	}

	.scope__clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		inline-size: 1.35rem;
		block-size: 1.35rem;
		padding: 0;
		border: 0;
		border-radius: calc(var(--je-radius-control) - 2px);
		background: transparent;
		color: var(--je-color-text-muted);
		cursor: pointer;
	}

	.scope__clear:hover {
		background: var(--je-color-mark-surface-hover);
		color: var(--je-color-mark-ink);
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
		align-items: start;
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

	/* The eyebrow answers "why did this go out" before the artifact's own
	   subject line; the actor mark rides it only when authorship is the
	   exception (agent-drafted, automatic). */
	.row__purpose {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin: 0 0 0.125rem;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	/* The actor badge rides the eyebrow but is a badge, not an eyebrow: it
	   keeps its own case instead of inheriting the caps treatment. */
	.row__purpose :global(.ui-badge) {
		text-transform: none;
		letter-spacing: normal;
	}

	.row__subject {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.row__cause {
		margin: 0.125rem 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.row__cause-door {
		white-space: nowrap;
	}

	.row__meta {
		margin: 0.125rem 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-subtle);
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

	/* The editor takes the row's full width: the address field and its commit
	   read as one act, not a control squeezed beside old evidence. */
	.bounce--editing {
		grid-template-columns: minmax(0, 1fr);
	}

	.fix {
		display: grid;
		gap: var(--je-space-2);
		max-inline-size: 30rem;
	}

	.fix__refusal {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-danger);
	}

	.fix__actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.fix__note {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
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

	.empty__link {
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: var(--je-color-action);
		text-decoration: underline;
		cursor: pointer;
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

		.queue__row {
			grid-template-columns: max-content minmax(0, 1fr);
			grid-template-areas:
				'sev copy'
				'action action';
			align-items: start;
		}

		.queue__action {
			justify-self: start;
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
