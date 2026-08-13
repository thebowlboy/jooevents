import type { EventSettingsDto } from '@jooevents/contracts';
import type { EventSettingsView } from '../view-models/event-settings';

type HandledEventSettingsKey =
	| 'schemaVersion'
	| 'eventId'
	| 'eventSetVersion'
	| 'eventVersion'
	| 'name'
	| 'timezone'
	| 'startDate'
	| 'endDate'
	| 'location'
	| 'venueNote'
	| 'dayStart'
	| 'dayEnd'
	| 'slotMinutes';

const handledEventSettingsKeys: Record<
	Exclude<keyof EventSettingsDto, HandledEventSettingsKey>,
	never
> = {};
void handledEventSettingsKeys;

interface CalendarDate {
	readonly year: number;
	readonly month: number;
	readonly day: number;
}

const monthNames = Object.freeze([
	'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
	'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
] as const);

function calendarDate(iso: string): CalendarDate | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) {
		return undefined;
	}
	return { year, month, day };
}

/** Stable English date-range label consumed by the tuned operator UI. */
export function formatEventSettingsDateRange(startIso: string, endIso: string): string {
	const start = calendarDate(startIso);
	const end = calendarDate(endIso);
	if (!start || !end) return `${startIso} – ${endIso}`;
	const startMonth = monthNames[start.month - 1];
	const endMonth = monthNames[end.month - 1];
	if (!startMonth || !endMonth) return `${startIso} – ${endIso}`;
	if (start.year === end.year && start.month === end.month) {
		return start.day === end.day
			? `${startMonth} ${start.day}, ${start.year}`
			: `${startMonth} ${start.day}–${end.day}, ${start.year}`;
	}
	return start.year === end.year
		? `${startMonth} ${start.day} – ${endMonth} ${end.day}, ${start.year}`
		: `${startMonth} ${start.day}, ${start.year} – ${endMonth} ${end.day}, ${end.year}`;
}

/** Exhaustive, detached mapping from the wire DTO into browser state. */
export function mapEventSettings(settings: EventSettingsDto): EventSettingsView {
	return Object.freeze({
		eventId: settings.eventId,
		eventSetVersion: settings.eventSetVersion,
		eventVersion: settings.eventVersion,
		name: settings.name,
		timezone: settings.timezone,
		startDate: settings.startDate,
		endDate: settings.endDate,
		location: settings.location,
		venueNote: settings.venueNote,
		dayStart: settings.dayStart,
		dayEnd: settings.dayEnd,
		slotMinutes: settings.slotMinutes,
		dates: formatEventSettingsDateRange(settings.startDate, settings.endDate)
	});
}
