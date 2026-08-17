import type { WorkspaceDataset } from './dataset';
import { defaultEventTheme } from './templates';

/**
 * Empty scenario: a workspace with no event yet. Every area stays locked and
 * every counter reads as a placeholder rather than a zero, because zero would
 * claim a measurement that has not been made.
 */
const fresh: WorkspaceDataset = {
	key: 'fresh',
	name: 'First login',
	description: 'A brand-new workspace. No event, no data, every area still locked.',

	summary: {
		event: null,
		lockedAreas: [
			'pulse',
			'submissions',
			'review',
			'decisions',
			'speakers',
			'reviewers',
			'tasks',
			'schedule',
			'messages',
			'templates',
			'forms',
			'embeds',
			'settings'
		],
		navCounts: {},
		stats: [
			{ label: 'Submissions', value: '—', sub: 'Create an event to begin' },
			{ label: 'Reviews', value: '—', sub: 'Create an event to begin' },
			{ label: 'Decided', value: '—', sub: 'Create an event to begin' },
			{ label: 'Placed', value: '—', sub: 'Create an event to begin' }
		],
		attention: [
			{
				id: 'create-event',
				severity: 'fyi',
				area: 'overview',
				title: 'Create your first event',
				detail:
					'Name, dates, and a timezone are enough to start. Submissions, review, speakers, schedule, and messages unlock as soon as the event exists — you can describe it in your own words or fill the form yourself.',
				action: 'Create event'
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
	submissionTrayTotals: { inbox: 0, 'set-aside': 0, late: 0, spam: 0 },

	reviewPlans: [],
	/* No event, so nobody has been invited to review anything. */
	reviewers: [],
	myQueue: [],
	/* No event, so no track exists to hold a population. */
	reviewDistributions: {},

	speakers: [],

	taskDefs: [],
	assignments: [],

	schedule: {
		days: [],
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
	readiness: { provider: 'Not connected', outbound: 'unknown', callbacks: 'unknown', inbound: 'unknown' },

	/* Templates arrive with the event; no event, so none exist yet. */
	templates: [],
	/* Same for the public surfaces: no event, no schedule page or CFP form. */
	surfaces: [],
	/* The field registry also arrives with the event. */
	fieldRegistry: [],
	theme: defaultEventTheme(null),

	forms: [],

	settings: null,
	members: []
};

export default fresh;
