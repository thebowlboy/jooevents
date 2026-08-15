import type { WorkspaceDataset } from './dataset';
import { dayDeadline, daysAgo, hoursAgo } from './dataset';

/** The event's zone — the authority for every deadline boundary below. */
const TZ = 'America/New_York';
import { defaultEventTheme, starterSurfaceTemplates, starterTemplates } from './templates';
import { baselineFieldRegistry } from './fields';

/**
 * Settled scenario: reviewing, deciding, notifying, and scheduling are all
 * finished. The schedule is published with no conflicts and nothing is waiting
 * on the organizer — the state the overview has to render as calmly as a crisis.
 */
const quiet: WorkspaceDataset = {
	key: 'quiet',
	name: 'All clear',
	description: 'Everything reviewed, decided, notified, and published. Nothing waiting.',

	summary: {
		event: {
			id: 'evt_aie-nyc-2026',
			name: 'AI Engineer NYC 2026',
			dates: 'Oct 12–14, 2026',
			location: 'New York City',
			timezone: 'America/New_York',
			phase: 'Schedule published · 14 days to doors',
			today: 'Monday, September 28'
		},
		lockedAreas: [],
		navCounts: {
			submissions: '10',
			review: '100%',
			speakers: '10',
			reviewers: '5',
			messages: '2'
		},
		/* Everything closed. Full meters read green because green is what
		   healthy means here — done on time is calm, not a party. */
		stats: [
			{
				label: 'Reviews',
				value: '100%',
				sub: 'both rounds closed · 536 of 536',
				health: 'ok',
				progress: { done: 536, required: 536 }
			},
			{
				label: 'Decided',
				value: '10 of 10',
				sub: '5 accepted · everyone has been told',
				health: 'ok',
				progress: { done: 10, required: 10 }
			},
			{
				label: 'Speaker tasks',
				value: '96%',
				sub: '48 of 50 complete',
				health: 'ok',
				progress: { done: 48, required: 50 }
			}
		],
		attention: [],
		pipeline: [
			{ key: 'collect', label: 'Collect', headline: '10', sub: 'CFP closed · 1 late', state: 'ok' },
			{ key: 'triage', label: 'Triage', headline: '8', sub: 'inbox · 1 set aside · 1 late', state: 'ok' },
			/* Full meters here stay neutral: done on time is calm, not a party.
			   Round 1 was the full-population round (536 of 536); round 2 also
			   closed, on Sep 9. */
			{
				key: 'review',
				label: 'Review',
				headline: '100%',
				sub: 'round 1 and round 2 closed',
				state: 'ok',
				progress: { done: 536, required: 536 },
				paceTone: 'on',
				deadline: { qualifier: 'closed', ...dayDeadline(-19, TZ), settled: true }
			},
			/* Complete, but this scenario names no notify-by date, so the meter
			   stands alone without a pace claim. */
			{
				key: 'decide',
				label: 'Decide',
				headline: '10',
				sub: '5 accepted · everyone has been told',
				state: 'ok',
				progress: { done: 10, required: 10 }
			},
			/* The 6 remaining tasks answer to the optional slide-draft date. */
			{
				key: 'speakers',
				label: 'Speakers',
				headline: '10',
				sub: 'confirmed · 48 of 50 tasks done',
				state: 'ok',
				progress: { done: 48, required: 50 },
				paceTone: 'on',
				deadline: { qualifier: 'slides due', ...dayDeadline(10, TZ) }
			},
			{
				key: 'schedule',
				label: 'Schedule',
				headline: '24/24',
				sub: 'placed and published',
				state: 'ok',
				progress: { done: 24, required: 24 },
				paceTone: 'on',
				deadline: { qualifier: 'published', ...dayDeadline(-6, TZ), settled: true }
			},
			{ key: 'comms', label: 'Comms', headline: '6', sub: '4 sent · 2 scheduled', state: 'ok' }
		],
		/* No "Doors open" row: the event's own dates are the shell's event card,
		   not a deadline, and this panel is for the things that must happen before
		   them. It also cannot be authored honestly here — the deadlines below run
		   on a live clock while the fixture's event dates are a fixed string. */
		deadlines: [
			{ label: 'Schedule published', ...dayDeadline(-6, TZ), settled: true },
			{ label: 'Optional slide drafts due', ...dayDeadline(10, TZ) },
			{ label: 'Final AV walkthrough', ...dayDeadline(11, TZ) }
		],
		activity: [
			{
				id: 'act-1',
				actor: 'person',
				name: 'Linnea Koski',
				text: 'approved the last speaker headshot — every public profile is complete',
				at: hoursAgo(3)
			},
			{
				id: 'act-2',
				actor: 'agent',
				name: 'Conflict scan',
				text: 'checked all 24 placements against rooms, speakers, and capacity — nothing found',
				at: daysAgo(1)
			},
			{ id: 'act-3', actor: 'person', name: 'Sofia Berg', text: 'closed review round 2', at: daysAgo(19) },
			{ id: 'act-4', actor: 'you', name: 'You', text: 'published the schedule', at: daysAgo(6) },
			{
				id: 'act-5',
				actor: 'you',
				name: 'You',
				text: 'sent the schedule announcement to 1,240 subscribers',
				at: daysAgo(6)
			}
		],
		trays: [
			{ kind: 'late', label: 'Late submissions', count: 1, href: '/app/submissions?tray=late' },
			{ kind: 'discarded', label: 'Spam, recoverable', count: 0, href: '/app/submissions?tray=discarded' },
			{ kind: 'unresolved-import', label: 'Unresolved import items', count: 0 },
			{ kind: 'stranded-drafts', label: 'Stranded form drafts', count: 0 },
			{ kind: 'inbound-mail', label: 'Inbound mail review', count: 0 },
			{ kind: 'bounced', label: 'Bounced recipients', count: 0, href: '/app/messages' }
		]
	},

	tracks: [
		{ id: 'trk-web', name: 'Agents & Tools', accent: 'sea' },
		{ id: 'trk-ai', name: 'Evals & Reliability', accent: 'lavender' },
		{ id: 'trk-infra', name: 'Models & Infrastructure', accent: 'neutral' }
	],
	formats: [
		{ id: 'fmt-talk', name: 'Talk', defaultDurationMin: 30 },
		{ id: 'fmt-workshop', name: 'Workshop', defaultDurationMin: 90 },
		{ id: 'fmt-panel', name: 'Panel', defaultDurationMin: 45 },
		/* Retired mid-planning; Tomás's scope still names it, so it keeps
		   rendering (flagged) while never being offered for new scoping. */
		{ id: 'fmt-lightning', name: 'Lightning', status: 'retired' }
	],

	submissions: [
		{
			id: 'sub-401',
			title: 'Opening Keynote: Ten Years of Reliable AI Systems',
			abstract:
				'A decade of moving AI systems from demos to durable products, and the engineering disciplines that mattered after the launch excitement faded.',
			speakers: [{ name: 'Ravi Chandran', email: 'ravi@keynote.example' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(105),
			source: 'direct_entry',
			enteredBy: 'Jere K.',
			tray: 'inbox',
			decision: 'accepted',
			decidedAt: daysAgo(100),
			notified: true,
			signals: [],
			reviewCount: 0
		},
		{
			id: 'sub-402',
			title: 'Serving 100k-Token Contexts Without Melting the App',
			abstract:
				'What we measured when an agent loaded a 100,000-token working context, the latency cliffs we found, and the three rendering changes that survived production.',
			speakers: [{ name: 'Ines Moreau', email: 'ines@gridworks.fr' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(86),
			source: 'cfp',
			tray: 'inbox',
			decision: 'accepted',
			decidedAt: daysAgo(21),
			notified: true,
			signals: [
				{
					key: 'relevance',
					label: 'On-topic 0.94',
					family: 'quality',
					score: 0.94,
					rationale: 'Measured rendering work with a reproducible benchmark.',
					source: 'Screen run #6'
				}
			],
			resources: [
				{ name: 'latency-cliff-benchmarks (repository)', kind: 'link', detail: 'codeberg.org' }
			],
			reviewAverage: 4.7,
			reviewCount: 5
		},
		{
			id: 'sub-403',
			title: 'Durable Agent Jobs: A Queueing Confession',
			abstract:
				'We ran long-lived agent jobs on a home-grown queue for three years. What worked, what melted, and the durable handoff pattern that finally fixed it.',
			speakers: [{ name: 'Daniel Kim', email: 'daniel@edgequery.dev' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(79),
			source: 'cfp',
			tray: 'inbox',
			decision: 'accepted',
			decidedAt: daysAgo(21),
			notified: true,
			signals: [],
			reviewAverage: 4.6,
			reviewCount: 5
		},
		{
			id: 'sub-404',
			title: 'Hands-on: AI Interface Audits That Stick',
			abstract:
				'A 90-minute workshop auditing streamed agent interfaces for accessibility, uncertainty, interruption, and keyboard control, then turning findings into fixes.',
			speakers: [
				{ name: 'Elif Aydın', email: 'elif@a11ycraft.eu' },
				{ name: 'Marc Dubois', email: 'marc@a11ycraft.eu' }
			],
			trackId: 'trk-web',
			formatId: 'fmt-workshop',
			submittedAt: daysAgo(71),
			source: 'cfp',
			tray: 'inbox',
			decision: 'accepted',
			decidedAt: daysAgo(21),
			notified: true,
			signals: [
				{
					key: 'equipment',
					label: 'AV checked',
					family: 'integrity',
					rationale: 'Laptops and second screen confirmed with the venue on Sep 4.',
					source: 'AV walkthrough'
				}
			],
			reviewAverage: 4.4,
			reviewCount: 5
		},
		{
			id: 'sub-405',
			title: 'Running Small Models at the Edge',
			abstract:
				'Running small models close to users without lying about quality: the routing policy, cloud fallbacks, and latency and accuracy dashboards we watch.',
			speakers: [{ name: 'Rosa Delgado', email: 'rosa@replicalabs.es' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(67),
			source: 'cfp',
			tray: 'inbox',
			decision: 'accepted',
			decidedAt: daysAgo(21),
			notified: true,
			signals: [],
			reviewAverage: 4.3,
			reviewCount: 5
		},
		{
			id: 'sub-406',
			title: 'Evaluation Rubrics as a Product API',
			abstract:
				'Treating evaluation criteria as a versioned product contract: calibration, deprecation, and rubric migrations we shipped without breaking historical comparisons.',
			speakers: [{ name: 'Nora Visser', email: 'nora@tokenslab.nl' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(63),
			source: 'cfp',
			tray: 'inbox',
			decision: 'waitlisted',
			decidedAt: daysAgo(20),
			notified: true,
			signals: [
				{
					key: 'dup',
					label: 'Similar to #148',
					family: 'quality',
					rationale: 'Overlapped an accepted token-governance talk; held as the first replacement.',
					source: 'Duplicate clustering'
				}
			],
			reviewAverage: 4.0,
			reviewCount: 5
		},
		{
			id: 'sub-407',
			title: 'Inference Infrastructure for Teams of Three',
			abstract:
				'An argument that small AI teams should run less inference platform, with the migration away from our own serving cluster and the bill that followed.',
			speakers: [{ name: 'Petra Novak', email: 'petra@smallops.cz' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(57),
			source: 'cfp',
			tray: 'inbox',
			decision: 'declined',
			decidedAt: daysAgo(20),
			notified: true,
			signals: [],
			reviewAverage: 3.1,
			reviewCount: 5
		},
		{
			id: 'sub-408',
			title: 'Why We Left the Monolithic Agent',
			abstract:
				'A migration retrospective covering orchestration cost, agent handoffs, and the two teams that asked to return to a single-agent architecture.',
			speakers: [{ name: 'Sven Aalto', email: 'sven@splitrepo.fi' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(54),
			source: 'cfp',
			tray: 'inbox',
			decision: 'declined',
			decidedAt: daysAgo(20),
			notified: true,
			signals: [],
			reviewAverage: 2.9,
			reviewCount: 4
		},
		{
			id: 'sub-409',
			title: 'Ship Faster With Our DevEx Platform',
			abstract:
				'A walkthrough of how our platform eliminates toil for engineering teams. Live demo of our newest features and pricing tiers.',
			speakers: [{ name: 'Britta Klein', email: 'britta@shipfast.tools' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(56),
			source: 'cfp',
			tray: 'set-aside',
			setAsideBy: 'Screen run #12',
			decision: 'declined',
			decidedAt: daysAgo(20),
			notified: true,
			signals: [
				{
					key: 'pitch',
					label: 'Product pitch 0.89',
					family: 'integrity',
					score: 0.89,
					rationale: 'Vendor demo with pricing; no transferable technique for attendees.',
					source: 'Screen run #12'
				}
			],
			reviewCount: 0
		},
		{
			id: 'sub-410',
			title: 'Sandboxing Tool Calls: The Production Log',
			abstract:
				'Arrived four hours after the CFP closed: a detailed production log comparing container isolation, tool-call startup latency, and capability checks.',
			speakers: [{ name: 'Leo Marchetti', email: 'leo@ingestworks.it' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(36),
			source: 'cfp',
			tray: 'late',
			decision: 'declined',
			decidedAt: daysAgo(20),
			notified: true,
			signals: [],
			reviewCount: 0
		}
	],
	submissionTrayTotals: { inbox: 8, 'set-aside': 1, late: 1, discarded: 0 },
	/* Nothing is waiting, so they drop in a couple of times a week. */
	previousVisit: daysAgo(3),
	visitHistory: [hoursAgo(4), daysAgo(3), daysAgo(6)],

	reviewPlans: [
		{
			id: 'plan-r1',
			name: 'Round 1 · all tracks',
			scaleMax: 5,
			reviewsPerSubmission: 5,
			deadlineRelative: 'closed Sep 2',
			anonymized: true,
			done: 536,
			total: 536,
			antiAnchoring: true,
			// Roster ids are member ids; the rows sum to the plan's done and
			// total, closed or not.
			reviewers: [
				{ id: 'mem-2', name: 'Sofia Berg', assigned: 134, done: 134, steppedBack: 1, awaitingReassignment: 0 },
				{ id: 'mem-3', name: 'Jonas Weber', assigned: 134, done: 134, steppedBack: 0, awaitingReassignment: 0 },
				{ id: 'mem-7', name: 'Priya Nair', assigned: 134, done: 134, steppedBack: 2, awaitingReassignment: 0 },
				{ id: 'mem-8', name: 'Tomás Rivera', assigned: 134, done: 134, steppedBack: 0, awaitingReassignment: 0 }
			]
		},
		{
			id: 'plan-r2',
			name: 'Round 2 · shortlist',
			scaleMax: 5,
			reviewsPerSubmission: 3,
			deadlineRelative: 'closed Sep 9',
			anonymized: false,
			done: 174,
			total: 174,
			antiAnchoring: true,
			reviewers: [
				{ id: 'mem-2', name: 'Sofia Berg', assigned: 58, done: 58, steppedBack: 0, awaitingReassignment: 0 },
				{ id: 'mem-7', name: 'Priya Nair', assigned: 58, done: 58, steppedBack: 1, awaitingReassignment: 0 },
				{ id: 'mem-5', name: 'Ines Moreau', assigned: 58, done: 58, steppedBack: 0, awaitingReassignment: 0 }
			]
		}
	],
	/* A small, settled roster: three generalists, two track scopes, everything
	   covered and nothing awaiting reassignment. Tomás's union also names the
	   retired lightning format — the ref outlives the entry's retirement. */
	reviewers: [
		{ id: 'mem-2', name: 'Sofia Berg', email: 'sofia@perfpanel.se', status: 'active', scope: [] },
		{ id: 'mem-3', name: 'Jonas Weber', email: 'jonas.weber@metricsense.de', status: 'active', scope: [] },
		{
			id: 'mem-7',
			name: 'Priya Nair',
			email: 'priya.nair@reviewlab.ai',
			status: 'active',
			scope: [{ kind: 'track', id: 'trk-ai' }]
		},
		{
			id: 'mem-8',
			name: 'Tomás Rivera',
			email: 'tomas@queueless.dev',
			status: 'active',
			scope: [
				{ kind: 'track', id: 'trk-infra' },
				{ kind: 'format', id: 'fmt-lightning' }
			]
		},
		{ id: 'mem-5', name: 'Ines Moreau', email: 'ines@gridworks.fr', status: 'active', scope: [] }
	],
	myQueue: [
		{
			submissionId: 'sub-402',
			committed: true,
			myScore: 5,
			myComment: 'Benchmarks are reproducible and the talk does not need the product to make its point.',
			peerScores: [5, 4, 5, 5]
		},
		{
			submissionId: 'sub-403',
			committed: true,
			myScore: 5,
			myComment: 'The confession framing earns the war story. Confirm the outbox section fits 30 minutes.',
			peerScores: [4, 5, 5, 4]
		},
		{
			submissionId: 'sub-406',
			committed: true,
			myScore: 4,
			myComment: 'Strong on its own; only waitlisted because the accepted token talk covers the same ground.',
			peerScores: [4, 4, 4, 4]
		},
		{
			submissionId: 'sub-407',
			committed: true,
			myScore: 3,
			myComment: 'Good argument, thin evidence. Encouraged a resubmission with the cost data attached.',
			peerScores: [3, 3, 3, 4]
		}
	],
	/* Both rounds are closed, so these are final populations. Agents & Tools is
	   past the count a strip can be counted at, which is the case the standing
	   mark has to degrade into mass for rather than lie about. */
	reviewDistributions: {
		'trk-web': [
			1.4, 1.7, 1.9, 1.9, 2.1, 2.1, 2.3, 2.3, 2.3, 2.5, 2.5, 2.5, 2.5, 2.7, 2.7, 2.7, 2.7, 2.7,
			2.8, 2.8, 2.8, 2.8, 2.8, 2.9, 2.9, 2.9, 2.9, 2.9, 2.9, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0,
			3.1, 3.1, 3.1, 3.1, 3.1, 3.1, 3.1, 3.1, 3.2, 3.2, 3.2, 3.2, 3.2, 3.2, 3.2, 3.2, 3.3, 3.3,
			3.3, 3.3, 3.3, 3.3, 3.3, 3.3, 3.3, 3.4, 3.4, 3.4, 3.4, 3.4, 3.4, 3.4, 3.4, 3.4, 3.5, 3.5,
			3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6, 3.7, 3.7, 3.7,
			3.7, 3.7, 3.7, 3.7, 3.7, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 3.9, 3.9, 3.9, 3.9, 3.9, 3.9,
			4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.1, 4.1, 4.1, 4.1, 4.1, 4.2, 4.2, 4.2, 4.2, 4.3, 4.3, 4.3,
			4.4, 4.4, 4.4, 4.5, 4.5, 4.6, 4.7, 4.8
		],
		'trk-infra': [
			1.6, 1.9, 2.2, 2.4, 2.9, 2.9, 3.0, 3.0, 3.1, 3.1, 3.2, 3.2, 3.3, 3.3, 3.3, 3.4, 3.4, 3.4,
			3.5, 3.5, 3.5, 3.6, 3.6, 3.6, 3.7, 3.7, 3.7, 3.8, 3.8, 3.8, 3.9, 3.9, 4.0, 4.0, 4.1, 4.1,
			4.2, 4.2, 4.3, 4.3, 4.4, 4.5, 4.6, 4.6, 4.7, 4.8
		],
		'trk-ai': [
			2.1, 2.6, 2.8, 3.0, 3.1, 3.3, 3.4, 3.5, 3.6, 3.6, 3.7, 3.8, 3.8, 3.9, 4.0, 4.0, 4.1, 4.2,
			4.3, 4.4, 4.5, 4.6, 4.7, 4.9
		]
	},

	speakers: [
		{
			id: 'spk-1',
			name: 'Ravi Chandran',
			email: 'ravi@keynote.example',
			state: 'confirmed',
			sessions: [{ id: 'ses-1', title: 'Opening Keynote: Ten Years of Reliable AI Systems' }],
			tasksDone: 5,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true
		},
		{
			id: 'spk-2',
			name: 'Ines Moreau',
			email: 'ines@gridworks.fr',
			state: 'confirmed',
			sessions: [{ id: 'ses-2', title: 'Serving 100k-Token Contexts Without Melting the App' }],
			tasksDone: 5,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true
		},
		{
			id: 'spk-3',
			name: 'Daniel Kim',
			email: 'daniel@edgequery.dev',
			state: 'confirmed',
			sessions: [{ id: 'ses-7', title: 'Durable Agent Jobs: A Queueing Confession' }],
			tasksDone: 5,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true
		},
		{
			id: 'spk-4',
			name: 'Sofia Berg',
			email: 'sofia@perfpanel.se',
			state: 'confirmed',
			sessions: [{ id: 'ses-5', title: 'Panel: Who Owns Agent Reliability?' }, { id: 'ses-17', title: 'Closing Panel: Can We Ship Reliable Agents?' }],
			tasksDone: 4,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true,
			note: 'Slide upload waived — both sessions are panels with no deck.'
		},
		{
			id: 'spk-5',
			name: 'Lukas Brandt',
			email: 'lukas@perfpanel.se',
			state: 'confirmed',
			sessions: [{ id: 'ses-5', title: 'Panel: Who Owns Agent Reliability?' }],
			tasksDone: 5,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true
		},
		{
			id: 'spk-6',
			name: 'Priya Nair',
			email: 'priya.nair@reviewlab.ai',
			state: 'confirmed',
			sessions: [{ id: 'ses-9', title: 'Agent Handoffs: Who Owns the Write?' }, { id: 'ses-17', title: 'Closing Panel: Can We Ship Reliable Agents?' }],
			tasksDone: 5,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true
		},
		{
			id: 'spk-7',
			name: 'Elif Aydın',
			email: 'elif@a11ycraft.eu',
			state: 'confirmed',
			sessions: [{ id: 'ses-12', title: 'Hands-on: AI Interface Audits That Stick' }],
			tasksDone: 5,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true
		},
		{
			id: 'spk-8',
			name: 'Marc Dubois',
			email: 'marc@a11ycraft.eu',
			state: 'confirmed',
			sessions: [{ id: 'ses-12', title: 'Hands-on: AI Interface Audits That Stick' }],
			tasksDone: 5,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true
		},
		{
			id: 'spk-9',
			name: 'Tomás Rivera',
			email: 'tomas@queueless.dev',
			state: 'confirmed',
			sessions: [{ id: 'ses-11', title: 'Hands-on: Vector Search Plans for People Who Fear Them' }],
			tasksDone: 4,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true,
			note: 'Slide draft is optional and not due until Oct 8.'
		},
		{
			id: 'spk-10',
			name: 'Astrid Holm',
			email: 'astrid@holmdesign.dk',
			state: 'confirmed',
			sessions: [{ id: 'ses-13', title: 'Day Two Keynote: What We Owe the Next Agent' }],
			tasksDone: 5,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true
		}
	],

	taskDefs: [
		{ id: 'task-headshot', name: 'Headshot upload', kind: 'upload', required: true, dueAbsolute: 'Sep 18, 23:59 EDT', dueRelative: 'closed 10 days ago' },
		{ id: 'task-bio', name: 'Speaker bio', kind: 'form', required: true, dueAbsolute: 'Sep 18, 23:59 EDT', dueRelative: 'closed 10 days ago' },
		{ id: 'task-consent', name: 'Recording consent', kind: 'confirm', required: true, dueAbsolute: 'Sep 18, 23:59 EDT', dueRelative: 'closed 10 days ago' },
		{ id: 'task-av', name: 'AV requirements form', kind: 'form', required: true, dueAbsolute: 'Sep 25, 23:59 EDT', dueRelative: 'closed 3 days ago' },
		{ id: 'task-slides', name: 'Slides draft', kind: 'upload', required: false, dueAbsolute: 'Oct 8, 23:59 EDT', dueRelative: 'in 10 days' }
	],
	assignments: [
		{ taskId: 'task-headshot', speakerId: 'spk-1', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-1', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-1', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-1', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-1', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-2', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-2', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-2', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-2', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-2', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-3', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-3', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-3', state: 'late-complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-3', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-3', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-4', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-4', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-4', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-4', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-4', state: 'waived', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-5', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-5', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-5', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-5', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-5', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-6', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-6', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-6', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-6', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-6', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-7', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-7', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-7', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-7', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-7', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-8', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-8', state: 'late-complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-8', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-8', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-8', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-9', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-9', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-9', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-9', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-9', state: 'todo', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-10', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-10', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-10', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-10', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-10', state: 'complete', overdue: false }
	],

	schedule: {
		days: [
			{ key: 'day-1', label: 'Tue Oct 13' },
			{ key: 'day-2', label: 'Wed Oct 14' }
		],
		rooms: [
			{ id: 'room-main', name: 'Main Stage', capacity: 1000 },
			{ id: 'room-2a', name: 'Breakout Stage A', capacity: 240 },
			{ id: 'room-lab', name: 'Evals Lab', capacity: 80 }
		],
		dayStart: '09:00',
		slotMinutes: 30,
		slotsPerDay: 16,
		sessions: [
			{ id: 'ses-1', title: 'Opening Keynote: Ten Years of Reliable AI Systems', speakers: [{ name: 'Ravi Chandran', email: 'ravi@keynote.example' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 60, state: 'programmed' },
			{ id: 'ses-2', title: 'Serving 100k-Token Contexts Without Melting the App', speakers: [{ name: 'Ines Moreau', email: 'ines@gridworks.fr' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-3', title: 'Typed Tool Contracts Between Agents That Never Meet', speakers: [{ name: 'Amara Okafor', email: 'amara@contractual.io' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-4', title: 'The Prompt Scaffold That Survived Three Model Upgrades', speakers: [{ name: 'Nora Visser', email: 'nora@tokenslab.nl' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-5', title: 'Panel: Who Owns Agent Reliability?', speakers: [{ name: 'Sofia Berg', email: 'sofia@perfpanel.se' }, { name: 'Lukas Brandt', email: 'lukas@perfpanel.se' }], trackId: 'trk-web', formatId: 'fmt-panel', durationMin: 45, state: 'programmed' },
			{ id: 'ses-6', title: 'Deterministic Replay for Agent Failures', speakers: [{ name: 'Ingrid Halvorsen', email: 'ingrid@nordicscale.no' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-7', title: 'Durable Agent Jobs: A Queueing Confession', speakers: [{ name: 'Daniel Kim', email: 'daniel@edgequery.dev' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-8', title: 'Cutting Our Eval Run From 22 Minutes to 4', speakers: [{ name: 'Oskar Lind', email: 'oskar@steadystate.se' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-9', title: 'Agent Handoffs: Who Owns the Write?', speakers: [{ name: 'Priya Nair', email: 'priya.nair@reviewlab.ai' }], trackId: 'trk-ai', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-10', title: 'Tracing an Agent Run in Anger', speakers: [{ name: 'Mikkel Sørensen', email: 'mikkel@boxfresh.dk' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-11', title: 'Hands-on: Vector Search Plans for People Who Fear Them', speakers: [{ name: 'Tomás Rivera', email: 'tomas@queueless.dev' }], trackId: 'trk-infra', formatId: 'fmt-workshop', durationMin: 90, state: 'programmed' },
			{ id: 'ses-12', title: 'Hands-on: AI Interface Audits That Stick', speakers: [{ name: 'Elif Aydın', email: 'elif@a11ycraft.eu' }, { name: 'Marc Dubois', email: 'marc@a11ycraft.eu' }], trackId: 'trk-web', formatId: 'fmt-workshop', durationMin: 90, state: 'programmed' },
			{ id: 'ses-13', title: 'Day Two Keynote: What We Owe the Next Agent', speakers: [{ name: 'Astrid Holm', email: 'astrid@holmdesign.dk' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 45, state: 'programmed' },
			{ id: 'ses-14', title: 'Streaming Agent UIs Without a State Machine Meltdown', speakers: [{ name: 'Deniz Kaya', email: 'deniz@ingestworks.io' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-15', title: 'Designing Agent Interfaces People Can Actually Trust', speakers: [{ name: 'Hana Sato', email: 'hana@streamcraft.jp' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-16', title: 'Componentizing the Agent Stack', speakers: [{ name: 'Elena Petrova', email: 'elena@sandboxworks.example' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-17', title: 'Closing Panel: Can We Ship Reliable Agents?', speakers: [{ name: 'Sofia Berg', email: 'sofia@perfpanel.se' }, { name: 'Priya Nair', email: 'priya.nair@reviewlab.ai' }], trackId: 'trk-web', formatId: 'fmt-panel', durationMin: 45, state: 'programmed' },
			{ id: 'ses-18', title: 'Evaluating Agents Without a Golden Dataset', speakers: [{ name: 'Hanna Virtanen', email: 'hanna@evalset.fi' }], trackId: 'trk-ai', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-19', title: 'Prompt Contracts: Versioning What You Ask the Model', speakers: [{ name: 'Yusuf Demir', email: 'yusuf@promptline.dev' }], trackId: 'trk-ai', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-20', title: 'Running Small Models at the Edge', speakers: [{ name: 'Rosa Delgado', email: 'rosa@replicalabs.es' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-21', title: 'The Agent Incident Review That Changed Our Roadmap', speakers: [{ name: 'Oskar Lind', email: 'oskar@steadystate.se' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-22', title: 'Boring Agent Deploys: 40 Releases a Day', speakers: [{ name: 'Pekka Ranta', email: 'pekka@releaseworks.fi' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-23', title: 'Hands-on: Reading Your Own Agent Traces', speakers: [{ name: 'Britta Lange', email: 'britta@tracewerk.de' }], trackId: 'trk-infra', formatId: 'fmt-workshop', durationMin: 90, state: 'programmed' },
			{ id: 'ses-24', title: 'Hands-on: Writing Agent Skills That Hold Up', speakers: [{ name: 'Nadia Farrow', email: 'nadia@farrowlabs.uk' }], trackId: 'trk-web', formatId: 'fmt-workshop', durationMin: 90, state: 'programmed' }
		],
		placements: [
			{ sessionId: 'ses-1', dayKey: 'day-1', roomId: 'room-main', startMin: 0, conflicts: [] },
			{ sessionId: 'ses-2', dayKey: 'day-1', roomId: 'room-main', startMin: 90, conflicts: [] },
			{ sessionId: 'ses-3', dayKey: 'day-1', roomId: 'room-main', startMin: 150, conflicts: [] },
			{ sessionId: 'ses-4', dayKey: 'day-1', roomId: 'room-main', startMin: 210, conflicts: [] },
			{ sessionId: 'ses-5', dayKey: 'day-1', roomId: 'room-main', startMin: 300, conflicts: [] },
			{ sessionId: 'ses-6', dayKey: 'day-1', roomId: 'room-2a', startMin: 90, conflicts: [] },
			{ sessionId: 'ses-7', dayKey: 'day-1', roomId: 'room-2a', startMin: 150, conflicts: [] },
			{ sessionId: 'ses-8', dayKey: 'day-1', roomId: 'room-2a', startMin: 210, conflicts: [] },
			{ sessionId: 'ses-9', dayKey: 'day-1', roomId: 'room-2a', startMin: 300, conflicts: [] },
			{ sessionId: 'ses-10', dayKey: 'day-1', roomId: 'room-2a', startMin: 360, conflicts: [] },
			{ sessionId: 'ses-11', dayKey: 'day-1', roomId: 'room-lab', startMin: 90, conflicts: [] },
			{ sessionId: 'ses-12', dayKey: 'day-1', roomId: 'room-lab', startMin: 210, conflicts: [] },
			{ sessionId: 'ses-13', dayKey: 'day-2', roomId: 'room-main', startMin: 0, conflicts: [] },
			{ sessionId: 'ses-14', dayKey: 'day-2', roomId: 'room-main', startMin: 60, conflicts: [] },
			{ sessionId: 'ses-15', dayKey: 'day-2', roomId: 'room-main', startMin: 120, conflicts: [] },
			{ sessionId: 'ses-16', dayKey: 'day-2', roomId: 'room-main', startMin: 180, conflicts: [] },
			{ sessionId: 'ses-17', dayKey: 'day-2', roomId: 'room-main', startMin: 330, conflicts: [] },
			{ sessionId: 'ses-18', dayKey: 'day-2', roomId: 'room-2a', startMin: 0, conflicts: [] },
			{ sessionId: 'ses-19', dayKey: 'day-2', roomId: 'room-2a', startMin: 60, conflicts: [] },
			{ sessionId: 'ses-20', dayKey: 'day-2', roomId: 'room-2a', startMin: 120, conflicts: [] },
			{ sessionId: 'ses-21', dayKey: 'day-2', roomId: 'room-2a', startMin: 180, conflicts: [] },
			{ sessionId: 'ses-22', dayKey: 'day-2', roomId: 'room-2a', startMin: 240, conflicts: [] },
			{ sessionId: 'ses-23', dayKey: 'day-2', roomId: 'room-lab', startMin: 60, conflicts: [] },
			{ sessionId: 'ses-24', dayKey: 'day-2', roomId: 'room-lab', startMin: 210, conflicts: [] }
		],
		breaks: [],
		published: true
	},

	communications: [
		{
			id: 'msg-1',
			subject: 'One week out: what to expect',
			audience: 'Registered attendees',
			audienceCount: 940,
			state: 'scheduled',
			purpose: 'Attendee update',
			cause: 'Standing pre-event sequence: the one-week-out note goes to everyone registered',
			actor: 'policy',
			sentAt: 'Sends Oct 8, 09:00',
			deliveredCount: 0,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-2',
			subject: 'Green room, load-in, and who to find',
			audience: 'Confirmed speakers',
			audienceCount: 28,
			state: 'scheduled',
			purpose: 'Speaker logistics',
			cause: 'Day-one logistics for the confirmed roster, timed to land the morning before doors',
			causeHref: '/app/speakers?filter=confirmed',
			actor: 'you',
			sentAt: 'Sends Oct 13, 09:00',
			deliveredCount: 0,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-3',
			subject: 'The full schedule is live',
			audience: 'Submitters and subscribers',
			audienceCount: 1240,
			state: 'sent',
			purpose: 'Schedule announcement',
			cause: 'The schedule was published on Sep 22 — every submitter and subscriber was told',
			causeHref: '/app/schedule',
			actor: 'you',
			templateId: 'tpl-schedule-announcement',
			sentAt: 'Sep 22, 10:00',
			deliveredCount: 1240,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-4',
			subject: 'Your session time and room',
			audience: 'Confirmed speakers',
			audienceCount: 28,
			state: 'sent',
			purpose: 'Speaker logistics',
			cause: 'Publishing the schedule fixed every session time — each speaker got their own slot',
			causeHref: '/app/schedule',
			actor: 'you',
			sentAt: 'Sep 22, 10:05',
			deliveredCount: 28,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-5',
			subject: 'Waitlist update — still held',
			audience: 'Waitlisted submitters',
			audienceCount: 12,
			state: 'sent',
			purpose: 'Decision notice',
			cause: '12 submissions stayed waitlisted after the final decision pass',
			causeHref: '/app/decisions',
			actor: 'you',
			sentAt: 'Sep 15, 09:00',
			deliveredCount: 12,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-6',
			subject: 'AI Engineer NYC 2026 — decision on your submission',
			audience: 'Final decline batch',
			audienceCount: 44,
			state: 'sent',
			purpose: 'Decision notice',
			cause: '44 submissions were declined in the final pass and their submitters told',
			causeHref: '/app/decisions',
			actor: 'you',
			templateId: 'tpl-decision-declined',
			sentAt: 'Sep 8, 17:30',
			deliveredCount: 44,
			bouncedCount: 0,
			bounces: []
		}
	],
	threads: {
		'spk-1': [
			{
				id: 'thr-1-1',
				messageId: 'msg-2',
				at: 'Sends Oct 13, 09:00',
				purpose: 'Speaker logistics',
				subject: 'Green room, load-in, and who to find',
				outcome: 'scheduled',
				actor: 'you'
			},
			{
				id: 'thr-1-2',
				messageId: 'msg-4',
				at: 'Sep 22, 10:05',
				purpose: 'Speaker logistics',
				subject: 'Your session time and room',
				outcome: 'delivered',
				actor: 'you'
			},
			{
				id: 'thr-1-3',
				messageId: 'msg-3',
				at: 'Sep 22, 10:00',
				purpose: 'Schedule announcement',
				subject: 'The full schedule is live',
				outcome: 'delivered',
				actor: 'you'
			}
		],
		'spk-2': [
			{
				id: 'thr-2-1',
				messageId: 'msg-2',
				at: 'Sends Oct 13, 09:00',
				purpose: 'Speaker logistics',
				subject: 'Green room, load-in, and who to find',
				outcome: 'scheduled',
				actor: 'you'
			},
			{
				id: 'thr-2-2',
				messageId: 'msg-4',
				at: 'Sep 22, 10:05',
				purpose: 'Speaker logistics',
				subject: 'Your session time and room',
				outcome: 'delivered',
				actor: 'you'
			},
			{
				id: 'thr-2-3',
				at: 'Sep 8, 17:35',
				purpose: 'Decision notice',
				subject: 'Good news about “Serving 100k-Token Contexts Without Melting the App”',
				outcome: 'delivered',
				actor: 'you'
			}
		]
	},
	readiness: { provider: 'Resend', outbound: 'ready', callbacks: 'ready', inbound: 'ready' },

	templates: starterTemplates(),
	surfaces: starterSurfaceTemplates('AI Engineer NYC 2026'),
	fieldRegistry: baselineFieldRegistry(),
	theme: defaultEventTheme('AI Engineer NYC 2026'),

	forms: [
		{ id: 'form-cfp', name: 'Call for Proposals', target: { kind: 'general' }, status: 'closed', version: 4, submissionCount: 9 },
		{
			id: 'form-late',
			name: 'Late submission request',
			target: { kind: 'general' },
			status: 'closed',
			version: 1,
			submissionCount: 1,
			composition: {
				excludedFieldIds: [
					'fld-headline',
					'fld-location',
					'fld-link',
					'fld-website',
					'fld-linkedin',
					'fld-x',
					'fld-github',
					'fld-format',
					'fld-notes',
					'fld-consent'
				]
			}
		},
		{
			id: 'form-evergreen',
			name: 'Speak at a Future AI Engineer Event',
			target: { kind: 'general' },
			status: 'open',
			version: 3,
			submissionCount: 58,
			composition: {
				excludedFieldIds: [
					'fld-headline',
					'fld-location',
					'fld-link',
					'fld-website',
					'fld-linkedin',
					'fld-x',
					'fld-github',
					'fld-format',
					'fld-notes',
					'fld-consent'
				],
				requiredOverrides: { 'fld-abstract': false }
			}
		}
	],

	settings: {
		name: 'AI Engineer NYC 2026',
		dates: 'Oct 12–14, 2026',
		startDate: '2026-10-12',
		endDate: '2026-10-14',
		location: 'New York City',
		timezone: 'America/New_York',
		venueNote: 'New York venue — Main Stage, Breakout Stage A, Evals Lab. Load-in from 07:00, AV walkthrough Oct 9.'
	},
	members: [
		{ id: 'mem-1', name: 'Jere K.', email: 'jere@aie-demo.example', role: 'Workspace Admin', status: 'active' },
		{ id: 'mem-2', name: 'Sofia Berg', email: 'sofia@perfpanel.se', role: 'Event Manager', status: 'active' },
		{ id: 'mem-3', name: 'Jonas Weber', email: 'jonas.weber@metricsense.de', role: 'Speaker Reviewer', status: 'active' },
		{ id: 'mem-4', name: 'Linnea Koski', email: 'linnea@aie-demo.example', role: 'Speaker Manager', status: 'active' },
		{ id: 'mem-5', name: 'Ines Moreau', email: 'ines@gridworks.fr', role: 'Speaker Reviewer', status: 'active' },
		{ id: 'mem-6', name: 'Aleks Rinne', email: 'aleks@aie-demo.example', role: 'Communications Coordinator', status: 'active' },
		{ id: 'mem-7', name: 'Priya Nair', email: 'priya.nair@reviewlab.ai', role: 'Speaker Reviewer', status: 'active' },
		{ id: 'mem-8', name: 'Tomás Rivera', email: 'tomas@queueless.dev', role: 'Speaker Reviewer', status: 'active' }
	]
};

export default quiet;
