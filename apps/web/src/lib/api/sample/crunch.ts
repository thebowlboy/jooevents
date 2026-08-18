import type { WorkspaceDataset } from './dataset';
import { closesInDays, dayDeadline, daysAgo, hoursAgo } from './dataset';

/** The event's zone — the authority for every deadline boundary below. */
const TZ = 'America/New_York';
import {
	defaultEventTheme,
	starterSurfaceTemplates,
	starterTemplates,
	withAgentRevision
} from './templates';
import { baselineFieldRegistry } from './fields';

/**
 * Peak-pressure scenario: the CFP is closed, review is all but finished, and
 * the acceptance notices are the only thing standing between the program and
 * the schedule. Publishing is blocked by five conflicts.
 */
const crunch: WorkspaceDataset = {
	key: 'crunch',
	name: 'Decision crunch',
	description: 'CFP closed, review 97% done, four decisions waiting to send, schedule blocked.',

	summary: {
		event: {
			id: 'evt_aie-nyc-2026',
			name: 'AI Engineer NYC 2026',
			dates: 'Oct 12–14, 2026',
			location: 'New York City',
			timezone: 'America/New_York',
			phase: 'CFP closed · decisions waiting to send',
			today: 'Monday, August 10'
		},
		lockedAreas: [],
		navCounts: {
			/* The held population. A spam proposal is kept and recoverable,
			   but it is not work waiting in this area, so it is out of the badge
			   and out of the Overview total that reads the same rows. */
			submissions: '15',
			review: '97%',
			decisions: { value: '4', tone: 'danger' },
			speakers: '12',
			reviewers: '8',
			tasks: { value: '18', tone: 'warning' },
			schedule: { value: '5', tone: 'danger' },
			messages: '4'
		},
		/* Three fixed slots beside the computed arrival tile: how much judging is
		   done, how much of the programme is chosen, how much of it is placed.
		   They used to restate the attention queue — "10 undecided", "3 not yet
		   notified", "notify by 3 days" were all rows in the panel below — which
		   spent the top of the screen saying what the next region says better. */
		stats: [
			{
				label: 'Round 2 reviews',
				value: '97%',
				/* The sub names why the bar is amber. With a meter above it the
				   sentence stays on the ink ladder, so the words are the only thing
				   carrying the state — colour ranks it, it never carries it. */
				sub: '583 of 600 · 17 open with one day left',
				health: 'attention',
				progress: { done: 583, required: 600 }
			},
			{
				label: 'Decided',
				value: '6 of 16',
				sub: '4 accepted · 4 still waiting to hear',
				health: 'attention',
				progress: { done: 6, required: 16 }
			},
			{
				label: 'Placed',
				value: '18 of 19',
				sub: 'on the grid · 5 conflicts',
				health: 'blocked',
				progress: { done: 18, required: 19 }
			}
		],
		attention: [
			{
				id: 'unnotified',
				severity: 'now',
				area: 'decisions',
				title: '4 speakers have not been told their result',
				detail:
					'One of them has been waiting 9 days. Results are never sent automatically — the send is yours to make.',
				action: 'Send their results',
				href: '/app/decisions?scope=unnotified'
			},
			{
				id: 'undecided',
				severity: 'soon',
				area: 'decisions',
				title: '10 submissions are waiting for your answer',
				detail: 'Scores are in for all of them. Evals & Reliability and Models & Infrastructure have not had a decision pass yet.',
				action: 'Open decision board'
			},
			{
				id: 'conflicts',
				severity: 'soon',
				area: 'schedule',
				title: '5 conflicts on the schedule',
				detail:
					'Three sessions want the same Evals Lab block, and Priya Nair is booked into two rooms at once.',
				action: 'Show the conflicts',
				href: '/app/schedule?panel=conflicts'
			},
			{
				id: 'review-open',
				severity: 'soon',
				area: 'review',
				title: '17 round 2 reviews still open',
				detail:
					'Due tomorrow, spread across 3 reviewers. Their scores are what the undecided submissions are waiting for.',
				action: 'Nudge reviewers'
			},
			{
				id: 'overdue-tasks',
				severity: 'soon',
				area: 'tasks',
				title: '18 speaker tasks overdue',
				detail: 'Headshots, bios, and recording consent — all past due for speakers already announced.',
				action: 'Filter overdue',
				href: '/app/tasks?filter=overdue'
			},
			{
				id: 'bounced',
				severity: 'fyi',
				area: 'messages',
				title: '3 speakers never received the CFP close notice',
				detail:
					'Their addresses rejected it, and the same list gets the acceptance emails.',
				action: 'Open communications'
			},
			{
				id: 'late-form',
				severity: 'fyi',
				area: 'forms',
				title: 'Late-submission form is still open',
				detail: '17 requests arrived after the CFP closed; the form closes itself in 2 days.',
				action: 'Review form'
			}
		],
		pipeline: [
			{ key: 'collect', label: 'Collect', headline: '16', sub: 'CFP closed two weeks ago · 1 late', state: 'ok' },
			{ key: 'triage', label: 'Triage', headline: '13', sub: 'inbox · 1 set aside · 1 late', state: 'ok' },
			/* A nearly-full meter reads calm; 17 reviews against a deadline that
			   lands tomorrow is not. Pace answers to the clock, not the fraction. */
			{
				key: 'review',
				label: 'Review',
				headline: '583',
				sub: 'of 600 reviews are in · 17 still open, across 3 reviewers',
				state: 'attention',
				progress: { done: 583, required: 600 },
				paceTone: 'behind',
				deadline: { qualifier: 'due', ...dayDeadline(1, TZ) }
			},
			{
				key: 'decide',
				label: 'Decide',
				headline: '6',
				sub: 'of 16 decided · 4 accepted · 4 still waiting to hear',
				state: 'attention',
				progress: { done: 6, required: 16 },
				paceTone: 'behind',
				deadline: { qualifier: 'notify by', ...dayDeadline(3, TZ) }
			},
			/* No stated task total, so no meter; 18 required tasks are already
			   overdue for announced speakers. */
			{
				key: 'speakers',
				label: 'Speakers',
				headline: '10',
				sub: 'confirmed · 18 tasks overdue',
				state: 'attention',
				paceTone: 'behind',
				deadline: { qualifier: 'content due', ...dayDeadline(32, TZ) }
			},
			{
				key: 'schedule',
				label: 'Schedule',
				headline: '18',
				sub: 'of 19 placed · 5 conflicts',
				state: 'blocked',
				progress: { done: 18, required: 19 },
				paceTone: 'behind',
				deadline: { qualifier: 'publish target', ...dayDeadline(18, TZ) }
			},
			{ key: 'comms', label: 'Messages', headline: '4', sub: 'waiting to send · 1 sending now', state: 'ok' }
		],
		deadlines: [
			{ label: 'Review round 2 due', ...dayDeadline(1, TZ) },
			{ label: 'Acceptance notices due', ...dayDeadline(3, TZ) },
			{
				label: 'Schedule publish target',
				...dayDeadline(18, TZ),
				note: '5 conflicts still open'
			},
			{ label: 'Speaker content due', ...dayDeadline(32, TZ) }
		],
		activity: [
			{
				id: 'act-1',
				actor: 'person',
				name: 'Sofia Berg',
				text: 'committed the last 9 Agents & Tools reviews in round 2',
				at: hoursAgo(0.3)
			},
			{
				id: 'act-2',
				actor: 'agent',
				name: 'Conflict scan',
				text: 'found 5 conflicts after the Lab import — three sessions want one block',
				at: hoursAgo(0.9)
			},
			{ id: 'act-3', actor: 'you', name: 'You', text: 'accepted 3 submissions in Agents & Tools', at: hoursAgo(2) },
			{
				id: 'act-4',
				actor: 'person',
				name: 'Astrid Holm',
				text: 'withdrew after acceptance — “Designing Agent Interfaces People Can Actually Trust” is unplaced',
				at: hoursAgo(5)
			},
			{
				id: 'act-5',
				actor: 'agent',
				name: 'Decision drafts',
				text: 'prepared acceptance, waitlist, and decline drafts for review — nothing sent',
				at: daysAgo(1)
			}
		],
		trays: [
			{ kind: 'late', label: 'Late submissions', count: 1, href: '/app/submissions?tray=late' },
			{ kind: 'spam', label: 'Spam, recoverable', count: 1, href: '/app/submissions?tray=spam' },
			{ kind: 'inbound-mail', label: 'Inbound mail review', count: 6 },
			{ kind: 'appeals', label: 'Appeals awaiting reply', count: 4 },
			{ kind: 'bounced', label: 'Bounced recipients', count: 3, href: '/app/messages' },
			{ kind: 'unresolved-import', label: 'Unresolved import items', count: 2 }
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
		{ id: 'fmt-panel', name: 'Panel', defaultDurationMin: 45 }
	],

	submissions: [
		{
			id: 'sub-301',
			title: 'Deterministic Replay for Agent Failures',
			abstract:
				'Recording model, tool, and retrieval boundaries precisely enough to replay a failed agent run locally, without capturing secrets or user data.',
			speakers: [{ name: 'Ingrid Halvorsen', email: 'ingrid@nordicscale.no' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(32),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [
				{
					key: 'relevance',
					label: 'On-topic 0.95',
					family: 'quality',
					score: 0.95,
					rationale: 'Named tooling, reproducible method, and two concrete failures.',
					source: 'Screen run #8'
				}
			],
			resources: [
				{ name: 'replay-architecture-draft.pdf', kind: 'slides', detail: 'PDF · 2.8 MB' },
				{ name: 'boundary-recorder (repository)', kind: 'link', detail: 'codeberg.org' }
			],
			reviewAverage: 4.7,
			reviewCount: 5
		},
		{
			id: 'sub-302',
			title: 'Type Systems for Tool-Calling Agents',
			abstract:
				'Where type systems help tool-calling agents, where schemas become ceremony, and the production failure that changed the boundary we enforce.',
			speakers: [{ name: 'Marc Dubois', email: 'marc@a11ycraft.eu' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(35),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			resources: [
				{ name: 'tool-contract-typing-notes.pdf', kind: 'document', detail: 'PDF · 410 KB' }
			],
			reviewAverage: 4.5,
			reviewCount: 5
		},
		{
			id: 'sub-303',
			title: 'Agent Handoffs: Who Owns the Write?',
			abstract:
				'Multi-agent systems fail at the seams. Patterns for typed handoffs, single-writer discipline, and reconstructing what happened after a bad run.',
			speakers: [{ name: 'Priya Nair', email: 'priya.nair@reviewlab.ai' }],
			trackId: 'trk-ai',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(30),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [
				{
					key: 'relevance',
					label: 'On-topic 0.93',
					family: 'quality',
					score: 0.93,
					rationale: 'Directly answers the track brief on agent reliability with implementation detail.',
					source: 'Screen run #8'
				}
			],
			reviewAverage: 4.5,
			reviewCount: 5
		},
		{
			id: 'sub-304',
			title: 'Hands-on: Vector Search Plans for People Who Fear Them',
			abstract:
				'A 90-minute lab reading vector-search and reranking plans from a seeded corpus until recall, latency, and cost tradeoffs become visible.',
			speakers: [{ name: 'Tomás Rivera', email: 'tomas@queueless.dev' }],
			trackId: 'trk-infra',
			formatId: 'fmt-workshop',
			submittedAt: daysAgo(38),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [
				{
					key: 'equipment',
					label: 'Needs AV check',
					family: 'integrity',
					rationale: 'Lab needs attendee laptops and a wired network for the seeded retrieval corpus.',
					source: 'Form answers'
				}
			],
			reviewAverage: 4.3,
			reviewCount: 4
		},
		{
			id: 'sub-305',
			title: 'Evaluation Rubrics as a Product API',
			abstract:
				'Treating evaluation criteria as a versioned product contract: calibration, deprecation, and rubric migrations we shipped without breaking historical comparisons.',
			speakers: [{ name: 'Nora Visser', email: 'nora@tokenslab.nl' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(24),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [
				{
					key: 'dup',
					label: 'Similar to #148',
					family: 'quality',
					rationale: 'Overlaps an earlier token-governance submission; clustered so both are decided together.',
					source: 'Duplicate clustering'
				}
			],
			reviewAverage: 4.2,
			reviewCount: 5
		},
		{
			id: 'sub-306',
			title: 'Cutting Our Eval Run From 22 Minutes to 4',
			abstract:
				'The cache keys, the test partitioning, and the three jobs we deleted. Includes the spreadsheet that let us argue about it with numbers instead of taste.',
			speakers: [{ name: 'Oskar Lind', email: 'oskar@steadystate.se' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(27),
			source: 'cfp',
			targetSessionId: 'ses-19',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			resources: [
				{ name: 'Conference cut of the internal tech talk', kind: 'video', detail: '18 min · makertube.net' }
			],
			reviewAverage: 4.0,
			reviewCount: 4
		},
		{
			id: 'sub-307',
			title: 'Evaluating Agents Without a Golden Dataset',
			abstract:
				'Building usable evaluations before labels exist: adversarial pairs, sampled human review, and the metrics we retired for lying to us.',
			speakers: [{ name: 'Hana Sato', email: 'hana@streamcraft.jp' }],
			trackId: 'trk-ai',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(22),
			source: 'cfp',
			targetSessionId: 'ses-19',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			reviewAverage: 3.9,
			reviewCount: 5
		},
		{
			id: 'sub-308',
			title: 'Panel: When Should Models Run at the Edge?',
			abstract:
				'Invited panel pairing a platform lead, a cost owner, and a skeptic to argue about where edge compute actually earned its bill this year.',
			speakers: [
				{ name: 'Sofia Berg', email: 'sofia@perfpanel.se' },
				{ name: 'Lukas Brandt', email: 'lukas@perfpanel.se' }
			],
			trackId: 'trk-web',
			formatId: 'fmt-panel',
			submittedAt: daysAgo(46),
			source: 'direct_entry',
			enteredBy: 'Linnea Koski',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			reviewAverage: 3.8,
			reviewCount: 3
		},
		{
			id: 'sub-309',
			title: 'Streaming Agent UIs Without a State Machine Meltdown',
			abstract:
				'Patterns for token-streaming interfaces that stay debuggable: optimistic ghosts, deterministic reducers, and replayable sessions.',
			speakers: [{ name: 'Deniz Kaya', email: 'deniz@ingestworks.io' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(41),
			source: 'cfp',
			tray: 'inbox',
			decision: 'accepted',
			decidedAt: hoursAgo(28),
			notified: false,
			signals: [
				{
					key: 'relevance',
					label: 'On-topic 0.96',
					family: 'quality',
					score: 0.96,
					rationale: 'Highest scoring Agents & Tools submission; patterns are framework-agnostic.',
					source: 'Screen run #8'
				}
			],
			reviewAverage: 4.8,
			reviewCount: 5
		},
		{
			id: 'sub-310',
			title: 'Typed Tool Contracts Between Agents That Never Meet',
			abstract:
				'How we replaced integration meetings with schema-first contracts, and what broke. Includes the migration playbook and the failure that nearly reversed it.',
			speakers: [{ name: 'Amara Okafor', email: 'amara@contractual.io' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(36),
			source: 'cfp',
			tray: 'inbox',
			decision: 'accepted',
			decidedAt: hoursAgo(28),
			notified: false,
			signals: [],
			reviewAverage: 4.6,
			reviewCount: 5
		},
		{
			id: 'sub-311',
			title: 'Durable Agent Jobs: A Queueing Confession',
			abstract:
				'We ran long-lived agent jobs on a home-grown queue for three years. What worked, what melted, and the durable handoff pattern that finally fixed it.',
			speakers: [{ name: 'Daniel Kim', email: 'daniel@edgequery.dev' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(33),
			source: 'cfp',
			tray: 'inbox',
			decision: 'accepted',
			decidedAt: hoursAgo(27),
			notified: false,
			signals: [],
			reviewAverage: 4.6,
			reviewCount: 5
		},
		{
			id: 'sub-312',
			title: 'Opening Keynote: AI Engineering Beyond the Demo',
			abstract:
				'Ten years of moving AI systems from demos to durable products, and what reliable autonomy costs the teams responsible for it.',
			speakers: [{ name: 'Ravi Chandran', email: 'ravi@keynote.example' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(59),
			source: 'direct_entry',
			enteredBy: 'Jere K.',
			tray: 'inbox',
			decision: 'accepted',
			decidedAt: daysAgo(58),
			notified: true,
			signals: [],
			reviewCount: 0
		},
		{
			id: 'sub-313',
			title: 'Hands-on: AI Interface Audits That Stick',
			abstract:
				'A 90-minute workshop auditing streamed agent interfaces for accessibility, uncertainty, interruption, and keyboard control, then turning findings into fixes.',
			speakers: [
				{ name: 'Elif Aydın', email: 'elif@a11ycraft.eu' },
				{ name: 'Marc Dubois', email: 'marc@a11ycraft.eu' }
			],
			trackId: 'trk-web',
			formatId: 'fmt-workshop',
			submittedAt: daysAgo(25),
			source: 'cfp',
			tray: 'inbox',
			decision: 'waitlisted',
			decidedAt: hoursAgo(26),
			notified: false,
			signals: [],
			reviewAverage: 4.1,
			reviewCount: 4
		},
		{
			id: 'sub-314',
			title: 'Scale Your Dev Team With Our AI Copilot',
			abstract:
				'A guided tour of our platform with live benchmarks against the competition, plus launch pricing for conference attendees.',
			speakers: [{ name: 'Britta Klein', email: 'britta@shipfast.tools' }],
			trackId: 'trk-ai',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(19),
			source: 'cfp',
			tray: 'set-aside',
			setAsideBy: 'Screen run #9',
			decision: 'undecided',
			notified: false,
			signals: [
				{
					key: 'pitch',
					label: 'Product pitch 0.91',
					family: 'integrity',
					score: 0.91,
					rationale: 'Vendor demo with pricing; no transferable technique for attendees.',
					source: 'Screen run #9'
				}
			],
			reviewCount: 0
		},
		{
			id: 'sub-315',
			title: 'Sandboxing Tool Calls: The Production Log',
			abstract:
				'Arrived nine hours after the CFP closed: a detailed production log comparing container isolation, tool-call startup latency, and capability checks.',
			speakers: [{ name: 'Mikkel Sørensen', email: 'mikkel@boxfresh.dk' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: hoursAgo(279),
			source: 'cfp',
			tray: 'late',
			decision: 'undecided',
			notified: false,
			signals: [],
			reviewCount: 0
		},
		{
			id: 'sub-316',
			title: 'Crypto Wealth Secrets 2026',
			abstract: 'Make passive income while you sleep!!! Limited spots for my masterclass.',
			speakers: [{ name: 'Rex Vault', email: 'rex@vaultmoney.xyz' }],
			trackId: 'trk-ai',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(14),
			source: 'cfp',
			tray: 'spam',
			decision: 'declined',
			decidedAt: daysAgo(13),
			notified: true,
			signals: [
				{
					key: 'spam',
					label: 'Spam 0.98',
					family: 'integrity',
					score: 0.98,
					rationale: 'Off-topic financial promotion from a disposable sender domain.',
					source: 'Arrival checks'
				}
			],
			reviewCount: 0,
			appealCount: 2
		}
	],
	submissionTrayTotals: { inbox: 13, 'set-aside': 1, late: 1, spam: 1 },
	/* Away for nearly two weeks. Neither today nor this week covers what they
	   missed, so the arrival window widens to the absence itself. */
	previousVisit: daysAgo(13),
	visitHistory: [daysAgo(13), daysAgo(14), daysAgo(21)],

	reviewPlans: [
		{
			id: 'plan-r1',
			name: 'Round 1 · screening',
			scaleMax: 5,
			reviewsPerSubmission: 5,
			deadlineRelative: 'closed Jul 28',
			anonymized: true,
			done: 900,
			total: 900,
			antiAnchoring: true,
			// Roster ids are member ids; each closed plan's rows still sum to
			// its done/total, so history and the meter agree.
			reviewers: [
				{ id: 'mem-2', name: 'Sofia Berg', assigned: 150, done: 150, steppedBack: 2, awaitingReassignment: 0 },
				{ id: 'mem-3', name: 'Jonas Weber', assigned: 150, done: 150, steppedBack: 0, awaitingReassignment: 0 },
				{ id: 'mem-8', name: 'Priya Nair', assigned: 150, done: 150, steppedBack: 3, awaitingReassignment: 0 },
				{ id: 'mem-9', name: 'Tomás Rivera', assigned: 150, done: 150, steppedBack: 1, awaitingReassignment: 0 },
				{ id: 'mem-10', name: 'Elif Aydın', assigned: 150, done: 150, steppedBack: 0, awaitingReassignment: 0 },
				{ id: 'mem-11', name: 'Marc Dubois', assigned: 150, done: 150, steppedBack: 1, awaitingReassignment: 0 }
			]
		},
		{
			id: 'plan-r2',
			name: 'Round 2 · shortlist',
			scaleMax: 5,
			reviewsPerSubmission: 5,
			deadlineRelative: 'due tomorrow',
			anonymized: false,
			done: 583,
			total: 600,
			antiAnchoring: true,
			reviewers: [
				{ id: 'mem-2', name: 'Sofia Berg', assigned: 75, done: 75, steppedBack: 0, awaitingReassignment: 0 },
				{ id: 'mem-3', name: 'Jonas Weber', assigned: 75, done: 75, steppedBack: 1, awaitingReassignment: 0 },
				{ id: 'mem-8', name: 'Priya Nair', assigned: 75, done: 75, steppedBack: 0, awaitingReassignment: 0 },
				{ id: 'mem-9', name: 'Tomás Rivera', assigned: 75, done: 75, steppedBack: 0, awaitingReassignment: 0 },
				{ id: 'mem-10', name: 'Elif Aydın', assigned: 75, done: 75, steppedBack: 2, awaitingReassignment: 0 },
				{ id: 'mem-11', name: 'Marc Dubois', assigned: 75, done: 72, steppedBack: 0, awaitingReassignment: 0 },
				{ id: 'mem-5', name: 'Ines Moreau', assigned: 75, done: 68, steppedBack: 1, awaitingReassignment: 0 },
				{ id: 'mem-6', name: 'Oskar Lind', assigned: 75, done: 68, steppedBack: 0, awaitingReassignment: 0 }
			]
		}
	],
	/* Eight reviewers and still a gap: Evals & Reliability has no scoped
	   reviewer at all, so only the two generalists cover it — while they also
	   carry everything else. The coverage panel's pressure case. */
	reviewers: [
		{ id: 'mem-2', name: 'Sofia Berg', email: 'sofia@perfpanel.se', status: 'active', scope: [] },
		{ id: 'mem-3', name: 'Jonas Weber', email: 'jonas.weber@metricsense.de', status: 'active', scope: [] },
		{
			id: 'mem-8',
			name: 'Priya Nair',
			email: 'priya.nair@reviewlab.ai',
			status: 'active',
			scope: [{ kind: 'track', id: 'trk-web' }]
		},
		{
			id: 'mem-9',
			name: 'Tomás Rivera',
			email: 'tomas@queueless.dev',
			status: 'active',
			scope: [{ kind: 'track', id: 'trk-infra' }]
		},
		{
			id: 'mem-10',
			name: 'Elif Aydın',
			email: 'elif@a11ycraft.eu',
			status: 'active',
			scope: [{ kind: 'format', id: 'fmt-workshop' }]
		},
		{
			id: 'mem-11',
			name: 'Marc Dubois',
			email: 'marc@a11ycraft.eu',
			status: 'active',
			scope: [{ kind: 'track', id: 'trk-web' }]
		},
		{
			id: 'mem-5',
			name: 'Ines Moreau',
			email: 'ines@gridworks.fr',
			status: 'active',
			scope: [{ kind: 'track', id: 'trk-infra' }]
		},
		{
			id: 'mem-6',
			name: 'Oskar Lind',
			email: 'oskar@steadystate.se',
			status: 'active',
			scope: [{ kind: 'track', id: 'trk-infra' }]
		}
	],
	myQueue: [
		{
			submissionId: 'sub-301',
			committed: true,
			myScore: 5,
			myComment: 'Best infrastructure submission this year. Ask for the replay tooling link in the speaker pack.',
			peerScores: [5, 4, 5, 4],
			accolades: ['top_pick']
		},
		{
			submissionId: 'sub-302',
			committed: true,
			myScore: 4,
			myComment: 'Honest about the rollback, which is rarer than the migration talk itself.',
			peerScores: [5, 4, 5, 4],
			accolades: ['top_pick']
		},
		{
			submissionId: 'sub-303',
			committed: true,
			myScore: 5,
			myComment: 'Pairs well with the streaming UI talk; avoid scheduling them opposite each other.',
			peerScores: [4, 5, 4, 4],
			accolades: ['top_pick']
		},
		{
			submissionId: 'sub-308',
			committed: true,
			myScore: 4,
			myComment: 'The room is under-rating this. The disagreement is real and both people who can settle it are on the panel.',
			peerScores: [4, 3],
			accolades: ['hidden_gem']
		},
		{ submissionId: 'sub-306', committed: false, myScore: 4 },
		{ submissionId: 'sub-307', committed: false }
	],
	/* Round 2 scores a shortlist, so every track's population sits high and the
	   spread is narrow — the case where a bare average tells a reviewer almost
	   nothing and its standing tells them everything. */
	reviewDistributions: {
		'trk-web': [
			3.1, 3.3, 3.4, 3.5, 3.6, 3.6, 3.7, 3.8, 3.8, 3.9, 3.9, 4.0, 4.0, 4.0, 4.1, 4.1, 4.1, 4.2,
			4.2, 4.2, 4.3, 4.3, 4.4, 4.4, 4.5, 4.5, 4.6, 4.6, 4.7, 4.7, 4.8, 4.8, 4.9, 4.9
		],
		'trk-infra': [
			3.2, 3.4, 3.5, 3.6, 3.7, 3.8, 3.8, 3.9, 3.9, 4.0, 4.0, 4.1, 4.1, 4.2, 4.2, 4.3, 4.3, 4.4,
			4.5, 4.5, 4.6, 4.6, 4.7, 4.7, 4.8, 4.9
		],
		'trk-ai': [3.0, 3.3, 3.5, 3.6, 3.7, 3.8, 3.9, 3.9, 4.0, 4.1, 4.2, 4.3, 4.4, 4.5, 4.5, 4.6, 4.7, 4.9]
	},

	speakers: [
		{
			id: 'spk-1',
			name: 'Ravi Chandran',
			email: 'ravi@keynote.example',
			state: 'confirmed',
			sessions: [{ id: 'ses-1', title: 'Opening Keynote: AI Engineering Beyond the Demo' }],
			tasksDone: 4,
			tasksTotal: 5,
			overdueTasks: 1,
			publiclyVisible: true,
			contentApproved: true
		},
		{
			id: 'spk-2',
			name: 'Sofia Berg',
			email: 'sofia@perfpanel.se',
			state: 'confirmed',
			sessions: [{ id: 'ses-7', title: 'Panel: Who Owns Agent Reliability?' }, { id: 'ses-16', title: 'Closing Panel: Can We Ship Reliable Agents?' }],
			tasksDone: 5,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true
		},
		{
			id: 'spk-3',
			name: 'Lukas Brandt',
			email: 'lukas@perfpanel.se',
			state: 'confirmed',
			sessions: [{ id: 'ses-7', title: 'Panel: Who Owns Agent Reliability?' }],
			tasksDone: 3,
			tasksTotal: 5,
			overdueTasks: 2,
			publiclyVisible: true,
			contentApproved: false
		},
		{
			id: 'spk-4',
			name: 'Elena Petrova',
			email: 'elena@sandboxworks.example',
			state: 'confirmed',
			sessions: [{ id: 'ses-5', title: 'Componentizing the Agent Stack' }],
			tasksDone: 1,
			tasksTotal: 5,
			overdueTasks: 3,
			publiclyVisible: false,
			contentApproved: false,
			note: 'Three reminders sent. Page shows “to be announced” until the headshot and bio arrive.'
		},
		{
			id: 'spk-5',
			name: 'Daniel Kim',
			email: 'daniel@edgequery.dev',
			state: 'confirmed',
			sessions: [{ id: 'ses-4', title: 'Durable Agent Jobs: A Queueing Confession' }],
			tasksDone: 2,
			tasksTotal: 5,
			overdueTasks: 3,
			publiclyVisible: false,
			contentApproved: false
		},
		{
			id: 'spk-6',
			name: 'Priya Nair',
			email: 'priya.nair@reviewlab.ai',
			state: 'confirmed',
			sessions: [{ id: 'ses-9', title: 'Prompt Contracts: Versioning What You Ask the Model' }, { id: 'ses-10', title: 'Provenance in Agent Interfaces' }],
			tasksDone: 5,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true,
			note: 'Two sessions — currently scheduled in two rooms at the same time on day two.'
		},
		{
			id: 'spk-7',
			name: 'Tomás Rivera',
			email: 'tomas@queueless.dev',
			state: 'confirmed',
			sessions: [{ id: 'ses-8', title: 'Hands-on: Reading Your Own Agent Traces' }],
			tasksDone: 2,
			tasksTotal: 5,
			overdueTasks: 3,
			publiclyVisible: true,
			contentApproved: false
		},
		{
			id: 'spk-8',
			name: 'Elif Aydın',
			email: 'elif@a11ycraft.eu',
			state: 'confirmed',
			sessions: [{ id: 'ses-13', title: 'Hands-on: Writing Agent Skills That Hold Up' }],
			tasksDone: 3,
			tasksTotal: 5,
			overdueTasks: 2,
			publiclyVisible: true,
			contentApproved: true
		},
		{
			id: 'spk-9',
			name: 'Marc Dubois',
			email: 'marc@a11ycraft.eu',
			state: 'invited',
			sessions: [{ id: 'ses-13', title: 'Hands-on: Writing Agent Skills That Hold Up' }],
			tasksDone: 0,
			tasksTotal: 0,
			overdueTasks: 0,
			publiclyVisible: false,
			contentApproved: false,
			note: 'Co-presenter invitation sent Aug 8. Tasks appear once he accepts.'
		},
		{
			id: 'spk-10',
			name: 'Mikkel Sørensen',
			email: 'mikkel@boxfresh.dk',
			state: 'confirmed',
			sessions: [{ id: 'ses-14', title: 'Tracing an Agent Run in Anger' }],
			tasksDone: 1,
			tasksTotal: 5,
			overdueTasks: 3,
			publiclyVisible: false,
			contentApproved: false
		},
		{
			id: 'spk-11',
			name: 'Ines Moreau',
			email: 'ines@gridworks.fr',
			state: 'confirmed',
			sessions: [{ id: 'ses-6', title: 'Serving 100k-Token Contexts Without Melting the App' }],
			tasksDone: 4,
			tasksTotal: 5,
			overdueTasks: 1,
			publiclyVisible: true,
			contentApproved: true
		},
		{
			id: 'spk-12',
			name: 'Astrid Holm',
			email: 'astrid@holmdesign.dk',
			state: 'declined',
			sessions: [{ id: 'ses-18', title: 'Designing Agent Interfaces People Can Actually Trust' }],
			tasksDone: 0,
			tasksTotal: 0,
			overdueTasks: 0,
			publiclyVisible: false,
			contentApproved: false,
			note: 'Withdrew after accepting. The session stays unplaced until a replacement is chosen.'
		}
	],

	/* Marc submitted twice in this round, which is the case the count exists
	   for; Oskar submitted once and never reached the roster. */
	speakerProfiles: [
		{
			email: 'marc@a11ycraft.eu',
			headline: 'Technical writer and accessibility auditor; co-presents the docs workshop.',
			location: 'Lyon, France',
			links: [
				{
					kind: 'linkedin',
					label: 'marc-dubois-a11y',
					href: 'https://www.linkedin.com/in/marc-dubois-a11y'
				},
				{ kind: 'website', label: 'a11ycraft.eu', href: 'https://a11ycraft.eu' }
			]
		},
		{
			/* The same person as in the mid-flight scenario, so the same addresses:
			   a profile is about the person, not about the event reading it. */
			email: 'priya.nair@reviewlab.ai',
			headline: 'Researches how review committees spend attention; builds the tooling she studies.',
			location: 'Bengaluru, India',
			links: [
				{ kind: 'x', label: '@priya_reviews', href: 'https://x.com/priya_reviews' },
				{ kind: 'linkedin', label: 'priya-nair', href: 'https://www.linkedin.com/in/priya-nair' },
				{ kind: 'website', label: 'reviewlab.ai', href: 'https://reviewlab.ai' }
			]
		},
		{
			email: 'oskar@steadystate.se',
			headline: 'SRE. Talks about the boring changes that stopped the pages.',
			location: 'Malmö, Sweden',
			links: [
				{ kind: 'x', label: '@oskar_ops', href: 'https://x.com/oskar_ops' },
				{ kind: 'github', label: 'oskar-steadystate', href: 'https://github.com/oskar-steadystate' }
			]
		}
	],

	taskDefs: [
		{ id: 'task-headshot', name: 'Headshot upload', kind: 'upload', required: true, dueAbsolute: 'Aug 8, 23:59 EDT', dueRelative: '2 days overdue' },
		{ id: 'task-bio', name: 'Speaker bio', kind: 'form', required: true, dueAbsolute: 'Aug 8, 23:59 EDT', dueRelative: '2 days overdue' },
		{ id: 'task-consent', name: 'Recording consent', kind: 'confirm', required: true, dueAbsolute: 'Aug 9, 23:59 EDT', dueRelative: '1 day overdue' },
		{ id: 'task-av', name: 'AV requirements form', kind: 'form', required: true, dueAbsolute: 'Aug 15, 23:59 EDT', dueRelative: 'in 5 days' },
		{ id: 'task-slides', name: 'Slides draft', kind: 'upload', required: false, dueAbsolute: 'Oct 1, 23:59 EDT', dueRelative: 'in 52 days' }
	],
	assignments: [
		{ taskId: 'task-headshot', speakerId: 'spk-1', state: 'late-complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-1', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-1', state: 'todo', overdue: true },
		{ taskId: 'task-av', speakerId: 'spk-1', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-1', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-2', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-2', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-2', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-2', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-2', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-3', state: 'todo', overdue: true },
		{ taskId: 'task-bio', speakerId: 'spk-3', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-3', state: 'todo', overdue: true },
		{ taskId: 'task-av', speakerId: 'spk-3', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-3', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-4', state: 'todo', overdue: true },
		{ taskId: 'task-bio', speakerId: 'spk-4', state: 'todo', overdue: true },
		{ taskId: 'task-consent', speakerId: 'spk-4', state: 'todo', overdue: true },
		{ taskId: 'task-av', speakerId: 'spk-4', state: 'todo', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-4', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-5', state: 'todo', overdue: true },
		{ taskId: 'task-bio', speakerId: 'spk-5', state: 'todo', overdue: true },
		{ taskId: 'task-consent', speakerId: 'spk-5', state: 'todo', overdue: true },
		{ taskId: 'task-av', speakerId: 'spk-5', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-5', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-6', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-6', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-6', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-6', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-6', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-7', state: 'todo', overdue: true },
		{ taskId: 'task-bio', speakerId: 'spk-7', state: 'todo', overdue: true },
		{ taskId: 'task-consent', speakerId: 'spk-7', state: 'todo', overdue: true },
		{ taskId: 'task-av', speakerId: 'spk-7', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-7', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-8', state: 'todo', overdue: true },
		{ taskId: 'task-bio', speakerId: 'spk-8', state: 'late-complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-8', state: 'todo', overdue: true },
		{ taskId: 'task-av', speakerId: 'spk-8', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-8', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-10', state: 'todo', overdue: true },
		{ taskId: 'task-bio', speakerId: 'spk-10', state: 'todo', overdue: true },
		{ taskId: 'task-consent', speakerId: 'spk-10', state: 'todo', overdue: true },
		{ taskId: 'task-av', speakerId: 'spk-10', state: 'todo', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-10', state: 'complete', overdue: false },

		{ taskId: 'task-headshot', speakerId: 'spk-11', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-11', state: 'complete', overdue: false },
		{ taskId: 'task-consent', speakerId: 'spk-11', state: 'todo', overdue: true },
		{ taskId: 'task-av', speakerId: 'spk-11', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-11', state: 'complete', overdue: false }
	],

	schedule: {
		days: [
			{ key: 'day-1', label: 'Tue Oct 13' },
			{ key: 'day-2', label: 'Wed Oct 14' }
		],
		rooms: [
			{ id: 'room-main', name: 'Main Stage', capacity: 1000 },
			{ id: 'room-2a', name: 'Breakout Stage A', capacity: 240 },
			{ id: 'room-2b', name: 'Breakout Stage B', capacity: 180 },
			{ id: 'room-lab', name: 'Evals Lab', capacity: 80 }
		],
		dayStart: '09:00',
		slotMinutes: 30,
		slotsPerDay: 16,
		sessions: [
			{ id: 'ses-1', title: 'Opening Keynote: AI Engineering Beyond the Demo', speakers: [{ name: 'Ravi Chandran', email: 'ravi@keynote.example' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 60, state: 'programmed', originSubmissionIds: ['sub-312'] },
			{ id: 'ses-2', title: 'Streaming Agent UIs Without a State Machine Meltdown', speakers: [{ name: 'Deniz Kaya', email: 'deniz@ingestworks.io' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 30, state: 'programmed', originSubmissionIds: ['sub-309'] },
			{ id: 'ses-3', title: 'Typed Tool Contracts Between Agents That Never Meet', speakers: [{ name: 'Amara Okafor', email: 'amara@contractual.io' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 30, state: 'programmed', originSubmissionIds: ['sub-310'] },
			{ id: 'ses-4', title: 'Durable Agent Jobs: A Queueing Confession', speakers: [{ name: 'Daniel Kim', email: 'daniel@edgequery.dev' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed', originSubmissionIds: ['sub-311'] },
			{ id: 'ses-5', title: 'Componentizing the Agent Stack', speakers: [{ name: 'Elena Petrova', email: 'elena@sandboxworks.example' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-6', title: 'Serving 100k-Token Contexts Without Melting the App', speakers: [{ name: 'Ines Moreau', email: 'ines@gridworks.fr' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-7', title: 'Panel: Who Owns Agent Reliability?', speakers: [{ name: 'Sofia Berg', email: 'sofia@perfpanel.se' }, { name: 'Lukas Brandt', email: 'lukas@perfpanel.se' }], trackId: 'trk-web', formatId: 'fmt-panel', durationMin: 45, state: 'programmed' },
			{ id: 'ses-8', title: 'Hands-on: Reading Your Own Agent Traces', speakers: [{ name: 'Tomás Rivera', email: 'tomas@queueless.dev' }], trackId: 'trk-infra', formatId: 'fmt-workshop', durationMin: 90, state: 'programmed' },
			{ id: 'ses-9', title: 'Prompt Contracts: Versioning What You Ask the Model', speakers: [{ name: 'Priya Nair', email: 'priya.nair@reviewlab.ai' }], trackId: 'trk-ai', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-10', title: 'Provenance in Agent Interfaces', speakers: [{ name: 'Priya Nair', email: 'priya.nair@reviewlab.ai' }], trackId: 'trk-ai', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-11', title: 'Retrieval That Admits It Missed', speakers: [{ name: 'Hana Sato', email: 'hana@streamcraft.jp' }], trackId: 'trk-ai', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-12', title: 'Boring Agent Deploys: 40 Releases a Day', speakers: [{ name: 'Oskar Lind', email: 'oskar@steadystate.se' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-13', title: 'Hands-on: Writing Agent Skills That Hold Up', speakers: [{ name: 'Elif Aydın', email: 'elif@a11ycraft.eu' }, { name: 'Marc Dubois', email: 'marc@a11ycraft.eu' }], trackId: 'trk-web', formatId: 'fmt-workshop', durationMin: 90, state: 'programmed' },
			{ id: 'ses-14', title: 'Tracing an Agent Run in Anger', speakers: [{ name: 'Mikkel Sørensen', email: 'mikkel@boxfresh.dk' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-15', title: 'The Prompt Scaffold That Survived Three Model Upgrades', speakers: [{ name: 'Nora Visser', email: 'nora@tokenslab.nl' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-16', title: 'Closing Panel: Can We Ship Reliable Agents?', speakers: [{ name: 'Sofia Berg', email: 'sofia@perfpanel.se' }], trackId: 'trk-web', formatId: 'fmt-panel', durationMin: 45, state: 'programmed' },
			{ id: 'ses-17', title: 'Zero-Downtime Vector Index Changes at 40k QPS', speakers: [{ name: 'Ingrid Halvorsen', email: 'ingrid@nordicscale.no' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-18', title: 'Designing Agent Interfaces People Can Actually Trust', speakers: [{ name: 'Astrid Holm', email: 'astrid@holmdesign.dk' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			/* A slot still gathering applicants — placement is orthogonal to
			   state, so it already holds a planned block on day two while its
			   applicants stay undecided. Also another uncovered Evals &
			   Reliability scope target. */
			{ id: 'ses-19', title: 'Panel: The Eval Budget Fight', speakers: [], trackId: 'trk-ai', formatId: 'fmt-panel', durationMin: 45, state: 'collecting' }
		],
		placements: [
			{ sessionId: 'ses-1', dayKey: 'day-1', roomId: 'room-main', startMin: 0, conflicts: [] },
			{ sessionId: 'ses-2', dayKey: 'day-1', roomId: 'room-main', startMin: 90, conflicts: [] },
			{ sessionId: 'ses-3', dayKey: 'day-1', roomId: 'room-main', startMin: 120, conflicts: [] },
			{ sessionId: 'ses-7', dayKey: 'day-1', roomId: 'room-main', startMin: 180, conflicts: [] },
			{ sessionId: 'ses-4', dayKey: 'day-1', roomId: 'room-2a', startMin: 90, conflicts: [] },
			{ sessionId: 'ses-5', dayKey: 'day-1', roomId: 'room-2a', startMin: 120, conflicts: [] },
			{ sessionId: 'ses-6', dayKey: 'day-1', roomId: 'room-2b', startMin: 90, conflicts: [] },
			{
				sessionId: 'ses-8',
				dayKey: 'day-1',
				roomId: 'room-lab',
				startMin: 180,
				conflicts: [
					{ severity: 'block', reason: 'Overlaps “Hands-on: Writing Agent Skills That Hold Up” in Evals Lab' },
					{ severity: 'block', reason: 'Overlaps “Tracing an Agent Run in Anger” in Evals Lab' }
				]
			},
			{
				sessionId: 'ses-13',
				dayKey: 'day-1',
				roomId: 'room-lab',
				startMin: 210,
				conflicts: [
					{ severity: 'block', reason: 'Overlaps “Hands-on: Reading Your Own Agent Traces” in Evals Lab' },
					{ severity: 'block', reason: 'Overlaps “Tracing an Agent Run in Anger” in Evals Lab' },
					{ severity: 'warn', reason: 'Evals Lab capacity 40 is under the 88 pre-registrations from last year' }
				]
			},
			{
				sessionId: 'ses-14',
				dayKey: 'day-1',
				roomId: 'room-lab',
				startMin: 240,
				conflicts: [
					{ severity: 'block', reason: 'Overlaps “Hands-on: Reading Your Own Agent Traces” in Evals Lab' },
					{ severity: 'block', reason: 'Overlaps “Hands-on: Writing Agent Skills That Hold Up” in Evals Lab' }
				]
			},
			{
				sessionId: 'ses-9',
				dayKey: 'day-2',
				roomId: 'room-main',
				startMin: 60,
				conflicts: [{ severity: 'block', reason: 'Priya Nair is scheduled in another room at the same time' }]
			},
			{
				sessionId: 'ses-10',
				dayKey: 'day-2',
				roomId: 'room-2a',
				startMin: 60,
				conflicts: [{ severity: 'block', reason: 'Priya Nair is scheduled in another room at the same time' }]
			},
			{ sessionId: 'ses-11', dayKey: 'day-2', roomId: 'room-2b', startMin: 60, conflicts: [] },
			{ sessionId: 'ses-12', dayKey: 'day-2', roomId: 'room-main', startMin: 120, conflicts: [] },
			{ sessionId: 'ses-15', dayKey: 'day-2', roomId: 'room-2a', startMin: 120, conflicts: [] },
			{ sessionId: 'ses-17', dayKey: 'day-2', roomId: 'room-2b', startMin: 120, conflicts: [] },
			{ sessionId: 'ses-16', dayKey: 'day-2', roomId: 'room-main', startMin: 300, conflicts: [] },
			/* The collecting panel holds its block while the applicants below
			   (sub-306, sub-307) stay undecided — a held slot awaiting decisions,
			   not a scheduling problem, so no conflicts. */
			{ sessionId: 'ses-19', dayKey: 'day-2', roomId: 'room-2b', startMin: 180, conflicts: [] }
		],
		breaks: [],
		published: false
	},

	communications: [
		{
			id: 'msg-0',
			subject: 'Waitlist update — where you stand',
			audience: '21 waitlisted submitters',
			audienceCount: 21,
			state: 'held',
			purpose: 'Decision notice',
			cause: '21 submissions were waitlisted — their update is queued behind provider setup',
			causeHref: '/app/decisions',
			actor: 'you',
			heldReason: 'Outbound email is not ready — the sending domain re-verification is pending; the send stays queued and releases once setup passes.',
			deliveredCount: 0,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-1',
			subject: 'Round 2 final call — reviews close tomorrow',
			audience: 'Reviewers with open assignments',
			audienceCount: 3,
			state: 'sending',
			purpose: 'Reviewer nudge',
			cause: 'Round 2 closes tomorrow with 3 reviewers still holding open assignments',
			causeHref: '/app/reviewers',
			actor: 'you',
			deliveredCount: 1,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-2',
			subject: 'Your talk was accepted — AI Engineer NYC 2026',
			audience: '3 accepted submitters',
			audienceCount: 3,
			state: 'draft',
			purpose: 'Decision notice',
			cause: '3 submissions were marked Accepted and their submitters have not been told',
			causeHref: '/app/decisions?scope=unnotified',
			actor: 'you',
			templateId: 'tpl-decision-accepted',
			deliveredCount: 0,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-3',
			subject: 'AI Engineer NYC 2026 — decision on your submission',
			audience: '62 declined submitters',
			audienceCount: 62,
			state: 'draft',
			purpose: 'Decision notice',
			cause: '62 submissions were marked Declined and their submitters have not been told',
			causeHref: '/app/decisions?scope=unnotified',
			actor: 'you',
			templateId: 'tpl-decision-declined',
			deliveredCount: 0,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-4',
			subject: 'You are on the waitlist',
			audience: '21 waitlisted submitters',
			audienceCount: 21,
			state: 'scheduled',
			purpose: 'Decision notice',
			cause: 'Waitlist notices hold until the acceptance batch has gone out',
			causeHref: '/app/decisions',
			actor: 'you',
			templateId: 'tpl-decision-waitlisted',
			sentAt: 'Sends Aug 14, 09:00',
			deliveredCount: 0,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-5',
			subject: 'Schedule preview for announced speakers',
			audience: 'Announced speakers',
			audienceCount: 18,
			state: 'sent',
			purpose: 'Schedule announcement',
			cause: 'The draft schedule reached every announced speaker for a conflict check',
			causeHref: '/app/schedule',
			actor: 'you',
			sentAt: 'Aug 8, 11:20',
			deliveredCount: 18,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-6',
			subject: 'The CFP is closed — thank you',
			audience: 'All submitters',
			audienceCount: 283,
			state: 'sent',
			purpose: 'CFP close notice',
			cause: 'The call for proposals closed on Aug 1 — every submitter was told what happens next',
			causeHref: '/app/forms',
			actor: 'you',
			sentAt: 'Aug 1, 18:05',
			deliveredCount: 280,
			bouncedCount: 3,
			bounces: [
				{
					email: 'elena@sandboxworks.example', reason: 'Mailbox full (soft bounce ×3)',
					resendPreview: {
						subject: '[Resend] The CFP is closed — thank you',
						plainText: 'This is a resend: our system could not confirm that the first attempt arrived. If you already received this message, please disregard this copy.\n\nThe call for proposals is closed. Thank you for sharing your work; we will email you when decisions are ready.',
						warningCodes: []
					}
				},
				{
					email: 'britta@shipfast.tools', reason: 'Domain rejected the message (DMARC)',
					resendPreview: {
						subject: '[Resend] The CFP is closed — thank you',
						plainText: 'This is a resend: our system could not confirm that the first attempt arrived. If you already received this message, please disregard this copy.\n\nThe call for proposals is closed. Thank you for sharing your work; we will email you when decisions are ready.',
						warningCodes: []
					}
				},
				{
					email: 'rex@vaultmoney.xyz', reason: 'Recipient address no longer exists',
					resendPreview: {
						subject: '[Resend] The CFP is closed — thank you',
						plainText: 'This is a resend: our system could not confirm that the first attempt arrived. If you already received this message, please disregard this copy.\n\nThe call for proposals is closed. Thank you for sharing your work; we will email you when decisions are ready.',
						warningCodes: []
					}
				}
			]
		},
		{
			id: 'msg-7',
			subject: 'Reviewer briefing: round 2',
			audience: 'Round 2 reviewers',
			audienceCount: 8,
			state: 'sent',
			purpose: 'Reviewer briefing',
			cause: 'Round 2 opened with 8 reviewers assigned — drafted by the review agent, sent after your review',
			causeHref: '/app/reviewers',
			actor: 'agent',
			sentAt: 'Jul 29, 08:00',
			deliveredCount: 8,
			bouncedCount: 0,
			bounces: []
		}
	],
	threads: {
		'spk-1': [
			{
				id: 'thr-1-1',
				messageId: 'msg-5',
				at: 'Aug 8, 11:20',
				purpose: 'Schedule announcement',
				subject: 'Schedule preview for announced speakers',
				outcome: 'delivered',
				actor: 'you'
			},
			{
				id: 'thr-1-2',
				at: 'Jul 12, 09:30',
				purpose: 'Speaker invitation',
				subject: 'An invitation to speak at AI Engineer NYC 2026',
				outcome: 'delivered',
				actor: 'you'
			}
		],
		'spk-2': [
			{
				id: 'thr-2-1',
				messageId: 'msg-5',
				at: 'Aug 8, 11:20',
				purpose: 'Schedule announcement',
				subject: 'Schedule preview for announced speakers',
				outcome: 'delivered',
				actor: 'you'
			}
		],
		/* Elena's note says three reminders went out; her copy of the CFP close
		   notice is one of the three bounces on that send. */
		'spk-4': [
			{
				id: 'thr-4-1',
				at: 'Aug 9, 09:00',
				purpose: 'Task reminder',
				subject: 'A nudge on your headshot upload',
				outcome: 'delivered',
				actor: 'policy'
			},
			{
				id: 'thr-4-2',
				at: 'Aug 4, 09:00',
				purpose: 'Task reminder',
				subject: 'A nudge on your speaker bio',
				outcome: 'delivered',
				actor: 'policy'
			},
			{
				id: 'thr-4-3',
				messageId: 'msg-6',
				at: 'Aug 1, 18:05',
				purpose: 'CFP close notice',
				subject: 'The CFP is closed — thank you',
				outcome: 'bounced',
				actor: 'you'
			},
			{
				id: 'thr-4-4',
				at: 'Jul 30, 09:00',
				purpose: 'Task reminder',
				subject: 'A nudge on your headshot upload',
				outcome: 'delivered',
				actor: 'policy'
			}
		]
	},
	readiness: { provider: 'Resend', outbound: 'ready', callbacks: 'ready', inbound: 'ready' },

	// The acceptance template has already been through one agent pass here,
	// tuned against this scenario's notify-by deadline.
	templates: withAgentRevision(
		starterTemplates(),
		'decision-accepted',
		'Tightened for the notify-by deadline',
		'2 h ago'
	),
	surfaces: starterSurfaceTemplates('AI Engineer NYC 2026'),
	fieldRegistry: baselineFieldRegistry(),
	theme: defaultEventTheme('AI Engineer NYC 2026'),

	forms: [
		{ id: 'form-cfp', name: 'Call for Proposals', target: { kind: 'general' }, status: 'closed', version: 4, submissionCount: 14 },
		{
			id: 'form-late',
			name: 'Late submission request',
			target: { kind: 'general' },
			status: 'open',
			closesAt: closesInDays(2),
			version: 1,
			submissionCount: 17,
			/* A late ask is a lighter ask: identity, contact, and the talk itself. */
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
			version: 2,
			submissionCount: 44,
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
		venueNote: 'New York venue — Main Stage, Breakout Stage A, Breakout Stage B, Evals Lab. Load-in from 07:00.'
	},
	members: [
		{ id: 'mem-1', name: 'Jere K.', email: 'jere@aie-demo.example', role: 'Workspace Admin', status: 'active' },
		{ id: 'mem-2', name: 'Sofia Berg', email: 'sofia@perfpanel.se', role: 'Event Manager', status: 'active' },
		{ id: 'mem-3', name: 'Jonas Weber', email: 'jonas.weber@metricsense.de', role: 'Speaker Reviewer', status: 'active' },
		{ id: 'mem-4', name: 'Linnea Koski', email: 'linnea@aie-demo.example', role: 'Speaker Manager', status: 'active' },
		{ id: 'mem-5', name: 'Ines Moreau', email: 'ines@gridworks.fr', role: 'Speaker Reviewer', status: 'active' },
		{ id: 'mem-6', name: 'Oskar Lind', email: 'oskar@steadystate.se', role: 'Speaker Reviewer', status: 'active' },
		// Signed in to help with the review backlog; no assignments until
		// approved — and no reviewer record either, so the roster stays honest.
		{ id: 'mem-7', name: 'Mira Solberg', email: 'mira.solberg@aie-demo.example', role: 'Speaker Reviewer', status: 'pending_review' },
		{ id: 'mem-8', name: 'Priya Nair', email: 'priya.nair@reviewlab.ai', role: 'Speaker Reviewer', status: 'active' },
		{ id: 'mem-9', name: 'Tomás Rivera', email: 'tomas@queueless.dev', role: 'Speaker Reviewer', status: 'active' },
		{ id: 'mem-10', name: 'Elif Aydın', email: 'elif@a11ycraft.eu', role: 'Speaker Reviewer', status: 'active' },
		{ id: 'mem-11', name: 'Marc Dubois', email: 'marc@a11ycraft.eu', role: 'Speaker Reviewer', status: 'active' }
	]
};

export default crunch;
