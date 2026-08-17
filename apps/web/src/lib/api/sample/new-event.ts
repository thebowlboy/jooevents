import { formatDate, formatDateRange, formatInstantDate } from '@jooevents/contracts';
import type { WorkspaceDataset } from './dataset';
import { defaultEventTheme, starterSurfaceTemplates, starterTemplates } from './templates';
import { baselineFieldRegistry } from './fields';
import flight from './flight';

/**
 * An event created in this browser session. Persisted client-side so it
 * survives the reload an event switch performs; the real backend replaces this
 * whole module with the event-creation operation and an event-scoped store.
 */
export interface CreatedEventSeed {
	id: string;
	name: string;
	timezone: string;
	/** ISO dates (yyyy-mm-dd). */
	startDate: string;
	endDate: string;
}

/**
 * The workspace a just-created event serves: every area open and empty, ready
 * to fill — not the fresh no-event lockout, and not sample fiction. Starter
 * templates, surfaces, and the baseline field registry arrive with the event
 * (the same starters every dataset carries); the team is the workspace's own,
 * unchanged, because members are workspace-level rather than event-level.
 */
export function newEventDataset(seed: CreatedEventSeed): WorkspaceDataset {
	const dates = formatDateRange(seed.startDate, seed.endDate);
	return {
		key: `created:${seed.id}`,
		name: seed.name,
		description: 'A newly created event — nothing collected yet.',

		summary: {
			event: {
				id: seed.id,
				name: seed.name,
				dates,
				location: '',
				timezone: seed.timezone,
				phase: 'Just created · CFP not open yet',
				// Today where the *event* is, not where the browser is: an organizer
				// travelling to their own conference must not see the day shift. The
				// weekday earns its place because this line exists to be placed
				// against the event's own days.
				today: formatInstantDate(new Date().toISOString(), seed.timezone, { weekday: true })
			},
			lockedAreas: [],
			navCounts: {},
			/* The submissions figure is measured from the rows, so it is not
			   authored here — it resolves to nothing collected yet, which is the
			   truth on a workspace whose form has not opened. */
			stats: [
				{ label: 'Reviews', value: '—', sub: 'No review plan yet' },
				{ label: 'Decided', value: '—', sub: 'Nothing to decide yet' },
				{ label: 'Placed', value: '—', sub: 'No sessions on the grid yet' }
			],
			/* No authored attention row: on a dormant event the pipeline rail is
			   the page, and its gate carries the one next step — opening the call
			   for proposals — with the same words and the same landing as the
			   empty submissions inbox's nudge. A row here too was the same fact
			   behind two doors. */
			attention: [],
			pipeline: [],
			deadlines: [],
			activity: [],
			trays: []
		},

		tracks: [],
		formats: [],

		submissions: [],
		submissionTrayTotals: { inbox: 0, 'set-aside': 0, late: 0, spam: 0 },

		reviewPlans: [],
		reviewers: [],
		myQueue: [],
		reviewDistributions: {},

		speakers: [],

		taskDefs: [],
		assignments: [],

		schedule: {
			days: eventDays(seed.startDate, seed.endDate),
			rooms: [],
			dayStart: '09:00',
			slotMinutes: 30,
			slotsPerDay: 16,
			sessions: [],
			placements: [],
			breaks: [],
			published: false
		},

		communications: [],
		threads: {},
		readiness: {
			provider: 'Not connected',
			outbound: 'unknown',
			callbacks: 'unknown',
			inbound: 'unknown'
		},

		templates: starterTemplates(),
		surfaces: starterSurfaceTemplates(seed.name),
		fieldRegistry: baselineFieldRegistry(),
		theme: defaultEventTheme(seed.name),

		forms: [],

		settings: {
			name: seed.name,
			dates,
			startDate: seed.startDate,
			endDate: seed.endDate,
			location: '',
			timezone: seed.timezone,
			venueNote: ''
		},
		members: structuredClone(flight.members)
	};
}

/**
 * The cursor's own calendar day. The cursor is anchored at local noon precisely
 * so that stepping a day never lands on a DST-shifted midnight, which makes its
 * local year/month/day the day it is standing on.
 */
function isoDay(date: Date): string {
	const month = date.getMonth() + 1;
	const day = date.getDate();
	return `${date.getFullYear()}-${month < 10 ? '0' : ''}${month}-${day < 10 ? '0' : ''}${day}`;
}

/** One schedule day per event date, capped so a typo'd year cannot mint thousands. */
function eventDays(startIso: string, endIso: string): { key: string; label: string }[] {
	const days: { key: string; label: string }[] = [];
	const cursor = new Date(`${startIso}T12:00:00`);
	const end = new Date(`${endIso}T12:00:00`);
	if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return days;
	while (cursor.getTime() <= end.getTime() && days.length < 14) {
		days.push({
			key: `day-${days.length}`,
			// A day tab needs its weekday and drops its year: every tab in one
			// event's schedule would otherwise repeat the same four digits.
			label: formatDate(isoDay(cursor), { weekday: true, year: false })
		});
		cursor.setDate(cursor.getDate() + 1);
	}
	return days;
}
