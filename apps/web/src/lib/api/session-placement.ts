/**
 * How a placed session says where and when it happens.
 *
 * A `Placement` stores `startMin` as minutes from the event's day start, which
 * is geometry, not language. This module is the one place that turns that
 * geometry into the words a reader sees, so every surface that states a
 * placement outside the grid — the speaker peek today, anything that joins a
 * session to a person later — spells the same clock the same way.
 *
 * The clock is the schedule's own: the day-start offset is added back before
 * the time is spelled, so `09:00` means nine o'clock at the event, never nine
 * minutes into an abstract day.
 */

import type { SessionPlacementDisplay } from './types';

/**
 * The slice of a schedule this module reads, stated structurally rather than as
 * `ScheduleState`: a dataset's seed of a schedule carries the same days, rooms
 * and placements while its rooms still lack the usage counts the API derives,
 * and both are equally able to answer where a session sits.
 */
export interface PlacementDisplaySource {
	readonly days: readonly { readonly key: string; readonly label: string }[];
	readonly rooms: readonly { readonly id: string; readonly name: string }[];
	readonly dayStart: string;
	readonly sessions: readonly { readonly id: string; readonly durationMin: number }[];
	readonly placements: readonly {
		readonly sessionId: string;
		readonly dayKey: string;
		readonly roomId: string;
		readonly startMin: number;
	}[];
}

/** Resolve a schedule day key to its human label without printing the key as prose. */
export function scheduleDayLabel(
	days: PlacementDisplaySource['days'],
	key: string
): string | undefined {
	return days.find((entry) => entry.key === key)?.label;
}

/** Resolve a schedule room id to its human name without printing the id as prose. */
export function scheduleRoomName(
	rooms: PlacementDisplaySource['rooms'],
	id: string
): string | undefined {
	return rooms.find((entry) => entry.id === id)?.name;
}

/** Minutes past midnight for an `HH:MM` day start; an unparseable one is midnight. */
function dayStartMinutes(dayStart: string): number {
	const [hour = 0, minute = 0] = dayStart.split(':').map(Number);
	return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
}

/** One clock reading, `HH:MM`, from an offset into the event's day. */
export function scheduleClockLabel(dayStart: string, offsetMin: number): string {
	const total = dayStartMinutes(dayStart) + offsetMin;
	const hours = Math.floor(total / 60) % 24;
	const minutes = total % 60;
	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** One event-clock range from a start offset and duration. */
export function scheduleRangeLabel(
	dayStart: string,
	startMin: number,
	durationMin: number
): string {
	return `${scheduleClockLabel(dayStart, startMin)}–${scheduleClockLabel(
		dayStart,
		startMin + durationMin
	)}`;
}

/**
 * Where and when one session sits, or `undefined` when the schedule cannot say.
 *
 * Four ways it cannot say, and all of them return nothing rather than a
 * half-fact: the session holds no placement, the session record itself is
 * missing (so the sitting has no length), or the placement names a day or a
 * room that no longer resolves. That last one is deliberate — a placement can
 * be real and committed while its day or room has been removed from the
 * schedule, and printing the raw key there would state a machine id as though
 * it were a place someone could walk to.
 */
export function sessionPlacementDisplay(
	schedule: PlacementDisplaySource,
	sessionId: string
): SessionPlacementDisplay | undefined {
	const placement = schedule.placements.find((entry) => entry.sessionId === sessionId);
	if (!placement) return undefined;
	const session = schedule.sessions.find((entry) => entry.id === sessionId);
	if (!session) return undefined;
	const day = scheduleDayLabel(schedule.days, placement.dayKey);
	const room = scheduleRoomName(schedule.rooms, placement.roomId);
	if (!day || !room) return undefined;
	return {
		day,
		time: scheduleRangeLabel(schedule.dayStart, placement.startMin, session.durationMin),
		room
	};
}
