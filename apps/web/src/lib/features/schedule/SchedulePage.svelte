<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Modal from '$lib/ui/Modal.svelte';
	import {
		Badge,
		Button,
		ChoiceGroup,
		Field,
		Popover,
		Radio,
		RecordDetail,
		RecordField,
		TrackChip,
		badgeFor,
		markArrivalGroup,
		revealTarget,
		trackAccent,
		trackPending
	} from '$lib/ui';
	import type {
		ScheduleAttachCandidate,
		SchedulePagePort,
		SchedulePublicationReview
	} from '$lib/api/schedule-page-port';
	import { describePortFailure } from '$lib/api/port-failure';
	import { presentProgramRoomCapacity } from '$lib/api/program-vocabulary-presentation';
	import {
		scheduleClockLabel,
		scheduleDayLabel,
		scheduleRangeLabel,
		scheduleRoomName
	} from '$lib/api/session-placement';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { applyParams, clearParams, param } from '$lib/features/workspace/url-state.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import InlineVocabAdd from '$lib/features/workspace/components/InlineVocabAdd.svelte';
	import ProfilePeek from '$lib/features/workspace/components/ProfilePeek.svelte';
	import {
		columnSegments,
		dayLengthMin,
		defaultStart,
		landsOnOrigin,
		neighborsAt,
		preflight,
		snapStart,
		type ColumnSegment,
		type NeighborAnchors,
		type SnapResult
	} from './placement-engine';
	import {
		groupHeading,
		isRoundupTray,
		placedInTray,
		programGrouping,
		trayLabel,
		type ProgramGroupRow,
		type RoundupTray
	} from './program-roundup';
	import {
		boardBlankCopy,
		boardReadiness,
		placementAvailability,
		placementBlockedCopy
	} from './board-readiness';
	import type {
		BreakBlock,
		Format,
		Placement,
		PlacementConflict,
		ScheduleState,
		SessionItem,
		SessionSpeaker,
		SessionState,
		SpeakerProfile,
		SpeakerRow,
		Submission,
		Track
	} from '$lib/api/types';

	interface Props {
		port: SchedulePagePort;
	}

	let { port }: Props = $props();
	const api = $derived(port);

	let schedule = $state.raw<ScheduleState | null>(null);
	let tracks = $state.raw<Track[]>([]);
	let formats = $state.raw<Format[]>([]);
	let roster = $state.raw<SpeakerRow[]>([]);
	let busy = $state(false);
	let publishReason = $state('');
	/** The drafted release a person is reading, between the two presses. */
	let publishReview = $state<SchedulePublicationReview | null>(null);
	let announcement = $state('');
	let breakModalError = $state('');
	let breakActionError = $state('');
	let conflictsPanel = $state<HTMLElement>();
	let programPanel = $state<HTMLElement>();
	const activeTracks = $derived(tracks.filter((track) => track.status === 'active'));

	// A placement, removal, or publish re-reads the schedule. That is a reload,
	// not a first load: the grid and its panels keep what they are showing and
	// dim until the new state lands.
	let refreshing = $state(false);
	const reload = trackPending(() => refreshing);

	/* Who is on the sessions this board holds, keyed by the roster address the
	   engagement is recorded against. Null is a read that came back with nothing,
	   and it is kept: a speaker without a profile is the ordinary case. Absent
	   means "not asked yet", which renders as the plain name it already was. */
	let profiles = $state<Record<string, SpeakerProfile | null>>({});

	/** Only the newest pass may replace the map, so an older read cannot clobber it. */
	let profileSeq = 0;

	function profileOf(speaker: SessionSpeaker): SpeakerProfile | null {
		return profiles[speaker.email] ?? null;
	}

	/**
	 * One pass for the whole board, after the sessions are on screen. A session
	 * speaker carries their address, so the lookup is direct; only addresses
	 * this session has never asked about are read, so the re-read that follows
	 * every placement, publish, and undo costs nothing.
	 */
	async function loadProfiles() {
		const seq = ++profileSeq;
		const emails = [
			...new Set(
				(schedule?.sessions ?? []).flatMap((session) =>
					session.speakers.map((speaker) => speaker.email)
				)
			)
		].filter((email) => !(email in profiles));
		if (emails.length === 0) return;
		const found = await Promise.all(emails.map((email) => api.speakers.profile(email)));
		if (seq !== profileSeq) return;
		const next = { ...profiles };
		emails.forEach((email, index) => (next[email] = found[index]));
		profiles = next;
	}

	/**
	 * Open proposals per collecting session — an honest total counted by the
	 * API over the whole submission table, never a row-window filter here.
	 */
	let proposals = $state.raw<Record<string, number>>({});

	async function load() {
		refreshing = true;
		try {
			const [next, targets, people] = await Promise.all([
				api.schedule.state(),
				api.schedule.proposalTargets(),
				// Graduation and direct entry grow the roster from other surfaces,
				// so the board's copy travels with every re-read.
				api.speakers.list()
			]);
			// The page owns a snapshot of the returned state so a committed placement
			// renders immediately without a full route reload.
			schedule = { ...next, placements: [...next.placements], breaks: [...next.breaks] };
			proposals = targets;
			roster = people;
		} finally {
			refreshing = false;
		}
		// After the board lands, not with it: a card's speaker line keeps its
		// metrics either way, so a profile arriving late changes ink and nothing else.
		await loadProfiles();
	}

	/**
	 * The template the public schedule page publishes from, resolved by kind so
	 * the door renders only when the surface actually exists.
	 */
	let scheduleSurfaceId = $state<string | null>(null);

	onMount(async () => {
		void api.templates.list().then(({ surfaces }) => {
			scheduleSurfaceId = surfaces.find((surface) => surface.kind === 'schedule')?.id ?? null;
		});
		// The roster travels with the vocabularies: it is what turns a name printed
		// on a card back into the person the profile belongs to.
		[tracks, formats, roster] = await Promise.all([
			api.vocab.tracks(),
			api.vocab.formats(),
			api.speakers.list()
		]);
		await load();
	});

	const rooms = $derived(schedule?.rooms ?? []);
	const days = $derived(schedule?.days ?? []);

	// The selected day is shareable state: a link can name the day it means, and
	// an unknown or absent one falls back to the first day of the event.
	const dayKey = $derived.by(() => {
		const asked = param('day');
		return asked && days.some((day) => day.key === asked) ? asked : (days[0]?.key ?? '');
	});
	const slotMinutes = $derived(schedule?.slotMinutes ?? 30);

	/*
	 * Without rooms or days there is no grid to draw, only the way in — and
	 * *which* way in depends on which supply is missing, so the blank state is
	 * derived rather than written. `board-readiness.ts` carries the reasoning
	 * and its tests; the page only renders the answer.
	 */
	const readiness = $derived(boardReadiness(schedule));
	const boardReady = $derived(readiness.ready);
	const blankCopy = $derived(boardBlankCopy(readiness));

	/**
	 * Whether the board can accept a placement at all. The pool's "Place…" used
	 * to render from the row alone, so a board with no grid offered a control
	 * that opened a mode with nothing in it. Now the reason is stated once,
	 * where the rows are, and the control that cannot work is not drawn.
	 */
	const placeability = $derived(placementAvailability(schedule));
	const canPlace = $derived(placeability.kind === 'available');
	const placementBlocked = $derived(placementBlockedCopy(placeability));

	const dayStartMin = $derived.by(() => {
		const [hour = 0, minute = 0] = (schedule?.dayStart ?? '00:00').split(':').map(Number);
		return hour * 60 + minute;
	});
	const dayLength = $derived(schedule ? dayLengthMin(schedule) : 0);
	const activeRooms = $derived(rooms.filter((room) => room.status === 'active'));

	// ------------------------------------------------------------------
	// Placement mode: the grid becomes the interface. Everything here is
	// ephemeral interface state — nothing reaches the URL or the server until
	// the confirm dialog commits through the ordinary place operation.

	let placing = $state.raw<SessionItem | null>(null);
	let placingOrigin = $state.raw<Placement | null>(null);
	let boardRegion = $state<HTMLElement>();

	/**
	 * Where the pointer (or keyboard focus) is currently proposing to land.
	 * The source decides whether the ghost carries the Enter cue: it teaches a
	 * key only to someone driving by keyboard, and never churns beside a pointer.
	 */
	let aim = $state.raw<
		({ dayKey: string; roomId: string; source: 'pointer' | 'keyboard' } & SnapResult) | null
	>(null);

	/**
	 * The aim has walked back onto the slot the session already occupies.
	 *
	 * The ghost stands for what will be true after the click, so here it must
	 * stop promising a move: landing on the origin commits nothing and stands the
	 * mode down. Same rectangle, different claim — "unchanged", not "new".
	 */
	const aimOnOrigin = $derived(
		aim !== null && landsOnOrigin(placingOrigin, aim.dayKey, aim.roomId, aim.startMin)
	);

	let confirmOpen = $state(false);
	let confirmDay = $state('');
	let confirmRoom = $state('');
	let confirmStart = $state(0);
	let confirmNote = $state<string | null>(null);

	/**
	 * The card-free space of every column, partitioned for the session in hand.
	 * Openings accept it; blocked bands stay visible with their reason (a gap
	 * too short, its speaker on another stage). Retired rooms offer nothing new
	 * — their header already carries the "retired" label.
	 *
	 * Every day is computed even though the board keeps showing one at a time
	 * (owner revision, 2026-08-11: entering the mode must not re-lay-out the
	 * board a person was just reading): the other days' results feed the quick
	 * picks and the per-day opening counts on the day switcher, which together
	 * carry the cross-day question without crowding the grid.
	 */
	const segmentsByColumn = $derived.by(() => {
		const map = new Map<string, ColumnSegment[]>();
		if (!placing || !schedule) return map;
		for (const day of schedule.days) {
			for (const room of schedule.rooms) {
				if (room.status !== 'active') continue;
				map.set(`${day.key}|${room.id}`, columnSegments(schedule, placing, day.key, room.id));
			}
		}
		return map;
	});

	/** How many openings each day offers the session in hand — the day switch's answer to "is switching worth it?". */
	const openingsPerDay = $derived.by(() => {
		const counts = new Map<string, number>();
		if (!placing) return counts;
		for (const day of days) {
			let total = 0;
			for (const room of rooms) {
				total += (segmentsByColumn.get(`${day.key}|${room.id}`) ?? []).filter(
					(segment) => segment.kind === 'open'
				).length;
			}
			counts.set(day.key, total);
		}
		return counts;
	});

	/**
	 * Entering the mode surfaces no new element on desktop: the control that was
	 * pressed transforms in place (pool "Place…" becomes Cancel on the same
	 * element, so pointer focus never moves; a card's Move hands to the origin
	 * card's Cancel). Keyboard entry goes to the first opening, where the ghost
	 * and its Enter cue appear. Narrow/touch gets the bottom strip, and the tap
	 * scrolls its destination — the board — into view.
	 */
	async function enterPlacement(session: SessionItem, viaKeyboard = false) {
		placing = session;
		placingOrigin = schedule?.placements.find((entry) => entry.sessionId === session.id) ?? null;
		aim = null;
		const here = openingsPerDay.get(dayKey) ?? 0;
		announcement = `${placingOrigin ? 'Moving' : 'Placing'} “${session.title}” — ${here} opening${here === 1 ? '' : 's'} highlighted on ${dayLabel(dayKey)}; the day buttons count the others. Choose an opening; Escape cancels.`;
		await tick();
		// The pool panel can grow tall, so "Place…" can be pressed far beneath
		// the calendar. Entering the mode brings the board back only when
		// its top has actually been scrolled past — a board already in view stays
		// exactly where it is. One rule for every viewport; on a single-column
		// layout the pool is always below, so this is also the mobile scroll.
		if ((boardRegion?.getBoundingClientRect().top ?? 0) < 0) {
			boardRegion?.scrollIntoView({ block: 'start' });
		}
		if (viaKeyboard) {
			const opening = boardRegion?.querySelector<HTMLElement>('.opening');
			if (opening) {
				opening.focus();
				return;
			}
		}
		// Pointer move-entry: the Move control left with its card, so focus hands
		// to its successor — the origin card's Cancel — without scrolling.
		if (placingOrigin) {
			document.getElementById('origin-cancel')?.focus({ preventScroll: true });
		}
	}

	function exitPlacement(returnFocus: boolean) {
		const session = placing;
		placing = null;
		placingOrigin = null;
		aim = null;
		confirmOpen = false;
		if (session && returnFocus) {
			void tick().then(() => {
				const home =
					document.getElementById(`placed-${session.id}`) ??
					document.getElementById(`pool-${session.id}`);
				home?.focus();
			});
		}
	}

	function cancelPlacement() {
		announcement = 'Placement cancelled.';
		exitPlacement(true);
	}

	/**
	 * The pointer's way out, matching Escape's.
	 *
	 * Aiming is a mode entered with the pointer, and until now it could only be
	 * left with the keyboard or by finding the Cancel control that moved with the
	 * card. The press that means "not this" on every other grid means it here.
	 * An armed removal stands down first, exactly as Escape treats it, so one
	 * press never does two things.
	 */
	function cancelOnRightClick(event: MouseEvent) {
		if (confirmOpen || breakOpen) return;
		if (armedRemoveId || armedBreakId) {
			event.preventDefault();
			disarmRemove();
			disarmBreak();
			return;
		}
		if (!placing) return;
		event.preventDefault();
		cancelPlacement();
	}

	// Dialogs own their Escape; a press while an in-place popover has focus is
	// that popover closing itself. Everything else exits the mode. Enter in the
	// confirm dialog commits from anywhere that is not a button — a button keeps
	// its own native Enter, so Cancel can never be overridden into a commit.
	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && confirmOpen) {
			if (event.target instanceof HTMLButtonElement) return;
			if (busy || confirmBlocked || !placing) return;
			event.preventDefault();
			void commitPlacement();
			return;
		}
		if (event.key !== 'Escape' || confirmOpen || breakOpen || newSessionOpen !== false) return;
		if (event.target instanceof Element && event.target.closest('.ui-popover')) return;
		// An armed removal stands down first; the mode survives the same press.
		if (armedRemoveId || armedBreakId) {
			disarmRemove();
			disarmBreak();
			return;
		}
		if (placing) cancelPlacement();
	}

	function segmentAt(event: { currentTarget: EventTarget | null; clientY: number }, segment: ColumnSegment): number {
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		return (
			segment.startMin +
			((event.clientY - rect.top) / rect.height) * (segment.endMin - segment.startMin)
		);
	}

	function aimAt(day: string, room: string, segment: ColumnSegment, event: PointerEvent) {
		if (!placing) return;
		const snapped = snapStart(segment, placing, slotMinutes, segmentAt(event, segment));
		aim = { dayKey: day, roomId: room, source: 'pointer', ...snapped };
	}

	function clearAim() {
		aim = null;
	}

	/** Keyboard focus proposes the flush-after-previous default, made visible. */
	function focusAim(day: string, room: string, segment: ColumnSegment) {
		aim = { dayKey: day, roomId: room, source: 'keyboard', ...defaultStart(segment, placing?.durationMin) };
	}

	/**
	 * The second click chooses. A pointer takes its aimed, snapped position; a
	 * keyboard activation (detail 0) takes the flush default — precision then
	 * belongs to the confirm dialog's typed time, never to aiming.
	 */
	function chooseOpening(day: string, room: string, segment: ColumnSegment, event: MouseEvent) {
		if (!placing) return;
		const snapped =
			event.detail === 0
				? defaultStart(segment, placing.durationMin)
				: snapStart(segment, placing, slotMinutes, segmentAt(event, segment));
		openConfirm(day, room, snapped);
	}

	/**
	 * The confirm dialog exists to get a decision about a change. A move that
	 * lands on its origin has none to decide, so the mode stands down and says
	 * so — asking anyway trains someone to dismiss the one dialog they are meant
	 * to read. Only a move reaches this: a session from the pool has no origin.
	 */
	function openConfirm(day: string, room: string, snapped: SnapResult) {
		const session = placing;
		if (session && landsOnOrigin(placingOrigin, day, room, snapped.startMin)) {
			announcement = `Move cancelled — “${session.title}” is already at ${dayLabel(day)} ${clockLabel(snapped.startMin)}, ${roomName(room)}.`;
			exitPlacement(true);
			return;
		}
		confirmDay = day;
		confirmRoom = room;
		confirmStart = snapped.startMin;
		confirmNote = snapped.note;
		confirmOpen = true;
	}

	const confirmConflicts = $derived.by<PlacementConflict[]>(() => {
		if (!placing || !schedule || !confirmOpen) return [];
		return preflight(schedule, placing, confirmDay, confirmRoom, confirmStart);
	});
	const confirmBlocked = $derived(confirmConflicts.some((c) => c.severity === 'block'));
	const confirmEnd = $derived(confirmStart + (placing?.durationMin ?? 0));

	/**
	 * The occupants around the current start, recomputed as it changes — the
	 * relative-to-neighbour register of the dialog, and (the modal covers the
	 * grid, entirely so on a phone) its only view of what sits nearby.
	 */
	const confirmNeighbors = $derived.by<NeighborAnchors>(() => {
		if (!placing || !schedule || !confirmOpen) return {};
		return neighborsAt(schedule, placing, confirmDay, confirmRoom, confirmStart);
	});

	function setConfirmStart(startMin: number, note: string | null) {
		confirmStart = clampStart(startMin);
		confirmNote = note;
	}

	function clockToOffset(value: string): number | null {
		const [hour, minute] = value.split(':').map(Number);
		if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
		return hour * 60 + minute - dayStartMin;
	}

	function clampStart(offset: number): number {
		return Math.min(Math.max(0, offset), Math.max(0, dayLength - (placing?.durationMin ?? 0)));
	}

	function onConfirmTime(event: Event) {
		const value = (event.currentTarget as HTMLInputElement).value;
		if (!value) return;
		const offset = clockToOffset(value);
		if (offset === null) return;
		confirmStart = clampStart(offset);
		confirmNote = null;
	}

	function nudge(deltaMin: number) {
		confirmStart = clampStart(confirmStart + deltaMin);
		confirmNote = null;
	}

	async function commitPlacement() {
		const session = placing;
		if (!session || busy || confirmBlocked) return;
		const previous = placingOrigin;
		const day = confirmDay;
		// The dialog's typed and nudged time can walk back onto the origin after
		// the aim landed somewhere else, so the no-op is caught here too. Left
		// alone it would spend a write and an undo receipt on a change the
		// schedule already reflects — a worse outcome than the pointless dialog,
		// because the receipt claims something happened.
		if (landsOnOrigin(previous, day, confirmRoom, confirmStart)) {
			announcement = `Move cancelled — “${session.title}” is already at ${dayLabel(day)} ${clockLabel(confirmStart)}, ${roomName(confirmRoom)}.`;
			exitPlacement(true);
			return;
		}
		busy = true;
		await api.schedule.place(session.id, day, confirmRoom, confirmStart);
		recordAction({
			area: 'schedule',
			label: `${previous ? 'Moved' : 'Placed'} “${session.title}” — ${dayLabel(day)} ${clockLabel(confirmStart)}, ${roomName(confirmRoom)}`,
			undo: previous
				? async () => {
						await api.schedule.place(session.id, previous.dayKey, previous.roomId, previous.startMin);
					}
				: async () => {
						await api.schedule.unplace(session.id);
					}
		});
		exitPlacement(false);
		await applyParams({ day });
		publishReason = '';
		await load();
		busy = false;
		// The commit is the user's own act, so focus lands on where the session went.
		void tick().then(() => reveal(document.getElementById(`placed-${session.id}`)));
	}


	// ------------------------------------------------------------------
	// Breaks: typed time reservations — the precision tool that never asks the
	// mouse to aim. Their edges become the flush anchors placement snaps to.

	let breakOpen = $state(false);
	let addingBreak = $state(false);
	let breakLabel = $state('Break');
	let breakDay = $state('');
	let breakStartClock = $state('12:00');
	let breakDuration = $state('15');
	let breakRooms = $state<Record<string, boolean>>({});

	function openAddBreak() {
		breakModalError = '';
		breakLabel = 'Break';
		breakDay = dayKey;
		breakStartClock = clockLabel(Math.min(Math.max(dayLength - 60, 0), 180));
		breakDuration = '15';
		breakRooms = Object.fromEntries(activeRooms.map((room) => [room.id, true]));
		breakOpen = true;
	}

	const breakReady = $derived.by(() => {
		const offset = clockToOffset(breakStartClock);
		const duration = Number(breakDuration);
		return (
			breakLabel.trim().length > 0 &&
			offset !== null &&
			offset >= 0 &&
			offset + duration <= dayLength &&
			activeRooms.some((room) => breakRooms[room.id])
		);
	});

	async function addBreakSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (!breakReady || addingBreak) return;
		const offset = clockToOffset(breakStartClock);
		if (offset === null) return;
		const duration = Number(breakDuration);
		const label = breakLabel.trim();
		const chosen = activeRooms.filter((room) => breakRooms[room.id]);
		addingBreak = true;
		breakModalError = '';
		try {
			const created = await api.schedule.addBreak({
				label,
				dayKey: breakDay,
				roomIds: chosen.map((room) => room.id),
				startMin: offset,
				durationMin: duration
			});
			recordAction({
				area: 'schedule',
				label: `Added “${label}” — ${dayLabel(breakDay)} ${clockLabel(offset)}, ${
					created.length === 1 ? roomName(created[0].roomId) : `${created.length} rooms`
				}`,
				undo: async () => api.schedule.removeBreaks(created.map((brk) => brk.id))
			});
			breakOpen = false;
			await applyParams({ day: breakDay });
			publishReason = '';
			await load();
		} catch (error) {
			const failure = describePortFailure(error, 'The break could not be added. Try again.');
			breakModalError = `The break wasn’t added. ${failure.message}`;
			announcement = breakModalError;
		} finally {
			addingBreak = false;
		}
	}

	// A break removal arms exactly like a session removal: the armed state veils
	// the block itself with an explicit confirm (see armRemove for the rationale).
	let armedBreakId = $state<string | null>(null);
	let disarmBreakTimer: ReturnType<typeof setTimeout> | undefined;

	function armBreak(brk: BreakBlock) {
		armedBreakId = brk.id;
		armedRemoveId = null;
		clearTimeout(disarmBreakTimer);
		disarmBreakTimer = setTimeout(() => (armedBreakId = null), 6000);
		announcement = `Confirm removing the “${brk.label}” break.`;
		void tick().then(() => document.getElementById(`confirm-break-${brk.id}`)?.focus());
	}

	function disarmBreak() {
		clearTimeout(disarmBreakTimer);
		armedBreakId = null;
	}

	function confirmBreakRemoval(brk: BreakBlock) {
		disarmBreak();
		void removeBreakNow(brk);
	}

	async function removeBreakNow(brk: BreakBlock) {
		if (busy) return;
		busy = true;
		breakActionError = '';
		try {
			await api.schedule.removeBreaks([brk.id]);
			recordAction({
				area: 'schedule',
				label: `Removed “${brk.label}” from ${dayLabel(brk.dayKey)} ${clockLabel(brk.startMin)}, ${roomName(brk.roomId)}`,
				undo: async () => {
					await api.schedule.restoreBreaks([brk.id]);
				}
			});
			publishReason = '';
			await load();
		} catch (error) {
			const failure = describePortFailure(error, 'The break could not be removed. Try again.');
			breakActionError = `The break wasn’t removed. ${failure.message}`;
			announcement = breakActionError;
		} finally {
			busy = false;
		}
	}

	// ------------------------------------------------------------------

	// Rooms are minted where they are missed, on the board itself.
	let addRoomOpen = $state(false);
	let addingRoom = $state(false);
	let newRoomName = $state('');
	let newRoomCapacity = $state<number | null>(null);
	let newRoomInput = $state<HTMLInputElement>();
	const roomReady = $derived(
		newRoomName.trim().length > 0 && newRoomCapacity !== null && newRoomCapacity > 0
	);

	async function openAddRoom() {
		addRoomOpen = !addRoomOpen;
		if (!addRoomOpen) return;
		await tick();
		newRoomInput?.focus();
	}

	async function addRoom(event: SubmitEvent) {
		event.preventDefault();
		if (!roomReady || addingRoom) return;
		addingRoom = true;
		const room = await api.vocab.addRoom(newRoomName.trim(), newRoomCapacity ?? 0);
		recordAction({
			area: 'schedule',
			label: `Added room “${room.name}” — ${presentProgramRoomCapacity(room.capacity).label}`,
			undo: async () => {
				await api.vocab.removeRoom(room.id);
			}
		});
		newRoomName = '';
		newRoomCapacity = null;
		addRoomOpen = false;
		await load();
		addingRoom = false;
	}

	const placedIds = $derived(new Set((schedule?.placements ?? []).map((p) => p.sessionId)));
	const dayPlacements = $derived((schedule?.placements ?? []).filter((p) => p.dayKey === dayKey));

	// ------------------------------------------------------------------
	// The Program panel: the round-up worklist. Grouped by what still stands
	// between each session and done — placed, peopled, decided — so the pool is
	// the single home of remaining program work, not only of unplaced rows.
	// A collecting session is placeable as a planned slot (16 §6); placement
	// never implies publication.

	const grouping = $derived(
		schedule ? programGrouping(schedule, new Map(Object.entries(proposals)), activeTracks.length > 0) : null
	);

	/**
	 * A scoped arrival (`?tray=…`) filters the panel to the tray it names, and
	 * the panel takes the tray's name as its heading for as long as it holds, so
	 * the scope is read where the rows are rather than beside them. The scope
	 * lives only in the URL, and one control gives the whole pool back.
	 */
	const trayFilter = $derived.by<RoundupTray | null>(() => {
		const asked = param('tray');
		return isRoundupTray(asked) ? asked : null;
	});

	const trayRows = $derived.by<ProgramGroupRow[]>(() => {
		if (!grouping || !trayFilter) return [];
		const rows: ProgramGroupRow[] = [];
		for (const group of grouping.order) {
			for (const row of grouping.groups.get(group) ?? []) {
				if (row.trays.includes(trayFilter)) rows.push(row);
			}
		}
		return rows;
	});

	/** A row offers Place… only when it is classified and holds no slot. */
	function placeable(row: ProgramGroupRow): boolean {
		return !row.placed
			&& row.session.state !== 'draft'
			&& !row.trays.includes('needs-track');
	}

	/**
	 * Rows that would take a slot if the board could hold one. The panel says
	 * why placement is unavailable only when somebody is actually waiting on
	 * it — an all-draft pool on a grid-less board has nothing to explain.
	 */
	const awaitingPlacement = $derived.by(() => {
		if (!grouping) return 0;
		let total = 0;
		for (const group of grouping.order) {
			for (const row of grouping.groups.get(group) ?? []) if (placeable(row)) total += 1;
		}
		return total;
	});

	function proposalsLabel(count: number): string {
		return count === 0 ? 'no proposals yet' : `${count} proposal${count === 1 ? '' : 's'}`;
	}

	// ------------------------------------------------------------------
	// New session: direct creation — the fixed keynote entered as fact, the
	// private sketch, the collecting container opened before any submission.
	// Speakers are deliberately absent here; attribution has one grammar (the
	// speakers panel), so a free-text name field cannot reintroduce strings.
	//
	// One dialog, two doors: the Program panel header (the worklist home — a
	// created session starts unplaced there) and the board's Add row (standing
	// at the grid, so its primary is Create and place…). A modal, matching how
	// the product creates every other named thing (New event, New form) — and
	// dismissal is parking: the draft survives until a create lands.

	let newSessionOpen = $state<false | 'panel' | 'board'>(false);
	let creatingSession = $state(false);
	let nsTitle = $state('');
	let nsFormatId = $state('');
	let nsTrackId = $state('');
	let nsDuration = $state('30');
	let nsDurationTouched = $state(false);
	let nsState = $state<SessionState>('programmed');
	let nsTitleInput = $state<HTMLInputElement>();

	const nsReady = $derived(
		nsTitle.trim().length > 0 &&
			nsFormatId !== '' &&
			Number(nsDuration) > 0 &&
			(nsState === 'draft' || activeTracks.length === 0 || nsTrackId !== '')
	);

	/** Enter commits the door's own primary: place-bound from the board, pool-bound from the panel. */
	const nsPlaceIsPrimary = $derived(newSessionOpen === 'board' && nsState !== 'draft' && canPlace);

	/**
	 * A dismissed form keeps what was typed: closing is parking, not
	 * discarding, so Escape or a click elsewhere never costs the title someone
	 * was mid-way through. The fields reset only after a create lands (or on a
	 * full reload, with everything else). Plain let — this is bookkeeping about
	 * the draft's freshness, not view state.
	 */
	let nsStarted = false;

	async function openNewSession(origin: 'panel' | 'board') {
		newSessionOpen = newSessionOpen === origin ? false : origin;
		if (!newSessionOpen) return;
		if (!nsStarted) {
			nsStarted = true;
			nsVocabNote = '';
			nsTitle = '';
			nsFormatId = formats.find((format) => format.status === 'active')?.id ?? '';
			nsTrackId = activeTracks.length === 1 ? activeTracks[0]!.id : '';
			nsDurationTouched = false;
			nsDuration = String(formatDefault(nsFormatId));
			nsState = 'programmed';
		}
		await tick();
		nsTitleInput?.focus();
	}

	/** What was minted in place, said in place — the sourced-options note. */
	let nsVocabNote = $state('');

	/**
	 * Vocabulary minted where it is chosen (the direct-entry pattern, 22):
	 * dedup against the live list first — an existing name is selected, not
	 * duplicated — and the new entry is selected and usable immediately.
	 */
	async function addFormatInline(name: string) {
		const existing = formats.find(
			(format) => format.name.trim().toLowerCase() === name.trim().toLowerCase()
		);
		if (existing) {
			nsFormatId = existing.id;
			onNsFormatChange();
			nsVocabNote = `“${existing.name}” already exists — selected.`;
			return;
		}
		const created = await api.vocab.addFormat(name);
		formats = await api.vocab.formats();
		nsFormatId = created.id;
		onNsFormatChange();
		nsVocabNote = `“${created.name}” added to the event's formats and selected.`;
	}

	async function addTrackInline(name: string) {
		const existing = tracks.find(
			(track) => track.name.trim().toLowerCase() === name.trim().toLowerCase()
		);
		if (existing) {
			nsTrackId = existing.id;
			nsVocabNote = `“${existing.name}” already exists — selected.`;
			return;
		}
		const created = await api.vocab.addTrack(name);
		tracks = await api.vocab.tracks();
		nsTrackId = created.id;
		nsVocabNote = `“${created.name}” added to the event's tracks and selected.`;
	}

	function formatDefault(formatId: string): number {
		return formats.find((format) => format.id === formatId)?.defaultDurationMin ?? slotMinutes;
	}

	/** The format's planned length fills the field until a typed value owns it. */
	function onNsFormatChange() {
		if (!nsDurationTouched) nsDuration = String(formatDefault(nsFormatId));
	}

	async function createSession(andPlace: boolean) {
		if (!nsReady || creatingSession) return;
		creatingSession = true;
		const created = await api.schedule.createSession({
			title: nsTitle.trim(),
			trackId: nsTrackId,
			formatId: nsFormatId,
			durationMin: Number(nsDuration),
			state: nsState
		});
		recordAction({
			area: 'schedule',
			label: `Created “${created.title}” — ${
				nsState === 'draft' ? 'draft' : nsState === 'collecting' ? 'collecting proposals' : 'in the program'
			}`,
			undo: async () => {
				const outcome = await api.schedule.removeSession(created.id);
				if (!outcome.ok) announcement = `Could not undo the creation — ${outcome.reason}.`;
			}
		});
		newSessionOpen = false;
		// The draft landed; the next open starts fresh.
		nsStarted = false;
		await load();
		creatingSession = false;
		if (andPlace) {
			const session = schedule?.sessions.find((entry) => entry.id === created.id);
			if (session) {
				await enterPlacement(session);
				return;
			}
		}
		void tick().then(() => reveal(document.getElementById(`pool-${created.id}`)));
	}

	// ------------------------------------------------------------------
	// Track repair. Existing permissive heads stay truthful until an organizer
	// classifies them; this is the named deterministic door that prevents a
	// legacy omission from becoming an unrepairable program fact.

	let trackRepairId = $state<string | null>(null);
	let repairTrackId = $state('');
	let repairingTrack = $state(false);
	const trackRepairSession = $derived(
		trackRepairId ? (schedule?.sessions.find((session) => session.id === trackRepairId) ?? null) : null
	);

	function openTrackRepair(session: SessionItem) {
		trackRepairId = session.id;
		repairTrackId = activeTracks.length === 1 ? activeTracks[0]!.id : '';
	}

	async function repairTrack(event: SubmitEvent) {
		event.preventDefault();
		if (!trackRepairSession || repairTrackId === '' || repairingTrack) return;
		repairingTrack = true;
		try {
			const updated = await api.schedule.retargetSession(
				trackRepairSession.id,
				trackRepairSession.formatId,
				repairTrackId
			);
			const track = activeTracks.find((candidate) => candidate.id === updated.trackId);
			recordAction({
				area: 'schedule',
				label: `Set “${updated.title}” to ${track?.name ?? 'its selected track'}`
			});
			trackRepairId = null;
			await load();
		} catch (error) {
			announcement = error instanceof Error ? error.message : 'The track could not be updated.';
		} finally {
			repairingTrack = false;
		}
	}

	/**
	 * The lifecycle writer's manual door: a draft or collecting session joins
	 * the program as editorial fact. Open proposals are never decided by this —
	 * the confirm copy says so where it matters (the button's own label names
	 * the consequence; proposals stay in Decisions).
	 */
	async function addToProgram(row: ProgramGroupRow) {
		if (busy) return;
		if (activeTracks.length > 0 && row.session.trackId === '') {
			openTrackRepair(row.session);
			return;
		}
		busy = true;
		const session = row.session;
		const outcome = await api.schedule.transitionSession(session.id, 'programmed');
		if (outcome.ok) {
			recordAction({
				area: 'schedule',
				label: `Added “${session.title}” to the program${
					row.proposalCount > 0
						? ` — ${proposalsLabel(row.proposalCount)} stay in Decisions`
						: ''
				}`,
				notUndoableReason:
					'This session is now in the program. Correct its format, track, speakers, or schedule in place.'
			});
		} else {
			announcement = outcome.reason;
		}
		await load();
		busy = false;
	}

	// ------------------------------------------------------------------
	// The speakers dialog: attribution's home (21 §5), addressable as
	// `?panel=speakers&session=…`, opened from a named control — never from a
	// card body. People-first: the roster leads, an accepted talk arrives as
	// the people on it, and a new person is one form away; a placeholder stays
	// honestly empty until then. The dialog names its session and slot so the
	// thread is never lost mid-attribution.

	const speakersForId = $derived(param('panel') === 'speakers' ? param('session') : null);
	const speakersSession = $derived(
		speakersForId ? (schedule?.sessions.find((entry) => entry.id === speakersForId) ?? null) : null
	);

	/** Where the session stands right now — the dialog's continuity cue. */
	const speakersContext = $derived.by(() => {
		const session = speakersSession;
		if (!session) return '';
		const placement = schedule?.placements.find((entry) => entry.sessionId === session.id);
		const where = placement
			? `${dayLabel(placement.dayKey)} ${clockLabel(placement.startMin)} · ${roomName(placement.roomId)}`
			: 'not placed yet';
		return `${session.durationMin} min · ${formatName(session.formatId)} · ${where}`;
	});

	/** One query narrows every way in: names, addresses, accepted talk titles. */
	let spQuery = $state('');

	function speakerMatches(text: string): boolean {
		const query = spQuery.trim().toLowerCase();
		if (!query) return true;
		return text.toLowerCase().includes(query);
	}

	/** Provenance per origin submission, loaded with the panel. */
	let origins = $state.raw<{ id: string; title: string; source: Submission['source']; speakerEmails: string[] }[]>([]);
	let attachable = $state.raw<ScheduleAttachCandidate[]>([]);
	let originsSeq = 0;

	async function loadSpeakersPanel(sessionId: string) {
		const seq = ++originsSeq;
		const [nextOrigins, nextAttachable] = await Promise.all([
			api.schedule.sessionOrigins(sessionId),
			api.schedule.attachCandidates(sessionId)
		]);
		if (seq !== originsSeq) return;
		origins = nextOrigins;
		attachable = nextAttachable;
	}

	function openSpeakers(session: SessionItem) {
		spQuery = '';
		addPersonOpen = false;
		void applyParams({ panel: 'speakers', session: session.id }, { history: 'push' });
	}

	function closeSpeakers() {
		void clearParams(['panel', 'session']);
	}

	function provenanceOf(speaker: SessionSpeaker): string {
		const origin = origins.find((entry) => entry.speakerEmails.includes(speaker.email));
		if (!origin) return 'added from the roster';
		if (origin.source === 'direct_entry') return 'direct entry';
		return `via “${origin.title}”`;
	}

	/**
	 * Roster people not yet on this session — the editorial-add candidates.
	 * Offered only while their engagement is standing: someone who declined,
	 * cancelled, or asked to cancel is not proposed for more program.
	 */
	const rosterCandidates = $derived.by(() => {
		const session = speakersSession;
		if (!session) return [];
		const held = new Set(session.speakers.map((speaker) => speaker.email));
		return roster.filter(
			(row) =>
				!held.has(row.email) &&
				(row.state === 'invited' || row.state === 'confirmed') &&
				speakerMatches(`${row.name} ${row.email}`)
		);
	});

	/**
	 * Accepted talks whose people are not yet on this session, person-first:
	 * the row leads with who arrives and says what they bring — adding them
	 * links their talk, co-speakers included, with provenance kept.
	 */
	const acceptedCandidates = $derived.by(() =>
		attachable.filter((submission) =>
			speakerMatches(
				`${submission.speakers.map((speaker) => speaker.name).join(' ')} ${submission.title}`
			)
		)
	);

	/** How many ways in exist before the query narrows them — the search scope. */
	const candidateScope = $derived.by(() => {
		const session = speakersSession;
		if (!session) return { people: 0, talks: 0 };
		const held = new Set(session.speakers.map((speaker) => speaker.email));
		return {
			people: roster.filter(
				(row) => !held.has(row.email) && (row.state === 'invited' || row.state === 'confirmed')
			).length,
			talks: attachable.length
		};
	});

	/** Closed copy for the engagement words a candidate row may show. */
	const engagementCopy: Record<SpeakerRow['state'], string> = {
		invited: 'invited',
		confirmed: 'confirmed',
		declined: 'declined',
		cancel_requested: 'asked to cancel',
		cancelled: 'cancelled'
	};

	let addPersonOpen = $state(false);
	let apName = $state('');
	let apEmail = $state('');
	let attributing = $state(false);
	const apReady = $derived(apName.trim().length > 0 && apEmail.includes('@'));

	async function afterAttribution(sessionId: string) {
		await load();
		await loadSpeakersPanel(sessionId);
		attributing = false;
	}

	async function attach(session: SessionItem, submission: ScheduleAttachCandidate) {
		if (attributing) return;
		attributing = true;
		const outcome = await api.schedule.attachSubmission(session.id, submission.id);
		if (outcome.ok) {
			recordAction({
				area: 'schedule',
				label: submission.moveFrom
					? `Moved “${submission.title}” from “${submission.moveFrom.sessionTitle}” to “${session.title}”`
					: `Attached “${submission.title}” to “${session.title}”`,
				undo: async () => {
					await api.schedule.detachSubmission(session.id, submission.id);
				}
			});
		} else {
			announcement = outcome.reason;
		}
		await afterAttribution(session.id);
	}

	async function addDirect(event: SubmitEvent) {
		event.preventDefault();
		const session = speakersSession;
		if (!session || !apReady || attributing) return;
		attributing = true;
		const person = { name: apName.trim(), email: apEmail.trim() };
		const outcome = await api.schedule.addDirectParticipant(session.id, person);
		if (outcome.ok) {
			recordAction({
				area: 'schedule',
				label: `Added ${person.name} to “${session.title}” — direct entry`,
				undo: async () => {
					await api.schedule.removeParticipant(session.id, person.email);
				}
			});
			apName = '';
			apEmail = '';
			addPersonOpen = false;
		} else {
			announcement = outcome.reason;
		}
		await afterAttribution(session.id);
	}

	async function addFromRoster(session: SessionItem, row: SpeakerRow) {
		if (attributing) return;
		attributing = true;
		const outcome = await api.schedule.addParticipantFromRoster(session.id, row.id);
		if (outcome.ok) {
			recordAction({
				area: 'schedule',
				label: `Added ${row.name} to “${session.title}”`,
				undo: async () => {
					await api.schedule.removeParticipant(session.id, row.email);
				}
			});
		} else {
			announcement = outcome.reason;
		}
		await afterAttribution(session.id);
	}

	// Removal arms in place (R6): the first press turns the control into the
	// question; anywhere else disarms. Fully undoable via the receipt either way.
	let armedParticipant = $state<string | null>(null);
	let disarmParticipantTimer: ReturnType<typeof setTimeout> | undefined;

	function armParticipant(email: string) {
		armedParticipant = email;
		clearTimeout(disarmParticipantTimer);
		disarmParticipantTimer = setTimeout(() => (armedParticipant = null), 4000);
	}

	async function removeParticipant(session: SessionItem, speaker: SessionSpeaker) {
		clearTimeout(disarmParticipantTimer);
		armedParticipant = null;
		if (attributing) return;
		attributing = true;
		const outcome = await api.schedule.removeParticipant(session.id, speaker.email);
		if (outcome.ok) {
			recordAction({
				area: 'schedule',
				label: `Removed ${speaker.name} from “${session.title}”`,
				// Restore through the roster row the person kept, so undo returns
				// the same identity rather than minting a second record for them.
				undo: async () => {
					const row = (await api.speakers.list()).find((entry) => entry.email === speaker.email);
					if (row) await api.schedule.addParticipantFromRoster(session.id, row.id);
					else await api.schedule.addDirectParticipant(session.id, speaker);
				}
			});
		} else {
			announcement = outcome.reason;
		}
		await afterAttribution(session.id);
	}

	type SessionParticipantRole = NonNullable<SessionSpeaker['role']>;

	async function changeParticipantRole(
		session: SessionItem,
		speaker: SessionSpeaker,
		role: SessionParticipantRole
	) {
		const previous = speaker.role ?? 'speaker';
		if (attributing || previous === role) return;
		attributing = true;
		const outcome = await api.schedule.changeParticipantRole(session.id, speaker.email, role);
		if (outcome.ok) {
			recordAction({
				area: 'schedule',
				label: `Changed ${speaker.name} to ${role}`,
				undo: async () => {
					await api.schedule.changeParticipantRole(session.id, speaker.email, previous);
				}
			});
		} else {
			announcement = outcome.reason;
		}
		await afterAttribution(session.id);
	}

	async function moveParticipant(session: SessionItem, index: number, direction: -1 | 1) {
		if (attributing) return;
		const destination = index + direction;
		if (destination < 0 || destination >= session.speakers.length) return;
		const before = session.speakers.map((speaker) => speaker.email);
		const after = [...before];
		const [moved] = after.splice(index, 1);
		if (!moved) return;
		after.splice(destination, 0, moved);
		attributing = true;
		const outcome = await api.schedule.reorderParticipants(session.id, after);
		if (outcome.ok) {
			recordAction({
				area: 'schedule',
				label: `Reordered speakers on “${session.title}”`,
				undo: async () => {
					await api.schedule.reorderParticipants(session.id, before);
				}
			});
		} else {
			announcement = outcome.reason;
		}
		await afterAttribution(session.id);
	}

	interface ConflictRow {
		key: string;
		placement: Placement;
		session: SessionItem;
		conflict: PlacementConflict;
	}

	const conflictRows = $derived.by<ConflictRow[]>(() => {
		if (!schedule) return [];
		const rows: ConflictRow[] = [];
		for (const placement of schedule.placements) {
			const session = schedule.sessions.find((s) => s.id === placement.sessionId);
			if (!session) continue;
			placement.conflicts.forEach((conflict, index) => {
				rows.push({ key: `${placement.sessionId}-${index}`, placement, session, conflict });
			});
		}
		return rows.sort((a, b) => Number(b.conflict.severity === 'block') - Number(a.conflict.severity === 'block'));
	});

	const blockingCount = $derived(conflictRows.filter((row) => row.conflict.severity === 'block').length);
	const warningCount = $derived(conflictRows.length - blockingCount);

	function sessionOf(id: string): SessionItem | undefined {
		return schedule?.sessions.find((session) => session.id === id);
	}

	function roomName(id: string): string {
		return scheduleRoomName(rooms, id) ?? id;
	}

	function dayLabel(key: string): string {
		return scheduleDayLabel(days, key) ?? key;
	}

	/**
	 * Whether the board can actually show this day. A placement whose day is not
	 * in the derived list is real and committed but undrawable, and its row must
	 * not offer a door to a column that does not exist — nor print the raw key,
	 * which is a machine date wearing a label's clothes.
	 */
	function dayIsDrawable(key: string): boolean {
		return boardReady && days.some((day) => day.key === key);
	}

	function trackName(id: string): string {
		return tracks.find((track) => track.id === id)?.name ?? 'Unassigned track';
	}

	/**
	 * The event's own track order, which is what makes an accent mean the same
	 * thing here as on every other surface. The local three-colour helper this
	 * replaced resolved a real programme into two hues plus "no colour", so the
	 * stripe taught a reader nothing; the shared palette carries eight.
	 */
	const trackIds = $derived(tracks.map((track) => track.id));

	/** The word for a session's stage, for the record's labelled detail. */
	const sessionStateLabel: Record<SessionState, string> = {
		programmed: 'In the program',
		collecting: 'Collecting proposals',
		draft: 'Private sketch'
	};

	/**
	 * Which pool row has its labelled detail open. One at a time, local state:
	 * a disclosure over facts the row already implies is not a surface worth
	 * addressing, unlike the speakers dialog beside it.
	 */
	let detailId = $state<string | null>(null);

	/**
	 * A format's own label may already carry its nominal length, so only the
	 * leading name is shown beside a session's actual duration.
	 */
	function formatName(id: string): string {
		const name = formats.find((format) => format.id === id)?.name;
		return name ? (name.split('·')[0] ?? name).trim() : id;
	}

	function clockLabel(offsetMin: number): string {
		return scheduleClockLabel(schedule?.dayStart ?? '00:00', offsetMin);
	}

	function rangeLabel(startMin: number, durationMin: number): string {
		return scheduleRangeLabel(schedule?.dayStart ?? '00:00', startMin, durationMin);
	}

	function reasonsFor(placement: Placement, severity: PlacementConflict['severity']): string {
		return placement.conflicts
			.filter((conflict) => conflict.severity === severity)
			.map((conflict) => conflict.reason)
			.join(' · ');
	}

	// Remove still arms in place, but the armed state veils the card's own face
	// with an explicit confirmation. The confirm control sits at a different
	// position than the trigger, so an accidental double-click cannot remove;
	// Keep, Escape, focus leaving, or the timer all stand down.
	let armedRemoveId = $state<string | null>(null);
	let disarmTimer: ReturnType<typeof setTimeout> | undefined;

	function armRemove(session: SessionItem) {
		armedRemoveId = session.id;
		armedBreakId = null;
		clearTimeout(disarmTimer);
		disarmTimer = setTimeout(() => (armedRemoveId = null), 6000);
		announcement = `Confirm removing “${session.title}” from the schedule.`;
		void tick().then(() => document.getElementById(`confirm-remove-${session.id}`)?.focus());
	}

	function disarmRemove() {
		clearTimeout(disarmTimer);
		armedRemoveId = null;
	}

	function keepPlacement(session: SessionItem) {
		disarmRemove();
		document.getElementById(`placed-${session.id}`)?.focus();
	}

	function confirmRemoval(session: SessionItem, placement: Placement) {
		disarmRemove();
		void remove(session, placement);
	}

	/** Standing down when focus leaves the veil for anywhere outside it. */
	function veilFocusout(event: FocusEvent) {
		const next = event.relatedTarget as Node | null;
		if (next && (event.currentTarget as HTMLElement).contains(next)) return;
		disarmRemove();
		disarmBreak();
	}

	async function remove(session: SessionItem, placement: Placement) {
		if (busy) return;
		busy = true;
		await api.schedule.unplace(session.id);
		recordAction({
			area: 'schedule',
			label: `Removed “${session.title}” from ${dayLabel(placement.dayKey)} ${clockLabel(placement.startMin)}`,
			undo: async () => {
				await api.schedule.place(session.id, placement.dayKey, placement.roomId, placement.startMin);
			}
		});
		publishReason = '';
		await load();
		busy = false;
	}

	/**
	 * First press: draft the release and read back what publishing would make
	 * public. Nothing has changed at this point — the draft exists server-side
	 * as a revision, and only `confirmPublish` commits it.
	 */
	async function reviewPublish() {
		if (busy) return;
		busy = true;
		publishReason = '';
		const result = await api.schedule.draftPublication();
		if ('ok' in result) publishReason = result.reason;
		else publishReview = result;
		busy = false;
	}

	function cancelPublish() {
		publishReview = null;
		publishReason = '';
	}

	/** Second press: publish exactly the draft on screen. */
	async function confirmPublish() {
		if (busy || !publishReview) return;
		busy = true;
		publishReason = '';
		const result = await api.schedule.publishReviewed(publishReview);
		if (!result.ok) publishReason = result.reason;
		else {
			publishReview = null;
			recordAction({
				area: 'schedule',
				label: 'Published the schedule',
				notUndoableReason: 'A published schedule rolls back by publishing a corrected successor.'
			});
			await load();
		}
		busy = false;
	}

	/**
	 * Arrival is a shared concern, so the scroll/focus/mark trio lives in
	 * `$lib/ui`. The grid is a crowd of similar cards, so a placed session is
	 * marked; a panel asked for by name is not.
	 */
	const reveal = revealTarget;

	/**
	 * The head count's jump to the conflicts panel. The address gains the
	 * panel's name so the landing is shareable; a repeat press while already
	 * scoped re-reveals instead of writing the same address again.
	 */
	function openConflictsPanel() {
		if (param('panel') === 'conflicts') {
			void tick().then(() => reveal(conflictsPanel ?? null, { mark: false }));
			return;
		}
		void applyParams({ panel: 'conflicts' }, { history: 'push' });
	}

	async function showOnGrid(placement: Placement) {
		await applyParams({ day: placement.dayKey });
		await tick();
		reveal(document.getElementById(`placed-${placement.sessionId}`));
	}

	/**
	 * Arriving from elsewhere: `?session=` lands on the session itself — on its
	 * day and focused when it is placed, on its pool row when it is not — and
	 * `?panel=conflicts` lands on the list that is holding publication.
	 */
	const askedSession = $derived(param('session'));
	const askedPanel = $derived(param('panel'));

	// Plain lets, deliberately outside the graph: they record what has already
	// been answered so a re-render cannot steal focus back a second time.
	let revealedSession: string | null = null;
	let revealedPanel: string | null = null;

	$effect(() => {
		const id = askedSession;
		const ready = schedule;
		// While the speakers panel names the session, the address means the
		// panel, not a second scroll-and-mark arrival on the same record.
		if (!ready || !id || askedPanel === 'speakers') {
			revealedSession = null;
			return;
		}
		if (revealedSession === id) return;
		revealedSession = id;
		const session = ready.sessions.find((entry) => entry.id === id);
		const placement = ready.placements.find((entry) => entry.sessionId === id);
		if (!session) return;
		announcement = placement
			? `${session.title} — ${dayLabel(placement.dayKey)} ${clockLabel(placement.startMin)}, ${roomName(placement.roomId)}.`
			: `${session.title} is not placed yet; it is waiting in the program pool.`;
		if (placement) void showOnGrid(placement);
		else void tick().then(() => reveal(document.getElementById(`pool-${id}`)));
	});

	$effect(() => {
		const panel = askedPanel;
		const ready = schedule;
		if (!ready || panel !== 'conflicts') {
			revealedPanel = null;
			return;
		}
		if (revealedPanel === panel) return;
		revealedPanel = panel;
		void tick().then(() => reveal(conflictsPanel ?? null, { mark: false }));
	});

	// A scoped tray arrival lands on the Program panel the way `?panel=conflicts`
	// lands on Conflicts: by name, no mark — the panel takes the tray's name
	// while it is scoped, so its heading is what answers.
	//
	// The grid is the other half of the same arrival. A tray's placed sessions
	// are already on the board, where they are cards among cards saying nothing
	// about why this person came, so they wear the arrival mark (R1's crowd
	// case). Only the ones the board is actually showing: a placement on another
	// day has no card, and dragging the person to a different day would answer a
	// question they did not ask — the scoped list already names every row.
	let revealedTray: string | null = null;

	$effect(() => {
		const tray = trayFilter;
		const ready = schedule;
		if (!ready || !tray) {
			revealedTray = null;
			return;
		}
		if (revealedTray === tray) return;
		revealedTray = tray;
		const onGrid = placedInTray(trayRows);
		announcement = `Program pool scoped to ${trayLabel[tray].toLowerCase()} — ${trayRows.length} session${trayRows.length === 1 ? '' : 's'}.`;
		void tick().then(() => {
			reveal(programPanel ?? null, { mark: false });
			markArrivalGroup(onGrid.map((id) => document.getElementById(`placed-${id}`)));
		});
	});

	// The speakers panel's data travels with its address: arriving, switching
	// sessions, and every attribution all re-read through the same door.
	let loadedSpeakersFor: string | null = null;

	$effect(() => {
		const id = speakersForId;
		if (!id) {
			loadedSpeakersFor = null;
			return;
		}
		if (loadedSpeakersFor === id) return;
		loadedSpeakersFor = id;
		origins = [];
		attachable = [];
		addPersonOpen = false;
		void loadSpeakersPanel(id);
	});
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if !schedule}
	{@const attentionExpected = api.workspace.scheduleAttentionExpectedSnapshot() === true}
	<!-- Every placeholder here is the resolved composition's own markup holding
	     skeleton fills: the day switch and publish action keep control height,
	     the grid keeps the room rail and slot rhythm inside the same scrolling
	     wrap, and the panels keep their row structure. -->
	<div class="head">
		<span class="ui-skeleton sk-days"></span>
		<p class="head__conflicts"><span class="ui-skeleton skeleton-line" style="inline-size: 6rem"></span></p>
		<div class="head__publish"><span class="ui-skeleton sk-publish"></span></div>
	</div>
	<div class="layout">
		<section class="board-region" aria-label="Loading schedule">
			<div class="ui-table-wrap ui-table-wrap--scroll board-wrap">
				<div class="board" style="--cols: 4; --slots: 8" aria-hidden="true">
					<span class="board__corner"></span>
					{#each Array(4) as _room, roomIndex (roomIndex)}
						<div class="board__room">
							<span class="board__room-name"><span class="ui-skeleton skeleton-line" style="inline-size: 6rem"></span></span>
							<span class="board__room-cap"><span class="ui-skeleton skeleton-line" style="inline-size: 3.5rem"></span></span>
						</div>
					{/each}
					<div class="board__times">
						{#each Array(8) as _slot, slotIndex (slotIndex)}
							<span class="board__time"><span class="ui-skeleton skeleton-line" style="inline-size: 2.25rem"></span></span>
						{/each}
					</div>
					{#each Array(4) as _col, colIndex (colIndex)}
						<div class="board__col"></div>
					{/each}
				</div>
			</div>
		</section>
		<div class="aside">
			<section class="panel" aria-hidden="true">
				<header class="panel__head">
					<h2>Program</h2>
					<span class="panel__count"><span class="ui-skeleton skeleton-line" style="inline-size: 0.75rem"></span></span>
				</header>
				<ul class="pool">
					{#each Array(1) as _row, rowIndex (rowIndex)}
						<li class="pool__row">
							<div class="pool__copy">
								<p class="pool__title"><span class="ui-skeleton skeleton-line" style="inline-size: 10rem"></span></p>
								<p class="pool__meta"><span class="ui-skeleton skeleton-line" style="inline-size: 12rem"></span></p>
							</div>
							<span class="ui-skeleton skeleton-action pool__action"></span>
						</li>
					{/each}
				</ul>
			</section>
			<section class="panel" aria-hidden="true">
				<header class="panel__head">
					<h2>Conflicts</h2>
					<span class="panel__count"><span class="ui-skeleton skeleton-line" style="inline-size: 0.75rem"></span></span>
				</header>
				<!-- A conflict count in the shell's summary is the evidence that this
				     panel resolves to rows rather than to its calm line. -->
				{#if attentionExpected}
					<ul class="conflicts">
						{#each Array(1) as _row, rowIndex (rowIndex)}
							<li class="conflicts__row">
								<span class="ui-skeleton skeleton-chip conflicts__sev"></span>
								<div class="conflicts__copy">
									<p class="conflicts__title"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></p>
									<p class="conflicts__reason"><span class="ui-skeleton skeleton-line" style="inline-size: 11rem"></span></p>
								</div>
								<span class="ui-skeleton skeleton-action conflicts__action"></span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="panel__calm"><span class="ui-skeleton skeleton-line" style="inline-size: 12rem"></span></p>
				{/if}
			</section>
		</div>
	</div>
{:else}
	<div class="head">
		<div class="ui-segmented head__days" role="group" aria-label="Schedule day">
			{#each days as day (day.key)}
				{@const dayOpenings = openingsPerDay.get(day.key) ?? 0}
				<!-- While placing, each day answers "is switching worth it?" with its
				     own opening count — cross-day awareness without a crowded board. -->
				<button
					type="button"
					class="ui-segmented__item"
					aria-pressed={dayKey === day.key}
					aria-label={placing
						? `${day.label} — ${dayOpenings} opening${dayOpenings === 1 ? '' : 's'} for this session`
						: undefined}
					onclick={() => applyParams({ day: day.key })}
					>{day.label}{#if placing}<span class="day-count" aria-hidden="true">{dayOpenings}</span>{/if}</button>
			{/each}
		</div>

		<p class="head__conflicts">
			{#if conflictRows.length === 0}
				No conflicts
			{:else}
				<!-- The always-in-view statement of broken physics is also the one
				     door to its rows (R2): the nav badge stopped re-aiming here, so
				     this count carries the jump to the panel below the worklist. -->
				<button type="button" class="head__conflicts-door" onclick={openConflictsPanel}>
					<!-- A count names a thing, not a rank: "5 blocking" counted an
					     adjective, and a reader could not tell what five of them were.
					     "Conflicts" is the word the Overview's attention row and this
					     panel's own heading already use for the same rows, so the number
					     that travels between them keeps its noun. -->
					{#if blockingCount > 0}<span class="count count--block">{blockingCount} conflict{blockingCount === 1 ? '' : 's'}</span>{/if}
					{#if blockingCount > 0 && warningCount > 0}<span class="count__sep"> · </span>{/if}
					{#if warningCount > 0}<span class="count count--warn">{warningCount} warning{warningCount === 1 ? '' : 's'}</span>{/if}
				</button>
			{/if}
		</p>

		<div class="head__publish">
			<p class="publish__reason" role="status">{publishReason}</p>
			{#if scheduleSurfaceId}
				<!-- The published page's structure lives with the templates; this door
				     opens that surface rather than growing a second editor here. -->
				<a
					class="ui-button ui-button--ghost ui-button--sm"
					href="/app/templates?tab=surfaces&template={scheduleSurfaceId}"
					aria-label="Public schedule template — Templates">
					Public schedule template
				</a>
			{/if}
			{#if schedule.published}
				<Badge {...badgeFor('published')} value="Published" />
			{:else}
				<button type="button" class="ui-button ui-button--primary" disabled={busy} onclick={reviewPublish}>
					Publish
				</button>
			{/if}
		</div>
	</div>
	{#if breakActionError}
		<p class="ui-notice ui-notice--danger" role="alert">{breakActionError}</p>
	{/if}

	{#if publishReview}
		<!-- The reviewed lane's one screen: what this release carries, and which
		     names it copies into public state. A schedule publish is the only
		     release action that discloses people, so the names are the review
		     rather than a footnote to it. Nothing is public until the press. -->
		<section
			class="publish-review"
			aria-labelledby="schedule-publish-review-title"
			aria-busy={busy || undefined}>
			<div>
				<h2 id="schedule-publish-review-title">Review release {publishReview.releaseNumber}</h2>
				<p class="publish-review__lede">Nothing is public yet.</p>
			</div>
			<dl class="publish-review__facts">
				<div>
					<dt>Sessions</dt>
					<dd>{publishReview.sessions}</dd>
				</div>
				<div>
					<dt>Placements</dt>
					<dd>{publishReview.occurrences}</dd>
				</div>
				<div>
					<dt>Public speakers</dt>
					<dd>{publishReview.lineupNames.length}</dd>
				</div>
				<div>
					<dt>Speaker groups</dt>
					<dd>{publishReview.speakerGroups.length}</dd>
				</div>
			</dl>
			<div class="publish-review__names">
				<h3>Public lineup order</h3>
				{#if publishReview.lineupNames.length === 0}
					<p class="publish-review__none">The public lineup is empty.</p>
				{:else}
					<ol>
						{#each publishReview.lineupNames as name (name)}
							<li>{name}</li>
						{/each}
					</ol>
				{/if}
				{#if publishReview.speakerGroups.length > 0}
					<p class="publish-review__none">
						Groups: {publishReview.speakerGroups.join(', ')}
					</p>
				{/if}
			</div>
			<div class="publish-review__names">
				<h3>
					{publishReview.declassifiedNames.length === 1
						? '1 speaker name becomes public'
						: `${publishReview.declassifiedNames.length} speaker names become public`}
				</h3>
				{#if publishReview.declassifiedNames.length === 0}
					<p class="publish-review__none">This release names nobody.</p>
				{:else}
					<ul>
						{#each publishReview.declassifiedNames as name (name)}
							<li>{name}</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="publish-review__actions">
				<button
					type="button"
					class="ui-button ui-button--primary"
					disabled={busy}
					onclick={confirmPublish}>Publish release {publishReview.releaseNumber}</button>
				<button
					type="button"
					class="ui-button ui-button--ghost"
					disabled={busy}
					onclick={cancelPublish}>Cancel</button>
			</div>
		</section>
	{/if}

	<div class="layout" class:is-refreshing={reload.visible} aria-busy={refreshing || undefined}>
		<!-- Right-click stands the mode down, the same way Escape does. While a
		     session is in hand the board is aiming, not browsing, so the platform
		     menu has nothing to offer here and the press is better spent on the
		     way out. Suppressed only while aiming: with nothing in hand the menu
		     behaves normally, and the confirm dialog owns its own dismissal. -->
		<section
			class="board-region"
			aria-label="Schedule grid"
			bind:this={boardRegion}
			oncontextmenu={cancelOnRightClick}>
			{#if !boardReady}
				<!-- The blank board names the supply it is missing and opens exactly
				     the door that supplies it. It used to say "Nothing is scheduled
				     yet" for every way the gate can fail, which was a false claim
				     about a schedule holding placements the geometry refused — and it
				     offered a room form to a board whose rooms were never the
				     problem. Both facts come from `board-readiness.ts`. -->
				<div class="blank">
					<h2 class="blank__title">{blankCopy.title}</h2>
					{#if blankCopy.stranded}
						<!-- Loudest thing in this region, because it is the one fact that
						     contradicts what the board appears to say. -->
						<p class="blank__stranded" role="status">{blankCopy.stranded}</p>
					{/if}
					<p class="blank__copy">{blankCopy.missing}</p>
					{#if blankCopy.offerEventDates}
						<!-- The door that supplies days. It is a link and not a form
						     because the dates belong to the event, not to this board. -->
						<p class="blank__copy blank__door">
							<a href="/app/settings">Set the event’s dates and day window</a>
						</p>
					{/if}
					{#if blankCopy.offerRoomForm}
						<p class="blank__copy">
							Drop a spreadsheet, a photo of the whiteboard, or describe your day structure — the
							draft comes back on this grid for review before anything is committed. Building it
							by hand works the same way: add a room, then place sessions from the pool one slot
							at a time.
						</p>
					{/if}
					{@render roomForm()}
					{#if rooms.length > 0}
						<!-- The grid needs days as well as rooms, so a room already added
						     has nowhere to appear yet; it is named where it was created. -->
						<p class="blank__rooms">
							Rooms so far: {rooms.map((room) => room.name).join(' · ')}
						</p>
					{/if}
				</div>
			{:else}
				<!-- Placement mode reuses the board's existing controls and geometry:
				     openings appear in columns, day buttons show counts, the pressed
				     control becomes Cancel, and a ghost follows the pointer. The live
				     region exposes the same state change without adding visual chrome. -->
				<!-- The one surface here that keeps its columns on a phone: a room
				     grid's meaning *is* the alignment, so it takes the shared
				     numeric-grid opt-out — it scrolls inside its own wrapper, with
				     the primitive's edge affordance, and never the document. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<!-- The tabindex is the point: a scroll container that cannot be
				     focused cannot be scrolled by keyboard at all, and a region whose
				     content is out of view is exactly the case WCAG 2.1.1 covers. -->
				<div
					class="ui-table-wrap ui-table-wrap--scroll board-wrap"
					role="region"
					tabindex="0"
					aria-label={`${dayLabel(dayKey)} — ${rooms.length} room${rooms.length === 1 ? '' : 's'}, scrolls sideways`}>
					<div class="board" style="--cols: {rooms.length}; --slots: {schedule.slotsPerDay}">
						<span class="board__corner"></span>
						{#each rooms as room (room.id)}
							<div class="board__room">
								<span class="board__room-name">{room.name}</span>
								<!-- A retired room keeps its column: nothing already placed in it
								     moves, it is simply no longer offered for new placements. -->
								<span class="board__room-cap"
									>{presentProgramRoomCapacity(room.capacity).label}{room.status === 'retired' ? ' · retired' : ''}</span>
							</div>
						{/each}

						<div class="board__times">
							{#each Array(schedule.slotsPerDay) as _, slot (slot)}
								<span class="board__time">{clockLabel(slot * slotMinutes)}</span>
							{/each}
							{#if placing && aim}
								<!-- The aim's readout on the time axis itself: the gutter is
								     where the eye checks times, so the shifted-to start rides
								     there at its exact height — action ink and a tick, clearly
								     provisional against the fixed slot labels. -->
								<span
									class="board__time-marker"
									aria-hidden="true"
									style="--start: {aim.startMin / slotMinutes}">{clockLabel(aim.startMin)}</span>
							{/if}
						</div>

						{#each rooms as room (room.id)}
							<div class="board__col">
								{#each schedule.placements.filter((p) => p.dayKey === dayKey && p.roomId === room.id) as placement (placement.sessionId)}
									{@const session = sessionOf(placement.sessionId)}
									{#if session}
										{#if placing?.id === session.id}
											<!-- The slot being left, kept visible while choosing the next
											     one — and the mode's exit lives here, exactly where Move
											     was pressed, instead of in a bar somewhere else.

											     When the aim comes back to this slot it is also the answer,
											     so it takes the aimed treatment and says so rather than
											     letting a ghost draw a second rectangle over it. Two
											     outlines on one rectangle meaning one thing was the
											     redundancy; this is the one that already carries a label
											     and a control. -->
											<article
												class="card card--origin"
												class:card--origin-aimed={aimOnOrigin}
												style="--start: {placement.startMin / slotMinutes}; --span: {session.durationMin / slotMinutes}">
												<p class="card__title">{session.title}</p>
												<p class="card__when">
													<span class="card__time">{rangeLabel(placement.startMin, session.durationMin)}</span>
													<span>· {aimOnOrigin ? 'leave it here' : 'current slot'}</span>
												</p>
												<div class="card__actions card__actions--standing">
													<button
														type="button"
														class="ui-button ui-button--secondary ui-button--sm"
														id="origin-cancel"
														aria-label={`Cancel moving “${session.title}”`}
														onclick={cancelPlacement}>Cancel <kbd aria-hidden="true">Esc</kbd></button>
												</div>
											</article>
										{:else}
											{@const blocked = placement.conflicts.some((c) => c.severity === 'block')}
											{@const warned = placement.conflicts.some((c) => c.severity === 'warn')}
											{@const collecting = session.state === 'collecting'}
											<article
												class="card"
												class:card--blocked={blocked}
												class:card--context={placing !== null}
												class:card--armed={armedRemoveId === session.id}
												class:card--collecting={collecting}
												id={`placed-${placement.sessionId}`}
												tabindex="-1"
												style="--start: {placement.startMin / slotMinutes}; --span: {session.durationMin / slotMinutes}">
												<span
													class="card__track"
													style="--track: var(--je-color-track-{trackAccent(
														session.trackId,
														trackIds
													)}-ink)"
													role="img"
													aria-label={`${trackName(session.trackId)} track`}></span>
												<p class="card__title">{session.title}</p>
												<p class="card__when">
													<span class="card__time">{rangeLabel(placement.startMin, session.durationMin)}</span>
													<!-- The reason a card is marked is reachable from the mark, by
													     press or keyboard, and mirrored to the live region: on this
													     grid a tooltip is unreachable on touch and invisible to a
													     keyboard. -->
													{#if blocked}
														{@const reason = reasonsFor(placement, 'block')}
														<Popover
															label={`Conflict on “${session.title}” — why`}
															onreveal={() => (announcement = `${session.title}: ${reason}`)}>
															{#snippet trigger()}
																<!-- The board's one accent-dominant mark: a blocking card is
																     the thing that stops publication, and it is at most a few
																     cards among many. The conflicts panel lists the same fact
																     as a column, so its badges stay unemphasised. -->
																<Badge {...badgeFor('blocking')} value="Conflict" emphasis />
															{/snippet}
															{#snippet children()}
																<p class="reason">{reason}</p>
																<p class="reason__note">Publication stays blocked until this is resolved.</p>
															{/snippet}
														</Popover>
													{/if}
													{#if warned}
														{@const reason = reasonsFor(placement, 'warn')}
														<Popover
															label={`Warning — why “${session.title}” is flagged`}
															onreveal={() => (announcement = `${session.title} warning: ${reason}`)}>
															{#snippet trigger()}
																<Badge {...badgeFor('warning')} value="Warning" />
															{/snippet}
															{#snippet children()}
																<p class="reason">{reason}</p>
															{/snippet}
														</Popover>
													{/if}
												</p>
												<!-- The card is the session's own composition — it already carries
												     the conflict disclosures and the move/remove controls — so the
												     speaker line is where the peek belongs. The grid labels around
												     it (room, capacity, clock) name no person, so nothing else on
												     this board gains a trigger. A held collecting slot has no
												     roster by design; its line says what it is waiting on instead,
												     and the pool row carries the one door to those proposals. -->
												{#if collecting}
													<p class="card__who card__who--collecting"
														>Collecting — {proposalsLabel(proposals[session.id] ?? 0)}</p>
												{:else if session.speakers.length === 0}
													<!-- A placeholder is a plan, not a failure: quiet ink, stated
													     honestly, completed from the speakers panel. -->
													<p class="card__who">No speakers yet</p>
												{:else}
													<p class="card__who"
														>{#each session.speakers as speaker, index (speaker.email)}{@const profile =
															profileOf(speaker)}{#if index > 0}{', '}{/if}{#if profile}<ProfilePeek
																{profile} />{:else}{speaker.name}{/if}{/each}</p>
												{/if}
												<div class="card__actions">
													<button
														type="button"
														class="ui-button ui-button--secondary ui-button--sm"
														aria-label={`Move “${session.title}”`}
														disabled={busy || placing !== null}
														onclick={(event) => enterPlacement(session, event.detail === 0)}>Move</button>
													<!-- Quiet danger: destructive, but not this card's primary — the
													     card's primary is Move. Filled danger waits for the
													     confirming press in the veil below, where destroying the
													     placement genuinely is the act being asked for. -->
													<button
														type="button"
														class="ui-button ui-button--danger-quiet ui-button--sm"
														aria-label={`Remove “${session.title}” from the schedule`}
														disabled={busy || placing !== null}
														onclick={() => armRemove(session)}>Remove</button>
													{#if !collecting}
														<!-- The named door to the session's people (R3): detail on a
														     spatial workspace opens from a control, never the card body. -->
														<button
															type="button"
															class="ui-button ui-button--ghost ui-button--sm"
															aria-label={`Speakers on “${session.title}”`}
															aria-haspopup="dialog"
															disabled={busy || placing !== null}
															onclick={() => openSpeakers(session)}>Speakers…</button>
													{/if}
												</div>
												{#if armedRemoveId === session.id}
													<!-- The armed state is the card's own face turned into the
													     question: unmistakable, in place, and the confirm sits at
													     a different position than the trigger, so a double-click
													     can never remove by accident. -->
													<div
														class="confirm-veil"
														role="group"
														aria-label={`Remove “${session.title}” from the schedule?`}
														onfocusout={veilFocusout}>
														<p class="confirm-veil__q">Remove from the schedule?</p>
														<div class="confirm-veil__actions">
															<button
																type="button"
																class="ui-button ui-button--danger ui-button--sm"
																id={`confirm-remove-${session.id}`}
																aria-label={`Remove “${session.title}” — confirm`}
																disabled={busy}
																onclick={() => confirmRemoval(session, placement)}>Remove</button>
															<button
																type="button"
																class="ui-button ui-button--secondary ui-button--sm"
																aria-label={`Keep “${session.title}” on the schedule`}
																onclick={() => keepPlacement(session)}>Keep</button>
														</div>
													</div>
												{/if}
											</article>
										{/if}
									{/if}
								{/each}

								{#each schedule.breaks.filter((b) => b.dayKey === dayKey && b.roomId === room.id) as brk (brk.id)}
									<div
										class="brk"
										class:brk--armed={armedBreakId === brk.id}
										style="--start: {brk.startMin / slotMinutes}; --span: {brk.durationMin / slotMinutes}">
										<p class="brk__copy">
											<span class="brk__label">{brk.label}</span>
											<span class="brk__time">{rangeLabel(brk.startMin, brk.durationMin)}</span>
										</p>
										<button
											type="button"
											class="ui-button ui-button--danger-quiet ui-button--sm brk__remove"
											aria-label={`Remove “${brk.label}” — ${dayLabel(brk.dayKey)} ${clockLabel(brk.startMin)}, ${roomName(brk.roomId)}`}
											disabled={busy || placing !== null}
											onclick={() => armBreak(brk)}>Remove</button>
										{#if armedBreakId === brk.id}
											<div
												class="confirm-veil"
												role="group"
												aria-label={`Remove the “${brk.label}” break?`}
												onfocusout={veilFocusout}>
												<p class="confirm-veil__q">Remove this break?</p>
												<div class="confirm-veil__actions">
													<button
														type="button"
														class="ui-button ui-button--danger ui-button--sm"
														id={`confirm-break-${brk.id}`}
														aria-label={`Remove “${brk.label}” — confirm`}
														disabled={busy}
														onclick={() => confirmBreakRemoval(brk)}>Remove</button>
													<button
														type="button"
														class="ui-button ui-button--secondary ui-button--sm"
														aria-label={`Keep the “${brk.label}” break`}
														onclick={disarmBreak}>Keep</button>
												</div>
											</div>
										{/if}
									</div>
									{/each}

									{#if placing}
										{#each segmentsByColumn.get(`${dayKey}|${room.id}`) ?? [] as segment (`${segment.kind}-${segment.startMin}`)}
											{#if segment.kind === 'open'}
												<button
													type="button"
													class="opening"
													style="--start: {segment.startMin / slotMinutes}; --span: {(segment.endMin - segment.startMin) / slotMinutes}"
													aria-label={`Opening ${rangeLabel(segment.startMin, segment.endMin - segment.startMin)} — ${room.name}, ${dayLabel(dayKey)}`}
													onpointermove={(event) => aimAt(dayKey, room.id, segment, event)}
													onpointerleave={clearAim}
													onfocus={() => focusAim(dayKey, room.id, segment)}
													onblur={clearAim}
													onclick={(event) => chooseOpening(dayKey, room.id, segment, event)}></button>
											{:else}
												<!-- Refused space stays visible and says why before any attempt;
												     the reason is press/keyboard-reachable and mirrored politely. -->
												<div
													class="opening-blocked"
													style="--start: {segment.startMin / slotMinutes}; --span: {(segment.endMin - segment.startMin) / slotMinutes}">
													<Popover
														label={`Unavailable ${rangeLabel(segment.startMin, segment.endMin - segment.startMin)} in ${room.name} — why`}
														kind="figure"
														fill
														onreveal={() => (announcement = segment.reason ?? '')}>
														{#snippet trigger()}
															<span class="opening-blocked__fill" aria-hidden="true"></span>
														{/snippet}
														{#snippet children()}
															<p class="reason">{segment.reason}</p>
														{/snippet}
													</Popover>
												</div>
											{/if}
										{/each}
										{#if aim && aim.dayKey === dayKey && aim.roomId === room.id && !aimOnOrigin}
											<!-- The following ghost, pointer-transparent so aiming stays live.
											     A held flush anchor is shown spatially — the touching edge goes
											     solid — never captioned: the neighbour it touches is already on
											     screen, and words beside a moving pointer are churn. The flush
											     phrase survives where the grid is absent (picks, confirm). -->
											<article
												class="card je-ghost ghost"
												class:ghost--flush-start={aim.flush === 'start' || aim.flush === 'both'}
												class:ghost--flush-end={aim.flush === 'end' || aim.flush === 'both'}
												aria-hidden="true"
												style="--start: {aim.startMin / slotMinutes}; --span: {placing.durationMin / slotMinutes}">
												<p class="card__title">{placing.title}</p>
												<p class="card__when">
													<span class="card__time">{rangeLabel(aim.startMin, placing.durationMin)}</span>
												</p>
												<!-- Key cues ride the ghost because that is where the eyes
												     are. Static content moves with the thing being watched
												     without churning; keys are invisible facts, unlike the
												     geometry around them. Touch hides the Esc half. -->
												<p class="ghost__cue">
													{#if aim.source === 'keyboard'}<kbd>Enter</kbd> selects<span
															class="ghost__cue-sep"> · </span>{/if}<span class="ghost__cue-esc"
														><kbd>Esc</kbd> cancels</span>
												</p>
											</article>
										{/if}
									{/if}
								</div>
						{/each}
					</div>
				</div>

				{#if !placing && dayPlacements.length === 0}
					<p class="board__note">
						Nothing is placed on {dayLabel(dayKey)} yet — place sessions from the pool.
					</p>
				{/if}

				{#if placing && (openingsPerDay.get(dayKey) ?? 0) === 0}
					<!-- The one placing state with nothing visible to show: a day the
					     session cannot land on. Without this line the mode would look
					     like nothing happened here. -->
					{@const elsewhere = days
						.filter((day) => day.key !== dayKey)
						.map((day) => ({ day, count: openingsPerDay.get(day.key) ?? 0 }))
						.sort((a, b) => b.count - a.count)[0]}
					<p class="board__note">
						No openings on {dayLabel(dayKey)} for this session{#if elsewhere && elsewhere.count > 0}
							— {elsewhere.day.label} has {elsewhere.count}{/if}.
					</p>
				{/if}

				<div class="board-add">
					<div class="board-add__actions">
						<!-- The board's own door to the same creation form the Program
						     panel opens — one label, one form, so it can never read as
						     a second feature. Standing here, the form leads with
						     Create and place…. -->
						<button
							type="button"
							class="ui-button ui-button--secondary ui-button--sm"
							id="new-session-door-board"
							aria-haspopup="dialog"
							disabled={placing !== null}
							onclick={() => void openNewSession('board')}>New session…</button>
						<button
							type="button"
							class="ui-button ui-button--secondary ui-button--sm"
							aria-expanded={addRoomOpen}
							aria-controls="board-add-room"
							onclick={openAddRoom}>Add room…</button>
						<button
							type="button"
							class="ui-button ui-button--secondary ui-button--sm"
							disabled={placing !== null}
							onclick={openAddBreak}>Add break…</button>
					</div>
					{#if addRoomOpen}
						<div class="board-add__panel" id="board-add-room">{@render roomForm()}</div>
					{/if}
				</div>
			{/if}
		</section>

		<div class="aside">

			<!-- The round-up worklist: what still stands between the program and
			     done. Groups partition the pool so every unfinished session renders
			     exactly once; a second gap is named on the row, never by a second
			     row. Placement stays this panel's verb; deciding and attributing
			     each keep their one door. -->
			<section class="panel" aria-label="Program" tabindex="-1" bind:this={programPanel}>
				<header class="panel__head">
					<!-- Scoped, the panel is the tray: its heading says which one and its
					     count counts the rows below it, so the scope is stated once, in
					     the place a heading is already read. -->
					<h2>{trayFilter ? trayLabel[trayFilter] : 'Program'}</h2>
					<span class="panel__count">{trayFilter ? trayRows.length : (grouping?.total ?? 0)}</span>
					<button
						type="button"
						class="ui-button ui-button--secondary ui-button--sm panel__head-action"
						id="new-session-door-panel"
						aria-haspopup="dialog"
						onclick={() => void openNewSession('panel')}>New session…</button>
				</header>

				{#if placementBlocked && awaitingPlacement > 0}
					<!-- Said once, where the rows are, instead of by every row growing a
					     control that cannot work. This is the other half of the blank
					     board above: that one says what the grid is missing, this one
					     says what the absence costs these sessions. -->
					<p class="panel__blocked">{placementBlocked}</p>
				{/if}

				{#if trayFilter}
					<!-- The way back, and only that: the heading above already names the
					     scope, so a badge repeating it would be the same fact twice. -->
					<p class="panel__scope">
						<button
							type="button"
							class="ui-button ui-button--ghost ui-button--sm"
							aria-label={`Clear the ${trayLabel[trayFilter].toLowerCase()} scope`}
							onclick={() => void applyParams({ tray: null }, { history: 'push' })}>Clear</button>
					</p>
					{#if trayRows.length === 0}
						<p class="panel__calm">Nothing is waiting here.</p>
					{:else}
						<ul class="pool">
							{#each trayRows as row (row.session.id)}
								{@render programRow(row)}
							{/each}
						</ul>
					{/if}
				{:else if grouping && grouping.total > 0}
					{#each grouping.order as group (group)}
						<section class="pool-group" aria-label={groupHeading[group]}>
							<h3 class="pool-group__title">
								{groupHeading[group]}
								<span class="panel__count">{(grouping.groups.get(group) ?? []).length}</span>
							</h3>
							<ul class="pool">
								{#each grouping.groups.get(group) ?? [] as row (row.session.id)}
									{@render programRow(row)}
								{/each}
							</ul>
						</section>
					{/each}
				{:else}
					<p class="panel__calm">
						Every session is placed, peopled, and decided. Accepted proposals and new sessions
						arrive here on their way to the grid.
					</p>
				{/if}
			</section>

			<!-- Below the worklist deliberately: the head row's blocking count and
			     the nav badge already keep broken physics impossible to miss, and
			     with nothing broken this panel is one calm line — the standing
			     round-up work outranks the usually-empty exception list.
			     Addressable: `?panel=conflicts` lands here with the caret on the
			     panel, which is where a blocking count on the rail or the
			     overview points. -->
			<section class="panel" aria-label="Conflicts" tabindex="-1" bind:this={conflictsPanel}>
				<header class="panel__head">
					<h2>Conflicts</h2>
					<span class="panel__count">{conflictRows.length}</span>
				</header>
				{#if conflictRows.length === 0}
					<!-- The condition, not the obstruction: this panel is read by people
					     who are not necessarily about to publish, and what publication
					     waits on belongs on the publish control, which states its own
					     refusal when somebody actually tries. -->
					<p class="panel__calm">No conflicts on the schedule.</p>
				{:else}
					<ul class="conflicts">
						{#each conflictRows as row (row.key)}
							<!-- Tone and glyph come from the shared vocabulary, so a blocking
							     conflict reads the same here as on the card it names. No
							     emphasis: this is a column of the same fact, and a column of
							     solid badges spends the region's whole accent budget on the
							     list rather than on the card that has to move. -->
							<li class="conflicts__row">
								<span class="conflicts__sev">
									<Badge
										{...badgeFor(row.conflict.severity === 'block' ? 'blocking' : 'warning')}
										value={row.conflict.severity === 'block' ? 'Blocking' : 'Warning'} />
								</span>
								<div class="conflicts__copy">
									<p class="conflicts__title">{row.session.title}</p>
									<p class="conflicts__reason">{row.conflict.reason}</p>
								</div>
								{#if dayIsDrawable(row.placement.dayKey)}
									<button
										type="button"
										class="ui-button ui-button--secondary ui-button--sm conflicts__action"
										onclick={() => showOnGrid(row.placement)}>
										Show on {dayLabel(row.placement.dayKey)}
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	</div>
{/if}

<!-- Attribution's home (21 §5), now the full stage: who is on this session,
     one search across every way in, and the session named so the thread is
     never lost. Every act commits individually with an undoable receipt, so
     closing loses nothing. -->
<Modal
	bind:open={() => speakersSession !== null, (value) => { if (!value) closeSpeakers(); }}
	title="Speakers"
	dismissible>
	{#if speakersSession}
		{@const session = speakersSession}
		<div class="speakers__body">
			<!-- The continuity cue: which session, and where it stands right now. -->
			<div class="speakers__context">
				<p class="speakers__session">{session.title}</p>
				<p class="speakers__meta">{speakersContext}</p>
			</div>

			{#if session.speakers.length === 0}
				<p class="speakers__calm">
					No speakers yet — a placeholder is fine. Add people from the roster, bring in an
					accepted talk, or add a new person when they are known.
				</p>
			{:else}
				<h3 class="speakers__group">On this session</h3>
				<ul class="speakers">
					{#each session.speakers as speaker, index (speaker.email)}
						<li class="speakers__row">
							<div class="speakers__copy">
								<p class="speakers__name">{speaker.name}</p>
								<!-- Provenance renders in place (R4): how this person got
								     here, not a hover secret. -->
								<p class="speakers__provenance">{provenanceOf(speaker)}</p>
							</div>
							<div class="speakers__edits">
								<label class="ui-sr-only" for={`speaker-role-${index}`}>Role for {speaker.name}</label>
								<select
									id={`speaker-role-${index}`}
									class="ui-control speakers__role"
									disabled={attributing}
									value={speaker.role ?? 'speaker'}
									onchange={(event) => changeParticipantRole(
										session,
										speaker,
										(event.currentTarget.value as SessionParticipantRole)
									)}>
									<option value="speaker">Speaker</option>
									<option value="moderator">Moderator</option>
									<option value="host">Host</option>
									<option value="panelist">Panelist</option>
								</select>
								{#if session.speakers.length > 1}
									<button type="button" class="ui-button ui-button--quiet ui-button--sm"
										disabled={attributing || index === 0}
										aria-label={`Move ${speaker.name} earlier`}
										onclick={() => moveParticipant(session, index, -1)}>Up</button>
									<button type="button" class="ui-button ui-button--quiet ui-button--sm"
										disabled={attributing || index === session.speakers.length - 1}
										aria-label={`Move ${speaker.name} later`}
										onclick={() => moveParticipant(session, index, 1)}>Down</button>
								{/if}
							{#if armedParticipant === speaker.email}
								<button
									type="button"
									class="ui-button ui-button--danger ui-button--sm speakers__action"
									disabled={attributing}
									aria-label={`Remove ${speaker.name} — confirm`}
									onclick={() => removeParticipant(session, speaker)}>Remove?</button>
							{:else}
								<!-- Resting: quiet danger among the Add controls it sits beside.
								     The armed press above is the confirming step inside this
								     dialog, which is where filled danger belongs. -->
								<button
									type="button"
									class="ui-button ui-button--danger-quiet ui-button--sm speakers__action"
									disabled={attributing}
									aria-label={`Remove ${speaker.name} from “${session.title}”`}
									onclick={() => armParticipant(speaker.email)}>Remove</button>
							{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}

			{#if candidateScope.people + candidateScope.talks > 3}
				<!-- One query across every way in; the scope line says what it
				     searched, so a short list reads as "few matched", never
				     "few exist". -->
				<Field id="speakers-search" label="Add people">
					{#snippet children({ id, describedBy })}
						<input
							class="ui-control"
							type="search"
							{id}
							aria-describedby={describedBy}
							placeholder="Search the roster and accepted talks"
							bind:value={spQuery} />
					{/snippet}
				</Field>
			{/if}

			{#if rosterCandidates.length > 0}
				<h3 class="speakers__group">From the roster</h3>
				<ul class="speakers">
					{#each rosterCandidates as row (row.id)}
						<li class="speakers__row">
							<div class="speakers__copy">
								<p class="speakers__name">{row.name}</p>
								<p class="speakers__provenance">{engagementCopy[row.state]}</p>
							</div>
							<button
								type="button"
								class="ui-button ui-button--secondary ui-button--sm speakers__action"
								disabled={attributing}
								aria-label={`Add ${row.name} to “${session.title}”`}
								onclick={() => addFromRoster(session, row)}>Add</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if acceptedCandidates.length > 0}
				<!-- People arriving with an accepted talk: adding them links the
				     talk itself — co-speakers included — and keeps the provenance.
				     Real program work: a panel assembled from separate proposals,
				     a lightning block of short talks. -->
				<h3 class="speakers__group">With an accepted talk</h3>
				<ul class="speakers">
					{#each acceptedCandidates as submission (submission.id)}
						<li class="speakers__row">
							<div class="speakers__copy">
								<p class="speakers__name">
									{submission.speakers.map((speaker) => speaker.name).join(', ')}
								</p>
					<p class="speakers__provenance">
						accepted — “{submission.title}”{submission.moveFrom ? ` · currently in “${submission.moveFrom.sessionTitle}”` : ''}
					</p>
							</div>
							<button
								type="button"
								class="ui-button ui-button--secondary ui-button--sm speakers__action"
								disabled={attributing}
					aria-label={`${submission.moveFrom ? 'Move' : 'Add'} “${submission.title}” to “${session.title}”`}
								onclick={() => attach(session, submission)}>
					{submission.moveFrom ? 'Move' : submission.speakers.length === 1 ? 'Add' : `Add ${submission.speakers.length}`}
							</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if spQuery.trim() && rosterCandidates.length === 0 && acceptedCandidates.length === 0}
				<p class="speakers__calm">
					No one matches “{spQuery.trim()}” across {candidateScope.people}
					{candidateScope.people === 1 ? 'person' : 'people'} on the roster and
					{candidateScope.talks} accepted {candidateScope.talks === 1 ? 'talk' : 'talks'} —
					add them as a new person below.
				</p>
			{/if}

			<div class="speakers__direct">
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm"
					aria-expanded={addPersonOpen}
					aria-controls="speakers-direct-form"
					onclick={() => {
						addPersonOpen = !addPersonOpen;
						if (addPersonOpen && !apName && spQuery.trim()) apName = spQuery.trim();
					}}>Add a new person…</button>
				{#if addPersonOpen}
					<!-- Direct entry (04 §3), whole: person, accepted direct-entry
					     record, invited engagement, and the attribution in one commit. -->
					<form class="speakers__form" id="speakers-direct-form" onsubmit={addDirect}>
						<Field id="speakers-direct-name" label="Name">
							{#snippet children({ id, describedBy })}
								<input
									class="ui-control"
									type="text"
									{id}
									aria-describedby={describedBy}
									disabled={attributing}
									bind:value={apName} />
							{/snippet}
						</Field>
						<Field id="speakers-direct-email" label="Email">
							{#snippet children({ id, describedBy })}
								<input
									class="ui-control"
									type="email"
									{id}
									aria-describedby={describedBy}
									disabled={attributing}
									bind:value={apEmail} />
							{/snippet}
						</Field>
						<Button type="submit" size="sm" disabled={!apReady || attributing}>
							Add to session
						</Button>
					</form>
				{/if}
			</div>
		</div>
	{/if}
</Modal>

<!-- Dismissal is parking, not discarding: backdrop, Escape, and the close
     button all keep the draft (nsStarted), so nothing typed is lost until a
     create lands or the page reloads. -->
<Modal
	bind:open={() => newSessionOpen !== false, (value) => { if (!value) newSessionOpen = false; }}
	title="New session"
	dismissible>
	{@render newSessionForm()}
</Modal>

<Modal
	bind:open={() => trackRepairId !== null, (value) => { if (!value) trackRepairId = null; }}
	title={trackRepairSession ? `Choose a track for “${trackRepairSession.title}”` : 'Choose a track'}
	dismissible>
	<form class="new-session" onsubmit={repairTrack}>
		<p class="new-session__vocab-note">
			This event uses tracks, so every collecting or programmed session needs one before publish.
		</p>
		<Field id="repair-session-track" label="Track">
			{#snippet children({ id, describedBy })}
				<select
					class="ui-control"
					{id}
					aria-describedby={describedBy}
					disabled={repairingTrack}
					bind:value={repairTrackId}>
					<option value="" disabled>Choose a track</option>
					{#each activeTracks as track (track.id)}
						<option value={track.id}>{track.name}</option>
					{/each}
				</select>
			{/snippet}
		</Field>
		<div class="new-session__actions">
			<Button type="button" size="sm" variant="secondary" onclick={() => (trackRepairId = null)}>
				Cancel
			</Button>
			<Button type="submit" size="sm" disabled={repairTrackId === '' || repairingTrack}>
				Save track
			</Button>
		</div>
	</form>
</Modal>

{#snippet newSessionForm()}
	<!-- Enter submits the opening door's own primary. -->
	<form
		class="new-session"
		id="new-session-form"
		onsubmit={(event) => {
			event.preventDefault();
			void createSession(nsPlaceIsPrimary);
		}}>
		<Field id="new-session-title" label="Title">
			{#snippet children({ id, describedBy })}
				<input
					class="ui-control"
					type="text"
					{id}
					aria-describedby={describedBy}
					disabled={creatingSession}
					bind:this={nsTitleInput}
					bind:value={nsTitle} />
			{/snippet}
		</Field>
		<div class="new-session__vocab">
			<Field id="new-session-format" label="Format">
				{#snippet children({ id, describedBy })}
					<div class="new-session__choice">
						<select
							class="ui-control"
							{id}
							aria-describedby={describedBy}
							disabled={creatingSession}
							bind:value={nsFormatId}
							onchange={onNsFormatChange}>
							{#if formats.filter((format) => format.status === 'active').length === 0}
								<option value="">No formats yet — add the first below</option>
							{/if}
							{#each formats.filter((format) => format.status === 'active') as format (format.id)}
								<option value={format.id}>{format.name}</option>
							{/each}
						</select>
						<InlineVocabAdd
							label="New format"
							placeholder="e.g. Workshop"
							disabled={creatingSession}
							submit={addFormatInline} />
					</div>
				{/snippet}
			</Field>
			<Field
				id="new-session-track"
				label="Track"
				description={activeTracks.length === 0
					? 'This event does not use tracks yet.'
					: nsState === 'draft'
						? 'Optional while this remains a private sketch.'
						: 'Required before this session can enter the program.'}>
				{#snippet children({ id, describedBy })}
					<div class="new-session__choice">
						<select
							class="ui-control"
							{id}
							aria-describedby={describedBy}
							disabled={creatingSession}
							bind:value={nsTrackId}>
							<option value="" disabled={nsState !== 'draft' && activeTracks.length > 0}>
								{activeTracks.length === 0
									? 'This event has no tracks'
									: nsState === 'draft'
										? 'Decide later — private draft'
										: 'Choose a track'}
							</option>
							{#each activeTracks as track (track.id)}
								<option value={track.id}>{track.name}</option>
							{/each}
						</select>
						<InlineVocabAdd
							label="New track"
							placeholder="e.g. Infrastructure"
							disabled={creatingSession}
							submit={addTrackInline} />
					</div>
				{/snippet}
			</Field>
			<Field id="new-session-duration" label="Minutes">
				{#snippet children({ id, describedBy })}
					<input
						class="ui-control"
						type="number"
						min="5"
						step="5"
						{id}
						aria-describedby={describedBy}
						disabled={creatingSession}
						bind:value={nsDuration}
						oninput={() => (nsDurationTouched = true)} />
				{/snippet}
			</Field>
		</div>
		{#if nsVocabNote}
			<p class="new-session__vocab-note" role="status">{nsVocabNote}</p>
		{/if}
		<ChoiceGroup legend="Starts as">
			<Radio
				name="new-session-state"
				value="programmed"
				label="In the program"
				description="An editorial fact — a fixed keynote, a known workshop."
				bind:group={nsState}
				disabled={creatingSession} />
			<Radio
				name="new-session-state"
				value="collecting"
				label="Collecting proposals"
				description="An open call people can apply to; nothing public yet."
				bind:group={nsState}
				disabled={creatingSession} />
			<Radio
				name="new-session-state"
				value="draft"
				label="Private sketch"
				description="Visible to organizers only, off the grid for now."
				bind:group={nsState}
				disabled={creatingSession} />
		</ChoiceGroup>
		<!-- One creation, one placement, zero re-finding it in a list: Create
		     and place… commits, then the new session is already in hand. The
		     door decides the emphasis — standing at the board, placing is the
		     point; in the panel, landing unplaced is. Enter always takes the
		     leading action, and Escape after committing still leaves a real,
		     honestly-pooled session. A private sketch stays off the grid, so
		     only Create is offered for it — and so is every session while the
		     board has no grid to place one on. -->
		<div class="new-session__actions">
			{#if nsPlaceIsPrimary}
				<Button type="submit" size="sm" disabled={!nsReady || creatingSession}>
					Create and place…
				</Button>
				<Button
					type="button"
					size="sm"
					variant="secondary"
					disabled={!nsReady || creatingSession}
					onclick={() => void createSession(false)}>Create</Button>
			{:else}
				<Button type="submit" size="sm" disabled={!nsReady || creatingSession}>Create</Button>
				{#if nsState !== 'draft' && canPlace}
					<Button
						type="button"
						size="sm"
						variant="secondary"
						disabled={!nsReady || creatingSession}
						onclick={() => void createSession(true)}>Create and place…</Button>
				{/if}
			{/if}
		</div>
	</form>
{/snippet}

{#snippet programRow(row: ProgramGroupRow)}
	{@const session = row.session}
	{@const placement = schedule?.placements.find((entry) => entry.sessionId === session.id)}
	{@const track = tracks.find((entry) => entry.id === session.trackId)}
	{@const open = detailId === session.id}
	<!-- The record composition: a rail carrying the track accent, a primary line
	     (title), the scan keys beneath it, and the trailing affordances. The
	     phone gets the same arrangement with touch metrics — nothing moves
	     off-screen and nothing scrolls sideways, because the row grows
	     downward, which is the one direction a phone has. -->
	<li
		class="pool__row"
		class:pool__row--active={placing?.id === session.id}
		class:pool__row--open={open}
		id={`pool-${session.id}`}
		tabindex="-1"
		style="--track: var(--je-color-track-{trackAccent(session.trackId, trackIds)}-ink)">
		<div class="pool__copy">
			<p class="pool__title">{session.title}</p>
			<p class="pool__meta">
				<span>{session.durationMin} min · {formatName(session.formatId)}</span>
				{#if track}
					<TrackChip name={track.name} id={track.id} order={trackIds} />
				{:else}
					<!-- Absence in words on the quietest rung, never an empty chip. -->
					<span class="pool__untracked">No track</span>
				{/if}
			</p>
			{#if placement && dayIsDrawable(placement.dayKey)}
				<p class="pool__meta">
					{dayLabel(placement.dayKey)}
					{clockLabel(placement.startMin)} · {roomName(placement.roomId)}
				</p>
			{:else if placement}
				<!-- Committed, and outside anything this grid can draw. Said, not
				     hidden, and not printed as a raw key. -->
				<p class="pool__fact">Placed at a time the current grid cannot draw</p>
			{/if}
			{#if session.state === 'collecting'}
				<!-- The one door to this session's proposals (R2): the count lands
				     on Decisions scoped to exactly these rows. Zero is stated, not
				     linked — there is nothing to decide yet. -->
				{#if row.proposalCount > 0}
					<p class="pool__fact">
						<a href={`/app/decisions?target=${session.id}`}
							>{proposalsLabel(row.proposalCount)} to decide</a>
					</p>
				{:else}
					<p class="pool__fact">No proposals yet</p>
				{/if}
			{:else if row.trays.includes('needs-speakers')}
				<p class="pool__fact">No speakers yet</p>
			{/if}
		</div>
		<div class="pool__actions">
			{#if session.state !== 'draft' && session.trackId === '' && activeTracks.length > 0}
				<Button size="sm" variant="secondary" onclick={() => openTrackRepair(session)}>
					Choose track…
				</Button>
			{/if}
			{#if placeable(row) && canPlace}
				<!-- One element for both faces, so the pointer that pressed Place…
				     is already resting on Cancel: entering the mode moves neither
				     layout nor focus. Drawn only while the board can actually take
				     a placement; the reason it cannot is stated once, above. -->
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm"
					aria-label={placing?.id === session.id
						? `Cancel placing “${session.title}”`
						: `Place “${session.title}”`}
					disabled={busy}
					onclick={(event) =>
						placing?.id === session.id
							? cancelPlacement()
							: enterPlacement(session, event.detail === 0)}
					>{#if placing?.id === session.id}Cancel <kbd aria-hidden="true">Esc</kbd
						>{:else}Place…{/if}</button>
			{/if}
			{#if placement && dayIsDrawable(placement.dayKey)}
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm"
					disabled={placing !== null}
					onclick={() => showOnGrid(placement)}>Show on {dayLabel(placement.dayKey)}</button>
			{/if}
			{#if session.state !== 'programmed'}
				<button
					type="button"
					class="ui-button ui-button--ghost ui-button--sm"
					aria-label={`Add “${session.title}” to the program`}
					disabled={busy || placing !== null}
					onclick={() => addToProgram(row)}>Add to program</button>
			{:else}
				<button
					type="button"
					class="ui-button ui-button--ghost ui-button--sm"
					aria-label={`Speakers on “${session.title}”`}
					aria-haspopup="dialog"
					disabled={placing !== null}
					onclick={() => openSpeakers(session)}>Speakers…</button>
			{/if}
			<!-- The record's own disclosure: the labelled facts the row's two lines
			     compress into a run-on, plus the people the pool row never named.
			     One component, two presentations — an inline expansion where there
			     is room beside the list, a full-screen sheet on a phone. -->
			<button
				type="button"
				class="ui-button ui-button--ghost ui-button--sm pool__detail-door"
				aria-expanded={open}
				aria-label={open ? `Hide details of “${session.title}”` : `Details of “${session.title}”`}
				onclick={() => (detailId = open ? null : session.id)}>{open ? 'Hide' : 'Details'}</button>
		</div>
		{#if open}
			<div class="pool__detail">
				<RecordDetail title={session.title} onclose={() => (detailId = null)}>
					{#snippet fields()}
						<!-- Field order mirrors the row's own reading order. -->
						<RecordField label="Length">{session.durationMin} min</RecordField>
						<RecordField label="Format">{formatName(session.formatId)}</RecordField>
						<RecordField label="Track">
							{#if track}
								<TrackChip name={track.name} id={track.id} order={trackIds} />
							{:else}
								No track
							{/if}
						</RecordField>
						<RecordField label="Stage">{sessionStateLabel[session.state]}</RecordField>
						<RecordField label="Placed">
							{#if placement && dayIsDrawable(placement.dayKey)}
								{dayLabel(placement.dayKey)}
								{rangeLabel(placement.startMin, session.durationMin)} · {roomName(placement.roomId)}
							{:else if placement}
								At a time the current grid cannot draw
							{:else}
								Not placed yet
							{/if}
						</RecordField>
						<RecordField label="Speakers">
							{#if session.speakers.length > 0}
								{session.speakers.map((speaker) => speaker.name).join(', ')}
							{:else if session.state === 'collecting'}
								Collecting — {proposalsLabel(row.proposalCount)}
							{:else}
								No speakers yet
							{/if}
						</RecordField>
					{/snippet}
				</RecordDetail>
			</div>
		{/if}
	</li>
{/snippet}

{#snippet roomForm()}
	<form class="add-room" onsubmit={addRoom}>
		<div class="add-room__fields">
			<Field id="board-room-name" label="Room name">
				{#snippet children({ id, describedBy })}
					<input
						class="ui-control"
						type="text"
						{id}
						aria-describedby={describedBy}
						disabled={addingRoom}
						bind:this={newRoomInput}
						bind:value={newRoomName} />
				{/snippet}
			</Field>
			<Field id="board-room-seats" label="Seats">
				{#snippet children({ id, describedBy })}
					<input
						class="ui-control"
						type="number"
						min="1"
						step="1"
						{id}
						aria-describedby={describedBy}
						disabled={addingRoom}
						bind:value={newRoomCapacity} />
				{/snippet}
			</Field>
		</div>
		<Button
			type="submit"
			variant="secondary"
			size="sm"
			disabled={!roomReady || addingRoom}
			loading={addingRoom}>Add room</Button>
	</form>
{/snippet}

<CommitReceipt onUndone={load} />

{#if placing}
	<!-- Narrow/touch only (CSS-gated): the in-place anchors scroll away there and
	     Esc does not exist, so the mode pins its name and exit to the thumb zone
	     as an overlay — fixed, so it moves no layout. -->
	<div class="mode-strip">
		<p class="mode-strip__title">{placingOrigin ? 'Moving' : 'Placing'} “{placing.title}”</p>
		<button
			type="button"
			class="ui-button ui-button--secondary ui-button--sm"
			onclick={cancelPlacement}>Cancel</button>
	</div>
{/if}

<p class="ui-sr-only" role="status">{announcement}</p>

<!-- The confirm step: the click chose an opening; committing the exact time is
     a deliberate act with the preflight rendered in place, so a misplacement is
     hard and precision is typed, never aimed. -->
<Modal bind:open={confirmOpen} title={placingOrigin ? 'Move session' : 'Place session'}>
	{#if placing}
		<p class="confirm__session">{placing.title}</p>
		<p class="confirm__where">
			{dayLabel(confirmDay)} · {roomName(confirmRoom)}{#if confirmNote}
				<span class="confirm__note"> — {confirmNote}</span>{/if}
		</p>
		{#if confirmNeighbors.prev || confirmNeighbors.next}
			<!-- Relative-to-neighbour setters, now touch-only (owner direction,
			     2026-08-13): on a desktop the aim already landed this time within
			     leeway, the grid stays visible beside the dialog, and a miss is a
			     cheap re-move — so the verbs were a third answer to a solved
			     question. On a phone the tap is genuinely approximate and the
			     modal covers the grid, so they stay — introduced candidly as the
			     help they are, not an unexplained extra control. -->
			<div class="confirm__anchors-group">
				<p class="confirm__anchors-why">If the tap landed a little off, snap it exactly:</p>
				<div class="confirm__anchors" role="group" aria-label="Snap to a neighbouring item">
					{#if confirmNeighbors.prev}
						{@const prev = confirmNeighbors.prev}
						<button
							type="button"
							class="ui-button ui-button--secondary ui-button--sm"
							onclick={() => setConfirmStart(prev.startMin, `Right after “${prev.label}”`)}>
							<span class="confirm__anchor-label">Right after “{prev.label}”</span>
						</button>
					{/if}
					{#if confirmNeighbors.next}
						{@const next = confirmNeighbors.next}
						<button
							type="button"
							class="ui-button ui-button--secondary ui-button--sm"
							onclick={() => setConfirmStart(next.startMin, `Right before “${next.label}”`)}>
							<span class="confirm__anchor-label">Right before “{next.label}”</span>
						</button>
					{/if}
				</div>
			</div>
		{/if}
		<div class="confirm__time">
			<Field id="confirm-start" label="Starts">
				{#snippet children({ id, describedBy })}
					<input
						class="ui-control"
						type="time"
						{id}
						aria-describedby={describedBy}
						step="300"
						min={schedule?.dayStart}
						max={clockLabel(Math.max(0, dayLength - (placing?.durationMin ?? 0)))}
						value={clockLabel(confirmStart)}
						oninput={onConfirmTime} />
				{/snippet}
			</Field>
			<div class="confirm__nudges" role="group" aria-label="Nudge start time">
				<button type="button" class="ui-button ui-button--secondary ui-button--sm" onclick={() => nudge(-5)}
					>−5 min</button>
				<button type="button" class="ui-button ui-button--secondary ui-button--sm" onclick={() => nudge(5)}
					>+5 min</button>
			</div>
		</div>
		<p class="confirm__ends">{placing.durationMin} min · ends {clockLabel(confirmEnd)}</p>
		{#if confirmConflicts.length > 0}
			<ul class="confirm__conflicts">
				{#each confirmConflicts as conflict, index (index)}
					<li class="confirm__conflict">
						<!-- A blocking conflict here disables the dialog's own primary, so
						     it takes the emphasis: it is the one thing standing between
						     this dialog and its commit. -->
						<Badge
							{...badgeFor(conflict.severity === 'block' ? 'blocking' : 'warning')}
							value={conflict.severity === 'block' ? 'Blocking' : 'Warning'}
							emphasis={conflict.severity === 'block'} />
						<span class="confirm__conflict-reason">{conflict.reason}</span>
					</li>
				{/each}
			</ul>
			{#if confirmBlocked}
				<p class="confirm__blocked-note">Pick a time that clears the conflict above.</p>
			{/if}
		{/if}
	{/if}
	{#snippet footer(close)}
		<!-- Esc here returns to aiming, not out of the mode — worth its chip. The
		     Enter chip is honest because the window handler commits from the time
		     field; chips are aria-hidden, the names stay the plain verbs. -->
		<button type="button" class="ui-button ui-button--secondary confirm__cancel" onclick={close}
			>Cancel <kbd aria-hidden="true">Esc</kbd></button>
		<button
			type="button"
			class="ui-button ui-button--primary confirm__commit"
			disabled={busy || confirmBlocked}
			onclick={commitPlacement}
			>{placingOrigin ? 'Move session' : 'Place session'} <kbd aria-hidden="true">Enter</kbd></button>
	{/snippet}
</Modal>

<!-- Typed reservation, no aiming: label, day, rooms, exact time. Its edges
     become the flush anchors later placements snap against. -->
<Modal bind:open={breakOpen} title="Add break">
	{#if breakModalError}
		<p class="ui-notice ui-notice--danger" role="alert">{breakModalError}</p>
	{/if}
	<form id="board-break-form" class="break-form" onsubmit={addBreakSubmit}>
		<Field id="break-label" label="Label">
			{#snippet children({ id, describedBy })}
				<input
					class="ui-control"
					type="text"
					{id}
					aria-describedby={describedBy}
					disabled={addingBreak}
					bind:value={breakLabel} />
			{/snippet}
		</Field>
		<div class="break-form__row">
			<Field id="break-day" label="Day">
				{#snippet children({ id, describedBy })}
					<select class="ui-select" {id} aria-describedby={describedBy} disabled={addingBreak} bind:value={breakDay}>
						{#each days as day (day.key)}
							<option value={day.key}>{day.label}</option>
						{/each}
					</select>
				{/snippet}
			</Field>
			<Field id="break-start" label="Starts">
				{#snippet children({ id, describedBy })}
					<input
						class="ui-control"
						type="time"
						{id}
						aria-describedby={describedBy}
						step="300"
						min={schedule?.dayStart}
						max={clockLabel(Math.max(0, dayLength - Number(breakDuration)))}
						disabled={addingBreak}
						bind:value={breakStartClock} />
				{/snippet}
			</Field>
			<Field id="break-length" label="Length">
				{#snippet children({ id, describedBy })}
					<select class="ui-select" {id} aria-describedby={describedBy} disabled={addingBreak} bind:value={breakDuration}>
						{#each ['5', '10', '15', '20', '30', '45', '60'] as minutes (minutes)}
							<option value={minutes}>{minutes} min</option>
						{/each}
					</select>
				{/snippet}
			</Field>
		</div>
		<ChoiceGroup legend="Rooms">
			{#each activeRooms as room (room.id)}
				<label class="break-form__room">
					<input
						type="checkbox"
						disabled={addingBreak}
						checked={breakRooms[room.id] ?? false}
						onchange={(event) =>
							(breakRooms = { ...breakRooms, [room.id]: event.currentTarget.checked })} />
					{room.name}
				</label>
			{/each}
		</ChoiceGroup>
		<p class="break-form__hint">
			A break reserves the time: placement snaps flush against it, and a session typed over it
			carries a visible warning.
		</p>
	</form>
	{#snippet footer(close)}
		<button type="button" class="ui-button ui-button--secondary" onclick={close}>Cancel</button>
		<Button
			type="submit"
			form="board-break-form"
			variant="primary"
			disabled={!breakReady || addingBreak}
			loading={addingBreak}>Add break</Button>
	{/snippet}
</Modal>

<style>
	/* The reviewed lane's own card, matching the Program Vocabulary merge review:
	   a titled panel, the facts, the disclosure, then the two presses. */
	.publish-review {
		display: grid;
		gap: var(--je-space-4);
		padding: var(--je-space-5);
		margin-block-end: var(--je-space-6);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.publish-review h2,
	.publish-review h3,
	.publish-review p {
		margin: 0;
	}

	.publish-review h2 {
		font-size: var(--je-font-size-lg);
	}

	.publish-review__lede {
		margin-block-start: var(--je-space-1);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.publish-review__facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-6);
		margin: 0;
	}

	.publish-review__facts dt {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.publish-review__facts dd {
		margin: 0;
		font-size: var(--je-font-size-xl);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.publish-review__names h3 {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.publish-review__names ul,
	.publish-review__names ol {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-1) var(--je-space-3);
		margin: var(--je-space-2) 0 0;
		padding: 0;
		list-style: none;
		font-size: var(--je-font-size-sm);
	}

	.publish-review__none {
		margin-block-start: var(--je-space-2);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.publish-review__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	/* The narrow composition stacks the presses rather than crushing them:
	   the primary keeps a full-width target and Cancel sits under it. */
	@media (max-width: 36rem) {
		.publish-review__actions {
			display: grid;
			grid-template-columns: 1fr;
		}
	}

	/* Header row: day switch, conflict tally, and the publish commit. */
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-3);
	}

	.head__days {
		max-inline-size: 100%;
		overflow-x: auto;
	}

	/* While placing, each day button carries its opening count for the session
	   in hand — the cross-day map, without expanding the board. Muted so the
	   day names stay the labels and the digits stay the aside. */
	.day-count {
		margin-inline-start: var(--je-space-1);
		font-size: var(--je-font-size-2xs);
		font-weight: 650;
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.head__conflicts {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* A door that reads as the fact it states: plain text with the underline
	   affordance, not a second button competing with Publish. */
	.head__conflicts-door {
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: inherit;
		cursor: pointer;
		text-decoration: underline;
		text-decoration-color: var(--je-color-border-strong);
		text-underline-offset: 3px;
	}

	.head__conflicts-door:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
		border-radius: 2px;
	}

	.count {
		font-weight: 650;
	}

	.count--block {
		color: var(--je-color-danger);
	}

	.count--warn {
		color: var(--je-color-warning);
	}

	.head__publish {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		margin-inline-start: auto;
	}

	.publish__reason {
		margin: 0;
		max-inline-size: 26rem;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-danger);
	}

	.publish__reason:empty {
		display: none;
	}

	/* Grid beside its working panels; the panels stack under it on narrow width. */
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 20rem;
		gap: var(--je-space-4);
		align-items: start;
	}

	/* A committed placement re-reads the schedule; the grid and its panels dim in
	   place, keeping the day a person is reading instead of collapsing back to
	   the loading shells. The header stays live so its controls still answer. */
	.layout.is-refreshing {
		opacity: 0.55;
		pointer-events: none;
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	.board-region {
		display: grid;
		gap: var(--je-space-2);
		min-inline-size: 0;
		/* The compact-viewport mode entry scrolls here; clear the shell bar so
		   the room rail arrives whole. */
		scroll-margin-block-start: 4rem;
	}

	.aside {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-4);
		min-inline-size: 0;
	}

	/* The mode's compact-viewport voice: a strip pinned to the thumb zone as an
	   overlay, because the in-place anchors (pool row, origin card) scroll away
	   on a single-column layout and touch has no Esc. Desktop never shows it —
	   there the mode surfaces nothing at all. */
	.mode-strip {
		display: none;
	}

	/* A key chip teaches a key that exists: touch has no Esc or Enter, so every
	   chip comes off there (narrow desktop windows keep them). */
	@media (pointer: coarse) {
		.pool__actions kbd,
		.card__actions--standing kbd,
		.confirm__cancel kbd,
		.confirm__commit kbd,
		.ghost__cue-esc {
			display: none;
		}
	}

	@media (max-width: 920px), (pointer: coarse) {
		.mode-strip {
			position: fixed;
			inset-inline: 0;
			inset-block-end: 0;
			/* Above the dev scenario pills (z 90): while the mode is active the
			   strip owns the bottom edge, and it leaves with the mode. */
			z-index: 100;
			display: flex;
			align-items: center;
			gap: var(--je-space-3);
			padding: var(--je-space-2) var(--je-space-4);
			padding-block-end: calc(var(--je-space-2) + env(safe-area-inset-bottom));
			border-block-start: 1px solid var(--je-color-border);
			background: var(--je-color-surface);
			box-shadow: var(--je-shadow-md);
		}

		.mode-strip__title {
			flex: 1;
			min-inline-size: 0;
			margin: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: var(--je-font-size-sm);
			font-weight: 650;
		}
	}

	/* The grid keeps its own scroll in both axes so a whole day never stretches
	   the page; the room headers and the time gutter stay pinned inside it. */
	.board-wrap {
		max-block-size: min(50rem, 78vh);
	}


	.board {
		--gutter: 3.5rem;
		--slot-h: 6.25rem;
		--col-min: 11rem;
		display: grid;
		grid-template-columns: var(--gutter) repeat(var(--cols), minmax(var(--col-min), 1fr));
		min-inline-size: calc(var(--gutter) + var(--cols) * var(--col-min));
		padding-block-end: var(--je-space-6);
	}

	.board__corner,
	.board__room {
		position: sticky;
		inset-block-start: 0;
		z-index: 5;
		border-block-end: 1px solid var(--je-color-border);
		background: var(--je-color-surface);
	}

	.board__corner {
		inset-inline-start: 0;
		z-index: 6;
	}

	.board__room {
		display: grid;
		gap: var(--je-space-1);
		padding: var(--je-space-2) var(--je-space-3);
		border-inline-start: 1px solid var(--je-color-border);
	}

	.board__room-name {
		font-size: var(--je-font-size-sm);
		font-weight: 650;
	}

	.board__room-cap {
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.board__times {
		position: sticky;
		inset-inline-start: 0;
		z-index: 4;
		display: grid;
		grid-template-rows: repeat(var(--slots), var(--slot-h));
		background: var(--je-color-surface);
	}

	.board__time {
		padding-block-start: var(--je-space-1);
		padding-inline-end: var(--je-space-2);
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
		text-align: end;
	}

	/* The aim's live start on the axis. Its top edge is the exact minute (the
	   tick), the digits mirror the slot labels' geometry one weight and one ink
	   step apart, and the surface fill masks a fixed label it lands on so the
	   two never overprint. Position follows the aim instantly — it is direct
	   manipulation, not motion. */
	.board__time-marker {
		position: absolute;
		inset-block-start: calc(var(--start) * var(--slot-h));
		inset-inline: 0;
		block-size: 1lh;
		box-sizing: content-box;
		padding-block-start: var(--je-space-1);
		padding-inline-end: var(--je-space-2);
		border-block-start: 2px solid var(--je-color-action);
		background: var(--je-color-surface);
		font-size: var(--je-font-size-2xs);
		font-weight: 650;
		color: var(--je-color-link);
		font-variant-numeric: tabular-nums;
		text-align: end;
		pointer-events: none;
	}

	/* Half-hour rules sit under stronger hour rules so the eye finds the hour. */
	.board__col {
		position: relative;
		block-size: calc(var(--slots) * var(--slot-h));
		border-inline-start: 1px solid var(--je-color-border);
		background-image:
			repeating-linear-gradient(
				to bottom,
				var(--je-color-border) 0 1px,
				transparent 1px calc(var(--slot-h) * 2)
			),
			repeating-linear-gradient(
				to bottom,
				var(--je-color-border-subtle) 0 1px,
				transparent 1px var(--slot-h)
			);
	}

	.board__note {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.card {
		--card-ring: 0 0 0 0 transparent;
		position: absolute;
		z-index: 1;
		inset-inline: var(--je-space-1);
		inset-block-start: calc(var(--start) * var(--slot-h));
		block-size: calc(var(--span) * var(--slot-h) - 2px);
		scroll-margin: var(--je-space-8);
		display: grid;
		align-content: start;
		gap: var(--je-space-1);
		overflow: hidden;
		padding: var(--je-space-2);
		padding-inline-start: calc(var(--je-space-2) + 3px);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface);
		box-shadow: var(--card-ring), var(--je-shadow-xs);
		transition: box-shadow var(--je-duration-fast) var(--je-ease);
	}

	/* The sanctioned dense-grid edge marker: a 3px track accent on the card. */
	.card__track {
		position: absolute;
		inset-block: 0;
		inset-inline-start: 0;
		inline-size: 3px;
		background: var(--track);
	}

	.card--blocked {
		--card-ring: inset 0 0 0 1px var(--je-color-danger-fill);
		border-color: var(--je-color-danger-fill);
	}

	/* A held planned slot: hollow and dashed, deliberately not the action-
	   colored ghost — a ghost is an uncommitted draft, while this slot is a
	   committed reservation whose *content* is still being collected. Neutral
	   ink, sunken fill, dashed boundary (16 §6's direction; ⚠ default pending
	   Q32's grid-voice residual). */
	.card--collecting {
		border-style: dashed;
		background: var(--je-color-surface-sunken);
	}

	.card__who--collecting {
		font-style: italic;
	}

	/* While placing, committed cards are context: still readable — the pattern
	   of the day is exactly what the mode exists to show — but visually behind
	   the openings, and their controls rest. */
	.card--context {
		opacity: 0.78;
	}

	.card--context .card__actions {
		display: none;
	}

	/* The slot being left during a move: clearly this session, clearly not an
	   offer. It has no controls and no track mark — the ghost is the live copy. */
	.card--origin {
		border-style: dashed;
		background: var(--je-color-surface-sunken);
		opacity: 0.8;
		/* While a session is in hand the pointer belongs to the aim, not to the
		   slot being left. Without this the origin's own content wins the hit test
		   over the opening drawn through it, so crossing into its own slot fires
		   the opening's `pointerleave`, clears the aim, and drops the ghost — then
		   the pointer lands back on the opening and re-aims. The enter/leave pair
		   repeats faster than the eye separates and reads as flicker, exactly over
		   the one position a move is most likely to be aimed at.

		   Same reasoning as the row-note overlay in the design record: an element
		   that appears under the cursor must not take it. Its one control is the
		   deliberate exception. */
		pointer-events: none;
		/* Above the openings drawn through it, so its Cancel stays clickable and
		   its focus ring stays visible; below a focused opening, which owns the
		   ring while the keyboard is aiming. */
		z-index: 2;
	}

	/* The aim has come back to this slot. Nothing will change if it lands here, so
	   the marker keeps its neutral fill — coral would promise a move — and takes a
	   quiet ring to confirm it is what the pointer is on. The line beside the time
	   carries the meaning; the ring alone never does. */
	.card--origin-aimed {
		border-style: solid;
		border-color: var(--je-color-action);
		opacity: 1;
	}

	/* The button, not its padded wrapper: every pixel handed back to the marker is
	   a pixel the aim goes dead, and the wrapper's leading padding sits right
	   where the ghost is read. */
	.card--origin .card__actions button {
		pointer-events: auto;
	}

	.card__title {
		margin: 0;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		line-height: var(--je-leading-snug);
	}

	.card__when {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1);
		margin: 0;
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
	}

	.card__time {
		font-variant-numeric: tabular-nums;
	}

	.card__who {
		margin: 0;
		overflow: hidden;
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* A card is only as tall as its slot span, so its actions stay clipped until
	   the card is hovered or one of them takes keyboard focus. They remain in
	   the document and in the tab order the whole time, so tabbing into a card
	   reveals them; the card then lifts to show everything it holds. */
	.card__actions {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}

	.card:hover .card__actions,
	.card:focus-within .card__actions {
		position: static;
		display: flex;
		gap: var(--je-space-1);
		inline-size: auto;
		block-size: auto;
		overflow: visible;
		padding-block-start: var(--je-space-1);
		clip-path: none;
	}

	/* The origin card's Cancel stands without hover: while the mode is active,
	   its exit must be visible, not discovered. */
	.card__actions--standing {
		position: static;
		display: flex;
		gap: var(--je-space-1);
		inline-size: auto;
		block-size: auto;
		overflow: visible;
		padding-block-start: var(--je-space-1);
		clip-path: none;
	}

	.card:hover,
	.card:focus-within {
		z-index: 3;
		block-size: auto;
		min-block-size: calc(var(--span) * var(--slot-h) - 2px);
		overflow: visible;
		box-shadow: var(--card-ring), var(--je-shadow-md);
	}

	/* Context and origin cards do not lift: nothing under them answers.

	   `:focus-within` matters as much as `:hover` here. Entering a move with the
	   pointer hands focus to the origin's own Cancel, so the marker sat lifted to
	   z-index 3 for the whole mode — above the ghost at 2. Aiming back at the
	   slot then drew the ghost behind the thing it was standing in for. */
	.card--context:hover,
	.card--context:focus-within {
		z-index: 1;
		box-shadow: var(--card-ring), var(--je-shadow-xs);
	}

	/* The origin keeps its own stable level rather than the lift: entering a move
	   with the pointer hands focus to its Cancel, so `:focus-within` held it
	   lifted for the whole mode. */
	.card--origin:hover,
	.card--origin:focus-within {
		z-index: 2;
		box-shadow: var(--card-ring), var(--je-shadow-xs);
	}

	.card:hover .card__title,
	.card:focus-within .card__title {
		-webkit-line-clamp: unset;
		line-clamp: unset;
	}

	.card:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	/* The armed removal: the object's own face becomes the question. Anchored to
	   the block's top and at least its full height, growing downward when a short
	   block cannot hold the question — the parent lifts and releases its clip so
	   the veil is never truncated. */
	.card--armed,
	.brk--armed {
		z-index: 3;
		overflow: visible;
	}

	.confirm-veil {
		position: absolute;
		inset-inline: 0;
		inset-block-start: 0;
		z-index: 4;
		min-block-size: 100%;
		display: grid;
		align-content: center;
		justify-items: start;
		gap: var(--je-space-2);
		padding: var(--je-space-2);
		border-radius: var(--je-radius-control);
		background:
			linear-gradient(var(--je-color-danger-soft), var(--je-color-danger-soft)),
			var(--je-color-surface);
		box-shadow:
			inset 0 0 0 1px var(--je-color-danger-fill),
			var(--je-shadow-md);
	}

	.confirm-veil__q {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
	}

	.confirm-veil__actions {
		display: flex;
		gap: var(--je-space-2);
	}

	/* The aim ghost rides above cards and never intercepts the pointer.
	   `.je-ghost` in the utility layer is the canonical draft treatment, but a
	   Svelte scoped `.card` outranks every @layer, so the same two declarations
	   are restated here to win — change them only in step with the utility. */
	.ghost {
		z-index: 2;
		pointer-events: none;
		box-shadow: none;
		border: 1px dashed var(--je-color-action);
		background: color-mix(in srgb, var(--je-color-action-soft) 70%, var(--je-color-surface));
	}

	/* A held flush anchor said spatially: the edge touching the neighbour goes
	   solid. Inset shadows, so the mark costs no layout and clips nowhere. */
	.ghost--flush-start {
		box-shadow: inset 0 2px 0 var(--je-color-action);
	}

	.ghost--flush-end {
		box-shadow: inset 0 -2px 0 var(--je-color-action);
	}

	.ghost--flush-start.ghost--flush-end {
		box-shadow:
			inset 0 2px 0 var(--je-color-action),
			inset 0 -2px 0 var(--je-color-action);
	}

	.ghost__cue {
		margin: 0;
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
	}

	/* An opening: free space offering itself. Quiet at rest so the day's shape
	   stays legible; the pointer brightens only the opening under it. */
	.opening {
		position: absolute;
		z-index: 1;
		inset-inline: var(--je-space-1);
		inset-block-start: calc(var(--start) * var(--slot-h));
		block-size: calc(var(--span) * var(--slot-h) - 2px);
		margin: 0;
		padding: 0;
		border: 1px dashed color-mix(in srgb, var(--je-color-action) 30%, transparent);
		border-radius: var(--je-radius-control);
		background: color-mix(in srgb, var(--je-color-action-soft) 26%, transparent);
		cursor: pointer;
		transition:
			background var(--je-duration-fast) var(--je-ease),
			border-color var(--je-duration-fast) var(--je-ease);
	}

	.opening:hover {
		border-color: var(--je-color-action);
		background: color-mix(in srgb, var(--je-color-action-soft) 62%, transparent);
	}

	/* Above the ghost, not level with it: at equal z-index the ghost is later in
	   the DOM and would paint over the focus ring — and a keyboard aim that lands
	   on the origin puts the ghost on exactly the opening being focused. */
	.opening:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
		z-index: 3;
	}

	/* Space that refuses the session in hand: visible, hatched, and carrying its
	   reason through the popover it is made of. */
	.opening-blocked {
		position: absolute;
		z-index: 1;
		inset-inline: var(--je-space-1);
		inset-block-start: calc(var(--start) * var(--slot-h));
	}

	.opening-blocked__fill {
		display: block;
		block-size: calc(var(--span) * var(--slot-h) - 2px);
		border-radius: var(--je-radius-control);
		background-color: transparent;
		background-image: repeating-linear-gradient(
			-45deg,
			var(--je-color-border) 0 1px,
			transparent 1px 7px
		);
		transition: background-color var(--je-duration-fast) var(--je-ease);
	}

	.opening-blocked:hover .opening-blocked__fill {
		background-color: var(--je-color-surface-sunken);
	}

	/* A break: reserved time, deliberately quieter than a session card. */
	.brk {
		position: absolute;
		z-index: 1;
		inset-inline: var(--je-space-1);
		inset-block-start: calc(var(--start) * var(--slot-h));
		block-size: calc(var(--span) * var(--slot-h) - 2px);
		display: flex;
		align-items: start;
		gap: var(--je-space-2);
		overflow: hidden;
		padding: var(--je-space-1) var(--je-space-2);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background-color: var(--je-color-surface-sunken);
		background-image: repeating-linear-gradient(
			-45deg,
			var(--je-color-border-subtle) 0 1px,
			transparent 1px 9px
		);
	}

	.brk__copy {
		display: flex;
		flex-wrap: wrap;
		column-gap: var(--je-space-2);
		margin: 0;
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
	}

	.brk__label {
		font-weight: 650;
	}

	.brk__time {
		font-variant-numeric: tabular-nums;
	}

	/* Like a card's actions, the remove control rests until the block is hovered
	   or focused; short breaks then grow to show it. */
	.brk__remove {
		margin-inline-start: auto;
		visibility: hidden;
	}

	.brk:hover,
	.brk:focus-within {
		z-index: 3;
		block-size: auto;
		min-block-size: calc(var(--span) * var(--slot-h) - 2px);
	}

	.brk:hover .brk__remove,
	.brk:focus-within .brk__remove {
		visibility: visible;
	}

	.blank {
		display: grid;
		justify-items: start;
		align-content: center;
		gap: var(--je-space-3);
		min-block-size: 22rem;
		padding: var(--je-space-8);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.blank__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 600;
	}

	.blank__copy {
		margin: 0;
		max-inline-size: 56ch;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.blank__rooms {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* The one fact in this region that contradicts what the board appears to
	   say, so it holds full ink and a caution tone while the explanatory copy
	   around it stays muted. The word carries the state; the colour agrees. */
	.blank__stranded {
		margin: 0;
		max-inline-size: 56ch;
		padding: var(--je-space-2) var(--je-space-3);
		border-inline-start: 3px solid var(--je-color-warning);
		border-radius: var(--je-radius-control);
		background: var(--je-color-warning-soft);
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-text);
	}

	/* The blank state's one accent-dominant element: the door that supplies
	   what is missing. Everything else here is copy. */
	.blank__door a {
		font-weight: 650;
	}

	/* Creation lives with the grid it feeds: the disclosure sits under the board
	   so opening it grows the region downward and moves nothing above it. */
	.board-add {
		display: grid;
		justify-items: start;
		gap: var(--je-space-2);
	}

	.board-add__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.board-add__panel {
		inline-size: 100%;
		max-inline-size: 26rem;
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
	}

	.add-room {
		display: grid;
		justify-items: start;
		gap: var(--je-space-3);
		inline-size: 100%;
		max-inline-size: 26rem;
	}

	.add-room__fields {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 6rem;
		gap: var(--je-space-3);
		inline-size: 100%;
	}

	.panel {
		padding: var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.panel__head {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-2);
		margin-block-end: var(--je-space-3);
	}

	.panel__head h2 {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.panel__count {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.panel__calm {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* Why these rows offer no placement. Full ink, because it is the answer to
	   a question the reader is about to ask about every row beneath it. */
	.panel__blocked {
		margin: 0 0 var(--je-space-3);
		padding: var(--je-space-2) var(--je-space-3);
		border-inline-start: 3px solid var(--je-color-warning);
		border-radius: var(--je-radius-control);
		background: var(--je-color-warning-soft);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text);
	}

	.reason {
		margin: 0;
	}

	.reason__note {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Both panels take focus when a link lands on them; the ring is the same one
	   every focusable surface uses. */
	.panel:focus-visible,
	.pool__row:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.conflicts,
	.pool {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.conflicts__row {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		grid-template-areas:
			'sev copy'
			'. action';
		align-items: start;
		gap: var(--je-space-2) var(--je-space-3);
		padding-block: var(--je-space-3);
	}

	.conflicts__row + .conflicts__row {
		border-block-start: 1px solid var(--je-color-border);
	}

	.conflicts__sev {
		grid-area: sev;
	}

	.conflicts__copy {
		grid-area: copy;
		min-inline-size: 0;
	}

	.conflicts__action {
		grid-area: action;
		justify-self: start;
	}

	.conflicts__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.conflicts__reason {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* The record: a rail carrying the track accent, the identifying line and its
	   scan keys, then the trailing affordances on their own line aligned with
	   the copy. One arrangement at every width — this panel is 20rem on the
	   widest desktop, so a copy column crushed between two fixed neighbours was
	   never a desktop design either; it was the narrow failure showing up early.
	   Touch metrics arrive with the density tokens, so the controls grow to the
	   44px row on a phone without a second rule here. */
	.pool__row {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas:
			'copy'
			'action'
			'detail';
		align-items: start;
		gap: var(--je-space-2);
		padding-block: var(--je-space-3);
		padding-inline-start: var(--je-space-3);
		border-inline-start: 3px solid var(--track);
	}

	.pool__row + .pool__row {
		border-block-start: 1px solid var(--je-color-border);
	}

	/* The session in hand is marked among its peers, not lifted: chosen-for-now
	   is metadata, and the board is where the work is happening. */
	.pool__row--active {
		background: var(--je-color-mark-surface);
	}

	.pool__copy {
		grid-area: copy;
		min-inline-size: 0;
	}

	.pool__action {
		grid-area: action;
	}

	.pool__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	/* The scan keys. A chip sits on this line, so the line is a flex row with a
	   baseline it can share rather than a run of inline text the chip breaks. */
	.pool__meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-2);
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.pool__untracked {
		color: var(--je-color-text-subtle);
	}

	/* A gap named on the row: quiet ink for a plan ("No speakers yet"), a link
	   only where a door exists (proposals to decide). */
	.pool__fact {
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* The trailing affordances: a wrapping row, never a column of stretched
	   blocks. Three full-width buttons under every row turned a worklist into a
	   stack of forms on a phone, and made each row's real primary — Place… —
	   indistinguishable from the disclosure beside it. */
	.pool__actions {
		grid-area: action;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-2);
	}

	/* The disclosure is the quietest control in the row and sits last. */
	.pool__detail-door {
		margin-inline-start: auto;
	}

	.pool__detail {
		grid-area: detail;
	}

	/* Group separation, carried by the inline presentation itself: the labelled
	   facts are a different kind of thing from the row's own lines, so the
	   boundary is visible and the gap around the group is larger than the gaps
	   inside it. The sheet presentation is out of flow (`display: contents`), so
	   attaching this to the inline host is also what stops the row holding a
	   blank strip open for a detail that has left the page. */
	.pool__detail :global(.ui-detail-host[data-presentation='inline']) {
		display: block;
		margin-block-start: var(--je-space-1);
		padding-block-start: var(--je-space-3);
		padding-inline-end: var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border);
	}

	/* An expansion is part of what opened it: the open row keeps the marked
	   surface rather than showing the page behind it. */
	.pool__row--open {
		background: var(--je-color-surface-sunken);
	}

	.pool-group + .pool-group {
		margin-block-start: var(--je-space-4);
	}

	.pool-group__title {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-2);
		margin: 0 0 var(--je-space-1);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	/* The scope a link arrived with, visible and dismissible (Q23 fill 1). */
	.panel__scope {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		margin: 0 0 var(--je-space-2);
	}

	.panel__head-action {
		margin-inline-start: auto;
	}

	/* The dialog supplies the surface; the form is plain composition inside it. */
	.new-session {
		display: grid;
		gap: var(--je-space-3);
	}

	.new-session__choice {
		display: grid;
		gap: var(--je-space-1);
	}

	.new-session__vocab-note {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Two real columns while they fit — a mint row opening under a select
	   needs the width of a text field, not a sliver — collapsing to one on a
	   narrow dialog. Minutes simply takes the next cell. */
	.new-session__vocab {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: var(--je-space-3);
	}

	.new-session__actions {
		display: flex;
		gap: var(--je-space-2);
	}

	/* The speakers panel: people rows with their provenance in place. */
	.speakers {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.speakers__body {
		display: grid;
		gap: var(--je-space-3);
	}

	/* The continuity cue: the session this dialog acts on, and where it
	   stands — placed and when, or honestly unplaced — so mid-attribution the
	   thread is never lost behind the covered grid. */
	.speakers__context {
		padding-block-end: var(--je-space-3);
		border-block-end: 1px solid var(--je-color-border);
	}

	.speakers__session {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.speakers__meta {
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.speakers__calm {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.speakers__row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content;
		align-items: center;
		gap: var(--je-space-3);
		padding-block: var(--je-space-2);
	}

	.speakers__row + .speakers__row {
		border-block-start: 1px solid var(--je-color-border);
	}

	.speakers__copy {
		min-inline-size: 0;
	}

	.speakers__edits {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--je-space-1);
		flex-wrap: wrap;
	}

	.speakers__role {
		inline-size: auto;
		min-inline-size: 8rem;
	}

	.speakers__name {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.speakers__provenance {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.speakers__group {
		margin: var(--je-space-2) 0 calc(-1 * var(--je-space-2));
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.speakers__direct {
		margin-block-start: var(--je-space-4);
	}

	.speakers__form {
		display: grid;
		gap: var(--je-space-3);
		margin-block-start: var(--je-space-3);
	}

	/* The confirm dialog: where, exactly when, and what the preflight says. */
	.confirm__session {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.confirm__where {
		margin: var(--je-space-1) 0 var(--je-space-4);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.confirm__note {
		font-weight: 650;
		color: var(--je-color-link);
	}

	/* Touch-only: on a fine pointer the aim already answered this, so the
	   group stays out of the dialog entirely (owner direction, 2026-08-13). */
	.confirm__anchors-group {
		display: none;
	}

	@media (max-width: 920px), (pointer: coarse) {
		.confirm__anchors-group {
			display: block;
			margin-block-end: var(--je-space-3);
		}
	}

	.confirm__anchors-why {
		margin: 0 0 var(--je-space-1);
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.confirm__anchors {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	/* A neighbour's title can be long; the verb stays one line and the quoted
	   title gives way. */
	.confirm__anchor-label {
		display: block;
		max-inline-size: 18rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.confirm__time {
		display: flex;
		align-items: end;
		gap: var(--je-space-3);
	}

	.confirm__nudges {
		display: flex;
		gap: var(--je-space-2);
		padding-block-end: 2px;
	}

	.confirm__ends {
		margin: var(--je-space-2) 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.confirm__conflicts {
		display: grid;
		gap: var(--je-space-2);
		list-style: none;
		margin: var(--je-space-4) 0 0;
		padding: 0;
	}

	.confirm__conflict {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-2);
	}

	.confirm__conflict-reason {
		font-size: var(--je-font-size-sm);
	}

	.confirm__blocked-note {
		margin: var(--je-space-2) 0 0;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-danger);
	}

	/* The base kbd chip is drawn for light surfaces; on the coral primary it
	   keeps only its outline and inherits the button's ink. */
	.confirm__commit kbd {
		border-color: color-mix(in srgb, currentcolor 45%, transparent);
		background: transparent;
		color: inherit;
	}

	/* The break form: typed precision, one row for the when. */
	.break-form {
		display: grid;
		gap: var(--je-space-4);
	}

	.break-form__row {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--je-space-3);
	}

	.break-form__room {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		font-size: var(--je-font-size-sm);
	}

	.break-form__hint {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Loading mirrors the resolved footprint so nothing collapses then expands. */
	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, a chip is badge-height, and the day
	   switch and actions are control-height. */
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
		inline-size: 4rem;
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 6.5rem;
		border-radius: var(--je-radius-control);
	}

	.sk-days {
		inline-size: 14rem;
		/* The day switch: segmented items inside their own 2px frame. */
		block-size: calc(var(--je-control-height-sm) + 4px);
		border-radius: calc(var(--je-radius-control) + 2px);
	}

	.sk-publish {
		inline-size: 6rem;
		block-size: var(--je-control-height);
		border-radius: var(--je-radius-control);
	}

	/* Narrow width restructures: the panels move below the grid, the grid keeps
	   its own horizontal scroll, and card actions stop depending on hover. */
	@media (max-width: 920px), (pointer: coarse) {
		.board {
			--slot-h: 8.75rem;
		}

		/* Three named controls do not fit one 11rem column, and the third was
		   being sliced in half by the next room's edge. They wrap instead: a
		   card grows downward inside a column that already scrolls, which costs
		   nothing, where a clipped control costs the action. */
		.card__actions {
			position: static;
			display: flex;
			flex-wrap: wrap;
			gap: var(--je-space-1);
			inline-size: auto;
			block-size: auto;
			overflow: visible;
			padding-block-start: var(--je-space-1);
			clip-path: none;
		}

		/* No hover to reveal it with: the control simply stands. */
		.brk__remove {
			visibility: visible;
		}
	}

	@media (max-width: 920px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
		}

		/* The head wraps here, but the publish cluster keeps its auto margin:
		   actions stay on the right on the wrapped row, exactly as they sit at
		   full width, instead of stringing out after the conflict counts. */

		/* The head wraps to two rows at this width; the resolver wraps with it. */
		.sk-days {
			inline-size: 100%;
		}

		.publish__reason {
			max-inline-size: none;
		}

		.confirm__time {
			flex-wrap: wrap;
			align-items: start;
		}

		.break-form__row {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
