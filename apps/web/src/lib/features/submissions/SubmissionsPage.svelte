<script lang="ts">
	import { onMount } from 'svelte';
	import { ChevronDown, Search } from 'lucide-svelte';
	import type { SubmissionsPagePort } from '$lib/api/submissions-page-port';
	import { describePortFailure, type PortFailureView } from '$lib/api/port-failure';
	import {
		Alert,
		createSettler,
		Marked,
		markIcon,
		Popover,
		shouldIgnoreRowPress,
		statusIcon,
		submissionTrayIcon,
		trackPending
	} from '$lib/ui';
	import type { IconComponent } from '$lib/ui';
	import { matchFields, parseSearch, type MatchRange, type SearchMatch } from '$lib/api/search';
	import {
		submissionFields,
		submissionSpeakerNameField,
		SUBMISSION_FIELD_TITLE,
		SUBMISSION_SEARCH_SCOPE
	} from '$lib/api/searchable';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import AddDirectEntryModal from './AddDirectEntryModal.svelte';
	import SubmissionDetail, {
		signalTone
	} from '$lib/features/workspace/components/SubmissionDetail.svelte';
	import ProfilePeek from '$lib/features/workspace/components/ProfilePeek.svelte';
	import StandingMark from '$lib/features/workspace/components/StandingMark.svelte';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { applyParams, param, paramIn } from '$lib/features/workspace/url-state.svelte';
	import { formatArrival, isNewArrival } from '$lib/features/workspace/recency';
	import type {
		DecisionState,
		Format,
		ReviewRoundStatus,
		ScoreStanding,
		SignalChip,
		SpeakerProfile,
		Submission,
		SubmissionOrigin,
		SubmissionPage,
		Track,
		TrayKey
	} from '$lib/api/types';

	let { port }: { readonly port: SubmissionsPagePort } = $props();

	let data = $state<SubmissionPage | null>(null);
	let tracks = $state<Track[]>([]);
	let formats = $state<Format[]>([]);
	let expandedId = $state<string | null>(null);
	let selected = $state<string[]>([]);
	let busy = $state(false);
	let announcement = $state('');
	let addOpen = $state(false);
	/**
	 * The list reads failed and nothing newer has landed. While `data` is still
	 * null this replaces the first-load skeletons — a skeleton over a refused
	 * answer claims work that is not happening — and with rows on screen it
	 * renders as a notice over the kept truth. `retryable` follows the port's
	 * own classification, so a terminal refusal never offers a retry.
	 */
	let loadFailure = $state<PortFailureView | null>(null);
	/** A tray change (or its undo) that did not commit, in the port's own copy. */
	let actFailure = $state<string | null>(null);

	/* Plain words, because these four are the fates an operator sorts into and
	   none of them is a decision the submitter ever sees. "Set aside" replaced
	   "Folded": a coinage that taught nothing, and whose nearest reading — poker,
	   where you fold your *own* hand — is the reverse of what happens here. */
	const trayLabels: Record<TrayKey, string> = {
		inbox: 'Inbox',
		'set-aside': 'Set aside',
		late: 'Late',
		discarded: 'Discarded'
	};
	const trayOrder: TrayKey[] = ['inbox', 'set-aside', 'late', 'discarded'];

	// The address owns the query. Landing on a scoped link, changing a filter,
	// reloading, and pressing Back all arrive at this one place, so the rows on
	// screen are always the rows the URL describes.
	const tray = $derived(paramIn('tray', trayOrder, 'inbox'));
	const search = $derived(param('search') ?? '');
	const trackId = $derived(param('trackId') ?? '');
	const formatId = $derived(param('formatId') ?? '');

	/*
	 * What the field shows while a settle is outstanding.
	 *
	 * Null means "follow the address", which is the resting state: a reload, a
	 * Back, or a scoped link all put their query in the box without this
	 * component tracking where the change came from. It holds a string only
	 * between a keystroke and the write that lands it, so the caret never waits
	 * on a round trip.
	 */
	let draft = $state<string | null>(null);
	const typed = $derived(draft ?? search);

	const settler = createSettler();
	$effect(() => () => settler.cancel());

	function queueSearch(value: string) {
		draft = value;
		settler.schedule(() => void commitSearch(value));
	}

	async function commitSearch(value: string) {
		await applyParams({ search: value.trim() });
		// Releasing to the address is what keeps Back working, but only if the
		// field has not moved on since: a keystroke during the write still owns
		// the box.
		if (draft === value) draft = null;
	}

	/**
	 * Where the query hit inside each row on screen, keyed by submission.
	 *
	 * Computed here rather than sent over the wire because the client already
	 * holds both the rows and the query, and running the same matcher the server
	 * ran costs nothing at this size. It also means the marks cannot claim a hit
	 * in a field the server withheld — a field that is not in the payload cannot
	 * be matched or drawn, so the blind-review partition holds by construction
	 * rather than by a second policy check here.
	 */
	const parsedSearch = $derived(parseSearch(search));
	const marks = $derived.by(() => {
		const found: Record<string, SearchMatch> = {};
		if (parsedSearch.terms.length === 0 || !data) return found;
		for (const row of data.rows) {
			const match = matchFields(submissionFields(row), parsedSearch);
			if (match) found[row.id] = match;
		}
		return found;
	});

	/** The spans to mark in one row's field, or none. */
	function rangesFor(rowId: string, field: number): readonly MatchRange[] {
		return marks[rowId]?.fields[field]?.ranges ?? [];
	}

	// Glyphs come from the shared vocabulary so an outcome keeps one shape on
	// every surface it appears; the word still carries the state.
	const decisionBadge: Record<
		Submission['decision'],
		{ label: string; tone: string; icon: IconComponent } | null
	> = {
		undecided: null,
		accepted: { label: 'Accepted', tone: 'success', icon: statusIcon.accepted },
		waitlisted: { label: 'Waitlisted', tone: 'lavender', icon: statusIcon.waitlisted },
		declined: { label: 'Declined', tone: 'neutral', icon: statusIcon.declined },
		withdrawn: { label: 'Withdrawn', tone: 'neutral', icon: statusIcon.withdrawn }
	};

	// Reloads keep the rows a person is looking at and dim them until the next
	// result lands; only the first load, with nothing to show, uses skeletons.
	let refreshing = $state(false);
	const reload = trackPending(() => refreshing);

	// A filter change and a committed mutation can both be in flight; only the
	// newest answer is allowed to land.
	let request = 0;

	// Where each row's average stands among the scored submissions in its track,
	// keyed by submission. `standingsRead` is what separates "not answered yet"
	// from "answered, and this row has no standing to make": the first holds the
	// pending figure, the second is the plain average it has always been.
	let standings = $state<Record<string, ScoreStanding>>({});
	let standingsRead = $state(false);

	// Who submitted, keyed by the address on the submission. Null is a read that
	// came back with nothing, and it is kept: a submitter without a profile is
	// the ordinary case, and asking again on every filter pass would spend a
	// round trip to learn the same nothing. Absent means "not asked yet", which
	// renders as the plain name it already was.
	let profiles = $state<Record<string, SpeakerProfile | null>>({});

	/**
	 * One pass for the whole table, after the rows are on screen. Only addresses
	 * this session has never asked about are read, so paging back and forth
	 * through the trays costs nothing.
	 */
	async function loadProfiles(rows: Submission[], ticket: number) {
		const emails = [
			...new Set(rows.flatMap((row) => row.speakers.map((speaker) => speaker.email)))
		].filter((email) => !(email in profiles));
		if (emails.length === 0) return;
		const found = await Promise.all(emails.map((email) => port.speakers.profile(email)));
		if (ticket !== request) return;
		const next = { ...profiles };
		emails.forEach((email, index) => (next[email] = found[index]));
		profiles = next;
	}

	async function load() {
		const query = {
			tray,
			search: search || undefined,
			trackId: trackId || undefined,
			formatId: formatId || undefined
		};
		const ticket = (request += 1);
		refreshing = true;
		let landed: Submission[] = [];
		try {
			try {
				const next = await port.submissions.list(query);
				if (ticket !== request) return;
				data = next;
				landed = next.rows;
				loadFailure = null;
				pruneToRows(next.rows);
				// The marks already on screen stay on screen: a re-read does not change
				// any average, and blanking them back to a pending figure would flash
				// the whole column for nothing. Only the flag reopens, so rows that
				// arrived without a mark yet show the pending figure.
				standingsRead = false;
			} finally {
				if (ticket === request) refreshing = false;
			}
			// One batch for the whole table, read after the rows are on screen. The
			// average cells reserve the figure's geometry from first paint, so these
			// resolve in place rather than widening the column under the reader.
			if (landed.length === 0) {
				standingsRead = true;
				return;
			}
			// The standing marks and the submitter profiles are two independent reads
			// of the same landed rows, so neither waits on the other.
			const [marks] = await Promise.all([
				port.review.standings(landed.map((row) => row.id)),
				loadProfiles(landed, ticket)
			]);
			if (ticket !== request) return;
			standings = marks;
			standingsRead = true;
		} catch (error) {
			// The failure becomes surfaced state, never an unhandled rejection: an
			// eternal first-load skeleton over a refused answer was the exact
			// defect here.
			if (ticket === request) loadFailure = describePortFailure(error);
		}
	}

	// Read at least once: the entry dialog's selects must be able to tell
	// "still loading" from "this event truly has no tracks yet".
	let vocabLoaded = $state(false);

	async function reloadVocab() {
		[tracks, formats] = await Promise.all([port.vocab.tracks(), port.vocab.formats()]);
		vocabLoaded = true;
	}

	/**
	 * Whether any form is currently taking submissions — what the empty inbox's
	 * nudge turns on. Null until known, and the empty state says nothing
	 * state-specific until then: a wrong claim that flashes is worse than a
	 * generic line that holds.
	 */
	let openFormCount = $state<number | null>(null);

	/*
	 * The visit snapshot. Both instants are captured once at page entry and
	 * held for the whole visit: the New mark is a claim about what arrived
	 * since the operator last looked, and re-deriving it mid-visit would fade
	 * rows while the person is looking at them. `visitRead` gates the marks so
	 * the column paints once rather than gaining marks as the read lands.
	 */
	const enteredAt = new Date();
	let previousVisit = $state<string | null>(null);
	let visitRead = $state(false);

	/** The newest review round's standing — the station groups' one review fact. */
	let round = $state<ReviewRoundStatus | null>(null);

	onMount(() => {
		// Each side read degrades to its own designed "not known" state on
		// failure (waiting selects, generic empty-state copy, no station meta,
		// no New marks) instead of rejecting unhandled; the list surface below
		// carries the page's failure state.
		void reloadVocab().catch(() => {});
		void port.forms.openCount().then((count) => (openFormCount = count)).catch(() => {});
		void port.visits.previous().then((visit) => {
			previousVisit = visit;
			visitRead = true;
		}).catch(() => {});
		void port.review.round().then((status) => (round = status)).catch(() => {});
	});

	function isNew(row: Submission): boolean {
		return visitRead && isNewArrival(row.submittedAt, previousVisit, enteredAt);
	}

	// -------------------------------------------------------------------------
	// Stations: residence is custody (the trays), progress is projection. An
	// undecided row is In review while an open round still owes it reviews,
	// Waiting on a decision otherwise; a decided row still owes its notice
	// until the send lands, and only then is it Done. Four rungs, exactly the
	// ladder of 23 §1 — merging the last two taught a false reading ("Decided ·
	// 4 not yet notified" over a row with no un-notified mark). Computed per
	// row, stored nowhere.

	type StationKey = 'review' | 'deciding' | 'notice' | 'done';

	function stationOf(row: Submission): StationKey {
		if (row.decision !== 'undecided') {
			return row.notified || row.decision === 'withdrawn' ? 'done' : 'notice';
		}
		// No per-item target on the plan means the round never says "done with
		// this one", so coverage holds until the round closes.
		if (round?.open && row.reviewCount < (round.reviewsPerSubmission ?? Infinity)) {
			return 'review';
		}
		return 'deciding';
	}

	/** Verdicts order the decided group by what still needs doing, then recency. */
	const decidedRank: Record<DecisionState, number> = {
		accepted: 0,
		waitlisted: 1,
		declined: 2,
		withdrawn: 3,
		undecided: 4
	};

	interface StationSection {
		key: StationKey | 'all';
		label: string | null;
		rows: Submission[];
	}

	/*
	 * The decidable custody trays (inbox, late — the same population the
	 * decision table draws from) group by station, in funnel order; set-aside
	 * and discarded stay flat lists, because they are not decidable and a
	 * decided-then-discarded row's badges already tell its story. A group with
	 * nothing in it does not render.
	 */
	const sections = $derived.by<StationSection[]>(() => {
		const rows = data?.rows ?? [];
		if (tray !== 'inbox' && tray !== 'late') return [{ key: 'all', label: null, rows }];
		const byStation: Record<StationKey, Submission[]> = {
			review: [],
			deciding: [],
			notice: [],
			done: []
		};
		for (const row of rows) byStation[stationOf(row)].push(row);
		// Arrival surfaces read newest first; comparison ordering lives on the
		// decision table. Decided rows order by verdict, then decision recency.
		byStation.review.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
		byStation.deciding.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
		const byVerdict = (a: Submission, b: Submission) =>
			decidedRank[a.decision] - decidedRank[b.decision] ||
			(b.decidedAt ?? '').localeCompare(a.decidedAt ?? '');
		byStation.notice.sort(byVerdict);
		byStation.done.sort(byVerdict);
		return [
			{ key: 'review' as const, label: 'In review', rows: byStation.review },
			{ key: 'deciding' as const, label: 'Waiting on a decision', rows: byStation.deciding },
			{ key: 'notice' as const, label: 'Decided · not yet notified', rows: byStation.notice },
			{ key: 'done' as const, label: 'Done', rows: byStation.done }
		].filter((section) => section.rows.length > 0);
	});

	/** The rows in the order they render — what j/k walks. */
	const orderedRows = $derived(sections.flatMap((section) => section.rows));

	// -------------------------------------------------------------------------
	// Where an accepted row went — read when its detail opens, kept for the
	// session. Null is an answered read (never graduated, or reversed); absent
	// means not asked yet, which renders nothing.
	let origins = $state<Record<string, SubmissionOrigin | null>>({});

	function openRow(id: string | null) {
		expandedId = id;
		if (id === null) return;
		const row = data?.rows.find((entry) => entry.id === id);
		if (!row || row.decision !== 'accepted' || id in origins) return;
		void port.schedule.originOf(id).then((origin) => {
			origins = { ...origins, [id]: origin };
		});
	}

	// Re-reads whenever the query in the address changes, including the first
	// paint and a Back that restores an earlier scope.
	//
	// Scope and search clear differently, and the distinction only started
	// mattering when search became a per-word write. Changing tray, track, or
	// format is a deliberate move to a different population, so a selection
	// built in the old one is meaningless and goes. Typing is not: a person
	// picking rows and then narrowing to find the next one must not lose the
	// picks they already made, which is what clearing on every keystroke would
	// do. So a search-only change keeps whatever survives the new result set.
	// Deliberately not `$state`: this is a memo of the scope already processed,
	// which nothing renders. As reactive state it was both read and written by
	// the effect below, so writing it re-triggered the effect and every scope
	// change issued two reads — the second superseding the first, which is
	// invisible when it works and a race when it does not.
	let lastScope = '';
	$effect(() => {
		const scope = `${tray} ${trackId} ${formatId}`;
		void search;
		if (scope !== lastScope) {
			lastScope = scope;
			selected = [];
			expandedId = null;
		}
		void load();
	});

	/**
	 * Drops picks and any open row that the newest result set no longer holds.
	 *
	 * A selection that outlives its row would act on a submission the operator
	 * can no longer see, so surviving ids are kept and the rest are released.
	 */
	function pruneToRows(rows: Submission[]) {
		const present = new Set(rows.map((row) => row.id));
		if (selected.some((id) => !present.has(id))) {
			selected = selected.filter((id) => present.has(id));
		}
		if (expandedId !== null && !present.has(expandedId)) expandedId = null;
	}

	function switchTray(next: TrayKey) {
		if (tray === next) return;
		// The default tray stays out of the address, so an unscoped link is clean.
		applyParams({ tray: next === 'inbox' ? null : next });
	}

	function toggleSelected(id: string) {
		selected = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
	}

	function toggleAll() {
		const rows = data?.rows ?? [];
		selected = selected.length === rows.length ? [] : rows.map((row) => row.id);
	}

	const triageCopy = {
		setAside: 'Set aside',
		returnToInbox: 'Moved back to the inbox',
		discard: 'Discarded',
		restore: 'Restored'
	} as const;

	async function act(action: keyof typeof triageCopy, ids: string[]) {
		// Captured before the move: the receipt's compensator returns each row to
		// the tray it was actually in, not to whatever the opposite call defaults to.
		const moved = (data?.rows ?? []).filter((row) => ids.includes(row.id));
		const before = moved.map((row) => ({ id: row.id, tray: row.tray, setAsideBy: row.setAsideBy }));
		busy = true;
		actFailure = null;
		try {
			await port.submissions[action](ids);
			recordAction({
				area: 'submissions',
				label:
					moved.length === 1
						? `${triageCopy[action]} “${moved[0].title}”`
						: `${triageCopy[action]} ${moved.length} submissions`,
				undo: async () => {
					// The receipt surface swallows a compensator's rejection, so a
					// refused restore states itself here instead of dismissing as
					// if the rows had walked back.
					try {
						await port.submissions.restoreTray(before);
					} catch (error) {
						actFailure = describePortFailure(
							error,
							'The submissions could not be moved back.'
						).message;
					}
				}
			});
			selected = [];
		} catch (error) {
			// The refusal surfaces typed; the re-read below still shows whatever
			// part of the change actually committed.
			actFailure = describePortFailure(error, 'The change could not be completed.').message;
		} finally {
			busy = false;
			await load();
		}
	}

	/** The same words the popover shows, for the polite live region. */
	function signalSentence(signal: SignalChip): string {
		const score = signal.score === undefined ? '' : ` Confidence ${signal.score.toFixed(2)}.`;
		return `${signal.label}. ${signal.rationale} Source: ${signal.source}.${score}`;
	}

	// A filter offers what may be chosen now, so retired entries drop out of the
	// lists; naming and coloring below still resolve them, permanently.
	const offeredTracks = $derived(tracks.filter((track) => track.status === 'active'));
	const offeredFormats = $derived(formats.filter((format) => format.status === 'active'));

	function trackName(id: string) {
		return tracks.find((track) => track.id === id)?.name ?? id;
	}

	function formatName(id: string) {
		return formats.find((format) => format.id === id)?.name ?? id;
	}

	function trackAccent(id: string): string {
		const accent = tracks.find((track) => track.id === id)?.accent;
		return accent === 'lavender' ? 'lavender' : accent === 'sea' ? 'sea' : 'neutral';
	}

	/**
	 * The row is a bigger door to the same detail, for the pointer only. The
	 * chevron stays the one focusable switch carrying `aria-expanded`, so the
	 * accessible tree gains nothing to disambiguate and the keyboard path is
	 * exactly what it was. Which presses belong to the row's own controls — or
	 * to a text selection — is the shared row-press contract in `$lib/ui`.
	 */
	function onRowPress(event: MouseEvent, id: string) {
		if (shouldIgnoreRowPress(event)) return;
		openRow(expandedId === id ? null : id);
	}

	function onKeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
		// j/k walk the rows as rendered — down the station groups, not the wire order.
		if (orderedRows.length === 0 || (event.key !== 'j' && event.key !== 'k')) return;
		const index = orderedRows.findIndex((row) => row.id === expandedId);
		const next =
			event.key === 'j' ? Math.min(index + 1, orderedRows.length - 1) : Math.max(index - 1, 0);
		openRow(orderedRows[next]?.id ?? null);
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="head">
	<nav class="trays" aria-label="Submission trays">
		{#each trayOrder as key (key)}
			{@const Fate = submissionTrayIcon[key]}
			<button
				type="button"
				class="trays__tab"
				class:trays__tab--active={tray === key}
				aria-pressed={tray === key}
				onclick={() => switchTray(key)}>
				<Fate size={14} aria-hidden="true" />
				{trayLabels[key]}
				<span class="trays__count">{data?.trayTotals[key] ?? '–'}</span>
			</button>
		{/each}
	</nav>
	{#if data}
		<p class="head__denominator">
			{Object.values(data.trayTotals).reduce((sum, count) => sum + count, 0)} total ·
			{data.trayTotals.inbox} inbox · {data.trayTotals['set-aside']} set aside ·
			{data.trayTotals.late} late · {data.trayTotals.discarded} discarded, all recoverable —
			every submission stays countable.
		</p>
	{:else}
		<p class="head__denominator" aria-hidden="true">
			<span class="ui-skeleton skeleton-line" style="inline-size: min(30rem, 100%)"></span>
		</p>
	{/if}
</div>

<section class="list" aria-label="Submissions">
	<div class="ui-toolbar">
		<div class="ui-input-wrap ui-input-wrap--leading toolbar__search">
			<span class="ui-input-wrap__icon" aria-hidden="true"><Search size={14} /></span>
			<!-- Settled rather than committed: the rows follow the words without a
			     gesture, and Enter only brings the pending write forward for anyone
			     who expects it to do something. -->
			<input
				class="ui-control"
				type="search"
				placeholder="Search title, abstract, or speaker"
				aria-label="Search submissions"
				value={typed}
				oninput={(event) => queueSearch(event.currentTarget.value)}
				onkeydown={(event) => {
					if (event.key !== 'Enter') return;
					event.preventDefault();
					settler.flush();
				}} />
		</div>
		<select
			class="ui-select toolbar__filter"
			aria-label="Filter by track"
			value={trackId}
			onchange={(event) => applyParams({ trackId: event.currentTarget.value })}>
			<option value="">All tracks</option>
			{#each offeredTracks as track (track.id)}
				<option value={track.id}>{track.name}</option>
			{/each}
		</select>
		<select
			class="ui-select toolbar__filter"
			aria-label="Filter by format"
			value={formatId}
			onchange={(event) => applyParams({ formatId: event.currentTarget.value })}>
			<option value="">All formats</option>
			{#each offeredFormats as format (format.id)}
				<option value={format.id}>{format.name}</option>
			{/each}
		</select>
		<span class="ui-toolbar__spacer"></span>
		<button
			type="button"
			class="ui-button ui-button--secondary ui-button--sm"
			onclick={() => (addOpen = true)}>Add submission</button>
	</div>

	<!-- What the search did, in past tense, for the eye and for assistive tech at
	     once. It carries the settled query rather than the keystroke, so it
	     neither floods a screen reader nor describes a result set that is still
	     a word behind. -->
	{#if data?.search}
		<p class="found" role="status">
			{#if data.search.matched === 0}
				No submission matches <span class="found__query">“{data.search.query}”</span>
			{:else}
				<strong>{data.search.matched}</strong> of {data.search.scanned}
				{data.search.scanned === 1 ? 'submission' : 'submissions'} match
				<span class="found__query">“{data.search.query}”</span>
			{/if}
			<span class="found__scope">· searched {SUBMISSION_SEARCH_SCOPE}</span>
		</p>
	{/if}

	{#if loadFailure && data !== null}
		<!-- The kept rows are yesterday's truth; the notice says the re-read
		     behind them failed, in the port's own copy. Keyed so a fresh failure
		     replaces a dismissed one instead of inheriting its hidden state. -->
		{#key loadFailure}
			<Alert
				tone="danger"
				title="The submission list could not be refreshed"
				message={loadFailure.message} />
		{/key}
	{/if}

	{#if actFailure}
		{#key actFailure}
			<Alert tone="danger" title="The change was not applied" message={actFailure} dismissible />
		{/key}
	{/if}

	<div class="ui-table-wrap" class:is-refreshing={reload.visible} aria-busy={refreshing || undefined}>
		<table class="ui-table ui-table--multiline">
			<thead>
				<tr>
					<th class="col-check ui-pick-cell">
						<label class="ui-pick">
							<input
								type="checkbox"
								aria-label="Select all shown"
								checked={data !== null && data.rows.length > 0 && selected.length === data.rows.length}
								onchange={toggleAll} />
						</label>
					</th>
					<th>Submission</th>
					<th>Signals</th>
					<th class="ui-table__number col-avg">Reviews</th>
					<th>Decision</th>
					<th class="col-expand"><span class="ui-sr-only">Details</span></th>
				</tr>
			</thead>
			<tbody>
				{#if !data}
					{#if loadFailure}
						<!-- The list reads failed or refused before any rows landed: the
						     typed state replaces the skeletons, because a skeleton claims
						     work that is no longer happening. Only a retryable failure
						     offers a retry; a terminal refusal renders as the refusal. -->
						<tr>
							<td colspan="6">
								<div class="empty" role="alert">
									<p class="empty__title">The submissions could not be loaded.</p>
									<p class="empty__hint">{loadFailure.message}</p>
									{#if loadFailure.retryable}
										<div class="empty__actions">
											<button
												type="button"
												class="ui-button ui-button--secondary ui-button--sm"
												onclick={() => void load()}>Try again</button>
										</div>
									{/if}
								</div>
							</td>
						</tr>
					{:else}
					{#each Array(6) as _, index (index)}
						<!-- Mirrors the resolved multiline row cell-for-cell, so the row
						     height is set by the same table metrics as real rows. -->
						<tr aria-hidden="true">
							<td class="col-check"></td>
							<td>
								<span class="ui-table__primary title-line"><span class="ui-skeleton skeleton-line" style="inline-size: 18rem"></span><span class="ui-skeleton skeleton-chip"></span></span>
								<span class="ui-table__secondary"><span class="ui-skeleton skeleton-line" style="inline-size: 12rem"></span></span>
							</td>
							<td><span class="signals"><span class="ui-skeleton skeleton-chip skeleton-chip--wide"></span></span></td>
							<td class="ui-table__number">
								<span class="avg">
									<span class="avg__mark avg__pending">
										<span class="ui-skeleton skeleton-line avg__num" style="inline-size: 1.75rem"></span>
									</span>
								</span>
							</td>
							<td><span class="ui-skeleton skeleton-chip"></span></td>
							<td class="col-expand"><span class="ui-skeleton skeleton-action skeleton-action--icon"></span></td>
						</tr>
					{/each}
					{/if}
				{:else if data.rows.length === 0}
					<tr>
						<td colspan="6">
							<div class="empty">
								<!-- An empty list has two different causes and the rows cannot
								     tell them apart: nothing matched the words, or nothing is
								     in this tray at all. Naming the query and the fields it
								     ran against is what turns "nothing" into something a
								     person can act on. -->
								{#if search}
									<p class="empty__title">
										No submission here matches <span class="found__query">“{search}”</span>.
									</p>
									<p class="empty__hint">
										Searched {SUBMISSION_SEARCH_SCOPE} across
										{data.search?.scanned ?? 0}
										{(data.search?.scanned ?? 0) === 1 ? 'submission' : 'submissions'} in
										{trayLabels[tray]}{trackId || formatId ? ' under the current filters' : ''}.
										Try fewer words, or clear the search to see the tray.
									</p>
								{:else if tray === 'inbox' && !trackId && !formatId && openFormCount === 0}
									<!-- The common first visit: nothing has arrived because
									     nothing is open to arrive through. The empty list is
									     where that dawns on someone, so the way forward starts
									     here — not behind an area name they haven't learned yet. -->
									<p class="empty__title">
										No submissions yet — your call for proposals (CFP) isn't open.
									</p>
									<p class="empty__hint">
										Start from the standard application — a complete form you trim to fit —
										and submissions land here as they arrive. For speakers you already know,
										add their submission yourself.
									</p>
									<div class="empty__actions">
										<a class="ui-button ui-button--primary ui-button--sm" href="/app/forms?new=1"
											>Open a call for proposals</a>
										<button
											type="button"
											class="ui-button ui-button--secondary ui-button--sm"
											aria-haspopup="dialog"
											onclick={() => (addOpen = true)}>Add submission</button>
									</div>
								{:else if tray === 'inbox' && !trackId && !formatId && (openFormCount ?? 0) > 0}
									<p class="empty__title">
										Your call for proposals (CFP) is open — nothing has arrived yet.
									</p>
									<p class="empty__hint">
										Share the form's link where your speakers are, or add a submission
										yourself for the speakers you already know.
									</p>
									<div class="empty__actions">
										<a class="ui-button ui-button--secondary ui-button--sm" href="/app/forms"
											>Open Forms</a>
										<button
											type="button"
											class="ui-button ui-button--secondary ui-button--sm"
											aria-haspopup="dialog"
											onclick={() => (addOpen = true)}>Add submission</button>
									</div>
								{:else}
									<p class="empty__title">Nothing in {trayLabels[tray]} yet.</p>
									<p class="empty__hint">
										Adjust the filters, share the application form, or add a submission
										yourself to bring one in.
									</p>
								{/if}
							</div>
						</td>
					</tr>
				{:else}
					{#each sections as section (section.key)}
						{#if section.label}
							<!-- The funnel, worded in place: residence stays the tray above,
							     what each row still needs is the group it sits in. Counts are
							     computed from the rows on screen — under a search they count
							     the matches, which is what the eye is comparing them to. -->
							<tr class="station">
								<td colspan="6">
									<div class="station__line">
										<span class="station__label">{section.label}</span>
										<span class="station__count">{section.rows.length}</span>
										{#if section.key === 'review' && round}
											<span class="station__meta"
												>· {round.percentDone}% reviewed ·
												<!-- The deadline inks up as it closes in — status-colored
												     text, the quietest rung; a pill here would out-shout
												     the rows it sits between. -->
												<span
													class="due"
													class:due--warning={round.deadlineTone === 'warning'}
													class:due--danger={round.deadlineTone === 'danger'}
													>{round.dueLabel}</span></span>
											<a class="station__door" href="/app/review">See review →</a>
										{:else if section.key === 'deciding'}
											<a class="station__door" href="/app/decisions">Decide →</a>
										{:else if section.key === 'notice'}
											<a class="station__door" href="/app/decisions?scope=unnotified"
												>Send notices →</a>
										{/if}
									</div>
								</td>
							</tr>
						{/if}
						{#each section.rows as row (row.id)}
						<!-- The pointer target is the row; the switch is still the chevron
						     inside it, which is why no role or tabindex is added here. -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<tr
							class="row"
							class:is-open={expandedId === row.id}
							onclick={(event) => onRowPress(event, row.id)}>
							<!-- The pick zone is the whole cell, so selecting never competes
							     with the row's own press. -->
							<td class="col-check ui-pick-cell">
								<label class="ui-pick">
									<input
										type="checkbox"
										aria-label={`Select “${row.title}”`}
										checked={selected.includes(row.id)}
										onchange={() => toggleSelected(row.id)} />
								</label>
							</td>
							<td>
								<!-- Title and track are read as one judgment — what is this talk
								     about — so the track sits beside the title, not columns away. -->
								<span class="ui-table__primary title-line">
									<span class="title-line__text"
										><Marked text={row.title} ranges={rangesFor(row.id, SUBMISSION_FIELD_TITLE)} /></span>
									{#if isNew(row)}
										<!-- Arrived since the operator last looked, or within the day —
										     information, never urgency: the mark stays on the quietest
										     rung and fades on its own once both arms lapse (23 §4). -->
										<span class="ui-badge ui-badge--neutral title-line__new">New</span>
									{/if}
									<span class="ui-badge ui-badge--{trackAccent(row.trackId)}">{trackName(row.trackId)}</span>
								</span>
								<span class="ui-table__secondary">
									<!-- The submitter is a scan key, and once a profile has landed for
									     that address it is also the way to read who they are without
									     leaving the table. A name with no profile behind it stays plain
									     text: a control that opens nothing is worse than a word that
									     never claimed to be one. -->
									<span class="scan"
										>{#each row.speakers as speaker, index (speaker.email)}{@const profile =
											profiles[speaker.email]}{@const nameRanges = rangesFor(
											row.id,
											submissionSpeakerNameField(index)
										)}{#if index > 0}{', '}{/if}{#if profile}<ProfilePeek
												{profile}
												ranges={nameRanges} />{:else}<Marked
												text={speaker.name}
												ranges={nameRanges} />{/if}{/each}</span>
									· {formatName(row.formatId)}
									{#if row.source === 'direct_entry'}
										<!-- Provenance in one phrase — this row is here because an
										     organizer put it here, and that person vouches for it. -->
										· <span class="direct"
											>direct entry{#if row.enteredBy}{' '}by {row.enteredBy}{/if}</span>
									{/if}
									<!-- The arrival fact ends the sentence: the inbox's pulse, and
									     for an undecided row also how long it has waited. Relative
									     while it still reads as "recently" ("3 days ago"), the plain
									     calendar date once elapsed-time arithmetic stops helping —
									     the word "arrived" said nothing the position didn't. -->
									· <span class="arrived">{formatArrival(row.submittedAt, enteredAt)}</span>
								</span>
							</td>
							<td>
								<span class="signals">
									{#each row.signals as signal (signal.key)}
										<!-- Why a machine marked this row is reachable from the mark
										     itself, by press or by keyboard, and mirrored to the live
										     region. A hover tooltip never arrives on touch at all. -->
										<Popover
											label={`${signal.label} — why this signal is on “${row.title}”`}
											onreveal={() => (announcement = signalSentence(signal))}>
											{#snippet trigger()}
												<span class="ui-badge ui-badge--{signalTone[signal.family]}">{signal.label}</span>
											{/snippet}
											{#snippet children()}
												<p class="signal__rationale">{signal.rationale}</p>
												<p class="signal__source">
													{signal.source}{#if signal.score !== undefined}
														· confidence {signal.score.toFixed(2)}{/if}
												</p>
											{/snippet}
										</Popover>
									{/each}
									{#if row.setAsideBy}
										{@const Agent = markIcon.agent}
									<span class="ui-badge ui-badge--lavender"
										><Agent class="ui-badge__icon" aria-hidden="true" />{row.setAsideBy}</span
									>
									{/if}
								</span>
							</td>
							<td class="ui-table__number">
								{#if row.reviewCount > 0}
									{@const standing = standings[row.id]}
									<!-- The average alone. A bare “4.8 / 3” beside it reads as a score
									     out of three, which is the one thing it never means; the panel's
									     lead line says “4.8 average of 3 reviews” in words that cannot be
									     misread. -->
									<span class="avg">
										<span class="avg__mark">
											{#if standing}
												<!-- The number a person quotes, inked by where it stands. Every
												     sentence stays in the panel: a cell has no line to give one. -->
												<StandingMark {standing} form="figure" quiet context={row.title} />
											{:else}
												<!-- Reviews are in but no average came back — a real state here,
											     not a defensive branch. It used to render an en dash while the
											     no-reviews case rendered an em dash: two glyphs, two different
											     facts, and nothing telling them apart. -->
											{#if row.reviewAverage === undefined}
												<span class="absent">No average yet</span>
											{:else}
												<span class="avg__num">{row.reviewAverage.toFixed(1)}</span>
											{/if}
											{/if}
										</span>
									</span>
								{:else}
									<span class="absent">No reviews yet</span>
								{/if}
							</td>
							<td>
								{#if decisionBadge[row.decision]}
									{@const badge = decisionBadge[row.decision]!}
									{@const Outcome = badge.icon}
									<span class="ui-badge ui-badge--{badge.tone}"
										><Outcome class="ui-badge__icon" aria-hidden="true" />{badge.label}</span
									>
									{#if !row.notified && (row.decision === 'accepted' || row.decision === 'declined' || row.decision === 'waitlisted')}
										{@const Unnotified = statusIcon.unnotified}
										<span class="ui-badge ui-badge--warning"
											><Unnotified class="ui-badge__icon" aria-hidden="true" />Un-notified</span
										>
									{/if}
								{:else}
									<!-- The same word the decisions board uses for the same state, so
									     one state keeps one name across surfaces. It stays literally
									     true in every tray; that a set-aside or discarded submission
									     will not be decided is what the tray itself says. -->
									{@const NotDecided = statusIcon.notStarted}
									<span class="ui-badge ui-badge--neutral"
										><NotDecided class="ui-badge__icon" aria-hidden="true" />Not decided</span>
								{/if}
							</td>
							<td class="col-expand">
								<button
									type="button"
									class="ui-button ui-button--ghost ui-button--icon ui-button--sm expand"
									class:expand--open={expandedId === row.id}
									aria-expanded={expandedId === row.id}
									aria-label={`Details for “${row.title}”`}
									onclick={() => openRow(expandedId === row.id ? null : row.id)}>
									<ChevronDown size={15} />
								</button>
							</td>
						</tr>
						{#if expandedId === row.id}
							{#snippet trayActions()}
								{#if row.tray === 'set-aside'}
									<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('returnToInbox', [row.id])}>Move back to inbox</button>
								{:else if row.tray === 'discarded'}
									<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('restore', [row.id])}>Restore to inbox</button>
								{:else}
									<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('setAside', [row.id])}>Set aside</button>
									<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('discard', [row.id])}>Discard</button>
								{/if}
							{/snippet}
							<!-- Two buttons of equal weight; what they differ in and what either
							     costs is stated here, at the point of action. -->
							{#snippet fates()}
								Neither is sent to the submitter and both can be undone. Set aside is
								the softer one and an agent may do it for you; discard is firmer and
								only a person can. Either way the submission leaves the decision
								board.
							{/snippet}
							<tr class="detail-row">
								<td colspan="6">
									<SubmissionDetail
										submission={row}
										origin={row.decision === 'accepted' ? origins[row.id] : undefined}
										actions={trayActions}
										footnote={row.tray !== 'set-aside' && row.tray !== 'discarded' ? fates : undefined} />
								</td>
							</tr>
						{/if}
						{/each}
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
	{#if data && data.rows.length > 0}
		<!-- Under a search the rows are what matched, not what the tray holds, so
		     "showing N of <tray total>" would claim the query ran against a
		     population it never saw. The disclosure that matters is unchanged —
		     the corpus is itself a window — so the note reports what was searched
		     rather than what is shown, and the count line above says how much of
		     it matched. -->
		<!-- Dimmed with the rows it describes. The tray comes from the address,
		     which changes before the replacement lands, so mid-read this line
		     names the tray being loaded while the rows beneath it are still the
		     previous one's. Dimming puts it inside the same "being replaced"
		     block rather than leaving one confident sentence over stale rows —
		     and it holds its space, so nothing moves when the read settles. -->
		<p class="window-note" class:is-refreshing={reload.visible}>
			{#if data.search}
				Searched {data.search.scanned} of {data.trayTotals[tray]}
			{:else}
				Showing {data.rows.length} of {data.trayTotals[tray]}
			{/if}
			in {trayLabels[tray].toLowerCase()}{port.source.kind === 'sample'
				? ' — sample window until live data lands.'
				: '.'}
		</p>
	{/if}
</section>

{#if selected.length > 0}
	<div class="bulkbar" role="toolbar" aria-label="Bulk actions">
		<span class="bulkbar__count">{selected.length} selected</span>
		{#if tray === 'set-aside'}
			<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('returnToInbox', selected)}>Move back to inbox</button>
		{:else if tray === 'discarded'}
			<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('restore', selected)}>Restore</button>
		{:else}
			<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('setAside', selected)}>Set aside</button>
			<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('discard', selected)}>Discard</button>
		{/if}
		<button type="button" class="ui-button ui-button--ghost ui-button--sm" onclick={() => (selected = [])}>Clear</button>
	</div>
{/if}

<AddDirectEntryModal
	bind:open={addOpen}
	{port}
	{tracks}
	{formats}
	vocabReady={vocabLoaded}
	defaultTrackId={trackId}
	defaultFormatId={formatId}
	onvocabchanged={reloadVocab}
	onadded={() => void load()} />

<CommitReceipt onUndone={load} />

<p class="ui-sr-only" role="status">{announcement}</p>

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-3);
	}

	.trays {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-1);
	}

	.trays__tab {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-2);
		padding: var(--je-space-1) var(--je-space-3);
		border: 1px solid transparent;
		border-radius: var(--je-radius-round);
		background: transparent;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
		cursor: pointer;
	}

	.trays__tab:hover {
		background: var(--je-color-surface);
		color: var(--je-color-text);
	}

	.trays__tab--active {
		background: var(--je-color-mark-surface);
		border-color: var(--je-color-mark-border);
		color: var(--je-color-text);
		font-weight: 600;
	}

	.trays__count {
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
	}

	.head__denominator {
		margin: 0;
		margin-inline-start: auto;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.toolbar__search {
		inline-size: 16rem;
	}

	.toolbar__filter {
		inline-size: auto;
	}

	/* Sits between the toolbar and the table because it describes the table, and
	   a reader who has already looked past it has already looked past the rows
	   it is counting. Reserving its line whether or not a search is running
	   would hold a permanent empty band above every unsearched list, so it takes
	   its space only when it has something to say — and it appears above the
	   table rather than inside it, so arriving does not shift a row. */
	.found {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.found strong {
		color: var(--je-color-text);
		font-variant-numeric: tabular-nums;
	}

	/* The words the person typed, echoed back exactly. Quoted and set apart so a
	   query that happens to read like our own copy still looks like theirs. */
	.found__query {
		color: var(--je-color-text);
	}

	.found__scope {
		white-space: nowrap;
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
		inline-size: 5.5rem;
	}

	.skeleton-chip--wide {
		inline-size: 8rem;
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 10rem;
		border-radius: var(--je-radius-control);
	}

	.skeleton-action--icon {
		inline-size: var(--je-control-height-sm);
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
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.empty__actions {
		display: flex;
		justify-content: center;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-4);
	}

	.muted {
		color: var(--je-color-text-muted);
	}

	/* The average cell reserves the resolved figure's box from the first
	   skeleton paint onward: same width, same line box, whichever of the three
	   states a row is in. The standing read then lands as ink alone — a tint and
	   a phrase — and the column never moves under someone mid-scan. The width is
	   declared on the wrapper so the header cell and the body cells cannot
	   disagree about it. */
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

	/* One column, one edge. The header, the figures, the pending fills, and the
	   em dash standing for “not scored yet” all end where the column ends, so a
	   row with no average still reads as the same column as the rows above it. */
	.ui-table__number {
		text-align: end;
	}

	/* Both levels of the mark align to that edge too: the reserved box against
	   the cell, and the mark against the reserved box — otherwise the figure
	   floats at the start of a reservation sized for the widest mark this table
	   can draw. */
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

	/* An absence note, not a value: small and quiet in a number column, so the
	   eye still reads the scored rows as the column's content. Matches the
	   decisions board, because it is the same absence. */
	.absent {
		font-size: var(--je-font-size-xs);
		font-weight: 400;
		font-variant-numeric: normal;
		color: var(--je-color-text-subtle);
		white-space: nowrap;
	}

	/* Mirrors the resolved figure's numeral exactly, so the average that is
	   already known is shown at the size it will keep. */
	.avg__num {
		flex: 0 0 auto;
		font-size: var(--je-font-size-base);
		font-weight: 700;
		line-height: 1.375rem;
	}


	/* Speaker identity is a scan key on this surface; it keeps full ink even on
	   the metadata line. */
	.scan {
		color: var(--je-color-text);
		font-weight: 500;
	}

	.direct {
		color: var(--je-color-accent-lavender-strong);
	}

	/* The arrival fact ends the metadata sentence and stays one token: a
	   timestamp that wraps away from its own words reads as a different fact. */
	.arrived {
		white-space: nowrap;
		color: var(--je-color-text-subtle);
	}

	.title-line {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-width: 0;
	}

	/* One line, like every `ui-table__primary strong` in the product: wrapped
	   titles break the scan and leave the loading skeleton under-reserving the
	   row it stands in for. The full name stays in the expansion and labels. */
	.title-line__text {
		min-inline-size: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Station group headers as section bands: the same fill the column head
	   wears, so each station reads as its own titled slab rather than one more
	   row — the stations are together on one page, and visibly apart on it.
	   Scrolling is the whole navigation; no filter tier earns its clicks here.
	   Reading order is label, count, fact, way onward. */
	tr.station td {
		padding-block: var(--je-space-2);
		background: var(--je-color-page);
		border-block: 1px solid var(--je-color-border-strong);
		/* Flush, like the column head: the fill and its two hairlines carry the
		   separation. A faked white gap (a thick surface-colored border) was
		   tried and read as the previous row trailing dead space — a spacer
		   hack a table cannot honestly make. */
	}

	/* The deadline's ink follows its urgency — text color only, the quietest
	   rung of the loudness ladder. */
	.due--warning {
		color: var(--je-color-warning);
		font-weight: 600;
	}

	.due--danger {
		color: var(--je-color-danger);
		font-weight: 600;
	}

	.station__line {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-2);
		min-width: 0;
	}

	.station__label {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.station__count {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text);
	}

	.station__meta {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		min-width: 0;
	}

	.station__door {
		margin-inline-start: auto;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		white-space: nowrap;
		color: var(--je-color-action);
		text-decoration: none;
	}

	.station__door:hover {
		text-decoration: underline;
	}

	.signals {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-1);
	}

	.signal__rationale {
		margin: 0;
	}

	.signal__source {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.col-check {
		inline-size: 2rem;
	}

	.col-expand {
		inline-size: 2.5rem;
	}

	.expand :global(svg) {
		transition: rotate var(--je-duration-fast) var(--je-ease);
	}

	.expand--open :global(svg) {
		rotate: 180deg;
	}

	/* The whole row opens its detail, so the whole row says so. Only the data
	   rows: the detail, the empty state and the skeletons are not doors. The
	   hover tint the table already gives every row is the other half of the
	   affordance and is left alone. */
	tr.row {
		cursor: pointer;
	}

	/* Marked things tint; open things lift. The pair in hand keeps the table's
	   full surface brightness — on a white list a tint can only recede, and the
	   row being worked on must never read below its neighbours — so a lifted
	   boundary frames row and expansion as one raised unit instead. */
	tr.is-open td {
		border-bottom-color: transparent;
		background: var(--je-color-surface);
		border-top: 2px solid var(--je-color-border-strong);
	}

	tr.is-open td:first-child {
		border-inline-start: 2px solid var(--je-color-border-strong);
	}

	tr.is-open td:last-child {
		border-inline-end: 2px solid var(--je-color-border-strong);
	}

	.detail-row td {
		background: var(--je-color-surface);
		border-bottom: 2px solid var(--je-color-border-strong);
	}

	.detail-row td:first-child {
		border-inline-start: 2px solid var(--je-color-border-strong);
	}

	.detail-row td:last-child {
		border-inline-end: 2px solid var(--je-color-border-strong);
	}

	/* A reload dims the rows in place; tearing them down would make the person
	   lose their spot for a wait that is usually shorter than a blink. */
	.ui-table-wrap.is-refreshing tbody,
	.window-note.is-refreshing {
		opacity: 0.55;
		pointer-events: none;
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	.window-note {
		margin: var(--je-space-2) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.bulkbar {
		position: sticky;
		inset-block-end: var(--je-space-4);
		align-self: center;
		display: flex;
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

	@media (max-width: 920px) {
		.head__denominator {
			margin-inline-start: 0;
		}

		.toolbar__search {
			inline-size: 100%;
		}

		.bulkbar {
			inset-block-end: var(--je-space-3);
		}
	}
</style>
