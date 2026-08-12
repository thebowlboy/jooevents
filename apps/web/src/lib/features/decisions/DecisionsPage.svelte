<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowDown, ArrowUp, Flame, Gem, MailWarning, Star, Zap } from 'lucide-svelte';
	// The situation glyph for a surface whose measurement has not been set up.
	import { CircleDashed as NoPlan } from 'lucide-svelte';
	import {
		Alert,
		Button,
		Field,
		Modal,
		PENDING_MIN_VISIBLE_MS,
		Popover,
		statusIcon,
		trackPending
	} from '$lib/ui';
	import type { IconComponent } from '$lib/ui';
	import ProfilePeek from '$lib/features/workspace/components/ProfilePeek.svelte';
	import ReviewSurface, {
		includedCount,
		templateDoor
	} from '$lib/features/workspace/components/ReviewSurface.svelte';
	import ScopeChip from '$lib/features/workspace/components/ScopeChip.svelte';
	import StandingMark from '$lib/features/workspace/components/StandingMark.svelte';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import { clearParams, param } from '$lib/features/workspace/url-state.svelte';
	import { useWorkspaceGateway } from '$lib/api/workspace-gateway';
	import type {
		AccoladeDef,
		AccoladeKey,
		DecisionState,
		EmailReadiness,
		MessageReview,
		MessageTemplate,
		ScoreStanding,
		SpeakerProfile,
		Submission,
		Track
	} from '$lib/api/types';

	const { api } = useWorkspaceGateway();

	/** The three decisions an organizer applies here. `withdrawn` is submitter-owned. */
	type Verdict = 'accepted' | 'waitlisted' | 'declined';

	let rows = $state<Submission[] | null>(null);
	let tracks = $state<Track[]>([]);
	let selected = $state<string[]>([]);
	let sortDir = $state<'asc' | 'desc'>('desc');
	/** In-flight notification send; decisions track their own rows via `pendingIds`. */
	let busy = $state(false);

	let confirmOpen = $state(false);
	let pendingVerdict = $state<Verdict>('accepted');
	let notifyOpen = $state(false);
	let subject = $state('Your submission decision');
	let sentCount = $state<number | null>(null);
	/** The reviewed batch: the ids below are exactly the ids the send commits. */
	let notifyIds = $state.raw<string[]>([]);
	let notifyReview = $state.raw<MessageReview | null>(null);
	let notifyReadiness = $state.raw<EmailReadiness | null>(null);
	/**
	 * Whether this event has a review plan at all. `plansRead` separates "not
	 * asked yet" from "asked, and there is none" so a row never claims a setup
	 * gap that has not been confirmed.
	 */
	let hasPlan = $state(false);
	let plansRead = $state(false);

	/** Stored templates, read once so the review's template fact can be a door. */
	let templates = $state.raw<MessageTemplate[] | null>(null);

	// One fact, one door on this surface: only the review's template line links
	// to the stored template it renders from (see `templateDoor`).
	const notifyDoor = $derived(templateDoor(notifyReview?.templateLabel, templates));

	const uid = $props.id();

	// Evidence from the already-fetched workspace summary decides whether the
	// conditional banner deserves a placeholder: a skeleton for a banner that
	// resolves to absent would collapse the page upward when data arrives.
	const expectBanner = api.workspace.summarySnapshot()?.navCounts.decisions !== undefined;

	const verdicts: { value: Verdict; label: string }[] = [
		{ value: 'accepted', label: 'Accept' },
		{ value: 'waitlisted', label: 'Waitlist' },
		{ value: 'declined', label: 'Decline' }
	];

	const verdictCopy: Record<Verdict, { verb: string; past: string }> = {
		accepted: { verb: 'Accept', past: 'accepted' },
		waitlisted: { verb: 'Waitlist', past: 'waitlisted' },
		declined: { verb: 'Decline', past: 'declined' }
	};

	const decisionBadge: Record<
		DecisionState,
		{ label: string; tone: string; icon: IconComponent } | null
	> = {
		undecided: null,
		accepted: { label: 'Accepted', tone: 'success', icon: statusIcon.accepted },
		waitlisted: { label: 'Waitlisted', tone: 'lavender', icon: statusIcon.waitlisted },
		declined: { label: 'Declined', tone: 'neutral', icon: statusIcon.declined },
		withdrawn: { label: 'Withdrawn', tone: 'neutral', icon: statusIcon.withdrawn }
	};

	/** Only organizer decisions can be pending a notification. */
	function isDecided(row: Submission): boolean {
		return row.decision !== 'undecided' && row.decision !== 'withdrawn';
	}

	/** The reviewer's own marks, drawn in the vocabulary the whole product uses. */
	const accoladeIcon: Record<AccoladeKey, IconComponent> = {
		top_pick: Star,
		hidden_gem: Gem,
		crowd_draw: Flame,
		bold_bet: Zap
	};

	// Where each candidate's average stands among the scored submissions in its
	// track, and which accolades this reviewer pinned to it. Both are read
	// alongside the rows rather than after them, so a row arrives complete.
	let standings = $state<Record<string, ScoreStanding>>({});
	let standingsRead = $state(false);
	let accoladeDefs = $state.raw<AccoladeDef[]>([]);
	let myAccolades = $state.raw<Record<string, AccoladeKey[]>>({});

	// Who submitted, keyed by the address on the submission. Null is a read that
	// came back with nothing, and it is kept: a submitter without a profile is
	// the ordinary case, and asking again on every decision re-read would spend a
	// round trip to learn the same nothing. Absent means "not asked yet", which
	// renders as the plain name it already was.
	let profiles = $state<Record<string, SpeakerProfile | null>>({});

	/** The pinned keys for one submission, in catalog order. */
	function pinnedFor(submissionId: string): AccoladeDef[] {
		const keys = myAccolades[submissionId];
		if (!keys || keys.length === 0) return [];
		return accoladeDefs.filter((def) => keys.includes(def.key));
	}

	// A reload keeps the candidates a person is reading and dims them until the
	// replacement lands; only the first load, with nothing to keep, uses skeletons.
	let refreshing = $state(false);
	const reload = trackPending(() => refreshing, { minVisibleMs: PENDING_MIN_VISIBLE_MS });

	/** Only the latest issued load may write, so overlapping re-reads cannot land stale. */
	let loadSeq = 0;

	/**
	 * One pass for the whole table, after the candidates are on screen. Only
	 * addresses this session has never asked about are read, so the re-read that
	 * follows every decision costs nothing. The map is replaced rather than
	 * mutated, so the ticket is what stops an older pass from clobbering entries
	 * a newer one already wrote.
	 */
	async function loadProfiles(landed: Submission[], seq: number) {
		const emails = [
			...new Set(landed.flatMap((row) => row.speakers.map((speaker) => speaker.email)))
		].filter((email) => !(email in profiles));
		if (emails.length === 0) return;
		const found = await Promise.all(emails.map((email) => api.speakers.profile(email)));
		if (seq !== loadSeq) return;
		const next = { ...profiles };
		emails.forEach((email, index) => (next[email] = found[index]));
		profiles = next;
	}

	/**
	 * Candidates are the inbox and late trays. Set-aside and discarded submissions
	 * are triage outcomes, so they are never decided from this table.
	 *
	 * The table-wide dim is a reload treatment: first paint has skeletons and
	 * nothing to keep, and a quiet re-read resolves on the rows that asked for
	 * it, so only a visible re-read with rows on screen turns it on.
	 */
	async function load({ quiet = false }: { quiet?: boolean } = {}) {
		const seq = ++loadSeq;
		if (!quiet && rows !== null) refreshing = true;
		let landed: Submission[] = [];
		try {
			const [inbox, late] = await Promise.all([
				api.submissions.list({ tray: 'inbox' }),
				api.submissions.list({ tray: 'late' })
			]);
			if (seq !== loadSeq) return;
			landed = [...inbox.rows, ...late.rows];
			rows = landed;
			// The marks already on screen stay on screen: a decision re-read does
			// not change any average, and blanking them back to a pending figure
			// would flash the whole column for nothing. Only the flag reopens, so
			// rows that arrived without a mark yet show the pending figure.
			standingsRead = false;
		} finally {
			if (seq === loadSeq) refreshing = false;
		}
		// One batch for the whole table, read after the rows are on screen. The
		// average cells reserve the mark's geometry from first paint, so these
		// resolve in place rather than widening the column under the reader.
		if (landed.length === 0) {
			standingsRead = true;
			return;
		}
		// The standing marks and the submitter profiles are two independent reads
		// of the same landed rows, so neither waits on the other.
		const [marks] = await Promise.all([
			api.review.standings(landed.map((row) => row.id)),
			loadProfiles(landed, seq)
		]);
		if (seq !== loadSeq) return;
		standings = marks;
		standingsRead = true;
	}

	onMount(async () => {
		// The accolades land with the first rows, so a pinned cluster is never a
		// late arrival that pushes a title sideways.
		const [trackList, settings, queue, defs, templateList, planList] = await Promise.all([
			api.vocab.tracks(),
			api.settings.get(),
			api.review.myQueue(),
			api.review.accoladeDefs(),
			api.templates.list(),
			api.review.plans()
		]);
		tracks = trackList;
		templates = templateList.messages;
		// Read once, only to tell "nobody has reviewed this yet" apart from
		// "there is nowhere to review it": the two look identical in a row and
		// need completely different things from the organizer.
		hasPlan = planList.length > 0;
		plansRead = true;
		if (settings) subject = `Your submission decision — ${settings.name}`;
		accoladeDefs = defs;
		myAccolades = Object.fromEntries(
			queue
				.filter((item) => item.accolades && item.accolades.length > 0)
				.map((item) => [item.submissionId, item.accolades as AccoladeKey[]])
		);
		await load();
	});

	// Submissions without a review average sort last in both directions, so
	// reversing the column never buries the scored rows under unscored ones.
	const sorted = $derived.by(() => {
		if (!rows) return [];
		const factor = sortDir === 'asc' ? 1 : -1;
		return [...rows].sort((a, b) => {
			if (a.reviewAverage === undefined || b.reviewAverage === undefined) {
				return (a.reviewAverage === undefined ? 1 : 0) - (b.reviewAverage === undefined ? 1 : 0);
			}
			return (a.reviewAverage - b.reviewAverage) * factor;
		});
	});

	const decidedCount = $derived(sorted.filter(isDecided).length);
	const unnotified = $derived(sorted.filter((row) => isDecided(row) && !row.notified));
	/** One email per speaker on an un-notified submission. */
	const recipientCount = $derived(unnotified.reduce((sum, row) => sum + row.speakers.length, 0));

	// An alert reading "12 accepted submissions not yet notified" lands here with
	// its scope in the address, so the table opens on exactly those twelve. The
	// chip says so on the surface and clears it in one press.
	const scoped = $derived(param('scope') === 'unnotified');
	const visible = $derived(scoped ? unnotified : sorted);
	const scopeLabel = 'Decided · not yet notified';

	function clearScope() {
		selected = [];
		// Pushed, so the Back button returns to the scoped view it came from.
		void clearParams(['scope'], { history: 'push' });
	}

	const allSelected = $derived(visible.length > 0 && selected.length === visible.length);

	/** Labels count the reviewed recipients once the projection has arrived. */
	const emailCount = $derived(notifyReview ? includedCount(notifyReview) : recipientCount);

	function trackName(id: string) {
		return tracks.find((track) => track.id === id)?.name ?? id;
	}

	function trackAccent(id: string): string {
		const accent = tracks.find((track) => track.id === id)?.accent;
		return accent === 'lavender' ? 'lavender' : accent === 'sea' ? 'sea' : 'neutral';
	}

	function plural(count: number, word: string) {
		return `${count} ${word}${count === 1 ? '' : 's'}`;
	}

	function toggleSelected(id: string) {
		selected = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
	}

	function toggleAll() {
		selected = allSelected ? [] : visible.map((row) => row.id);
	}

	function toggleSort() {
		sortDir = sortDir === 'desc' ? 'asc' : 'desc';
	}

	// A decision resolves on the rows it commits, not on the whole table: the
	// committed rows dim in place while a quiet full re-read fetches the new
	// truth, and every other row stays readable and actionable.
	//
	// `pendingIds` is the in-flight truth and blocks repeat activation from the
	// first frame. The dim keys off the tracker, so a commit faster than the
	// grace tier leaves no trace; `dimmedIds` carries the rows through the
	// minimum-visible tail after the work lands, so a shown dim never blinks.
	let pendingIds = $state<string[]>([]);
	let dimmedIds = $state<string[]>([]);
	const deciding = trackPending(() => pendingIds.length > 0, {
		minVisibleMs: PENDING_MIN_VISIBLE_MS
	});

	$effect(() => {
		if (pendingIds.length === 0 && !deciding.visible && dimmedIds.length > 0) dimmedIds = [];
	});

	async function decide(ids: string[], decision: DecisionState, label: string) {
		// A row already committing is dropped rather than committed twice.
		const targets = ids.filter((id) => !pendingIds.includes(id));
		if (targets.length === 0) return;
		// The compensator restores each submission's decision as it stood.
		const previous = (rows ?? [])
			.filter((row) => targets.includes(row.id))
			.map((row) => ({ id: row.id, decision: row.decision }));
		pendingIds = [...pendingIds, ...targets];
		dimmedIds = [...new Set([...dimmedIds, ...targets])];
		try {
			try {
				await api.decisions.decide(targets, decision);
			} catch (error) {
				// A failed write can still have committed (a timeout, a dropped
				// response), so re-sync from the server before the failure surfaces.
				void load().catch(() => {});
				throw error;
			}
			recordAction({
				area: 'decisions',
				label,
				undo: async () => {
					for (const entry of previous) {
						await api.decisions.decide([entry.id], entry.decision);
					}
				}
			});
			try {
				await load({ quiet: true });
			} catch {
				// The commit landed but the quiet re-read did not; the visible
				// full reload is the fallback that still brings the new truth in.
				await load();
			}
		} finally {
			pendingIds = pendingIds.filter((id) => !targets.includes(id));
		}
	}

	function decideRow(row: Submission, verdict: Verdict) {
		if (row.decision === verdict) return;
		const past = verdictCopy[verdict].past;
		decide([row.id], verdict, `${past[0].toUpperCase()}${past.slice(1)} “${row.title}”`);
	}

	function askBulk(verdict: Verdict) {
		pendingVerdict = verdict;
		confirmOpen = true;
	}

	async function confirmBulk() {
		const ids = selected;
		confirmOpen = false;
		await decide(
			ids,
			pendingVerdict,
			`Set ${plural(ids.length, 'submission')} to ${verdictCopy[pendingVerdict].past}`
		);
		selected = [];
	}

	// The dialog opens on the reviewable batch and then fills in: the projection
	// and provider readiness arrive into a shell that already holds its place.
	async function openNotify() {
		const ids = unnotified.map((row) => row.id);
		sentCount = null;
		notifyIds = ids;
		notifyReview = null;
		notifyReadiness = null;
		notifyOpen = true;
		const [projection, delivery] = await Promise.all([
			api.decisions.reviewNotification(ids),
			api.messages.readiness()
		]);
		if (!notifyOpen || notifyIds !== ids) return;
		notifyReview = projection;
		notifyReadiness = delivery;
	}

	async function sendNotifications() {
		const count = emailCount;
		busy = true;
		try {
			await api.decisions.notify(notifyIds, subject);
			recordAction({
				area: 'decisions',
				label: `Sent ${plural(count, 'decision notification')}`,
				notUndoableReason: 'Email cannot be recalled after the provider accepts it.'
			});
			sentCount = count;
			await load();
		} finally {
			busy = false;
		}
	}
</script>

{#if !rows}
	{#if expectBanner}
		<!-- The banner's own composition with skeleton fills: geometry comes from
		     the same classes the resolved banner uses, so it cannot drift. -->
		<section class="banner" aria-hidden="true">
			<span class="banner__plate ui-skeleton"></span>
			<div class="banner__copy">
				<p class="banner__title"><span class="ui-skeleton skeleton-line" style="inline-size: 18rem"></span></p>
				<p class="banner__detail"><span class="ui-skeleton skeleton-line" style="inline-size: 26rem"></span></p>
			</div>
			<span class="ui-skeleton skeleton-action"></span>
		</section>
	{/if}
{:else if unnotified.length > 0}
	<section class="banner" aria-labelledby="{uid}-banner">
		<span class="banner__plate" aria-hidden="true"><MailWarning size={16} /></span>
		<div class="banner__copy">
			<p class="banner__title" id="{uid}-banner">
				{plural(unnotified.length, 'decision')} not yet sent to the submitter
			</p>
			<p class="banner__detail">
				Deciding never emails anyone. Composing the notification is the separate step that does.
			</p>
		</div>
		<button type="button" class="ui-button ui-button--primary ui-button--sm banner__action" onclick={openNotify}>
			Compose notifications
		</button>
	</section>
{/if}

<CommitReceipt onUndone={load} />

<section class="table-region" aria-labelledby="{uid}-heading">
	<header class="head">
		<h2 class="head__title" id="{uid}-heading">Candidates</h2>
		{#if scoped}
			<ScopeChip label={scopeLabel} onclear={clearScope} />
		{/if}
		{#if rows}
			<p class="head__note">
				{#if scoped}
					{plural(visible.length, 'decision')} waiting on a notification, of {plural(sorted.length, 'candidate')}.
				{:else}
					{plural(sorted.length, 'candidate')} from inbox and late · {decidedCount} decided ·
					{sorted.length - decidedCount} undecided — set-aside and discarded submissions are not decided here.
				{/if}
			</p>
		{:else}
			<p class="head__note" aria-hidden="true"><span class="ui-skeleton skeleton-line" style="inline-size: min(28rem, 100%)"></span></p>
		{/if}
	</header>

	<!-- Said once for the surface: every "No reviews yet" below has one shared
	     cause, and repeating it per row would state one fact as many. Deciding
	     without scores is allowed, so this reports a gap rather than blocking
	     the table — and it carries the way to close it, because a fact shown
	     without its next step is the defect the orientation grammar exists to
	     prevent. -->
	{#if rows && rows.length > 0 && plansRead && !hasPlan}
		<p class="no-plan">
			<span class="no-plan__mark" aria-hidden="true"><NoPlan size={14} /></span>
			<span>
				No review plan yet, so nothing here has a score. You can still decide without
				one. <a href="/app/review">Set up review</a>
			</span>
		</p>
	{/if}

	<div class="ui-table-wrap" class:is-refreshing={reload.visible} aria-busy={refreshing || undefined}>
		<table class="ui-table ui-table--multiline">
			<thead>
				<tr>
					<th class="col-check ui-pick-cell">
						<label class="ui-pick">
							<input type="checkbox" aria-label="Select all candidates" checked={allSelected} onchange={toggleAll} />
						</label>
					</th>
					<th>Submission</th>
					<th>Track</th>
					<th
						class="ui-table__number col-avg"
						aria-sort={sortDir === 'asc' ? 'ascending' : 'descending'}>
						<button type="button" class="ui-button ui-button--ghost ui-button--sm sort" onclick={toggleSort}>
							Review avg
							{#if sortDir === 'asc'}
								<ArrowUp size={12} aria-hidden="true" />
							{:else}
								<ArrowDown size={12} aria-hidden="true" />
							{/if}
							<span class="ui-sr-only">
								— sorted {sortDir === 'asc' ? 'lowest first' : 'highest first'}, activate to reverse
							</span>
						</button>
					</th>
					<th>Decision</th>
					<th>Set decision</th>
				</tr>
			</thead>
			<tbody>
				{#if !rows}
					{#each Array(8) as _, index (index)}
						<!-- Mirrors the resolved multiline row cell-for-cell, so the row
						     height is set by the same table metrics as real rows. -->
						<tr aria-hidden="true">
							<td class="col-check"></td>
							<td>
								<span class="ui-table__primary"><span class="ui-skeleton skeleton-line" style="inline-size: 16rem"></span></span>
								<span class="ui-table__secondary"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></span>
							</td>
							<td><span class="ui-skeleton skeleton-chip"></span></td>
							<td class="ui-table__number">
								<span class="avg">
									<span class="avg__mark avg__pending">
										<span class="ui-skeleton skeleton-line avg__num" style="inline-size: 1.75rem"></span>
									</span>
								</span>
							</td>
							<td><span class="ui-skeleton skeleton-chip"></span></td>
							<td><span class="ui-skeleton skeleton-action skeleton-action--rowacts"></span></td>
						</tr>
					{/each}
				{:else if visible.length === 0}
					<tr>
						<td colspan="6">
							<div class="empty">
								{#if scoped}
									<p class="empty__title">Every decision here has been sent.</p>
									<p class="empty__hint">
										Nothing in the candidate list is waiting on a notification. The full list of
										{plural(sorted.length, 'candidate')} is one press away.
									</p>
									<button type="button" class="ui-button ui-button--secondary ui-button--sm" onclick={clearScope}>
										Show all candidates
									</button>
								{:else}
									<p class="empty__title">Nothing is waiting on a decision.</p>
									<p class="empty__hint">
										Candidates appear here once submissions reach the inbox or late tray. Ask an agent to
										screen the incoming submissions, or open Submissions and work through them yourself.
									</p>
									<a class="ui-button ui-button--secondary ui-button--sm" href="/app/submissions">
										Open Submissions
									</a>
								{/if}
							</div>
						</td>
					</tr>
				{:else}
					{#each visible as row (row.id)}
						{@const badge = decisionBadge[row.decision]}
						{@const rowPending = pendingIds.includes(row.id)}
						{@const pinned = pinnedFor(row.id)}
						{@const standing = standings[row.id]}
						<tr
							data-selected={selected.includes(row.id) ? 'true' : undefined}
							class:is-deciding={deciding.visible && dimmedIds.includes(row.id)}
							aria-busy={rowPending || undefined}>
							<td class="col-check ui-pick-cell">
								<label class="ui-pick">
									<input
										type="checkbox"
										aria-label={`Select “${row.title}”`}
										checked={selected.includes(row.id)}
										disabled={rowPending}
										onchange={() => toggleSelected(row.id)} />
								</label>
							</td>
							<td>
								<span class="ui-table__primary title-line">
									<span class="title-line__text">{row.title}</span>
									{#if pinned.length > 0}
										<!-- One disclosure for the whole cluster: the marks are read as a
										     group, and naming each one is what the panel is for. -->
										<Popover
											label={`${pinned.map((def) => def.label).join(', ')} — accolades you pinned to “${row.title}”`}
											kind="figure">
											{#snippet trigger()}
												<span class="accolades">
													{#each pinned as def (def.key)}
														{@const Mark = accoladeIcon[def.key]}
														<Mark size={13} aria-hidden="true" />
													{/each}
												</span>
											{/snippet}
											{#snippet children()}
												{#each pinned as def (def.key)}
													<p class="accolade">{def.label} — pinned by you</p>
												{/each}
											{/snippet}
										</Popover>
									{/if}
								</span>
								<!-- The submitter is a scan key, and once a profile has landed for
								     that address it is also the way to read who they are without
								     leaving the table. A name with no profile behind it stays plain
								     text: a control that opens nothing is worse than a word that
								     never claimed to be one. -->
								<span class="ui-table__secondary scan"
									>{#each row.speakers as speaker, index (speaker.email)}{@const profile =
										profiles[speaker.email]}{#if index > 0}{', '}{/if}{#if profile}<ProfilePeek
											{profile} />{:else}{speaker.name}{/if}{/each}</span>
							</td>
							<td>
								<span class="ui-badge ui-badge--{trackAccent(row.trackId)}">{trackName(row.trackId)}</span>
							</td>
							<td class="ui-table__number">
								{#if row.reviewCount > 0}
									<!-- The average alone. A bare “4.8 / 3” beside it reads as a score
									     out of three, which is the one thing it never means; the panel's
									     lead line says “4.8 average of 3 reviews” in words that cannot be
									     misread. -->
									<span class="avg">
										<span class="avg__mark">
											{#if standing}
												<!-- Wide enough for the pack, the strip carries the disclosure and
												     the figure stays the number to quote; narrow drops to the
												     figure, which then carries it. One press either way; every
												     sentence stays in the panel. -->
												<span class="avg__wide">
													<StandingMark {standing} form="both" quiet stripWidth="9rem" context={row.title} />
												</span>
												<span class="avg__narrow">
													<StandingMark {standing} form="figure" quiet context={row.title} />
												</span>
											{:else}
												<!-- Reviews are in but no average came back. Rare, and a dash
												     here would read as "not reviewed" — the one thing this row
												     is not. -->
												{#if row.reviewAverage === undefined}
													<span class="absent">No average yet</span>
												{:else}
													<span class="avg__num">{row.reviewAverage.toFixed(1)}</span>
												{/if}
											{/if}
										</span>
									</span>
								{:else}
									<!-- The row's own fact. Why there are no reviews *anywhere* is a
									     fact about the event, not about this submission, so it is
									     stated once above the table rather than repeated down every
									     row — nine identical cells are noise, not nine answers. -->
									<span class="absent">No reviews yet</span>
								{/if}
							</td>
							<td>
								<span class="decision">
									{#if badge}
										{@const Outcome = badge.icon}
									<span class="ui-badge ui-badge--{badge.tone}"
										><Outcome class="ui-badge__icon" aria-hidden="true" />{badge.label}</span
									>
										{#if isDecided(row) && !row.notified}
											{@const Unnotified = statusIcon.unnotified}
										<span class="ui-badge ui-badge--warning ui-badge--solid"
											><Unnotified class="ui-badge__icon" aria-hidden="true" />Un-notified</span
										>
										{/if}
									{:else}
										<!-- Undecided is a state, not an absence, and the design system
										     badges every lifecycle state. A dash left the reader to guess
										     between "nobody has decided", "still being reviewed", and
										     "something is pending" — three different answers, one glyph.
										     The word says which; the column beside it says why there is
										     no evidence yet, so neither repeats the other. -->
										{@const NotDecided = statusIcon.notStarted}
										<span class="ui-badge ui-badge--neutral"
											><NotDecided class="ui-badge__icon" aria-hidden="true" />Not decided</span>
									{/if}
								</span>
							</td>
							<td>
								<span class="rowacts" role="group" aria-label={`Set decision for “${row.title}”`}>
									{#each verdicts as verdict (verdict.value)}
										<button
											type="button"
											class="ui-button ui-button--sm rowacts__btn rowacts__btn--{verdict.value}"
											aria-pressed={row.decision === verdict.value}
											disabled={rowPending}
											onclick={() => decideRow(row, verdict.value)}>{verdict.label}</button>
									{/each}
								</span>
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</section>

{#if selected.length > 0}
	<div class="bulkbar" role="toolbar" aria-label="Bulk decisions">
		<span class="bulkbar__count">{selected.length} selected</span>
		{#each verdicts as verdict (verdict.value)}
			<button
				type="button"
				class="ui-button ui-button--secondary ui-button--sm"
				disabled={selected.some((id) => pendingIds.includes(id))}
				onclick={() => askBulk(verdict.value)}>{verdictCopy[verdict.value].verb}</button>
		{/each}
		<button type="button" class="ui-button ui-button--ghost ui-button--sm" onclick={() => (selected = [])}>
			Clear
		</button>
	</div>
{/if}

<Modal
	bind:open={confirmOpen}
	title={`${verdictCopy[pendingVerdict].verb} ${plural(selected.length, 'submission')}?`}>
	<p class="modal__lead">
		Sets {plural(selected.length, 'submission')} to {verdictCopy[pendingVerdict].past}. Nothing is
		emailed until you compose notifications.
	</p>
	<p class="modal__note">Any of them can be decided again before that send.</p>
	{#snippet footer(close)}
		<Button variant="secondary" size="sm" onclick={close}>Cancel</Button>
		<Button size="sm" onclick={confirmBulk}>
			{verdictCopy[pendingVerdict].verb} {selected.length}
		</Button>
	{/snippet}
</Modal>

{#snippet subjectField()}
	<Field
		id="{uid}-subject"
		label="Subject"
		description="Each recipient receives their own decision in the body.">
		{#snippet children({ id, describedBy })}
			<input class="ui-control" type="text" {id} aria-describedby={describedBy} bind:value={subject} />
		{/snippet}
	</Field>
{/snippet}

<Modal bind:open={notifyOpen} title="Compose decision notifications">
	{#if sentCount === null}
		<p class="modal__lead notify__lead">
			{plural(recipientCount, 'submitter')} across {plural(unnotified.length, 'submission')} have a
			decision that has not been sent. Deciding never emailed them; this send is the step that does.
		</p>
		<ReviewSurface
			review={notifyReview}
			readiness={notifyReadiness}
			previewLabel="Their decision line"
			subject={subjectField}
			templateDoor={notifyDoor} />
	{:else}
		<Alert
			tone="success"
			title={`${plural(sentCount, 'email')} sent`}
			message="Delivery state per recipient is tracked in the outbox. These submissions no longer count as un-notified." />
	{/if}
	{#snippet footer(close)}
		{#if sentCount === null}
			<Button variant="secondary" size="sm" onclick={close}>Cancel</Button>
			<Button
				size="sm"
				loading={busy}
				disabled={!notifyReview || emailCount === 0}
				onclick={sendNotifications}>
				Send {plural(emailCount, 'email')}
			</Button>
		{:else}
			<Button variant="secondary" size="sm" onclick={close}>Done</Button>
		{/if}
	{/snippet}
</Modal>

<style>
	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line-box tall, a chip is badge-height, an action
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
		inline-size: 6rem;
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 10.5rem;
		border-radius: var(--je-radius-control);
	}

	.skeleton-action--rowacts {
		inline-size: 11.5rem;
	}

	/* The single attention surface on this page: tinted card plus a solid plate,
	   amber because the work is pending rather than broken. */
	.banner {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) max-content;
		align-items: center;
		gap: var(--je-space-3) var(--je-space-4);
		padding: var(--je-space-3) var(--je-space-4);
		border: 1px solid color-mix(in srgb, var(--je-color-warning-fill) 38%, transparent);
		border-radius: var(--je-radius-surface);
		background:
			linear-gradient(var(--je-color-warning-soft), var(--je-color-warning-soft)),
			var(--je-color-surface);
	}

	.banner__plate {
		display: grid;
		place-items: center;
		inline-size: 2rem;
		block-size: 2rem;
		border-radius: var(--je-radius-control);
		background: var(--je-color-warning-emphasis);
		color: var(--je-color-warning-emphasis-contrast);
	}

	.banner__copy {
		min-width: 0;
	}

	.banner__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.banner__detail {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-3);
		margin-block-end: var(--je-space-3);
	}

	.head__title {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.head__note {
		margin: 0;
		margin-inline-start: auto;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* The ghost button's own padding is cancelled on the side the column is
	   aligned to, so its label sits on the same edge as the figures below it
	   rather than one control-padding short of it. */
	.sort {
		margin-inline-end: calc(var(--je-space-2) * -1);
		text-transform: inherit;
		letter-spacing: inherit;
	}

	/* A full reload (undo, notification send) re-reads everything; the rows dim
	   in place so nobody loses their spot to skeletons. */
	tbody {
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	.ui-table-wrap.is-refreshing tbody {
		opacity: 0.55;
		pointer-events: none;
	}

	/* A decision resolves on the rows it committed: they dim and go inert while
	   the quiet re-read lands, and every other row stays live. */
	tbody tr {
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	tbody tr.is-deciding {
		opacity: 0.55;
		pointer-events: none;
	}

	.empty {
		display: grid;
		justify-items: center;
		gap: var(--je-space-3);
		padding: var(--je-space-8) var(--je-space-4);
		text-align: center;
	}

	.empty__title {
		margin: 0;
		font-weight: 600;
	}

	.empty__hint {
		margin: 0;
		max-inline-size: 52ch;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		white-space: normal;
	}

	.muted {
		color: var(--je-color-text-muted);
	}

	.no-plan {
		display: flex;
		align-items: flex-start;
		gap: var(--je-space-2);
		margin: 0 0 var(--je-space-3);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-warning);
	}

	.no-plan__mark {
		display: flex;
		/* Optically centred on the first line rather than the paragraph box, so
		   the glyph sits with the sentence when the copy wraps. */
		padding-block-start: 0.1em;
		flex-shrink: 0;
	}

	.no-plan a {
		color: inherit;
		font-weight: 650;
	}

	/* An absence note, not a value: it sits in a number column, so it stays
	   small and quiet enough that the eye still reads the scored rows as the
	   column's content and skips these rather than trying to compare them. */
	.absent {
		font-size: var(--je-font-size-xs);
		font-weight: 400;
		font-variant-numeric: normal;
		color: var(--je-color-text-subtle);
		white-space: nowrap;
	}

	/* A setup gap is the organizer's to close, so it carries attention ink; a
	   row simply waiting on reviewers does not. */
	.absent--blocked {
		color: var(--je-color-warning);
	}

	/* Speaker identity is a scan key on this surface; it keeps full ink even on
	   the metadata line. */
	.scan {
		color: var(--je-color-text);
		font-weight: 500;
	}

	.col-check {
		inline-size: 2rem;
	}

	/* The title owns the line and the pinned marks sit at its end, because they
	   are read as part of naming the submission. */
	.title-line {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-width: 0;
	}

	.title-line__text {
		min-inline-size: 0;
	}

	.accolades {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		color: var(--je-color-accent-lavender-strong);
	}

	.accolade {
		margin: 0;
	}

	/* The average cell reserves its resolved box from the first skeleton paint
	   onward, so the standing read lands as ink alone and the column never moves
	   under someone mid-scan. The reservation is one number, declared on the
	   wrapper so the header cell and the body cells cannot disagree; the strip's
	   width is added to it at the only widths that can pay for it. */
	.ui-table-wrap {
		/* Sized to the phrase this table actually shows — “Higher than 93% of 46
		   scored” — beside the numeral. Longer sentences ellipsize into the
		   popover, which is where the full evidence lives anyway. */
		--avg-w: 12.25rem;
	}

	/* Column width stated once, so auto layout keeps it across skeleton,
	   pending, and resolved rather than redistributing on every arrival. The
	   allowance beyond the reservation is the cell's own padding; the extra that
	   used to pay for a “/ N” suffix went with the suffix. */
	.col-avg {
		inline-size: calc(var(--avg-w) + 1.5rem);
	}

	/* One column, one edge. The sort header, the figures, the pending fills, and
	   the em dash standing for “not scored yet” all end where the column ends, so
	   a row with no average still reads as the same column as the rows above it. */
	.ui-table__number {
		text-align: end;
	}

	/* Both levels of the mark align to that edge too: the reserved box against
	   the cell, and the mark against the reserved box. The strip still precedes
	   the figure — the pair moves as one, so the number a person quotes lands on
	   the column's edge with its pack beside it. */
	.avg {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--je-space-2);
		min-block-size: 1.375rem;
	}

	/* Flex, not block: the mark is an inline-flex box, and a line box would add
	   a baseline strut under it and grow the row when the standing lands. */
	.avg__mark {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		inline-size: var(--avg-w);
		min-inline-size: 0;
	}

	.avg__pending {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		block-size: 1.375rem;
	}

	/* Mirrors the resolved figure's numeral exactly, so the average that is
	   already known is shown at the size it will keep. */
	.avg__num {
		flex: 0 0 auto;
		font-size: var(--je-font-size-base);
		font-weight: 700;
		line-height: 1.375rem;
	}


	.avg__narrow {
		display: flex;
		align-items: center;
		min-inline-size: 0;
	}

	/* Measured, not guessed: at 1280 the strip's column forces the table past its
	   own wrapper and squeezes the title to its min-content, so the strip starts
	   where it costs the title nothing it does not already pay today. */
	.avg__wide {
		display: none;
	}

	@media (min-width: 1440px) {
		.ui-table-wrap {
			--avg-w: 21rem;
		}

		.avg__wide {
			display: flex;
			align-items: center;
			min-inline-size: 0;
		}

		.avg__narrow {
			display: none;
		}
	}

	.decision {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1);
	}

	.rowacts {
		display: flex;
		gap: var(--je-space-1);
	}

	/* Full words with learned tints: the buttons are their own legend. */
	.rowacts__btn--accepted {
		background: var(--je-color-success-soft);
		color: var(--je-color-success);
	}

	.rowacts__btn--waitlisted {
		background: var(--je-color-accent-lavender-soft);
		color: var(--je-color-accent-lavender-strong);
	}

	.rowacts__btn--declined {
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text-muted);
	}

	/* The applied decision stays visible at the point of action, so re-clicking
	   it is never mistaken for a change. */
	.rowacts__btn[aria-pressed='true'] {
		box-shadow: inset 0 0 0 1.5px currentColor;
		font-weight: 700;
	}

	.bulkbar {
		position: sticky;
		inset-block-end: var(--je-space-4);
		align-self: center;
		max-inline-size: 100%;
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: var(--je-space-2);
		padding: var(--je-space-2) var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-round);
		box-shadow: var(--je-shadow-md);
	}

	.bulkbar__count {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		margin-inline-end: var(--je-space-2);
		font-variant-numeric: tabular-nums;
	}

	.modal__lead {
		margin: 0;
		font-size: var(--je-font-size-md);
		line-height: var(--je-leading-normal);
	}

	.modal__note {
		margin: var(--je-space-2) 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.notify__lead {
		margin-block-end: var(--je-space-5);
	}

	/* Narrow widths restructure: the banner's action moves under its copy and the
	   dense table scrolls inside its own wrapper. */
	@media (max-width: 920px) {
		.banner {
			grid-template-columns: max-content minmax(0, 1fr);
			grid-template-areas:
				'plate copy'
				'. action';
		}

		.banner__plate {
			grid-area: plate;
		}

		.banner__copy {
			grid-area: copy;
		}

		.banner__action {
			grid-area: action;
			justify-self: start;
		}

		.head__note {
			margin-inline-start: 0;
		}

		.bulkbar {
			inset-block-end: var(--je-space-3);
			padding-inline: var(--je-space-3);
		}
	}
</style>
