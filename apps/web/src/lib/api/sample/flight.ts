import type { WorkspaceDataset } from './dataset';
import { closesInDays } from './dataset';
import { defaultEventTheme, starterSurfaceTemplates, starterTemplates } from './templates';
import { baselineFieldRegistry } from './fields';

/**
 * Baseline scenario: mid-flight event. CFP still open, review round 1 running,
 * first decisions made, schedule half built with blocking conflicts.
 */
const flight: WorkspaceDataset = {
	key: 'flight',
	name: 'Mid-flight',
	description: 'CFP open, review running, decisions started, schedule half built.',

	summary: {
		event: {
			id: 'evt_aie-nyc-2026',
			name: 'AI Engineer NYC 2026',
			dates: 'Oct 12–14, 2026',
			location: 'New York City',
			timezone: 'America/New_York',
			phase: 'CFP open · Review round 1 running',
			today: 'Monday, August 10'
		},
		lockedAreas: [],
		navCounts: {
			submissions: '223',
			review: '62%',
			decisions: { value: '12', tone: 'warning' },
			speakers: '24',
			reviewers: '6',
			tasks: { value: '14', tone: 'warning' },
			schedule: { value: '2', tone: 'danger' },
			messages: '2'
		},
		stats: [
			{ label: 'Submissions', value: '223', sub: '+18 this week' },
			{ label: 'Round 1 reviews', value: '62%', sub: '224 of 360 committed' },
			{ label: 'Accepted', value: '24', sub: '12 not yet notified', tone: 'attention' },
			{ label: 'CFP closes', value: '12 days', sub: 'Aug 22, 23:59 EDT' }
		],
		attention: [
			{
				id: 'cancel-request',
				severity: 'now',
				area: 'speakers',
				title: 'Cancellation request from Maya Lindqvist',
				detail: '“Context Caching Without Tears” · requested 2 h ago. Nothing has been sent or changed yet.',
				action: 'Review request',
				href: '/app/speakers?filter=attention'
			},
			{
				id: 'unnotified',
				severity: 'now',
				area: 'decisions',
				title: '12 accepted submissions not yet notified',
				detail: 'Oldest decision is 6 days old. Notification is a separate, deliberate send.',
				action: 'Compose notifications',
				href: '/app/decisions?scope=unnotified'
			},
			{
				id: 'conflicts',
				severity: 'soon',
				area: 'schedule',
				title: '2 blocking conflicts on the schedule',
				detail: 'Publishing stays blocked while blocking conflicts exist.',
				action: 'Open conflicts',
				href: '/app/schedule?panel=conflicts'
			},
			{
				id: 'overdue-tasks',
				severity: 'soon',
				area: 'tasks',
				title: '14 speaker tasks overdue',
				detail: 'Across 6 speakers — mostly headshots and AV forms.',
				action: 'Filter overdue',
				href: '/app/tasks?filter=overdue'
			},
			{
				id: 'needs-reviewer',
				severity: 'soon',
				area: 'review',
				// The 3 is the sum of `awaitingReassignment` across this plan's
				// reviewers, which is what the roster badges add up to.
				title: '3 reviews need another reviewer',
				detail: 'Their reviewer stepped back over a conflict of interest and nobody has picked them up.',
				action: 'Reassign'
			},
			{
				id: 'bounced',
				severity: 'fyi',
				area: 'messages',
				title: '2 emails bounced',
				detail: 'Addresses need correcting before the next send.',
				action: 'Open communications'
			},
			{
				id: 'import-items',
				severity: 'fyi',
				area: 'submissions',
				title: '4 unresolved import items',
				detail: 'From “speakers-2025.xlsx” — two room names and one possible duplicate.',
				action: 'Resolve items'
			}
		],
		pipeline: [
			/* Collect has no denominator — nobody knows how many will submit — so
			   it carries a pace against the CFP close but never a meter. */
			{
				key: 'collect',
				label: 'Collect',
				headline: '223',
				sub: 'CFP open · closes in 12 days',
				state: 'ok',
				paceTone: 'on',
				deadlineLabel: 'CFP closes in 12 days',
				deadlineIso: '2026-08-22T23:59:00-04:00'
			},
			{ key: 'triage', label: 'Triage', headline: '128', sub: 'inbox · 73 set aside · 13 late', state: 'ok' },
			{
				key: 'review',
				label: 'Review',
				headline: '62%',
				sub: '224 of 360 · due in 18 days',
				state: 'attention',
				progress: { done: 224, required: 360 },
				paceTone: 'on',
				deadlineLabel: 'due Aug 28',
				deadlineIso: '2026-08-28T23:59:00-04:00'
			},
			/* 61 decided of the 223 collected; decisions have no committed
			   notify-by date in this scenario, so no pace claim is made. */
			{
				key: 'decide',
				label: 'Decide',
				headline: '61',
				sub: '24 accepted · 12 un-notified',
				state: 'attention',
				progress: { done: 61, required: 223 }
			},
			/* No stated speaker-roster target, so no meter; the 14 overdue
			   required tasks put the stage behind its content deadline. */
			{
				key: 'speakers',
				label: 'Speakers',
				headline: '21',
				sub: 'confirmed · 14 tasks overdue',
				state: 'attention',
				paceTone: 'behind',
				deadlineLabel: 'content due Sep 11',
				deadlineIso: '2026-09-11T23:59:00-04:00'
			},
			{
				key: 'schedule',
				label: 'Schedule',
				headline: '16/27',
				sub: 'placed · 2 blocking conflicts',
				state: 'blocked',
				progress: { done: 16, required: 27 },
				paceTone: 'behind',
				deadlineLabel: 'publish target Sep 25',
				deadlineIso: '2026-09-25'
			},
			{ key: 'comms', label: 'Comms', headline: '18', sub: 'sent today · 2 bounced', state: 'ok' }
		],
		deadlines: [
			{ label: 'CFP closes', absolute: 'Aug 22, 23:59 EDT', relative: 'in 12 days', tone: 'ok' },
			{ label: 'Review round 1 due', absolute: 'Aug 28, 23:59 EDT', relative: 'in 18 days', tone: 'ok' },
			{ label: 'Speaker content due', absolute: 'Sep 11, 23:59 EDT', relative: 'in 32 days', tone: 'ok' },
			{ label: 'Schedule publish target', absolute: 'Sep 25', relative: 'in 46 days · blocked by 2 conflicts', tone: 'blocked' }
		],
		activity: [
			{
				id: 'act-1',
				actor: 'agent',
				name: 'Triage run #4',
				text: 'finished screening 41 new submissions — 12 set aside as off-topic',
				time: '8 min ago'
			},
			{ id: 'act-2', actor: 'person', name: 'Sofia Berg', text: 'committed 6 reviews in Round 1', time: '24 min ago' },
			{
				id: 'act-3',
				actor: 'agent',
				name: 'Schedule import',
				text: 'draft ready for review — 2 unresolved room names (“Main Stage B”, “Workshop annex”) and one session naming a speaker who has not confirmed yet',
				time: '1 h ago'
			},
			{ id: 'act-4', actor: 'person', name: 'Jonas Weber', text: 'accepted 3 submissions', time: '2 h ago' },
			{ id: 'act-5', actor: 'you', name: 'You', text: 'sent “Speaker onboarding” to 18 recipients', time: 'yesterday' }
		],
		trays: [
			{ kind: 'late', label: 'Late submissions', count: 13, href: '/app/submissions?tray=late' },
			{ kind: 'discarded', label: 'Discarded, recoverable', count: 9, href: '/app/submissions?tray=discarded' },
			{ kind: 'unresolved-import', label: 'Unresolved import items', count: 4 },
			{ kind: 'stranded-drafts', label: 'Stranded form drafts', count: 3 },
			{ kind: 'inbound-mail', label: 'Inbound mail review', count: 2 },
			{ kind: 'bounced', label: 'Bounced recipients', count: 2, href: '/app/messages' }
		]
	},

	tracks: [
		{ id: 'trk-web', name: 'Agents & Tools', accent: 'sea' },
		{ id: 'trk-ai', name: 'Evals & Reliability', accent: 'lavender' },
		{ id: 'trk-infra', name: 'Models & Infrastructure', accent: 'neutral' }
	],
	formats: [
		{ id: 'fmt-talk', name: 'Talk · 30 min', defaultDurationMin: 30 },
		{ id: 'fmt-workshop', name: 'Workshop · 90 min', defaultDurationMin: 90 },
		{ id: 'fmt-panel', name: 'Panel · 45 min', defaultDurationMin: 45 }
	],

	submissions: [
		{
			id: 'sub-101',
			title: 'Context Caching Without Tears',
			abstract:
				'A field guide to prompt and prefix caching: production hit-rate traces, the invalidation mistakes that cost us, and the harness we use to test changes.',
			speakers: [{ name: 'Maya Lindqvist', email: 'maya@nordicweb.dev' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: 'Jul 2',
			source: 'cfp',
			tray: 'inbox',
			decision: 'accepted',
			notified: true,
			signals: [
				{ key: 'relevance', label: 'On-topic 0.94', family: 'quality', score: 0.94, rationale: 'Abstract cites concrete production invalidation graphs and tooling.', source: 'Screen run #2' },
				{ key: 'prior', label: 'Prior speaker', family: 'draw', rationale: 'Spoke at two prior editions; strong attendee ratings.', source: 'History' }
			],
			resources: [
				{ name: 'edge-caching-draft-slides.pdf', kind: 'slides', detail: 'PDF · 4.2 MB' },
				{ name: 'Invalidation-graph tooling (repository)', kind: 'link', detail: 'codeberg.org' }
			],
			reviewAverage: 4.6,
			reviewCount: 3
		},
		{
			id: 'sub-102',
			title: 'Typed Tool Contracts Between Agents That Never Meet',
			abstract:
				'How we made tool-calling agents coordinate through schema-first contracts, what broke, and the failure that forced us back to single-writer discipline.',
			speakers: [{ name: 'Amara Okafor', email: 'amara@contractual.io' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: 'Jul 8',
			source: 'cfp',
			tray: 'inbox',
			decision: 'accepted',
			notified: false,
			signals: [
				{ key: 'relevance', label: 'On-topic 0.88', family: 'quality', score: 0.88, rationale: 'Concrete migration narrative with named tooling.', source: 'Screen run #2' }
			],
			reviewAverage: 4.4,
			reviewCount: 3
		},
		{
			id: 'sub-103',
			title: 'LLM Review Queues: Allocating Human Attention',
			abstract:
				'Designing reviewer workflows where models rank and cluster but humans decide. Covers anti-anchoring, provenance display, and measured reviewer throughput changes.',
			speakers: [{ name: 'Priya Nair', email: 'priya.nair@reviewlab.ai' }],
			trackId: 'trk-ai',
			formatId: 'fmt-talk',
			submittedAt: 'Jul 11',
			source: 'cfp',
			tray: 'inbox',
			decision: 'accepted',
			notified: false,
			signals: [
				{ key: 'relevance', label: 'On-topic 0.91', family: 'quality', score: 0.91, rationale: 'Directly addresses review-tooling track themes with measurements.', source: 'Screen run #2' }
			],
			resources: [
				{ name: 'Conference talk recording — earlier version', kind: 'video', detail: '28 min · peertube.tv' },
				{ name: 'reviewer-throughput-study.pdf', kind: 'document', detail: 'PDF · 1.1 MB' }
			],
			reviewAverage: 4.2,
			reviewCount: 3
		},
		{
			id: 'sub-104',
			title: 'Durable Agent Jobs: A Queueing Confession',
			abstract:
				'We ran long-lived agent jobs on a home-grown queue for three years. What worked, what melted, and the durable handoff pattern that finally fixed it.',
			speakers: [{ name: 'Tomás Rivera', email: 'tomas@queueless.dev' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: 'Jul 15',
			source: 'cfp',
			targetSessionId: 'ses-11',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [
				{ key: 'relevance', label: 'On-topic 0.86', family: 'quality', score: 0.86, rationale: 'War story with a clear architectural takeaway.', source: 'Screen run #3' }
			],
			resources: [{ name: 'Lightning-talk cut of this story', kind: 'video', detail: '9 min · makertube.net' }],
			reviewAverage: 4.1,
			reviewCount: 2
		},
		{
			id: 'sub-105',
			title: 'Hands-on: AI Interface Audits That Stick',
			abstract:
				'A 90-minute workshop auditing streamed agent interfaces for accessibility, uncertainty, interruption, and keyboard control, then turning findings into fixes.',
			speakers: [
				{ name: 'Elif Aydın', email: 'elif@a11ycraft.eu' },
				{ name: 'Marc Dubois', email: 'marc@a11ycraft.eu' }
			],
			trackId: 'trk-web',
			formatId: 'fmt-workshop',
			submittedAt: 'Jul 18',
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [
				{ key: 'equipment', label: 'Needs AV check', family: 'integrity', rationale: 'Workshop requests attendee laptops and a second projector.', source: 'Form answers' }
			],
			resources: [
				{ name: 'workshop-outline-and-setup.pdf', kind: 'document', detail: 'PDF · 640 KB' },
				{ name: 'audit-starter-kit (repository)', kind: 'link', detail: 'codeberg.org' }
			],
			reviewAverage: 3.9,
			reviewCount: 2
		},
		{
			id: 'sub-106',
			title: 'The Inference Bill Nobody Read',
			abstract:
				'Cutting a seven-figure inference bill by routing work across model profiles, tightening context budgets, and deleting calls nobody could justify.',
			speakers: [{ name: 'Jonas Weber', email: 'jonas.weber@metricsense.de' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: 'Jul 20',
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			reviewAverage: 3.7,
			reviewCount: 2
		},
		{
			id: 'sub-107',
			title: 'Streaming Agent UIs Without a State Machine Meltdown',
			abstract:
				'Patterns for token-streaming interfaces that stay debuggable: optimistic ghosts, deterministic reducers, and replayable sessions.',
			speakers: [{ name: 'Hana Sato', email: 'hana@streamcraft.jp' }],
			trackId: 'trk-ai',
			formatId: 'fmt-talk',
			submittedAt: 'Jul 24',
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [
				{ key: 'relevance', label: 'On-topic 0.83', family: 'quality', score: 0.83, rationale: 'Framework-agnostic patterns matching the AI-UX sub-theme.', source: 'Screen run #3' }
			],
			reviewCount: 1
		},
		{
			id: 'sub-108',
			title: 'Zero-Downtime Vector Index Changes at 40k QPS',
			abstract:
				'Re-embedding and switching vector indexes without dropping retrieval traffic: the checklist, the shadow reads, and the two incidents that shaped the rollout.',
			speakers: [{ name: 'Ingrid Halvorsen', email: 'ingrid@nordicscale.no' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: 'Aug 6',
			source: 'cfp',
			targetSessionId: 'ses-11',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			reviewCount: 0
		},
		{
			id: 'sub-109',
			title: 'Grow Your SaaS 10x With AI Growth Hacking',
			abstract:
				'Learn the secret growth loops top founders use. My agency has helped 200+ companies explode their MRR with AI-powered funnels.',
			speakers: [{ name: 'Chad Maxwell', email: 'chad@growthblast.biz' }],
			trackId: 'trk-ai',
			formatId: 'fmt-talk',
			submittedAt: 'Aug 1',
			source: 'cfp',
			tray: 'set-aside',
			setAsideBy: 'Screen run #4',
			decision: 'undecided',
			notified: false,
			signals: [
				{ key: 'pitch', label: 'Product pitch 0.92', family: 'integrity', score: 0.92, rationale: '“My agency has helped 200+ companies” — promotional framing, no technical content.', source: 'Screen run #4' }
			],
			reviewCount: 0
		},
		{
			id: 'sub-110',
			title: 'Ship Faster With Our DevEx Platform',
			abstract:
				'A walkthrough of how our platform eliminates toil for engineering teams. Live demo of our newest features and pricing tiers.',
			speakers: [{ name: 'Britta Klein', email: 'britta@shipfast.tools' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: 'Aug 3',
			source: 'cfp',
			tray: 'set-aside',
			setAsideBy: 'Screen run #4',
			decision: 'undecided',
			notified: false,
			signals: [
				{ key: 'pitch', label: 'Product pitch 0.88', family: 'integrity', score: 0.88, rationale: 'Vendor demo with pricing; no transferable technique.', source: 'Screen run #4' }
			],
			reviewCount: 0
		},
		{
			id: 'sub-111',
			title: 'Sandboxing Tool Calls: What We Learned in Production',
			abstract:
				'Arrived after our screening pass: a detailed production log comparing container isolation, tool-call startup latency, and capability checks.',
			speakers: [{ name: 'Deniz Kaya', email: 'deniz@ingestworks.io' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: 'Aug 9',
			source: 'cfp',
			tray: 'late',
			decision: 'undecided',
			notified: false,
			signals: [],
			reviewCount: 0
		},
		{
			id: 'sub-112',
			title: 'Panel: Who Owns Agent Reliability?',
			abstract:
				'Invited panel pairing model, product, and platform leads to argue about eval budgets, incident ownership, and what actually improved reliability.',
			speakers: [
				{ name: 'Sofia Berg', email: 'sofia@perfpanel.se' },
				{ name: 'Lukas Brandt', email: 'lukas@perfpanel.se' }
			],
			trackId: 'trk-web',
			formatId: 'fmt-panel',
			submittedAt: 'Jun 20',
			source: 'direct_entry',
			enteredBy: 'Linnea Koski',
			tray: 'inbox',
			decision: 'accepted',
			notified: true,
			signals: [],
			reviewCount: 0
		},
		{
			id: 'sub-113',
			title: 'Crypto Wealth Secrets 2026',
			abstract: 'Make passive income while you sleep!!! Limited spots for my masterclass.',
			speakers: [{ name: 'Rex Vault', email: 'rex@vaultmoney.xyz' }],
			trackId: 'trk-ai',
			formatId: 'fmt-talk',
			submittedAt: 'Jul 30',
			source: 'cfp',
			tray: 'discarded',
			decision: 'declined',
			notified: true,
			signals: [
				{ key: 'spam', label: 'Spam 0.97', family: 'integrity', score: 0.97, rationale: 'Off-topic financial promotion; disposable sender domain.', source: 'Arrival checks' }
			],
			reviewCount: 0,
			appealCount: 1
		},
		{
			id: 'sub-114',
			title: 'Evaluation Rubrics as a Product API',
			abstract:
				'Treating evaluation criteria as a versioned product contract: calibration, deprecation, and rubric migrations we shipped without breaking historical comparisons.',
			speakers: [{ name: 'Nora Visser', email: 'nora@tokenslab.nl' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: 'Jul 27',
			source: 'cfp',
			tray: 'inbox',
			decision: 'waitlisted',
			notified: false,
			signals: [
				{ key: 'dup', label: 'Similar to #87', family: 'quality', rationale: 'Overlaps an earlier token-governance submission; clustered for comparison.', source: 'Duplicate clustering' }
			],
			reviewAverage: 3.8,
			reviewCount: 3
		}
	],
	submissionTrayTotals: { inbox: 128, 'set-aside': 73, late: 13, discarded: 9 },

	reviewPlans: [
		{
			id: 'plan-r1',
			name: 'Round 1 · all tracks',
			scaleMax: 5,
			deadlineRelative: 'due in 18 days',
			anonymized: true,
			done: 224,
			total: 360,
			antiAnchoring: true,
			// Roster ids are member ids: one identity keys this row, the
			// reviewers roster, and Settings. The rows sum to the plan's own
			// done (224) and total (360) — the meter and the roster tell one
			// story. Priya Nair is invited but has not arrived, so she holds
			// no row yet.
			reviewers: [
				{ id: 'mem-2', name: 'Sofia Berg', assigned: 72, done: 68, steppedBack: 0, awaitingReassignment: 0 },
				{ id: 'mem-3', name: 'Jonas Weber', assigned: 72, done: 55, steppedBack: 1, awaitingReassignment: 1 },
				{ id: 'mem-6', name: 'Tomás Rivera', assigned: 72, done: 46, steppedBack: 0, awaitingReassignment: 0 },
				{ id: 'mem-7', name: 'Elif Aydın', assigned: 72, done: 30, steppedBack: 2, awaitingReassignment: 2 },
				{ id: 'mem-8', name: 'Marc Dubois', assigned: 72, done: 25, steppedBack: 0, awaitingReassignment: 0 }
			]
		}
	],
	/* Two generalists carry everything; the rest hold typed refs to records
	   that exist — a track, a format, a still-collecting session. Priya was
	   invited with an initial scope and appears here and in the members list
	   under the same id, because a reviewer is a member. */
	reviewers: [
		{ id: 'mem-2', name: 'Sofia Berg', email: 'sofia@perfpanel.se', status: 'active', scope: [] },
		{
			id: 'mem-3',
			name: 'Jonas Weber',
			email: 'jonas.weber@metricsense.de',
			status: 'active',
			scope: [{ kind: 'track', id: 'trk-infra' }]
		},
		{
			id: 'mem-6',
			name: 'Tomás Rivera',
			email: 'tomas@queueless.dev',
			status: 'active',
			/* A union: infrastructure submissions plus everyone applying to
			   the collecting panel. */
			scope: [
				{ kind: 'track', id: 'trk-infra' },
				{ kind: 'session', id: 'ses-11' }
			]
		},
		{
			id: 'mem-7',
			name: 'Elif Aydın',
			email: 'elif@a11ycraft.eu',
			status: 'active',
			scope: [{ kind: 'format', id: 'fmt-workshop' }]
		},
		{ id: 'mem-8', name: 'Marc Dubois', email: 'marc@a11ycraft.eu', status: 'active', scope: [] },
		{
			id: 'mem-5',
			name: 'Priya Nair',
			email: 'priya.nair@reviewlab.ai',
			status: 'invited',
			scope: [{ kind: 'track', id: 'trk-ai' }]
		}
	],
	myQueue: [
		{ submissionId: 'sub-104', committed: true, myScore: 4, myComment: 'Strong war story; verify the outbox section fits 30 minutes.', peerScores: [4, 4] },
		{ submissionId: 'sub-105', committed: false },
		{ submissionId: 'sub-106', committed: false },
		{ submissionId: 'sub-107', committed: false, myScore: 3 }
	],
	/* Round 1 is mid-flight, so each track carries only what has actually been
	   scored: the web track is far enough along to rank inside, infrastructure
	   is behind it, and Evals & Reliability has too few scored submissions for any
	   percentile claim to be honest yet. */
	reviewDistributions: {
		'trk-web': [
			2.1, 2.4, 2.6, 2.7, 2.9, 3.0, 3.0, 3.1, 3.2, 3.2, 3.3, 3.3, 3.4, 3.4, 3.5, 3.5, 3.5, 3.6,
			3.6, 3.6, 3.7, 3.7, 3.7, 3.8, 3.8, 3.8, 3.9, 3.9, 3.9, 4.0, 4.0, 4.0, 4.1, 4.1, 4.2, 4.2,
			4.3, 4.3, 4.4, 4.4, 4.5, 4.5, 4.6, 4.7, 4.8, 4.9
		],
		'trk-infra': [
			2.3, 2.6, 2.8, 3.0, 3.1, 3.2, 3.3, 3.4, 3.5, 3.5, 3.6, 3.7, 3.7, 3.8, 3.9, 3.9, 4.0, 4.1,
			4.2, 4.3, 4.4, 4.5, 4.6, 4.8
		],
		'trk-ai': [2.9, 3.3, 3.6, 3.8, 4.0, 4.2, 4.5]
	},

	/* The public roster's groups, in the order they appear on the page. Mid-flight
	   is where an event first needs them: the keynote has to lead, and the panel
	   reads as one thing rather than as two loose names. */
	speakerCategories: [
		{ id: 'spkcat-keynote', name: 'Keynotes', accent: 'lavender' },
		{ id: 'spkcat-talk', name: 'Talks', accent: 'sea' },
		{ id: 'spkcat-panel', name: 'Panel', accent: 'neutral' }
	],

	/* Listed in public order: the lineup is the sequence of this array, and the
	   API materializes it into positions the drag path can move. */
	speakers: [
		{
			id: 'spk-1',
			name: 'Maya Lindqvist',
			email: 'maya@nordicweb.dev',
			state: 'cancel_requested',
			sessions: [{ id: 'ses-2', title: 'Context Caching Without Tears' }],
			tasksDone: 3,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true,
			categoryId: 'spkcat-talk',
			note: 'Requested cancellation 2 h ago — client emergency. Wants a call before anything is announced.'
		},
		{
			id: 'spk-2',
			name: 'Amara Okafor',
			email: 'amara@contractual.io',
			state: 'invited',
			sessions: [{ id: 'ses-7', title: 'Typed Tool Contracts Between Agents That Never Meet' }],
			tasksDone: 0,
			tasksTotal: 0,
			overdueTasks: 0,
			publiclyVisible: false,
			contentApproved: false,
			categoryId: 'spkcat-talk'
		},
		{
			id: 'spk-3',
			name: 'Priya Nair',
			email: 'priya.nair@reviewlab.ai',
			state: 'invited',
			sessions: [{ id: 'ses-8', title: 'LLM Review Queues: Allocating Human Attention' }],
			tasksDone: 0,
			tasksTotal: 0,
			overdueTasks: 0,
			publiclyVisible: false,
			contentApproved: false,
			categoryId: 'spkcat-talk'
		},
		{
			id: 'spk-4',
			name: 'Sofia Berg',
			email: 'sofia@perfpanel.se',
			state: 'confirmed',
			sessions: [{ id: 'ses-3', title: 'Panel: Who Owns Agent Reliability?' }],
			tasksDone: 5,
			tasksTotal: 5,
			overdueTasks: 0,
			publiclyVisible: true,
			contentApproved: true,
			categoryId: 'spkcat-panel'
		},
		{
			id: 'spk-5',
			name: 'Lukas Brandt',
			email: 'lukas@perfpanel.se',
			state: 'confirmed',
			sessions: [{ id: 'ses-3', title: 'Panel: Who Owns Agent Reliability?' }],
			tasksDone: 2,
			tasksTotal: 5,
			overdueTasks: 2,
			publiclyVisible: false,
			contentApproved: false,
			categoryId: 'spkcat-panel'
		},
		{
			id: 'spk-6',
			name: 'Ravi Chandran',
			email: 'ravi@keynote.example',
			state: 'confirmed',
			sessions: [{ id: 'ses-1', title: 'Opening Keynote: AI Engineering Beyond the Demo' }],
			tasksDone: 3,
			tasksTotal: 5,
			overdueTasks: 1,
			publiclyVisible: true,
			contentApproved: false,
			categoryId: 'spkcat-keynote',
			note: 'Keynote — headshot still pending approval; page shows “to be announced” styling until approved.'
		},
		{
			id: 'spk-7',
			name: 'Elena Petrova',
			email: 'elena@sandboxworks.example',
			state: 'confirmed',
			sessions: [{ id: 'ses-4', title: 'Componentizing the Agent Stack' }],
			tasksDone: 1,
			tasksTotal: 5,
			overdueTasks: 3,
			publiclyVisible: false,
			contentApproved: false,
			categoryId: 'spkcat-talk'
		},
		{
			id: 'spk-8',
			name: 'Daniel Kim',
			email: 'daniel@edgequery.dev',
			state: 'confirmed',
			sessions: [{ id: 'ses-5', title: 'Running Small Models at the Edge' }],
			tasksDone: 2,
			tasksTotal: 5,
			overdueTasks: 2,
			publiclyVisible: true,
			contentApproved: true,
			categoryId: 'spkcat-talk'
		},
		{
			id: 'spk-9',
			name: 'Astrid Holm',
			email: 'astrid@holmdesign.dk',
			state: 'declined',
			sessions: [],
			tasksDone: 0,
			tasksTotal: 0,
			overdueTasks: 0,
			publiclyVisible: false,
			contentApproved: false,
			note: 'Declined the invitation — scheduling clash. Slot returned to the pool.'
		}
	],

	/* Some submitters have a profile and most do not, which is the state a real
	   CFP is in: two of these people are on the roster and carry sessions with
	   them, two only ever submitted. */
	speakerProfiles: [
		{
			email: 'maya@nordicweb.dev',
			headline: 'Platform engineer working on CDN invalidation and cache correctness.',
			location: 'Stockholm, Sweden',
			/* Which networks a person is on is uneven in life and uneven here: one
			   profile carries four addresses, another only the one it was written
			   from. A row that is always the same length would be a fiction. */
			links: [
				{ kind: 'x', label: '@maya_lindqvist', href: 'https://x.com/maya_lindqvist' },
				{
					kind: 'linkedin',
					label: 'maya-lindqvist',
					href: 'https://www.linkedin.com/in/maya-lindqvist'
				},
				{ kind: 'website', label: 'nordicweb.dev', href: 'https://nordicweb.dev' },
				{ kind: 'other', label: 'Talks archive', href: 'https://nordicweb.dev/talks' }
			]
		},
		{
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
			email: 'sofia@perfpanel.se',
			headline: 'AI product performance lead; three years of panel moderation at this event.',
			location: 'Gothenburg, Sweden',
			links: [
				{ kind: 'linkedin', label: 'sofia-berg', href: 'https://www.linkedin.com/in/sofia-berg' }
			]
		},
		{
			email: 'tomas@queueless.dev',
			headline: 'Agent infrastructure engineer with an unhealthy attachment to durable queues.',
			location: 'Lisbon, Portugal',
			links: [
				{ kind: 'github', label: 'tomasrivera', href: 'https://github.com/tomasrivera' },
				{ kind: 'website', label: 'queueless.dev', href: 'https://queueless.dev' }
			]
		},
		{
			email: 'elif@a11ycraft.eu',
			headline: 'Accessibility consultant; runs audit workshops for product teams.',
			location: 'Istanbul, Türkiye',
			links: [
				{ kind: 'x', label: '@elif_a11y', href: 'https://x.com/elif_a11y' },
				{ kind: 'website', label: 'a11ycraft.eu', href: 'https://a11ycraft.eu' }
			]
		},
		{
			email: 'jonas.weber@metricsense.de',
			headline: 'Observability architect. Writes about what telemetry actually costs.',
			location: 'Berlin, Germany',
			links: [
				{ kind: 'website', label: 'metricsense.de', href: 'https://metricsense.de' },
				{ kind: 'other', label: 'Cost notes', href: 'https://metricsense.de/notes' }
			]
		}
	],

	taskDefs: [
		{ id: 'task-headshot', name: 'Headshot upload', kind: 'upload', required: true, dueAbsolute: 'Sep 11, 23:59 EDT', dueRelative: 'in 32 days' },
		{ id: 'task-bio', name: 'Speaker bio', kind: 'form', required: true, dueAbsolute: 'Sep 11, 23:59 EDT', dueRelative: 'in 32 days' },
		{ id: 'task-av', name: 'AV requirements form', kind: 'form', required: true, dueAbsolute: 'Aug 8, 23:59 EDT', dueRelative: '2 days overdue' },
		{ id: 'task-travel', name: 'Confirm travel details', kind: 'confirm', required: true, dueAbsolute: 'Sep 18, 23:59 EDT', dueRelative: 'in 39 days' },
		{ id: 'task-slides', name: 'Slides draft', kind: 'upload', required: false, dueAbsolute: 'Oct 1, 23:59 EDT', dueRelative: 'in 52 days' }
	],
	assignments: [
		{ taskId: 'task-headshot', speakerId: 'spk-1', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-1', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-1', state: 'complete', overdue: false },
		{ taskId: 'task-travel', speakerId: 'spk-1', state: 'todo', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-1', state: 'todo', overdue: false },
		{ taskId: 'task-headshot', speakerId: 'spk-4', state: 'complete', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-4', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-4', state: 'complete', overdue: false },
		{ taskId: 'task-travel', speakerId: 'spk-4', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-4', state: 'complete', overdue: false },
		{ taskId: 'task-headshot', speakerId: 'spk-5', state: 'todo', overdue: true },
		{ taskId: 'task-bio', speakerId: 'spk-5', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-5', state: 'todo', overdue: true },
		{ taskId: 'task-travel', speakerId: 'spk-5', state: 'todo', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-5', state: 'complete', overdue: false },
		{ taskId: 'task-headshot', speakerId: 'spk-6', state: 'received', overdue: false },
		{ taskId: 'task-bio', speakerId: 'spk-6', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-6', state: 'todo', overdue: true },
		{ taskId: 'task-travel', speakerId: 'spk-6', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-6', state: 'complete', overdue: false },
		{ taskId: 'task-headshot', speakerId: 'spk-7', state: 'todo', overdue: true },
		{ taskId: 'task-bio', speakerId: 'spk-7', state: 'todo', overdue: true },
		{ taskId: 'task-av', speakerId: 'spk-7', state: 'todo', overdue: true },
		{ taskId: 'task-travel', speakerId: 'spk-7', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-7', state: 'todo', overdue: false },
		{ taskId: 'task-headshot', speakerId: 'spk-8', state: 'todo', overdue: true },
		{ taskId: 'task-bio', speakerId: 'spk-8', state: 'complete', overdue: false },
		{ taskId: 'task-av', speakerId: 'spk-8', state: 'todo', overdue: true },
		{ taskId: 'task-travel', speakerId: 'spk-8', state: 'complete', overdue: false },
		{ taskId: 'task-slides', speakerId: 'spk-8', state: 'todo', overdue: false }
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
			{ id: 'ses-1', title: 'Opening Keynote: AI Engineering Beyond the Demo', speakers: [{ name: 'Ravi Chandran', email: 'ravi@keynote.example' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 60, state: 'programmed' },
			{ id: 'ses-2', title: 'Context Caching Without Tears', speakers: [{ name: 'Maya Lindqvist', email: 'maya@nordicweb.dev' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-3', title: 'Panel: Who Owns Agent Reliability?', speakers: [{ name: 'Sofia Berg', email: 'sofia@perfpanel.se' }, { name: 'Lukas Brandt', email: 'lukas@perfpanel.se' }], trackId: 'trk-web', formatId: 'fmt-panel', durationMin: 60, state: 'programmed' },
			{ id: 'ses-4', title: 'Componentizing the Agent Stack', speakers: [{ name: 'Elena Petrova', email: 'elena@sandboxworks.example' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-5', title: 'Running Small Models at the Edge', speakers: [{ name: 'Daniel Kim', email: 'daniel@edgequery.dev' }], trackId: 'trk-infra', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-6', title: 'AI Interface Audits That Stick', speakers: [{ name: 'Elif Aydın', email: 'elif@a11ycraft.eu' }, { name: 'Marc Dubois', email: 'marc@a11ycraft.eu' }], trackId: 'trk-web', formatId: 'fmt-workshop', durationMin: 90, state: 'programmed' },
			{ id: 'ses-7', title: 'Typed Tool Contracts Between Agents That Never Meet', speakers: [{ name: 'Amara Okafor', email: 'amara@contractual.io' }], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-8', title: 'LLM Review Queues: Allocating Human Attention', speakers: [{ name: 'Priya Nair', email: 'priya.nair@reviewlab.ai' }], trackId: 'trk-ai', formatId: 'fmt-talk', durationMin: 30, state: 'programmed' },
			{ id: 'ses-10', title: 'Closing Panel: Can We Ship Reliable Agents?', speakers: [{ name: 'Sofia Berg', email: 'sofia@perfpanel.se' }], trackId: 'trk-web', formatId: 'fmt-panel', durationMin: 45, state: 'programmed' },
			/* Still-collecting slots: no speakers yet, never placed. They are
			   legitimate reviewer-scope targets — that is what collecting is. */
			{ id: 'ses-11', title: 'Panel: Durable Agent Infrastructure', speakers: [], trackId: 'trk-infra', formatId: 'fmt-panel', durationMin: 45, state: 'collecting' },
			{ id: 'ses-12', title: 'Lightning Talks: Eval Fails in Production', speakers: [], trackId: 'trk-ai', formatId: 'fmt-talk', durationMin: 30, state: 'collecting' },
			/* Programmed by hand before anyone was booked: the closing slot is
			   committed content with an empty roster, so it needs speakers as
			   well as a place on the grid. */
			{ id: 'ses-13', title: 'Closing Keynote — speaker to be announced', speakers: [], trackId: 'trk-web', formatId: 'fmt-talk', durationMin: 60, state: 'programmed' }
		],
		placements: [
			{ sessionId: 'ses-1', dayKey: 'day-1', roomId: 'room-main', startMin: 0, conflicts: [] },
			{ sessionId: 'ses-2', dayKey: 'day-1', roomId: 'room-main', startMin: 90, conflicts: [] },
			{
				sessionId: 'ses-3',
				dayKey: 'day-1',
				roomId: 'room-2a',
				startMin: 90,
				conflicts: [{ severity: 'block', reason: 'Sofia Berg is scheduled in Main Stage at the same time' }]
			},
			{
				sessionId: 'ses-10',
				dayKey: 'day-1',
				roomId: 'room-main',
				startMin: 120,
				conflicts: [{ severity: 'block', reason: 'Overlaps “Context Caching Without Tears” in Main Stage' }]
			},
			{
			sessionId: 'ses-4',
			dayKey: 'day-1',
			roomId: 'room-2a',
			startMin: 210,
			conflicts: [{ severity: 'warn', reason: 'Runs into “Lunch” in Breakout Stage A' }]
		},
			{
				sessionId: 'ses-6',
				dayKey: 'day-1',
				roomId: 'room-lab',
				startMin: 90,
				conflicts: [{ severity: 'warn', reason: 'Evals Lab capacity 40 is under the 62 pre-registrations from last year' }]
			},
			{ sessionId: 'ses-5', dayKey: 'day-2', roomId: 'room-2a', startMin: 0, conflicts: [] },
			{ sessionId: 'ses-8', dayKey: 'day-2', roomId: 'room-main', startMin: 60, conflicts: [] }
		],
		// Lunch reserves 12:00–13:00 (startMin 180 from the 09:00 day start) in
		// every room on both days — placement aiming treats these as occupied,
		// and their edges are the flush anchors the placement mode snaps to.
		breaks: [
			{ id: 'brk-1', label: 'Lunch', dayKey: 'day-1', roomId: 'room-main', startMin: 180, durationMin: 60 },
			{ id: 'brk-2', label: 'Lunch', dayKey: 'day-1', roomId: 'room-2a', startMin: 180, durationMin: 60 },
			{ id: 'brk-3', label: 'Lunch', dayKey: 'day-1', roomId: 'room-lab', startMin: 180, durationMin: 60 },
			{ id: 'brk-4', label: 'Lunch', dayKey: 'day-2', roomId: 'room-main', startMin: 180, durationMin: 60 },
			{ id: 'brk-5', label: 'Lunch', dayKey: 'day-2', roomId: 'room-2a', startMin: 180, durationMin: 60 },
			{ id: 'brk-6', label: 'Lunch', dayKey: 'day-2', roomId: 'room-lab', startMin: 180, durationMin: 60 }
		],
		published: false
	},

	communications: [
		{
			id: 'msg-1',
			subject: 'Speaker onboarding — what happens next',
			audience: 'Confirmed speakers',
			audienceCount: 18,
			state: 'sent',
			purpose: 'Speaker onboarding',
			cause: '18 speakers reached confirmed — onboarding for the confirmed roster',
			causeHref: '/app/speakers?filter=confirmed',
			actor: 'you',
			sentAt: 'Yesterday, 16:40',
			deliveredCount: 16,
			bouncedCount: 2,
			bounces: [
				{ email: 'elena@sandboxworks.example', reason: 'Mailbox full (soft bounce ×3)' },
				{ email: 'daniel@edgequery.dev', reason: 'Domain rejected the message (DMARC)' }
			]
		},
		{
			id: 'msg-2',
			subject: 'Acceptance — AI Engineer NYC 2026',
			audience: '12 accepted submitters',
			audienceCount: 12,
			state: 'draft',
			purpose: 'Decision notice',
			cause: '12 submissions were marked Accepted and their submitters have not been told',
			causeHref: '/app/decisions?scope=unnotified',
			actor: 'you',
			templateId: 'tpl-decision-accepted',
			deliveredCount: 0,
			bouncedCount: 0,
			bounces: [],
			review: {
				templateLabel: 'decision-notice @ revision 2',
				audienceLabel: 'Accepted, not yet notified (current snapshot)',
				binding: 'current_snapshot',
				recipients: [
					{ name: 'Amara Okafor', email: 'amara@contractual.io', state: 'included', mergeSample: 'Accepted — “Typed Tool Contracts Between Agents That Never Meet”', mergeValues: { 'submission.title': 'Typed Tool Contracts Between Agents That Never Meet' } },
					{ name: 'Priya Nair', email: 'priya.nair@reviewlab.ai', state: 'included', mergeSample: 'Accepted — “LLM Review Queues: Allocating Human Attention”', mergeValues: { 'submission.title': 'LLM Review Queues: Allocating Human Attention' } },
					{ name: 'Deniz Kaya', email: 'deniz@ingestworks.io', state: 'blocked', reason: 'The template fills in a session length and this submission has no format set' },
					{ name: 'Hana Sato', email: 'hana@streamcraft.jp', state: 'included', mergeSample: 'Accepted — “Streaming Agent UIs Without a State Machine Meltdown”', mergeValues: { 'submission.title': 'Streaming Agent UIs Without a State Machine Meltdown' } },
					{ name: 'Ingrid Halvorsen', email: 'ingrid@nordicscale.no', state: 'included', mergeSample: 'Accepted — “Zero-Downtime Vector Index Changes at 40k QPS”', mergeValues: { 'submission.title': 'Zero-Downtime Vector Index Changes at 40k QPS' } },
					{ name: 'Nora Visser', email: 'nora@tokenslab.nl', state: 'included', mergeSample: 'Accepted — “Evaluation Rubrics as a Product API”', mergeValues: { 'submission.title': 'Evaluation Rubrics as a Product API' } },
					{ name: 'Tomás Rivera', email: 'tomas@queueless.dev', state: 'included', mergeSample: 'Accepted — “Durable Agent Jobs: A Queueing Confession”', mergeValues: { 'submission.title': 'Durable Agent Jobs: A Queueing Confession' } },
					{ name: 'Elif Aydın', email: 'elif@a11ycraft.eu', state: 'included', mergeSample: 'Accepted — “AI Interface Audits That Stick”', mergeValues: { 'submission.title': 'AI Interface Audits That Stick' } },
					{ name: 'Marc Dubois', email: 'marc@a11ycraft.eu', state: 'included', mergeSample: 'Accepted — “AI Interface Audits That Stick”', mergeValues: { 'submission.title': 'AI Interface Audits That Stick' } },
					{ name: 'Jonas Weber', email: 'jonas.weber@metricsense.de', state: 'included', mergeSample: 'Accepted — “The Inference Bill Nobody Read”', mergeValues: { 'submission.title': 'The Inference Bill Nobody Read' } },
					{ name: 'Lena Fischer', email: 'lena@edgecraft.at', state: 'included', mergeSample: 'Accepted — “Progressive Rollouts With Boring Tools”', mergeValues: { 'submission.title': 'Progressive Rollouts With Boring Tools' } },
					{ name: 'Owen Gallagher', email: 'owen@shipwright.ie', state: 'included', mergeSample: 'Accepted — “Incident Reviews People Stop Dreading”', mergeValues: { 'submission.title': 'Incident Reviews People Stop Dreading' } },
					{ name: 'Rex Vault', email: 'rex@vaultmoney.xyz', state: 'excluded', reason: 'Address suppressed after a hard bounce' }
				],
				sender: 'AI Engineer <program@aie-demo.example>',
				replyModel: 'Replies go to the organizer inbox',
				irreversibleNote: 'Email cannot be recalled after the provider accepts it.'
			}
		},
		{
			id: 'msg-3',
			subject: 'AV form reminder',
			audience: 'Speakers with incomplete AV form',
			audienceCount: 6,
			state: 'scheduled',
			purpose: 'Task reminder',
			cause: 'Standing reminder: the AV form is incomplete three days before its deadline',
			causeHref: '/app/tasks',
			actor: 'policy',
			sentAt: 'Sends Aug 12, 09:00',
			deliveredCount: 0,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-4',
			subject: 'Review round 1 midpoint nudge',
			audience: 'Reviewers under 50%',
			audienceCount: 3,
			state: 'sent',
			purpose: 'Reviewer nudge',
			cause: 'Round 1 passed its midpoint with 3 reviewers under half done — drafted by the review agent, sent after your review',
			causeHref: '/app/reviewers',
			actor: 'agent',
			sentAt: 'Aug 7, 10:12',
			deliveredCount: 3,
			bouncedCount: 0,
			bounces: []
		},
		{
			id: 'msg-5',
			subject: 'We received “Typed Tool Contracts Between Agents That Never Meet”',
			audience: 'Amara Okafor',
			audienceCount: 1,
			state: 'sent',
			purpose: 'Submission confirmation',
			cause: 'Sent automatically when the submission arrived, under the standing confirmation policy',
			actor: 'policy',
			sentAt: 'Jul 28, 09:03',
			deliveredCount: 1,
			bouncedCount: 0,
			bounces: []
		}
	],
	threads: {
		'spk-1': [
			{
				id: 'thr-1-1',
				messageId: 'msg-1',
				at: 'Yesterday, 16:40',
				purpose: 'Speaker onboarding',
				subject: 'Speaker onboarding — what happens next',
				outcome: 'delivered',
				actor: 'you'
			},
			{
				id: 'thr-1-2',
				at: 'Jul 21, 14:05',
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
				at: 'Jul 28, 09:03',
				purpose: 'Submission confirmation',
				subject: 'We received “Typed Tool Contracts Between Agents That Never Meet”',
				outcome: 'delivered',
				actor: 'policy'
			}
		],
		'spk-5': [
			{
				id: 'thr-5-1',
				messageId: 'msg-3',
				at: 'Sends Aug 12, 09:00',
				purpose: 'Task reminder',
				subject: 'AV form reminder',
				outcome: 'scheduled',
				actor: 'policy'
			},
			{
				id: 'thr-5-2',
				messageId: 'msg-1',
				at: 'Yesterday, 16:40',
				purpose: 'Speaker onboarding',
				subject: 'Speaker onboarding — what happens next',
				outcome: 'delivered',
				actor: 'you'
			}
		],
		'spk-7': [
			{
				id: 'thr-7-1',
				messageId: 'msg-1',
				at: 'Yesterday, 16:40',
				purpose: 'Speaker onboarding',
				subject: 'Speaker onboarding — what happens next',
				outcome: 'bounced',
				actor: 'you'
			}
		],
		'spk-8': [
			{
				id: 'thr-8-1',
				messageId: 'msg-1',
				at: 'Yesterday, 16:40',
				purpose: 'Speaker onboarding',
				subject: 'Speaker onboarding — what happens next',
				outcome: 'bounced',
				actor: 'you'
			}
		]
	},
	readiness: { provider: 'Resend', outbound: 'ready', callbacks: 'ready', inbound: 'not_applicable' },

	templates: starterTemplates(),
	surfaces: starterSurfaceTemplates('AI Engineer NYC 2026'),
	fieldRegistry: baselineFieldRegistry(),
	theme: defaultEventTheme('AI Engineer NYC 2026'),

	forms: [
		/* The open CFP asks the standard application — no composition, which is
		 * the point of the baseline: most forms never deviate. */
		{ id: 'form-cfp', name: 'Call for Proposals', target: { kind: 'general' }, status: 'open', closesAt: closesInDays(12), version: 3, submissionCount: 214 },
		/* A slot form trims to what a panelist decision needs (6 questions) —
		 * the panel already owns its track and format, so neither is asked. */
		{
			id: 'form-panel',
			name: 'Agent Reliability Panelist Application',
			target: { kind: 'session', sessionId: 'ses-11' },
			status: 'open',
			closesAt: closesInDays(5),
			version: 1,
			submissionCount: 9,
			composition: {
				excludedFieldIds: [
					'fld-location',
					'fld-link',
					'fld-website',
					'fld-linkedin',
					'fld-x',
					'fld-github',
					'fld-format',
					'fld-track',
					'fld-notes'
				]
			}
		},
		/* The evergreen form keeps 5 questions, offers only the two tracks that
		 * carry across events, and takes a rough abstract. */
		{
			id: 'form-evergreen',
			name: 'Speak at a Future AI Engineer Event',
			target: { kind: 'general' },
			status: 'open',
			version: 2,
			submissionCount: 31,
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
				requiredOverrides: { 'fld-abstract': false },
				optionExposure: { 'fld-track': ['trk-web', 'trk-ai'] }
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
		venueNote: 'New York venue — Main Stage, Breakout Stage A, Evals Lab. Load-in from 07:00.'
	},
	members: [
		{ id: 'mem-1', name: 'Jere K.', email: 'jere@aie-demo.example', role: 'Workspace Admin', status: 'active' },
		// Sofia reviews on the Event Manager role: a reviewer is a member
		// with any role that includes review, not a preset check.
		{ id: 'mem-2', name: 'Sofia Berg', email: 'sofia@perfpanel.se', role: 'Event Manager', status: 'active' },
		{ id: 'mem-3', name: 'Jonas Weber', email: 'jonas.weber@metricsense.de', role: 'Speaker Reviewer', status: 'active' },
		{ id: 'mem-4', name: 'Linnea Koski', email: 'linnea@aie-demo.example', role: 'Speaker Manager', status: 'active' },
		{ id: 'mem-5', name: 'Priya Nair', email: 'priya.nair@reviewlab.ai', role: 'Speaker Reviewer', status: 'invited' },
		{ id: 'mem-6', name: 'Tomás Rivera', email: 'tomas@queueless.dev', role: 'Speaker Reviewer', status: 'active' },
		{ id: 'mem-7', name: 'Elif Aydın', email: 'elif@a11ycraft.eu', role: 'Speaker Reviewer', status: 'active' },
		{ id: 'mem-8', name: 'Marc Dubois', email: 'marc@a11ycraft.eu', role: 'Speaker Reviewer', status: 'active' }
	]
};

export default flight;
