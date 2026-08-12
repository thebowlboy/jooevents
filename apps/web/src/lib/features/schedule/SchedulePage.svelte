<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Modal from '$lib/ui/Modal.svelte';
	import { Button, Field, Popover, revealTarget, statusIcon, trackPending } from '$lib/ui';
	import { useWorkspaceGateway } from '$lib/api/workspace-gateway';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { applyParams, param } from '$lib/features/workspace/url-state.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import ProfilePeek from '$lib/features/workspace/components/ProfilePeek.svelte';
	import {
		columnSegments,
		dayLengthMin,
		defaultStart,
		neighborsAt,
		preflight,
		snapStart,
		type ColumnSegment,
		type NeighborAnchors,
		type SnapResult
	} from './placement-engine';
	import type {
		BreakBlock,
		Format,
		Placement,
		PlacementConflict,
		ScheduleState,
		SessionItem,
		SpeakerProfile,
		SpeakerRow,
		Track
	} from '$lib/api/types';

	const { api } = useWorkspaceGateway();

	let schedule = $state.raw<ScheduleState | null>(null);
	let tracks = $state.raw<Track[]>([]);
	let formats = $state.raw<Format[]>([]);
	let roster = $state.raw<SpeakerRow[]>([]);
	let busy = $state(false);
	let publishReason = $state('');
	let announcement = $state('');
	let conflictsPanel = $state<HTMLElement>();

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

	/**
	 * A session names its speakers as text, so the address a profile is keyed by
	 * has to come back from the roster. Only a name held by exactly one roster
	 * entry resolves; two people spelled alike would otherwise open one of them
	 * under the other's name, which is worse than a plain word.
	 */
	const rosterByName = $derived.by(() => {
		const found = new Map<string, SpeakerRow | null>();
		for (const speaker of roster) {
			found.set(speaker.name, found.has(speaker.name) ? null : speaker);
		}
		return found;
	});

	function profileOf(name: string): SpeakerProfile | null {
		const speaker = rosterByName.get(name);
		return speaker ? (profiles[speaker.email] ?? null) : null;
	}

	/**
	 * One pass for the whole board, after the sessions are on screen. Only
	 * addresses this session has never asked about are read, so the re-read that
	 * follows every placement, publish, and undo costs nothing.
	 */
	async function loadProfiles() {
		const seq = ++profileSeq;
		const emails = [
			...new Set(
				(schedule?.sessions ?? [])
					.flatMap((session) => session.speakerNames)
					.map((name) => rosterByName.get(name)?.email)
					.filter((email) => email !== undefined)
			)
		].filter((email) => !(email in profiles));
		if (emails.length === 0) return;
		const found = await Promise.all(emails.map((email) => api.speakers.profile(email)));
		if (seq !== profileSeq) return;
		const next = { ...profiles };
		emails.forEach((email, index) => (next[email] = found[index]));
		profiles = next;
	}

	async function load() {
		refreshing = true;
		try {
			const next = await api.schedule.state();
			// The page owns a snapshot of the returned state so a committed placement
			// renders immediately without a full route reload.
			schedule = { ...next, placements: [...next.placements], breaks: [...next.breaks] };
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
	/** Without rooms or days there is no grid to draw, only the way in. */
	const boardReady = $derived(rooms.length > 0 && days.length > 0);

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

	/** The viewports that get the bottom mode strip instead of in-page cues. */
	const compactViewport = () =>
		typeof window !== 'undefined' &&
		window.matchMedia('(max-width: 920px), (pointer: coarse)').matches;

	/**
	 * Where the pointer (or keyboard focus) is currently proposing to land.
	 * The source decides whether the ghost carries the Enter cue: it teaches a
	 * key only to someone driving by keyboard, and never churns beside a pointer.
	 */
	let aim = $state.raw<
		({ dayKey: string; roomId: string; source: 'pointer' | 'keyboard' } & SnapResult) | null
	>(null);

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
		if (compactViewport()) boardRegion?.scrollIntoView({ block: 'start' });
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
		if (event.key !== 'Escape' || !placing || confirmOpen || breakOpen) return;
		if (event.target instanceof Element && event.target.closest('.ui-popover')) return;
		cancelPlacement();
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

	function openConfirm(day: string, room: string, snapped: SnapResult) {
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
		const created: BreakBlock[] = [];
		for (const room of chosen) {
			created.push(
				await api.schedule.addBreak({
					label,
					dayKey: breakDay,
					roomId: room.id,
					startMin: offset,
					durationMin: duration
				})
			);
		}
		recordAction({
			area: 'schedule',
			label: `Added “${label}” — ${dayLabel(breakDay)} ${clockLabel(offset)}, ${
				created.length === 1 ? roomName(created[0].roomId) : `${created.length} rooms`
			}`,
			undo: async () => {
				for (const brk of created) await api.schedule.removeBreak(brk.id);
			}
		});
		breakOpen = false;
		await applyParams({ day: breakDay });
		publishReason = '';
		await load();
		addingBreak = false;
	}

	// A break removal arms exactly like a session removal: destructive single
	// row → arm in place, then a receipt whose undo re-adds it.
	let armedBreakId = $state<string | null>(null);
	let disarmBreakTimer: ReturnType<typeof setTimeout> | undefined;

	function armOrRemoveBreak(brk: BreakBlock) {
		if (armedBreakId !== brk.id) {
			armedBreakId = brk.id;
			clearTimeout(disarmBreakTimer);
			disarmBreakTimer = setTimeout(() => (armedBreakId = null), 4000);
			return;
		}
		clearTimeout(disarmBreakTimer);
		armedBreakId = null;
		void removeBreakNow(brk);
	}

	async function removeBreakNow(brk: BreakBlock) {
		if (busy) return;
		busy = true;
		await api.schedule.removeBreak(brk.id);
		recordAction({
			area: 'schedule',
			label: `Removed “${brk.label}” from ${dayLabel(brk.dayKey)} ${clockLabel(brk.startMin)}, ${roomName(brk.roomId)}`,
			undo: async () => {
				await api.schedule.addBreak({
					label: brk.label,
					dayKey: brk.dayKey,
					roomId: brk.roomId,
					startMin: brk.startMin,
					durationMin: brk.durationMin
				});
			}
		});
		publishReason = '';
		await load();
		busy = false;
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
			label: `Added room “${room.name}” — ${room.capacity} seats`,
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
	const unscheduled = $derived((schedule?.sessions ?? []).filter((s) => !placedIds.has(s.id)));
	const dayPlacements = $derived((schedule?.placements ?? []).filter((p) => p.dayKey === dayKey));

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
		return rooms.find((room) => room.id === id)?.name ?? id;
	}

	function dayLabel(key: string): string {
		return days.find((day) => day.key === key)?.label ?? key;
	}

	function trackName(id: string): string {
		return tracks.find((track) => track.id === id)?.name ?? 'Unassigned track';
	}

	function trackColor(id: string): string {
		const accent = tracks.find((track) => track.id === id)?.accent;
		if (accent === 'lavender') return 'var(--je-color-accent-lavender)';
		if (accent === 'sea') return 'var(--je-color-accent-sea)';
		return 'var(--je-color-text-subtle)';
	}

	/**
	 * A format's own label may already carry its nominal length, so only the
	 * leading name is shown beside a session's actual duration.
	 */
	function formatName(id: string): string {
		const name = formats.find((format) => format.id === id)?.name;
		return name ? (name.split('·')[0] ?? name).trim() : id;
	}

	function clockLabel(offsetMin: number): string {
		const total = dayStartMin + offsetMin;
		const hours = Math.floor(total / 60) % 24;
		const minutes = total % 60;
		return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
	}

	function rangeLabel(startMin: number, durationMin: number): string {
		return `${clockLabel(startMin)}–${clockLabel(startMin + durationMin)}`;
	}

	function reasonsFor(placement: Placement, severity: PlacementConflict['severity']): string {
		return placement.conflicts
			.filter((conflict) => conflict.severity === severity)
			.map((conflict) => conflict.reason)
			.join(' · ');
	}

	// Remove arms on the first press and fires on the second, then leaves a
	// receipt whose undo puts the session back in its exact slot.
	let armedRemoveId = $state<string | null>(null);
	let disarmTimer: ReturnType<typeof setTimeout> | undefined;

	function armOrRemove(session: SessionItem, placement: Placement) {
		if (armedRemoveId !== session.id) {
			armedRemoveId = session.id;
			clearTimeout(disarmTimer);
			disarmTimer = setTimeout(() => (armedRemoveId = null), 4000);
			return;
		}
		clearTimeout(disarmTimer);
		armedRemoveId = null;
		void remove(session, placement);
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

	async function publish() {
		if (busy) return;
		busy = true;
		publishReason = '';
		const result = await api.schedule.publish();
		if (!result.ok) publishReason = result.reason;
		else {
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
		if (!ready || !id) {
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
			: `${session.title} is not placed yet; it is waiting in Unscheduled.`;
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
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if !schedule}
	{@const known = api.workspace.summarySnapshot()}
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
			<div class="ui-table-wrap board-wrap">
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
					<h2>Conflicts</h2>
					<span class="panel__count"><span class="ui-skeleton skeleton-line" style="inline-size: 0.75rem"></span></span>
				</header>
				<!-- A conflict count in the shell's summary is the evidence that this
				     panel resolves to rows rather than to its calm line. -->
				{#if known?.navCounts.schedule}
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
			<section class="panel" aria-hidden="true">
				<header class="panel__head">
					<h2>Unscheduled</h2>
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
				{#if blockingCount > 0}<span class="count count--block">{blockingCount} blocking</span>{/if}
				{#if blockingCount > 0 && warningCount > 0}<span class="count__sep"> · </span>{/if}
				{#if warningCount > 0}<span class="count count--warn">{warningCount} warning{warningCount === 1 ? '' : 's'}</span>{/if}
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
				{@const Live = statusIcon.published}
				<span class="ui-badge ui-badge--success"
					><Live class="ui-badge__icon" aria-hidden="true" />Published</span
				>
			{:else}
				<button type="button" class="ui-button ui-button--primary" disabled={busy} onclick={publish}>
					Publish
				</button>
			{/if}
		</div>
	</div>

	<div class="layout" class:is-refreshing={reload.visible} aria-busy={refreshing || undefined}>
		<section class="board-region" aria-label="Schedule grid" bind:this={boardRegion}>
			{#if !boardReady}
				<div class="blank">
					<h2 class="blank__title">Nothing is scheduled yet</h2>
					<p class="blank__copy">
						Drop a spreadsheet, a photo of the whiteboard, or describe your day structure — the
						draft comes back on this grid for review before anything is committed.
					</p>
					<p class="blank__copy">
						Building it by hand works the same way: add a room, then place sessions from the pool
						one slot at a time.
					</p>
					{@render roomForm()}
					{#if rooms.length > 0}
						<!-- The grid needs days as well as rooms, so a room added here has
						     nowhere to appear yet; it is named where it was created. -->
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
				<div class="ui-table-wrap board-wrap">
					<div class="board" style="--cols: {rooms.length}; --slots: {schedule.slotsPerDay}">
						<span class="board__corner"></span>
						{#each rooms as room (room.id)}
							<div class="board__room">
								<span class="board__room-name">{room.name}</span>
								<!-- A retired room keeps its column: nothing already placed in it
								     moves, it is simply no longer offered for new placements. -->
								<span class="board__room-cap"
									>{room.capacity} seats{room.status === 'retired' ? ' · retired' : ''}</span>
							</div>
						{/each}

						<div class="board__times">
							{#each Array(schedule.slotsPerDay) as _, slot (slot)}
								<span class="board__time">{clockLabel(slot * slotMinutes)}</span>
							{/each}
						</div>

						{#each rooms as room (room.id)}
							<div class="board__col">
								{#each schedule.placements.filter((p) => p.dayKey === dayKey && p.roomId === room.id) as placement (placement.sessionId)}
									{@const session = sessionOf(placement.sessionId)}
									{#if session}
										{#if placing?.id === session.id}
											<!-- The slot being left, kept visible while choosing the next
											     one — and the mode's exit lives here, exactly where Move
											     was pressed, instead of in a bar somewhere else. -->
											<article
												class="card card--origin"
												style="--start: {placement.startMin / slotMinutes}; --span: {session.durationMin / slotMinutes}">
												<p class="card__title">{session.title}</p>
												<p class="card__when">
													<span class="card__time">{rangeLabel(placement.startMin, session.durationMin)}</span>
													<span>· current slot</span>
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
											<article
												class="card"
												class:card--blocked={blocked}
												class:card--context={placing !== null}
												id={`placed-${placement.sessionId}`}
												tabindex="-1"
												style="--start: {placement.startMin / slotMinutes}; --span: {session.durationMin / slotMinutes}">
												<span
													class="card__track"
													style="--track: {trackColor(session.trackId)}"
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
														{@const Blocking = statusIcon.blocking}
														{@const reason = reasonsFor(placement, 'block')}
														<Popover
															label={`Conflict — why “${session.title}” is blocking`}
															onreveal={() => (announcement = `${session.title} is blocking: ${reason}`)}>
															{#snippet trigger()}
																<span class="ui-badge ui-badge--danger ui-badge--solid"
																	><Blocking class="ui-badge__icon" aria-hidden="true" />Conflict</span
																>
															{/snippet}
															{#snippet children()}
																<p class="reason">{reason}</p>
																<p class="reason__note">Publication stays blocked until this is resolved.</p>
															{/snippet}
														</Popover>
													{/if}
													{#if warned}
														{@const Warned = statusIcon.warning}
														{@const reason = reasonsFor(placement, 'warn')}
														<Popover
															label={`Warning — why “${session.title}” is flagged`}
															onreveal={() => (announcement = `${session.title} warning: ${reason}`)}>
															{#snippet trigger()}
																<span class="ui-badge ui-badge--warning"
																	><Warned class="ui-badge__icon" aria-hidden="true" />Warning</span
																>
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
												     it (room, capacity, clock) name no person and the unscheduled
												     pool lists none, so nothing else on this board gains a trigger.
												     A name the roster does not resolve stays plain text. -->
												<p class="card__who"
													>{#each session.speakerNames as name, index (name)}{@const profile =
														profileOf(name)}{#if index > 0}{', '}{/if}{#if profile}<ProfilePeek
															{profile} />{:else}{name}{/if}{/each}</p>
												<div class="card__actions">
													<button
														type="button"
														class="ui-button ui-button--secondary ui-button--sm"
														aria-label={`Move “${session.title}”`}
														disabled={busy || placing !== null}
														onclick={(event) => enterPlacement(session, event.detail === 0)}>Move</button>
													<button
														type="button"
														class="ui-button ui-button--danger ui-button--sm"
														aria-label={armedRemoveId === session.id
															? `Press again to remove “${session.title}”`
															: `Remove “${session.title}” from the schedule`}
														disabled={busy || placing !== null}
														onblur={() => (armedRemoveId = null)}
														onclick={() => armOrRemove(session, placement)}>{armedRemoveId === session.id ? 'Remove?' : 'Remove'}</button>
												</div>
											</article>
										{/if}
									{/if}
								{/each}

								{#each schedule.breaks.filter((b) => b.dayKey === dayKey && b.roomId === room.id) as brk (brk.id)}
									<div
										class="brk"
										style="--start: {brk.startMin / slotMinutes}; --span: {brk.durationMin / slotMinutes}">
										<p class="brk__copy">
											<span class="brk__label">{brk.label}</span>
											<span class="brk__time">{rangeLabel(brk.startMin, brk.durationMin)}</span>
										</p>
										<button
											type="button"
											class="ui-button ui-button--ghost ui-button--sm brk__remove"
											aria-label={armedBreakId === brk.id
												? `Press again to remove “${brk.label}”`
												: `Remove “${brk.label}” — ${dayLabel(brk.dayKey)} ${clockLabel(brk.startMin)}, ${roomName(brk.roomId)}`}
											disabled={busy || placing !== null}
											onblur={() => (armedBreakId = null)}
											onclick={() => armOrRemoveBreak(brk)}>{armedBreakId === brk.id ? 'Remove?' : 'Remove'}</button>
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
										{#if aim && aim.dayKey === dayKey && aim.roomId === room.id}
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
												{#if aim.source === 'keyboard'}
													<!-- Taught only to someone driving by keyboard: what the key
													     does is invisible, unlike the geometry around it. -->
													<p class="ghost__cue"><kbd>Enter</kbd> selects</p>
												{/if}
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
			<!-- Addressable: `?panel=conflicts` lands here with the caret on the panel,
			     which is where a blocking count on the rail or the overview points. -->
			<section class="panel" aria-label="Conflicts" tabindex="-1" bind:this={conflictsPanel}>
				<header class="panel__head">
					<h2>Conflicts</h2>
					<span class="panel__count">{conflictRows.length}</span>
				</header>
				{#if conflictRows.length === 0}
					<p class="panel__calm">Nothing is blocking publication.</p>
				{:else}
					<ul class="conflicts">
						{#each conflictRows as row (row.key)}
							{@const Severity =
								row.conflict.severity === 'block' ? statusIcon.blocking : statusIcon.warning}
							<li class="conflicts__row">
								<span
									class="ui-badge conflicts__sev"
									class:ui-badge--danger={row.conflict.severity === 'block'}
									class:ui-badge--solid={row.conflict.severity === 'block'}
									class:ui-badge--warning={row.conflict.severity === 'warn'}>
									<Severity class="ui-badge__icon" aria-hidden="true" />
									{row.conflict.severity === 'block' ? 'Blocking' : 'Warning'}
								</span>
								<div class="conflicts__copy">
									<p class="conflicts__title">{row.session.title}</p>
									<p class="conflicts__reason">{row.conflict.reason}</p>
								</div>
								<button
									type="button"
									class="ui-button ui-button--secondary ui-button--sm conflicts__action"
									onclick={() => showOnGrid(row.placement)}>
									Show on {dayLabel(row.placement.dayKey)}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="panel" aria-label="Unscheduled">
				<header class="panel__head">
					<h2>Unscheduled</h2>
					<span class="panel__count">{unscheduled.length}</span>
				</header>
				{#if unscheduled.length === 0}
					<p class="panel__calm">
						Every session has a slot. Newly accepted sessions arrive here waiting to be placed.
					</p>
				{:else}
					<ul class="pool">
						{#each unscheduled as session (session.id)}
							<li
								class="pool__row"
								class:pool__row--active={placing?.id === session.id}
								id={`pool-${session.id}`}
								tabindex="-1"
								style="--track: {trackColor(session.trackId)}">
								<div class="pool__copy">
									<p class="pool__title">{session.title}</p>
									<p class="pool__meta">
										{session.durationMin} min · {formatName(session.formatId)} · {trackName(session.trackId)}
									</p>
								</div>
								<!-- One element for both faces, so the pointer that pressed
								     Place… is already resting on Cancel: entering the mode moves
								     neither layout nor focus. -->
								<button
									type="button"
									class="ui-button ui-button--secondary ui-button--sm pool__action"
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
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	</div>
{/if}

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
			<!-- Relative-to-neighbour setters: precision in the domain's own words,
			     no aiming, no arithmetic — and the dialog's window onto what sits
			     beside this slot while the modal covers the grid. -->
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
					{@const Severity = conflict.severity === 'block' ? statusIcon.blocking : statusIcon.warning}
					<li class="confirm__conflict">
						<span
							class="ui-badge"
							class:ui-badge--danger={conflict.severity === 'block'}
							class:ui-badge--solid={conflict.severity === 'block'}
							class:ui-badge--warning={conflict.severity === 'warn'}>
							<Severity class="ui-badge__icon" aria-hidden="true" />
							{conflict.severity === 'block' ? 'Blocking' : 'Warning'}
						</span>
						<span class="confirm__conflict-reason">{conflict.reason}</span>
					</li>
				{/each}
			</ul>
			{#if confirmBlocked}
				<p class="confirm__blocked-note">Pick a time that clears the blocking conflict above.</p>
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
		<fieldset class="break-form__rooms">
			<legend class="ui-label">Rooms</legend>
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
		</fieldset>
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
		.pool__action kbd,
		.card__actions--standing kbd,
		.confirm__cancel kbd,
		.confirm__commit kbd {
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

	/* Context and origin cards do not lift: nothing under them answers. */
	.card--context:hover,
	.card--origin:hover {
		z-index: 1;
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

	.opening:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
		z-index: 2;
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

	.pool__row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content;
		grid-template-areas: 'copy action';
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
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
		background: var(--je-color-surface-selected);
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

	.pool__meta {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
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

	.confirm__anchors {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin-block-end: var(--je-space-3);
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

	.break-form__rooms {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		border: 0;
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

		.card__actions {
			position: static;
			display: flex;
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

		.head__publish {
			margin-inline-start: 0;
		}

		/* The head wraps to two rows at this width; the resolver wraps with it. */
		.sk-days {
			inline-size: 100%;
		}

		.publish__reason {
			max-inline-size: none;
		}

		.pool__row {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas:
				'copy'
				'action';
			align-items: start;
		}

		.pool__action {
			justify-self: start;
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
