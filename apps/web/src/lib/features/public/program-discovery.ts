/**
 * Public-program discovery: search, facets, presentation, and address state.
 *
 * These helpers derive a visitor's view from one released schedule or roster.
 * They never invent sessions, speakers, or vocabulary, and they never read
 * organizer, draft, or collecting facts. Presentation state (query, facets,
 * list/agenda/gallery, surname order) stays local to the address.
 */

import { formatClock, formatClockRange, parseClockMinutes } from '@jooevents/contracts';
import { matchFields, parseSearch, type SearchableField } from '$lib/api/search';
import type {
	EmbedScope,
	Placement,
	PublicSpeakerCard,
	ScheduleState,
	SessionItem,
	Track
} from '$lib/api/types';

export const SESSION_SEARCH_SCOPE = 'session title and speaker name';
export const SPEAKER_SEARCH_SCOPE = 'speaker name';

export const SCHEDULE_PRESENTATIONS = ['list', 'agenda'] as const;
export type SchedulePresentation = (typeof SCHEDULE_PRESENTATIONS)[number];

export const SPEAKER_PRESENTATIONS = ['gallery', 'list'] as const;
export type SpeakerPresentation = (typeof SPEAKER_PRESENTATIONS)[number];

export const SPEAKER_ORDERS = ['lineup', 'surname'] as const;
export type SpeakerOrder = (typeof SPEAKER_ORDERS)[number];

const RELEASED_FORMAT_PREFIX = 'released-format:';
const RELEASED_TRACK_NONE = 'released-track:none';

export interface DiscoveryFacets {
	readonly trackId: string | null;
	readonly formatId: string | null;
	readonly roomId: string | null;
}

export interface FacetOption {
	readonly id: string;
	readonly label: string;
}

export interface PublishedFacets {
	readonly tracks: readonly FacetOption[];
	readonly formats: readonly FacetOption[];
	readonly rooms: readonly FacetOption[];
}

export interface PlacedProgramSession {
	readonly placement: Placement;
	readonly session: SessionItem;
}

export interface SessionResultCopy {
	readonly headline: string;
	readonly scope: string | null;
}

export interface SessionDetailView {
	readonly title: string;
	readonly speakerNames: readonly string[];
	readonly trackName: string | null;
	readonly trackAccent: Track['accent'] | null;
	readonly formatName: string | null;
	readonly dayLabel: string | null;
	readonly timeLabel: string | null;
	readonly roomName: string | null;
	readonly durationMin: number;
	readonly description: { readonly kind: 'missing'; readonly message: string };
}

export function parseSchedulePresentation(value: string | null): SchedulePresentation {
	return value === 'agenda' ? 'agenda' : 'list';
}

export function parseSpeakerPresentation(
	value: string | null,
	fallback: SpeakerPresentation = 'gallery'
): SpeakerPresentation {
	if (value === 'list' || value === 'gallery') return value;
	return fallback;
}

export function parseSpeakerOrder(value: string | null): SpeakerOrder {
	return value === 'surname' ? 'surname' : 'lineup';
}

/** The published format name already carried on the released session id. */
export function publishedFormatName(formatId: string): string | null {
	if (formatId.startsWith(RELEASED_FORMAT_PREFIX)) {
		const name = formatId.slice(RELEASED_FORMAT_PREFIX.length).trim();
		return name.length > 0 ? name : null;
	}
	const trimmed = formatId.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function sessionMatchesSearch(session: SessionItem, rawQuery: string): boolean {
	const query = parseSearch(rawQuery);
	if (query.terms.length === 0) return true;
	return matchFields(sessionSearchFields(session), query) !== null;
}

export function speakerMatchesSearch(card: PublicSpeakerCard, rawQuery: string): boolean {
	const query = parseSearch(rawQuery);
	if (query.terms.length === 0) return true;
	const fields: SearchableField[] = [{ text: card.name, space: 'identity', weight: 'primary' }];
	return matchFields(fields, query) !== null;
}

export function collectPublishedFacets(
	schedule: ScheduleState,
	tracks: readonly Track[]
): PublishedFacets {
	const placed = placedProgrammed(schedule);
	const trackById = new Map(tracks.map((track) => [track.id, track]));
	const trackIds: string[] = [];
	for (const track of tracks) {
		if (placed.some((entry) => entry.session.trackId === track.id)) trackIds.push(track.id);
	}
	for (const entry of placed) {
		const id = entry.session.trackId;
		if (!id || id === RELEASED_TRACK_NONE || trackIds.includes(id)) continue;
		trackIds.push(id);
	}

	const formatIds: string[] = [];
	for (const entry of placed) {
		const id = entry.session.formatId;
		if (!id || !publishedFormatName(id) || formatIds.includes(id)) continue;
		formatIds.push(id);
	}

	const roomIds: string[] = [];
	for (const room of schedule.rooms) {
		if (placed.some((entry) => entry.placement.roomId === room.id)) roomIds.push(room.id);
	}
	for (const entry of placed) {
		if (roomIds.includes(entry.placement.roomId)) continue;
		roomIds.push(entry.placement.roomId);
	}

	return {
		tracks: trackIds.map((id) => ({
			id,
			label: trackById.get(id)?.name ?? id
		})),
		formats: formatIds.map((id) => ({
			id,
			label: publishedFormatName(id) ?? id
		})),
		rooms: roomIds.map((id) => ({
			id,
			label: schedule.rooms.find((room) => room.id === id)?.name ?? id
		}))
	};
}

export function facetsAreActive(facets: DiscoveryFacets): boolean {
	return Boolean(facets.trackId || facets.formatId || facets.roomId);
}

export function discoveryIsActive(query: string, facets: DiscoveryFacets): boolean {
	return parseSearch(query).terms.length > 0 || facetsAreActive(facets);
}

export function filterPlacedSessions(
	schedule: ScheduleState,
	query: string,
	facets: DiscoveryFacets
): PlacedProgramSession[] {
	return placedProgrammed(schedule).filter((entry) => matchesDiscovery(entry, query, facets));
}

/**
 * The released schedule narrowed to the visitor's search and facets.
 * Unmatched programmed sessions drop out of both lists so the renderer can
 * keep receiving an already-narrowed projection.
 */
export function narrowSchedule(
	schedule: ScheduleState,
	query: string,
	facets: DiscoveryFacets
): ScheduleState {
	if (!discoveryIsActive(query, facets)) return schedule;
	const kept = filterPlacedSessions(schedule, query, facets);
	const ids = new Set(kept.map((entry) => entry.session.id));
	return {
		...schedule,
		sessions: schedule.sessions.filter((session) => ids.has(session.id)),
		placements: kept.map((entry) => entry.placement)
	};
}

export function filterRoster(
	roster: readonly PublicSpeakerCard[],
	query: string
): PublicSpeakerCard[] {
	if (parseSearch(query).terms.length === 0) return [...roster];
	return roster.filter((card) => speakerMatchesSearch(card, query));
}

/**
 * The released roster population one public address names. Scope is applied
 * before visitor search and ordering so the result count and rendered cards
 * always describe the same people. A missing scoped person stays an honest
 * empty population; it never widens back to the full lineup.
 */
export function rosterInScope(
	roster: readonly PublicSpeakerCard[],
	scope: EmbedScope
): PublicSpeakerCard[] {
	if (scope.kind === 'category') {
		return roster.filter((card) => card.categoryId === scope.categoryId);
	}
	if (scope.kind === 'speaker') {
		return roster.filter((card) => card.id === scope.speakerId);
	}
	return [...roster];
}

/**
 * A named alphabetical presentation. The canonical lineup array is not
 * rewritten; callers pass the filtered copy they already hold.
 */
export function orderRosterBySurname(
	roster: readonly PublicSpeakerCard[]
): PublicSpeakerCard[] {
	return [...roster].sort((left, right) => {
		const bySurname = surnameKey(left.name).localeCompare(surnameKey(right.name), 'en');
		if (bySurname !== 0) return bySurname;
		const byName = left.name.localeCompare(right.name, 'en');
		if (byName !== 0) return byName;
		return left.id.localeCompare(right.id, 'en');
	});
}

export function presentRoster(
	roster: readonly PublicSpeakerCard[],
	query: string,
	order: SpeakerOrder
): PublicSpeakerCard[] {
	const matched = filterRoster(roster, query);
	return order === 'surname' ? orderRosterBySurname(matched) : matched;
}

export function describeSessionResults(input: {
	readonly matched: number;
	readonly scanned: number;
	readonly query: string;
	readonly hasFacets: boolean;
}): SessionResultCopy {
	const searched = parseSearch(input.query).terms.length > 0;
	const quoted = searched ? `“${input.query.trim()}”` : null;
	const noun = input.scanned === 1 ? 'session' : 'sessions';
	if (input.matched === 0) {
		if (searched && input.hasFacets) {
			return {
				headline: `No session matches ${quoted} and these filters`,
				scope: SESSION_SEARCH_SCOPE
			};
		}
		if (searched) {
			return { headline: `No session matches ${quoted}`, scope: SESSION_SEARCH_SCOPE };
		}
		return { headline: 'No session matches these filters', scope: null };
	}
	if (searched && input.hasFacets) {
		return {
			headline: `${input.matched} of ${input.scanned} ${noun} match ${quoted} and these filters`,
			scope: SESSION_SEARCH_SCOPE
		};
	}
	if (searched) {
		return {
			headline: `${input.matched} of ${input.scanned} ${noun} match ${quoted}`,
			scope: SESSION_SEARCH_SCOPE
		};
	}
	return {
		headline: `${input.matched} of ${input.scanned} ${noun} match these filters`,
		scope: null
	};
}

export function describeSpeakerResults(input: {
	readonly matched: number;
	readonly scanned: number;
	readonly query: string;
}): SessionResultCopy {
	const quoted = `“${input.query.trim()}”`;
	const noun = input.scanned === 1 ? 'speaker' : 'speakers';
	if (input.matched === 0) {
		return { headline: `No speaker matches ${quoted}`, scope: SPEAKER_SEARCH_SCOPE };
	}
	return {
		headline: `${input.matched} of ${input.scanned} ${noun} match ${quoted}`,
		scope: SPEAKER_SEARCH_SCOPE
	};
}

export function adjacentDayKey(
	days: readonly { readonly key: string }[],
	currentKey: string | null,
	direction: -1 | 1
): string | null {
	if (days.length === 0) return null;
	if (currentKey === null) return direction === 1 ? (days[0]?.key ?? null) : (days[days.length - 1]?.key ?? null);
	const index = days.findIndex((day) => day.key === currentKey);
	if (index < 0) return null;
	return days[index + direction]?.key ?? null;
}

export function sessionDetailView(
	schedule: ScheduleState,
	tracks: readonly Track[],
	sessionId: string
): SessionDetailView | null {
	const session = schedule.sessions.find((entry) => entry.id === sessionId);
	if (!session || session.state !== 'programmed') return null;
	const placement = schedule.placements.find((entry) => entry.sessionId === sessionId);
	const track = tracks.find((entry) => entry.id === session.trackId);
	const dayStartMin = parseClockMinutes(schedule.dayStart) ?? 0;
	const timeLabel = placement
		? formatClockRange(dayStartMin + placement.startMin, dayStartMin + placement.startMin + session.durationMin)
		: null;
	return {
		title: session.title,
		speakerNames: session.speakers.map((speaker) => speaker.name).filter(Boolean),
		trackName: track?.name ?? (session.trackId === RELEASED_TRACK_NONE ? null : null),
		trackAccent: track?.accent ?? null,
		formatName: publishedFormatName(session.formatId),
		dayLabel: placement
			? (schedule.days.find((day) => day.key === placement.dayKey)?.label ?? null)
			: null,
		timeLabel,
		roomName: placement
			? (schedule.rooms.find((room) => room.id === placement.roomId)?.name ?? null)
			: null,
		durationMin: session.durationMin,
		description: {
			kind: 'missing',
			message: 'A description has not been published yet.'
		}
	};
}

export function sessionTimeLabel(
	schedule: ScheduleState,
	entry: PlacedProgramSession
): string {
	const dayStartMin = parseClockMinutes(schedule.dayStart) ?? 0;
	return formatClockRange(
		dayStartMin + entry.placement.startMin,
		dayStartMin + entry.placement.startMin + entry.session.durationMin
	);
}

export function sessionClock(schedule: ScheduleState, startMin: number): string {
	const dayStartMin = parseClockMinutes(schedule.dayStart) ?? 0;
	return formatClock(dayStartMin + startMin);
}

/** Writes query changes onto a public pathname without dropping the rest. */
export function hrefWithParams(
	pathname: string,
	search: string,
	changes: Record<string, string | null | undefined>
): string {
	const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
	for (const [key, value] of Object.entries(changes)) {
		if (value === null || value === undefined || value === '') params.delete(key);
		else params.set(key, value);
	}
	const next = params.toString();
	return next ? `${pathname}?${next}` : pathname;
}

function sessionSearchFields(session: SessionItem): SearchableField[] {
	const fields: SearchableField[] = [{ text: session.title, space: 'body', weight: 'primary' }];
	for (const speaker of session.speakers) {
		if (!speaker.name) continue;
		fields.push({ text: speaker.name, space: 'identity', weight: 'primary' });
	}
	return fields;
}

function placedProgrammed(schedule: ScheduleState): PlacedProgramSession[] {
	const byId = new Map(schedule.sessions.map((session) => [session.id, session]));
	const placed: PlacedProgramSession[] = [];
	for (const placement of schedule.placements) {
		const session = byId.get(placement.sessionId);
		if (!session || session.state !== 'programmed') continue;
		placed.push({ placement, session });
	}
	return placed;
}

function matchesDiscovery(
	entry: PlacedProgramSession,
	query: string,
	facets: DiscoveryFacets
): boolean {
	if (facets.trackId && entry.session.trackId !== facets.trackId) return false;
	if (facets.formatId && entry.session.formatId !== facets.formatId) return false;
	if (facets.roomId && entry.placement.roomId !== facets.roomId) return false;
	return sessionMatchesSearch(entry.session, query);
}

function surnameKey(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return '';
	const last = parts[parts.length - 1] ?? '';
	const rest = parts.slice(0, -1).join(' ');
	return `${last} ${rest}`.trim().toLocaleLowerCase('en');
}
