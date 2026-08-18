<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ChevronDown, Search } from 'lucide-svelte';
	import type { SubmissionsPagePort } from '$lib/api/submissions-page-port';
	import { describePortFailure, type PortFailureView } from '$lib/api/port-failure';
	import {
		Alert,
		Badge,
		Marked,
		Popover,
		ScopeFilter,
		revealTarget,
		TrackChip,
		badgeFor,
		createSettler,
		markIcon,
		recordTable,
		shouldIgnoreRowPress,
		submissionTrayIcon,
		trackPending,
		type Scope
	} from '$lib/ui';
	import { matchFields, parseSearch, type MatchRange, type SearchMatch } from '$lib/api/search';
	import {
		submissionFields,
		submissionSpeakerNameField,
		SUBMISSION_FIELD_TITLE,
		SUBMISSION_SEARCH_SCOPE
	} from '$lib/api/searchable';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import AddDirectEntryModal from './AddDirectEntryModal.svelte';
	import SubmissionRecordDetail from './SubmissionRecordDetail.svelte';
	import SubmissionJourney from './SubmissionJourney.svelte';
	import {
		NO_TRACK_SCOPE,
		TRAY_ORDER,
		decisionCellFor,
		formatLabel,
		journeyOf,
		isNoTrackScope,
		noticeAge,
		noticeStatus,
		rowsInTrackScope,
		signalTone,
		trackLabel,
		trackOrder,
		trackQuery,
		trayLabels,
		trayScopes
	} from './submission-view';
	import { describeArrivalPulse } from '@jooevents/contracts';
	import type { SubmissionArrivalsView } from '$lib/api/submissions-page-port';
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

	// The address owns the query. Landing on a scoped link, changing a filter,
	// reloading, and pressing Back all arrive at this one place, so the rows on
	// screen are always the rows the URL describes.
	const tray = $derived(paramIn('tray', TRAY_ORDER, 'inbox'));
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
			// The untracked scope is not a track, so it is not a track filter: the
			// tray comes back whole and `rowsInTrackScope` narrows it below.
			trackId: trackQuery(trackId),
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
			// The standing marks, the submitter profiles, and the accepted rows'
			// schedule landings are independent reads of the same landed rows, so
			// none waits on another.
			const [marks] = await Promise.all([
				port.review.standings(landed.map((row) => row.id)),
				loadProfiles(landed, ticket),
				loadOrigins(landed, ticket)
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

	/*
	 * The arrival pulse: what is new, over a window the engine chose from this
	 * operator's own rotation and names beside its number. It answers the visit's
	 * first question — is there anything to look at, or not — before a single row
	 * is scanned. Null while unread or unmeasurable, and the head then says
	 * nothing about newness rather than guessing.
	 */
	let pulseView = $state<SubmissionArrivalsView | null>(null);
	const pulseWords = $derived(
		pulseView
			? describeArrivalPulse({
					pulse: pulseView.arrivals.pulse,
					timezone: pulseView.timezone,
					now: enteredAt.getTime()
				})
			: null
	);

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
		void port.arrivals.pulse().then((view) => (pulseView = view)).catch(() => {});
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
	 * and spam stay flat lists, because they are not decidable and a
	 * decided-then-spam row's badges already tell its story. A group with
	 * nothing in it does not render.
	 */
	/**
	 * The rows the current track scope selects.
	 *
	 * A real track is the port's own filter and nothing is dropped again here;
	 * the untracked scope is the one the port cannot express, so it narrows over
	 * the tray the port already returned whole. Every count on this surface
	 * reads from here, so the note under the table and the rows above it can
	 * never disagree.
	 */
	const scopedRows = $derived(rowsInTrackScope(data?.rows ?? [], trackId));

	const sections = $derived.by<StationSection[]>(() => {
		const rows = scopedRows;
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
			{ key: 'deciding' as const, label: 'Decision needed', rows: byStation.deciding },
			{ key: 'notice' as const, label: 'Results not sent', rows: byStation.notice },
			{ key: 'done' as const, label: 'Done', rows: byStation.done }
		].filter((section) => section.rows.length > 0);
	});

	/** The rows in the order they render — what j/k walks. */
	const orderedRows = $derived(sections.flatMap((section) => section.rows));

	// -------------------------------------------------------------------------
	// Where an accepted row went — the journey strip's Scheduled dot and the
	// expansion's durable door both read it, kept for the session. Null is an
	// answered read (never graduated, or reversed); absent means not asked yet,
	// which the strip renders as not-placed-yet until the batch lands.
	let origins = $state<Record<string, SubmissionOrigin | null>>({});

	/** One pass for the whole table's accepted rows, alongside the standings. */
	async function loadOrigins(rows: Submission[], ticket: number) {
		const ids = rows
			.filter((row) => row.decision === 'accepted' && !(row.id in origins))
			.map((row) => row.id);
		if (ids.length === 0) return;
		const found = await Promise.all(ids.map((id) => port.schedule.originOf(id)));
		if (ticket !== request) return;
		const next = { ...origins };
		ids.forEach((id, index) => (next[id] = found[index] ?? null));
		origins = next;
	}

	/**
	 * Arriving from elsewhere: `?submission=` lands on that row — its tray
	 * selected, hiding filters cleared, the row open, scrolled to, and marked —
	 * so a link handed over by a speaker record or an agent keeps its promise.
	 */
	const askedSubmission = $derived(param('submission'));
	// Outside the graph on purpose: remembers which arrival was answered.
	let revealedSubmission: string | null = null;

	$effect(() => {
		const id = askedSubmission;
		const ready = data?.rows;
		if (!ready || !id) {
			revealedSubmission = null;
			return;
		}
		if (revealedSubmission === id) return;
		revealedSubmission = id;
		const row = ready.find((entry) => entry.id === id);
		if (!row) return;
		void (async () => {
			await applyParams({
				search: null,
				trackId: null,
				formatId: null,
				tray: row.tray === 'inbox' ? null : row.tray
			});
			openRow(id);
			announcement = `“${row.title}” — its row is open.`;
			await tick();
			const shown = Array.from(
				document.querySelectorAll<HTMLElement>(`[data-submission="${id}"]`)
			).find((element) => element.offsetWidth > 0);
			revealTarget(shown ?? null);
		})();
	});

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

	function switchTray(next: string) {
		if (tray === next) return;
		// The default tray stays out of the address, so an unscoped link is clean.
		applyParams({ tray: next === 'inbox' ? null : next });
	}

	function toggleSelected(id: string) {
		selected = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
	}

	function toggleAll() {
		// "All shown" means the rows on screen, which under the untracked scope is
		// fewer than the tray holds.
		selected = selected.length === scopedRows.length ? [] : scopedRows.map((row) => row.id);
	}

	const triageCopy = {
		setAside: 'Set aside',
		returnToInbox: 'Moved back to the inbox',
		markSpam: 'Marked as spam',
		notSpam: 'Marked as not spam'
	} as const;

	async function act(action: keyof typeof triageCopy, ids: string[]) {
		const moved = (data?.rows ?? []).filter((row) => ids.includes(row.id));
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
				notUndoableReason: 'Use the destination tray action if this submission needs moving again.'
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
	// lists; naming below still resolves them, permanently.
	const offeredTracks = $derived(tracks.filter((track) => track.status === 'active'));
	const offeredFormats = $derived(formats.filter((format) => format.status === 'active'));

	/* Position in the event's own track list walks the accent palette from the
	   top, so a track wears one colour here, on the decision board, and on the
	   schedule — rather than a hash that can collide. */
	const trackIds = $derived(trackOrder(tracks));

	/* The four fates, as the mutually-exclusive scope set they are. Counts join
	   once the totals are known; the chips are equal-width either way, so the
	   number arrives without moving anything. */
	const trays = $derived<Scope[]>(
		trayScopes(data?.trayTotals ?? null).map((scope) => ({
			...scope,
			icon: submissionTrayIcon[scope.value]
		}))
	);

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
	<!-- Mutually exclusive scopes stay visible: four members, every one reachable
	     at 390px, no ragged wrap and nothing hidden behind an overflow. -->
	<div class="head__trays">
		<ScopeFilter label="Submission trays" scopes={trays} value={tray} onchange={switchTray} />
	</div>
	{#if data}
		<!-- The visit's first answer — is there anything new, or not — leads; the
		     custody arithmetic lives on the tray chips beside it, so this line no
		     longer recites four counts the chips already carry. The delta wears
		     the same neutral mark as a New row and the Overview tile: one
		     concept, one look. -->
		<p class="head__denominator">
			{#if pulseWords}
				{#if pulseWords.delta}
					<Badge tone="neutral" value={pulseWords.delta} />
				{:else}
					<span class="head__quiet">{pulseWords.quiet}</span>
				{/if}
				<span aria-hidden="true">·</span>
			{/if}
			<span class="head__total"
				>{Object.values(data.trayTotals).reduce((sum, count) => sum + count, 0)} total, all
				recoverable</span>
		</p>
	{:else}
		<p class="head__denominator" aria-hidden="true">
			<span class="ui-skeleton skeleton-line" style="inline-size: min(18rem, 100%)"></span>
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
			<!-- Submissions with no track are a real population an organizer has to
			     work through, so they are findable rather than merely visible. -->
			<option value={NO_TRACK_SCOPE}>No track</option>
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
		<!-- The attachment restores what a display change costs: table roles after
		     the row re-composes into a record, and the column names mirrored onto
		     the cells that stack. Below the columns' width the row becomes
		     rail · identity · state · affordance, so nothing leaves the screen. -->
		<table class="ui-table ui-table--multiline" {@attach recordTable()}>
			<thead>
				<tr>
					<th class="col-check ui-pick-cell">
						<label class="ui-pick">
							<input
								type="checkbox"
								aria-label="Select all shown"
								checked={data !== null && scopedRows.length > 0 && selected.length === scopedRows.length}
								onchange={toggleAll} />
						</label>
					</th>
					<th>Submission</th>
					<th>Signals</th>
					<th class="ui-table__number col-avg">Reviews</th>
					<th>Decision</th>
					<!-- How far along its line each row is — five dots the eye compares
					     straight down the page; the breakdown is one press away. -->
					<th class="col-journey">Progress</th>
					<!-- The clock the arrival groups sort by, in its own column: the
					     sorted value is exactly what earns a column, and one constant
					     right-edge slot is what lets the eye run down the page's
					     timeline without reading a sentence per row. -->
					<th class="ui-table__number col-when">Received</th>
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
							<td colspan="8">
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
							<td class="col-check ui-pick-cell"></td>
							<td class="ui-cell--lead">
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
							<td class="ui-cell--state"><span class="ui-skeleton skeleton-chip"></span></td>
							<td class="col-journey"><span class="ui-skeleton skeleton-dots"></span></td>
							<td class="ui-table__number col-when"><span class="when"><span class="ui-skeleton skeleton-line" style="inline-size: 4rem"></span></span></td>
							<td class="col-expand ui-cell--trail"><span class="ui-skeleton skeleton-action skeleton-action--icon"></span></td>
						</tr>
					{/each}
					{/if}
				{:else if scopedRows.length === 0}
					<tr>
						<td colspan="8">
							<div class="empty">
								<!-- An empty list has two different causes and the rows cannot
								     tell them apart: nothing matched the words, or nothing is
								     in this tray at all. Naming the query and the fields it
								     ran against is what turns "nothing" into something a
								     person can act on. -->
								{#if isNoTrackScope(trackId) && data.rows.length > 0}
									<!-- The scope is the answer: every submission in this tray
									     carries a track, which is the fact the operator came to
									     check. Naming it beats reporting an absence. -->
									<p class="empty__title">
										Every submission in {trayLabels[tray].toLowerCase()} has a track.
									</p>
									<p class="empty__hint">
										Nothing here is without one{search ? ' that matches your search' : ''}.
										Choose “All tracks” to see the {data.rows.length} in this tray.
									</p>
								{:else if search}
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
								<td colspan="8">
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
											>Send results →</a>
										{/if}
									</div>
								</td>
							</tr>
						{/if}
						{#each section.rows as row (row.id)}
						{@const rowTrack = trackLabel(tracks, row.trackId)}
						{@const rowFormat = formatLabel(formats, row.formatId)}
						{@const decidedAt = noticeAge(row)}
						{@const cell = decisionCellFor(row, section.key)}
						<!-- The pointer target is the row; the switch is still the chevron
						     inside it, which is why no role or tabindex is added here. -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<tr
							class="row"
							class:is-open={expandedId === row.id}
							data-arrival-host
							data-submission={row.id}
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
							<td class="ui-cell--lead">
								<!-- Title and track are read as one judgment — what is this talk
								     about — so the track sits beside the title, not columns away.
								     A submission with no track draws nothing here: an empty
								     capsule is a defect, and the absence is said in words on the
								     metadata line below. -->
								<span class="ui-table__primary title-line">
									<span class="title-line__text"
										><Marked text={row.title} ranges={rangesFor(row.id, SUBMISSION_FIELD_TITLE)} /></span>
									{#if rowTrack.kind === 'named'}
										<TrackChip name={rowTrack.name} id={row.trackId} order={trackIds} />
									{/if}
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
									<!-- Facts join this sentence only when there is a fact: a blank
									     slot between two separators is how “Ingrid Halvorsen · ·
									     direct entry” shipped. An unassigned track is the one
									     absence worth stating, and it states itself on the quietest
									     rung — and it is a scope in the track filter above. -->
									<!-- The separator binds to the fact that follows it with a
									     no-break space, so a wrapped record never leaves a lone
									     interpunct hanging at the end of a line. -->
									{#if rowTrack.kind === 'none'}
										<span class="no-track">·&nbsp;No track</span>
									{/if}
									{#if rowFormat.kind === 'named'}
										·&nbsp;{rowFormat.name}
									{/if}
									{#if row.source === 'direct_entry'}
										<!-- Provenance in one phrase — this row is here because an
										     organizer put it here, and that person vouches for it. -->
										<span class="direct"
											>·&nbsp;direct entry{#if row.enteredBy}{' '}by {row.enteredBy}{/if}</span>
									{/if}
									<!-- The one clock that is pressure rather than information: a
									     decided row whose result was never sent. It stays in the
									     sentence and names itself, because it is not the arrival —
									     that clock now has its own column at the row's edge, where
									     the eye can run down the page's timeline. -->
									{#if decidedAt}
										<span class="arrived">·&nbsp;decided {formatArrival(decidedAt, enteredAt)}</span>
									{/if}
								</span>
							</td>
							<!-- Signals and the review average keep their place in the record as
							     labelled lines rather than moving into the detail. Both carry a
							     disclosure of their own — why a machine marked this row, where
							     this average stands — and a control a touch reader can only reach
							     by opening the row is a control they have lost.

							     A row with no signal has nothing to label, so its cell withdraws
							     from the record entirely: a lone "SIGNALS" over empty space is
							     the empty pill wearing a different costume. -->
							<td class:ui-cell--detail={row.signals.length === 0 && !row.setAsideBy}>
								<span class="signals">
									{#each row.signals as signal (signal.key)}
										<!-- Why a machine marked this row is reachable from the mark
										     itself, by press or by keyboard, and mirrored to the live
										     region. A hover tooltip never arrives on touch at all. -->
										<Popover
											label={`${signal.label} — why this signal is on “${row.title}”`}
											onreveal={() => (announcement = signalSentence(signal))}>
											{#snippet trigger()}
												<Badge tone={signalTone[signal.family]} value={signal.label} />
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
										<Badge tone="lavender" icon={markIcon.agent} value={row.setAsideBy} />
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
							<!-- The state cell, deduplicated against the group band above it:
							     inside a station group only what varies row to row renders here
							     — the verdict — while the constant fact ("Decision needed",
							     "Result not sent") is said once, on the band. Tone and glyph
							     still come from the shared status vocabulary, so the same state
							     cannot wear one loudness here and another on the decision board. -->
							<td class="ui-cell--state">
								{#if cell.status}
									<span class="decision">
										<Badge {...badgeFor(cell.status.key)} value={cell.status.label} />
										{#if cell.notice}
											<Badge {...badgeFor(noticeStatus.key)} value={noticeStatus.label} />
										{/if}
									</span>
								{:else if cell.absent}
									<span class="absent">{cell.absent}</span>
								{/if}
							</td>
							<td class="col-journey">
								<SubmissionJourney
									steps={journeyOf(row, {
										round,
										origin: origins[row.id],
										arrival: formatArrival(row.submittedAt, enteredAt)
									})}
									context={row.title}
									onreveal={() =>
										(announcement = `Progress on “${row.title}”.`)} />
							</td>
							<!-- The arrival, on every row, in one constant slot. The New mark
							     sits with the fact it qualifies — arrived since the operator
							     last looked, or within the day; information, never urgency
							     (23 §4). -->
							<td class="ui-table__number col-when">
								<span class="when">
									{#if isNew(row)}
										<Badge tone="neutral" value="New" />
									{/if}
									<span class="arrived">{formatArrival(row.submittedAt, enteredAt)}</span>
								</span>
							</td>
							<td class="col-expand ui-cell--trail">
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
								{:else if row.tray === 'spam'}
									<!-- The email pair's learned reversal: pressing it moves the
									     row back to the inbox, which the receipt then says. -->
									<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('notSpam', [row.id])}>Not spam — restore to inbox</button>
								{:else}
									<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('setAside', [row.id])}>Set aside</button>
									<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('markSpam', [row.id])}>Mark as spam</button>
								{/if}
							{/snippet}
							<!-- One clause, and only the half a reader cannot already see.
							     This was four lines grading the two buttons as "softer" and
							     "firmer" — a feeling, not a fact, and the reader still could not
							     choose between them because the outcome is the same. What
							     genuinely differs is who may do it, and that is already shown
							     where it happened: a row an agent set aside carries the agent's
							     own lavender mark. Attribution states it once, on the evidence,
							     instead of prose stating it on every row it might apply to. -->
							{#snippet fates()}
								Neither is sent to the submitter, and both can be undone.
							{/snippet}
							<tr class="detail-row ui-table__detail">
								<td colspan="8">
									<!-- One component, two presentations: the inline expansion stays
									     on desktop so a power user compares without losing the list,
									     and promotes to a full-screen sheet on a phone, where a
									     labelled two-column detail inside a 390px column is
									     unreadable. Dismissing the sheet must also close the row, or
									     the row stays open behind a sheet nobody can see. -->
									<SubmissionRecordDetail
										submission={row}
										track={rowTrack}
										format={rowFormat}
										trackOrder={trackIds}
										timezone={pulseView?.timezone}
										origin={row.decision === 'accepted' ? origins[row.id] : undefined}
										actions={trayActions}
										footnote={row.tray !== 'set-aside' && row.tray !== 'spam' ? fates : undefined}
										onclose={() => openRow(null)} />
								</td>
							</tr>
						{/if}
						{/each}
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
	{#if data && scopedRows.length > 0}
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
				Showing {scopedRows.length} of {data.trayTotals[tray]}
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
		{:else if tray === 'spam'}
			<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('notSpam', selected)}>Not spam — restore</button>
		{:else}
			<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('setAside', selected)}>Set aside</button>
			<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={busy} onclick={() => act('markSpam', selected)}>Mark as spam</button>
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

	/* The scope set is its own query container, so its inline size is resolved
	   without regard to its contents — in a shrink-to-fit slot that resolves to
	   zero and the chips vanish. It therefore gets a definite basis here, free
	   to grow into the head's slack and capped before four filters start
	   reading as a navigation bar. Below its own 30rem the primitive
	   re-composes into two even rows. */
	.head__trays {
		flex: 1 1 22rem;
		min-inline-size: 0;
		max-inline-size: 40rem;
	}

	.head__denominator {
		margin: 0;
		margin-inline-start: auto;
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* "Nothing new this week" is a fact an organizer came for, not an error and
	   not a zeroed chip — quiet words on the metadata rung. */
	.head__quiet {
		white-space: nowrap;
	}

	.head__total {
		white-space: nowrap;
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
	   the metadata line. The quiet sea role lets the eye find people down a
	   column of records without borrowing a status or action treatment. */
	.scan {
		color: var(--je-color-recognition-person);
		font-weight: 600;
	}

	/* Provenance is support, not a scan key: it descends to the sentence's own
	   muted rung (owner colour-noise pass, 2026-08-15). The lavender it used to
	   wear is the agent-attribution family, and a talk an organizer keyed in by
	   hand is exactly not an agent's act — one hue, one meaning. */
	.direct {
		color: var(--je-color-text-muted);
	}

	/* The one absence this surface states rather than leaves blank, on the
	   quietest rung of the metadata sentence. It is not a category, so it takes
	   no chip; it is findable, because the track filter carries the same scope. */
	.no-track {
		color: var(--je-color-text-subtle);
	}

	.decision {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1);
	}

	/* A time fact stays one token: a timestamp that wraps away from its own
	   words reads as a different fact. */
	.arrived {
		white-space: nowrap;
		color: var(--je-color-recognition-time);
		font-variant-numeric: tabular-nums;
	}

	/* The arrival column: one constant right-edge slot per row, so the eye can
	   run down the page's timeline without reading a sentence per row. Sized to
	   the widest phrase the vocabulary produces ("34 minutes ago") plus the New
	   mark that sometimes rides beside it. */
	.col-when {
		inline-size: 9rem;
	}

	.when {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--je-space-2);
		min-inline-size: 0;
	}

	/* Five dots and their press padding — the strip's own box sets the floor. */
	.col-journey {
		inline-size: 4.5rem;
	}

	/* Stands at the strip's height so the read lands without moving the row. */
	.skeleton-dots {
		display: inline-block;
		inline-size: 3.25rem;
		block-size: 1.4375rem;
		border-radius: var(--je-radius-round);
	}

	.title-line {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-width: 0;
	}

	/* One line while the row is a row: wrapped titles break the scan and leave
	   the loading skeleton under-reserving the row it stands in for. The full
	   name stays in the expansion and labels. */
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

	/*
	 * ══ The compact columns ══════════════════════════════════════════════════
	 *
	 * Between the record threshold and full width, the table is still columns —
	 * but its two reservations were sized for a 1166px wrapper and, measured at
	 * 906px, held the table 221px past its own edge (the metadata sentence's
	 * nowrap run set a ~540px floor under the lead column on top of them). In
	 * this range the reservations yield — the standing phrase ellipsizes into
	 * its popover, which is where the full evidence lives anyway — the arrival
	 * column sizes to its content, and the metadata sentence wraps exactly as
	 * the record presentation already lets it. Nothing leaves the screen and
	 * the wrapper never scrolls sideways.
	 */
	@container je-table (min-width: 52rem) and (max-width: 74rem) {
		.ui-table {
			--avg-w: 6rem;
		}

		.col-when {
			inline-size: auto;
		}

		.ui-table :global(.ui-table__secondary) {
			overflow: visible;
			text-overflow: clip;
			white-space: normal;
		}

		/* The identity column takes what the fixed columns leave rather than
		   demanding its longest title's width: the zero cap removes its
		   intrinsic claim from auto layout while the full-width claim hands it
		   every remaining pixel, the title's own ellipsis absorbs the
		   difference, and the sentence beneath wraps (above). */
		td.ui-cell--lead {
			inline-size: 100%;
			max-inline-size: 0;
		}
	}

	/*
	 * ══ The record ═══════════════════════════════════════════════════════════
	 *
	 * What this surface adds once the shared table has re-composed its rows.
	 * Last in the sheet on purpose: these are overrides of the column rules
	 * above, and a cascade order is easier to keep true than a specificity
	 * argument. The query asks the table wrapper, exactly as the primitive
	 * does, so the two can never disagree about when a row stops being a row.
	 */
	@container je-table (max-width: 51.99rem) {
		/* A record grows downward, which is the one direction a phone has: the
		   identifying value stops being an ellipsis the moment there is no
		   column to protect, and the track chip drops below the title rather
		   than squeezing the name it qualifies. */
		.title-line {
			flex-wrap: wrap;
		}

		.title-line__text {
			overflow: visible;
			text-overflow: clip;
			white-space: normal;
			/* And it takes the whole line, so what qualifies it follows underneath
			   with the record's full width to read in. Sharing the line squeezed
			   the track chip to 68px and truncated a category to "Mo…" — and the
			   full name lives in `title`, which is a pointer affordance a touch
			   reader never receives. */
			flex: 1 0 100%;
		}

		/* A category is a scan key, and at record width the chip has a line of
		   its own — so it wraps rather than truncating. The full name lives in
		   `title`, which is a pointer affordance a touch reader never receives,
		   so a clipped chip on a phone is a name nobody can recover. */
		.ui-table :global(.ui-track__label) {
			overflow: visible;
			text-overflow: clip;
			white-space: normal;
		}

		/* A labelled line below the primary line has the whole record to use.
		   The primitive leaves it in the identity column, which the state and
		   the affordance have already narrowed — measured at 390px that left a
		   value 41px of room and truncated a track name to "Mo…". */
		.ui-table.ui-table--multiline > tbody > tr > :global(td[data-label]) {
			grid-column: 2 / -1;
			/* A chip is a box drawn around a word; blockified into a grid cell it
			   would stretch to the column and read as a banner. */
			justify-items: start;
		}

		/* The average's reserved box exists so a column cannot reflow under a
		   reader mid-scan. A record has no column to protect, so the figure
		   sits with its own label instead of at a 12rem right edge. */
		.ui-table__number {
			text-align: start;
		}

		.avg {
			justify-content: flex-start;
		}

		.avg__mark {
			inline-size: auto;
		}

		/* At record width the arrival is a labelled line like any other; it
		   keeps its left edge with the record rather than a column's right one. */
		.when {
			justify-content: flex-start;
		}

		/* The header row keeps only its controls here, so the strip is the band
		   rather than one cell of it wearing the column-head fill alone. The
		   group still lays out as a table header inside a block table, which
		   shrink-wraps it to the width of the one control it kept — 56px of
		   grey floating over a 358px record. */
		thead {
			display: block;
		}

		thead tr {
			background: var(--je-color-page);
		}

		thead th {
			background: none;
		}

		/* The station band is a sentence and a door; at record width it wraps
		   rather than pushing the door past the edge. */
		.station__line {
			flex-wrap: wrap;
		}

		.station__door {
			margin-inline-start: 0;
		}

		/* At record width the open row's frame belongs to the table primitive,
		   and the detail itself has promoted to a sheet — so the cell keeps no
		   painted strip of its own. Two boundaries around nothing read as a
		   hole cut in the list. */
		.detail-row td {
			border: 0;
			background: none;
		}
	}

	/*
	 * A phone, where the record has no width to spare. A decided row carries
	 * two states, and side by side they took 210px of a 334px record — leaving
	 * the title 68px and truncating its track to "Mo…". Capped, the second
	 * state stacks under the first and the identity keeps the room it needs.
	 */
	@container je-table (max-width: 30rem) {
		.ui-cell--state {
			max-inline-size: 7rem;
		}
	}
</style>
