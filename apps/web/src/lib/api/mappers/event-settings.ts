import { formatDateRange, type EventSettingsDto } from '@jooevents/contracts';
import type { EventSettingsView } from '../view-models/event-settings';

type HandledEventSettingsKey =
	| 'schemaVersion'
	| 'eventId'
	| 'eventSetVersion'
	| 'eventVersion'
	| 'profileContentReview'
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

/**
 * The event's span as the shell and the page headers say it.
 *
 * The spelling is the product's one date vocabulary, so the sidebar, the
 * settings form, a public listing, and the email about the same event all read
 * the same. It kept its own name because a dozen call sites already say it; the
 * body is a single call and this alias is only worth the line while they move.
 */
export function formatEventSettingsDateRange(startIso: string, endIso: string): string {
	return formatDateRange(startIso, endIso, { fallback: 'Dates not set' });
}

/** Exhaustive, detached mapping from the wire DTO into browser state. */
export function mapEventSettings(settings: EventSettingsDto): EventSettingsView {
	return Object.freeze({
		eventId: settings.eventId,
		eventSetVersion: settings.eventSetVersion,
		eventVersion: settings.eventVersion,
		profileContentReview: settings.profileContentReview,
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
