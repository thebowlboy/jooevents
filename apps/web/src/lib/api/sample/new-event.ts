import type { WorkspaceDataset } from './dataset';
import { formatDateRange } from './dataset';
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
				today: new Date().toLocaleDateString('en-US', {
					weekday: 'long',
					month: 'long',
					day: 'numeric'
				})
			},
			lockedAreas: [],
			navCounts: {},
			stats: [
				{ label: 'Submissions', value: '0', sub: 'No form is open yet' },
				{ label: 'Reviews', value: '—', sub: 'No review plan yet' },
				{ label: 'Accepted', value: '0', sub: 'Nothing decided yet' },
				{ label: 'CFP closes', value: '—', sub: 'No close date yet' }
			],
			attention: [
				{
					id: 'open-intake',
					severity: 'fyi',
					area: 'forms',
					title: 'Open your call for proposals',
					detail:
						'The standard application form is ready to trim and open. Submissions, review, and the schedule fill from what it collects.',
					action: 'Go to Forms'
				}
			],
			pipeline: [],
			deadlines: [],
			activity: [],
			trays: []
		},

		tracks: [],
		formats: [],

		submissions: [],
		submissionTrayTotals: { inbox: 0, 'set-aside': 0, late: 0, discarded: 0 },

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

/** One schedule day per event date, capped so a typo'd year cannot mint thousands. */
function eventDays(startIso: string, endIso: string): { key: string; label: string }[] {
	const days: { key: string; label: string }[] = [];
	const cursor = new Date(`${startIso}T12:00:00`);
	const end = new Date(`${endIso}T12:00:00`);
	if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return days;
	while (cursor.getTime() <= end.getTime() && days.length < 14) {
		days.push({
			key: `day-${days.length}`,
			label: cursor.toLocaleDateString('en-US', {
				weekday: 'short',
				month: 'short',
				day: 'numeric'
			})
		});
		cursor.setDate(cursor.getDate() + 1);
	}
	return days;
}
