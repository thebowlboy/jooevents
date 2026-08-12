import type {
	AccoladeDef,
	AccoladeKey,
	AnyTemplate,
	ComparableCard,
	EditClassification,
	EmailReadiness,
	EventSettings,
	EventTheme,
	FieldContext,
	FieldKind,
	Format,
	FormSummary,
	Member,
	MergeFieldDef,
	MessageReview,
	MessageTemplate,
	ModelChoice,
	MutationOutcome,
	MyReviewItem,
	OutboxMessage,
	Placement,
	BreakBlock,
	PlacementConflict,
	RegistryField,
	ReviewPlan,
	ReviseProgress,
	Room,
	ScheduleState,
	ScoreStanding,
	SlotSuggestion,
	SpeakerProfile,
	SpeakerRow,
	Submission,
	SubmissionPage,
	SubmissionQuery,
	SurfaceBlock,
	SurfaceField,
	SurfaceTemplate,
	TaskAssignment,
	TaskDef,
	TemplateSuggestion,
	Track,
	TrayKey,
	VocabStatus,
	WorkspaceSummary
} from './types';
import { isSurfaceTemplate } from './types';
import { normalizeThemeRecipe } from '../theme/theme-contract';
import type { FormatSeed, RoomSeed, TrackSeed } from './sample/dataset';
import { formatUsage, removalBlockReason, roomUsage, trackUsage, type VocabUsageSource } from './vocab';
import { resolveDataset, sampleLatencyMs, sampleResidency } from './sample/registry';
import { computeStanding } from './standing';
import { accoladeCatalog, composeCapRefusal } from './accolades';
import { suggestPlacement, type PlacementSuggestion } from './placement';
import { asSurfaceField, contextFields, projectApplicationForm, sectionFieldIds } from './fields';
import { compareMatches, matchFields, parseSearch } from './search';
import { submissionFields } from './searchable';
import { createListSource, RESIDENT_ROW_CEILING } from './residency';

/**
 * Workspace API, currently served from an in-memory sample dataset. Screens
 * call these functions exactly as they will call the real transport; mutations
 * update the working copy so a session behaves like a live product until the
 * page reloads. Aggregate counters reflect the loaded scenario; row-level
 * mutations update the rows and the counters they can derive, not every
 * narrative number.
 */

const db = structuredClone(resolveDataset());

/** True while the app is running on sample data instead of a live backend. */
export const sampleMode = true;

/**
 * Which fiction is loaded. Every count on screen belongs to this scenario, so a
 * surface saying "sample data" can name the story rather than leaving the
 * numbers' truth value unstated.
 */
export const sampleScenario: { key: string; name: string; description: string } = {
	key: db.key,
	name: db.name,
	description: db.description
};

const latency = () => new Promise((resolve) => setTimeout(resolve, sampleLatencyMs()));

const overlaps = (aStart: number, aDur: number, bStart: number, bDur: number) =>
	aStart < bStart + bDur && bStart < aStart + aDur;

function sessionDuration(sessionId: string): number {
	return db.schedule.sessions.find((s) => s.id === sessionId)?.durationMin ?? db.schedule.slotMinutes;
}

function conflictsFor(sessionId: string, dayKey: string, roomId: string, startMin: number): PlacementConflict[] {
	const found: PlacementConflict[] = [];
	const duration = sessionDuration(sessionId);
	const session = db.schedule.sessions.find((s) => s.id === sessionId);
	for (const other of db.schedule.placements) {
		if (other.sessionId === sessionId || other.dayKey !== dayKey) continue;
		const otherSession = db.schedule.sessions.find((s) => s.id === other.sessionId);
		if (!otherSession) continue;
		if (!overlaps(startMin, duration, other.startMin, otherSession.durationMin)) continue;
		if (other.roomId === roomId) {
			const room = db.schedule.rooms.find((r) => r.id === roomId);
			found.push({ severity: 'block', reason: `Overlaps “${otherSession.title}” in ${room?.name ?? 'the same room'}` });
		}
		const shared = session?.speakerNames.find((name) => otherSession.speakerNames.includes(name));
		if (shared && other.roomId !== roomId) {
			found.push({ severity: 'block', reason: `${shared} is scheduled in another room at the same time` });
		}
	}
	// A break is a deliberate reservation, not physics: overlapping one warns —
	// visibly, on the card — but never blocks publication.
	for (const brk of db.schedule.breaks) {
		if (brk.dayKey !== dayKey || brk.roomId !== roomId) continue;
		if (!overlaps(startMin, duration, brk.startMin, brk.durationMin)) continue;
		const room = db.schedule.rooms.find((r) => r.id === roomId);
		found.push({ severity: 'warn', reason: `Runs into “${brk.label}” in ${room?.name ?? 'this room'}` });
	}
	return found;
}

function recomputeAllConflicts(): void {
	for (const placement of db.schedule.placements) {
		const computed = conflictsFor(placement.sessionId, placement.dayKey, placement.roomId, placement.startMin);
		// Seeded warnings (capacity notes a dataset authored) survive recompute;
		// break-overlap warnings are computed, so they are dropped here and
		// re-derived by conflictsFor — otherwise each recompute would stack a copy.
		const seeded = placement.conflicts.filter(
			(c) => c.severity === 'warn' && !c.reason.startsWith('Runs into “')
		);
		placement.conflicts = [...computed, ...seeded];
	}
}

function scheduleBlockCount(): number {
	return db.schedule.placements.filter((p) => p.conflicts.some((c) => c.severity === 'block')).length;
}

function syncScheduleCounters(): void {
	const blocks = scheduleBlockCount();
	if (blocks > 0) db.summary.navCounts.schedule = { value: String(blocks), tone: 'danger' };
	else delete db.summary.navCounts.schedule;
}

/**
 * Which rows a submission query selects, and in what order.
 *
 * One function, called by both sides of the residency seam: the server path
 * runs it over the whole table, the resident path runs it over a held scope.
 * They agree because they are the same code — the alternative, two
 * implementations kept in step by a test, is how "it filters differently in
 * production" happens.
 */
function selectSubmissions(rows: readonly Submission[], query: SubmissionQuery): SubmissionPage {
	// Scope narrows first, so `scanned` counts the records the search was
	// actually asked about rather than the whole table.
	const scoped = rows.filter((submission) => {
		if (query.tray && submission.tray !== query.tray) return false;
		if (query.trackId && submission.trackId !== query.trackId) return false;
		if (query.formatId && submission.formatId !== query.formatId) return false;
		return true;
	});

	const parsed = parseSearch(query.search ?? '');
	if (parsed.terms.length === 0) {
		return { rows: scoped, trayTotals: db.submissionTrayTotals };
	}

	// Ranked, then tie-broken on id: the same query must return the same order
	// every time, or a keystroke reshuffles rows under the reader.
	const matched = scoped
		.map((submission) => ({ submission, match: matchFields(submissionFields(submission), parsed) }))
		.filter((entry) => entry.match !== null)
		.sort((a, b) =>
			compareMatches(
				{ match: a.match!, key: a.submission.id },
				{ match: b.match!, key: b.submission.id }
			)
		)
		.map((entry) => entry.submission);

	return {
		rows: matched,
		trayTotals: db.submissionTrayTotals,
		search: { query: query.search ?? '', matched: matched.length, scanned: scoped.length }
	};
}

/** Bumped by every mutation, so a held scope can tell it has gone stale. */
let submissionsVersion = 0;

/**
 * Submissions behind the residency seam.
 *
 * The scope is the event rather than the tray: trays are disjoint partitions of
 * the same small population, so holding all of them costs almost nothing extra
 * and makes switching between them local too. Track, format, and search are
 * filters within the scope, never part of its key.
 *
 * In sample mode both ports read the same in-memory tables, which is exactly
 * the point — it makes the two modes comparable on identical data. When the
 * real transport lands this composition moves client-side in front of HTTP, and
 * the ports become one GET for the scope and one GET per query.
 */
const submissionList = createListSource<Submission, SubmissionQuery, SubmissionPage>(
	{
		scopeKey: () => `event:${db.key}`,
		async loadScope() {
			await latency();
			// Copied rather than shared, so a held scope behaves like one that
			// crossed a network: mutations reach it through invalidation, not by
			// aliasing the store.
			return {
				rows: db.submissions.map((submission) => ({ ...submission })),
				complete: db.submissions.length <= RESIDENT_ROW_CEILING,
				version: `${db.key}:${submissionsVersion}`
			};
		},
		async queryServer(query) {
			await latency();
			return selectSubmissions(db.submissions, query);
		},
		applyLocally: selectSubmissions
	},
	{ residency: sampleResidency }
);

/** Every submission mutation ends here, so no caller can forget to invalidate. */
function submissionsChanged(): void {
	submissionsVersion += 1;
	submissionList.invalidate();
}

function moveTrayCount(from: Submission['tray'], to: Submission['tray']): void {
	db.submissionTrayTotals[from] = Math.max(0, db.submissionTrayTotals[from] - 1);
	db.submissionTrayTotals[to] += 1;
	// Every tray mutation moves a count, so invalidating here covers all five of
	// them at once rather than asking five call sites to remember. The two
	// decision mutations do not move a tray and say so themselves.
	submissionsChanged();
}

let mintSequence = 0;

/** Session-unique ids for records minted by sample-mode mutations. */
function mintId(prefix: string): string {
	mintSequence += 1;
	return `${prefix}-local-${mintSequence}`;
}

/**
 * The records vocabulary usage is counted from. Lists and removal guards read
 * the same source through the same predicates, so a count on screen and the
 * check behind a removal can never disagree.
 */
function usageSource(): VocabUsageSource {
	return {
		submissions: db.submissions,
		sessions: db.schedule.sessions,
		placements: db.schedule.placements
	};
}

function asTrack(seed: TrackSeed): Track {
	return { ...seed, status: seed.status ?? 'active', usage: trackUsage(seed.id, usageSource()) };
}

function asFormat(seed: FormatSeed): Format {
	return { ...seed, status: seed.status ?? 'active', usage: formatUsage(seed.id, usageSource()) };
}

function asRoom(seed: RoomSeed): Room {
	return { ...seed, status: seed.status ?? 'active', usage: roomUsage(seed.id, usageSource()) };
}

/** Retire and restore only move the lifecycle mark; nothing else is touched. */
function setStatus(seed: { status?: VocabStatus } | undefined, status: VocabStatus): MutationOutcome {
	if (seed) seed.status = status;
	return { ok: true };
}

function submissionTitle(submissionId: string): string {
	return db.submissions.find((row) => row.id === submissionId)?.title ?? submissionId;
}

/**
 * One submission's standing inside its own track, or null when the claim
 * cannot be made: no average yet, or no scored population to rank inside.
 * Shared by the single and batch reads so both answer identically.
 */
function standingFor(submissionId: string): ScoreStanding | null {
	const submission = db.submissions.find((row) => row.id === submissionId);
	if (!submission || submission.reviewAverage === undefined) return null;
	const population = db.reviewDistributions?.[submission.trackId];
	if (!population || population.length === 0) return null;
	// The population includes this submission; the comparison is against the
	// others, so exactly one copy of its own average comes out.
	const others = [...population];
	const own = others.indexOf(submission.reviewAverage);
	if (own >= 0) others.splice(own, 1);
	const track = db.tracks.find((entry) => entry.id === submission.trackId);
	return computeStanding(
		submission.reviewAverage,
		db.reviewPlans[0]?.scaleMax ?? 5,
		others,
		submission.reviewCount,
		{ label: track?.name ?? 'Track', trackId: submission.trackId }
	);
}

/**
 * One submitter's profile, joined to what they are in this event.
 *
 * The authored part is only what the person says about themselves; the counted
 * part — how many submissions carry this address, and the roster entry and its
 * sessions when one shares it — is read here so no surface has to derive it.
 * Addresses are compared case-insensitively because a mailbox is, but the
 * profile answers with the address as authored.
 */
function profileFor(email: string): SpeakerProfile | null {
	const key = email.trim().toLowerCase();
	const seed = db.speakerProfiles?.find((entry) => entry.email.trim().toLowerCase() === key);
	if (!seed) return null;
	const submissions = db.submissions.filter((submission) =>
		submission.speakers.some((speaker) => speaker.email.trim().toLowerCase() === key)
	);
	const roster = db.speakers.find((speaker) => speaker.email.trim().toLowerCase() === key);
	const submitted = submissions
		.flatMap((submission) => submission.speakers)
		.find((speaker) => speaker.email.trim().toLowerCase() === key);
	const profile: SpeakerProfile = {
		name: roster?.name ?? submitted?.name ?? seed.email,
		email: seed.email,
		headline: seed.headline,
		submissionCount: submissions.length
	};
	if (seed.location) profile.location = seed.location;
	if (seed.links && seed.links.length > 0) profile.links = seed.links;
	if (roster) {
		profile.speakerId = roster.id;
		if (roster.sessions.length > 0) profile.sessions = roster.sessions;
	}
	return profile;
}

function outboxEntry(subject: string, audience: string, audienceCount: number, state: OutboxMessage['state']): OutboxMessage {
	const message: OutboxMessage = {
		id: mintId('msg'),
		subject,
		audience,
		audienceCount,
		state,
		sentAt: state === 'sent' ? 'Just now' : undefined,
		deliveredCount: state === 'sent' ? audienceCount : 0,
		bouncedCount: 0,
		bounces: []
	};
	db.outbox.unshift(message);
	return message;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How a template edit instruction is routed, as data. The model *names* here
 * are display data the server reports beside its choice; no identifier of any
 * model lives in feature code.
 */
const reviseProfiles = {
	quick: { label: 'Quick touch', model: 'Claude Haiku' },
	comprehensive: { label: 'Full pass', model: 'Claude Sonnet' }
} as const;

/**
 * The models an organizer can pin an edit to, plus the routing default —
 * always first, always recommended. Mock server data shaped like the real
 * profile listing: every id and label here is display data the api serves;
 * feature code never imports them as constants.
 */
const templateModelChoices: ModelChoice[] = [
	{ id: 'auto', label: 'Auto', sub: 'Routes each request to the lightest model that can do it' },
	{ id: 'gpt-5-6-sol', label: 'GPT 5.6 Sol', sub: 'Strong all-round drafting at a steady pace' },
	{ id: 'sonnet-5', label: 'Sonnet 5', sub: 'Quick and precise on focused wording changes' },
	{ id: 'opus-5', label: 'Opus 5', sub: 'The deepest rewrites — takes its time' }
];

/**
 * How the mock stream paces per pinned model: a token budget factor over the
 * routed default and a per-tick delay. Opus drafts longer and slower; the
 * others sit near the default. Deterministic display data only.
 */
const modelPacing: Record<string, { tokenFactor: number; tickMs: number }> = {
	'gpt-5-6-sol': { tokenFactor: 1.15, tickMs: 110 },
	'sonnet-5': { tokenFactor: 1, tickMs: 100 },
	'opus-5': { tokenFactor: 1.5, tickMs: 150 }
};

const autoPacing = { tokenFactor: 1, tickMs: 120 };

/**
 * Wording that implies changing structure, not just words — of a message's
 * blocks or of a public surface's sections, questions, and grouping.
 */
const structuralPattern =
	/restructur|rewrit|reorder|remove|rework|section|question|\bfield\b|\bgroup(?:ing|ed|s)?\b/i;

function classifyInstruction(instruction: string, modelId?: string): EditClassification {
	const words = instruction.trim().split(/\s+/).filter(Boolean).length;
	const scope = structuralPattern.test(instruction) || words > 12 ? 'comprehensive' : 'quick';
	// A pinned model bypasses routing: the scope heuristic still sizes the run,
	// but the label echoes the pick instead of naming a routed profile.
	const pinned =
		modelId && modelId !== 'auto'
			? templateModelChoices.find((choice) => choice.id === modelId)
			: undefined;
	if (pinned) {
		return { scope, profileLabel: pinned.label, reason: 'Your pick', chosenBy: 'you' };
	}
	const profile = reviseProfiles[scope];
	return {
		scope,
		profileLabel: `${profile.label} · ${profile.model}`,
		reason: scope === 'quick' ? 'Wording-only change' : 'Structural change across blocks',
		chosenBy: 'auto'
	};
}

/**
 * Starter instructions per template kind. Every string here is wording the
 * revise transformations genuinely understand, so pressing one always yields
 * a visible draft change — never dead example copy.
 */
function suggestionsFor(template: AnyTemplate): TemplateSuggestion[] {
	if (!isSurfaceTemplate(template)) {
		return [{ text: 'Warmer tone' }, { text: 'Tighten it' }, { text: 'Add a deadline row' }];
	}
	if (template.kind === 'schedule') {
		return [{ text: 'Group by track' }, { text: 'More compact cards' }, { text: 'Hide rooms' }];
	}
	// The application form's useful changes are field work: each chip is a
	// registry operation the revise vocabulary executes through the placement
	// advisor and the one field registry.
	return [
		{ text: 'Add a travel question' },
		{ text: 'Ask about dietary needs' },
		{ text: 'Make headline optional' }
	];
}

function firstSentence(text: string): string {
	// A `{{merge.token}}` is one opaque unit: the dot inside its key never ends
	// a sentence, so trimming can never cut a token in half.
	const match = text.match(/^(?:\{\{[^}]*\}\}|[^.!?])*[.!?]/);
	return match ? match[0].trim() : text;
}

/**
 * A deterministic transformation of the current template, driven by the
 * instruction's keywords, plus a one-sentence account of what changed. Works
 * on a deep copy: a draft never touches the stored template.
 */
function reviseDraft(current: MessageTemplate, instruction: string): { draft: MessageTemplate; note: string } {
	const draft = structuredClone(current);
	const changes: string[] = [];

	if (/short|tight/i.test(instruction)) {
		for (const block of draft.blocks) {
			if (block.type === 'paragraph') block.text = firstSentence(block.text);
		}
		changes.push('trimmed each paragraph to its first sentence');
	}
	if (/warm|friendly/i.test(instruction)) {
		const opening = draft.blocks.find((block) => block.type === 'paragraph');
		if (opening) {
			// The greeting only names the recipient when the template already
			// declares the token; a draft never uses an undeclared merge field.
			const greeting = draft.mergeFields.some((field) => field.key === 'speaker.name')
				? 'It’s genuinely good to be writing to you, {{speaker.name}}.'
				: 'It’s genuinely good to be writing this one.';
			const rest = opening.text.slice(firstSentence(opening.text).length).trim();
			opening.text = rest ? `${greeting} ${rest}` : greeting;
			changes.push('rewrote the greeting to open more warmly');
		}
	}
	if (/deadline/i.test(instruction)) {
		if (!draft.mergeFields.some((field) => field.key === 'task.due')) {
			draft.mergeFields.push({ key: 'task.due', label: 'Due', sample: 'Sep 11, 23:59 EDT' });
		}
		const details = draft.blocks.find((block) => block.type === 'details');
		if (details) {
			if (!details.rows.some((row) => row.label === 'Due')) {
				details.rows.push({ label: 'Due', value: '{{task.due}}' });
			}
			changes.push('added the due date to the details block');
		} else {
			const at = draft.blocks.findIndex((block) => block.type === 'button');
			draft.blocks.splice(at === -1 ? draft.blocks.length : at, 0, {
				type: 'details',
				rows: [{ label: 'Due', value: '{{task.due}}' }]
			});
			changes.push('added a details block carrying the due date');
		}
	}
	if (/button|\bcta\b/i.test(instruction)) {
		const button = draft.blocks.find((block) => block.type === 'button');
		if (button) {
			button.label = 'Take the next step';
			changes.push('renamed the call-to-action button');
		}
	}
	if (changes.length === 0) {
		draft.subject = `Quick word — ${draft.subject.charAt(0).toLowerCase()}${draft.subject.slice(1)}`;
		const opening = draft.blocks.find((block) => block.type === 'paragraph');
		if (opening) opening.text = `Here’s where things stand. ${opening.text}`;
		changes.push('adjusted the subject line and opening phrasing');
	}

	const account = changes.join(', then ');
	return { draft, note: `${account.charAt(0).toUpperCase()}${account.slice(1)}.` };
}

/**
 * A revise instruction the field registry refuses rather than drafts — e.g.
 * removing the locked email question. The message is the same typed reason a
 * direct registry mutation returns, surfaced as the round's error.
 */
export class ReviseRefusal extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'ReviseRefusal';
	}
}

/** One field operation parsed from a revise instruction line. */
type FieldOp =
	| { op: 'ask'; topic: string }
	| { op: 'requirement'; label: string; required: boolean }
	| { op: 'remove'; label: string };

const opQuotes = /[“”"']/g;

/**
 * The form surface's field vocabulary: one operation per instruction line, so
 * a refine chain replays every round's field work in order.
 */
function parseFieldOps(instruction: string): FieldOp[] {
	const ops: FieldOp[] = [];
	for (const line of instruction.split('\n')) {
		const flip = line.match(/\bmake\s+(?:the\s+)?(.+?)\s+(optional|required)\b/i);
		if (flip) {
			ops.push({
				op: 'requirement',
				label: flip[1].replace(opQuotes, '').trim(),
				required: flip[2].toLowerCase() === 'required'
			});
			continue;
		}
		const remove = line.match(
			/\b(?:remove|delete|drop)\s+(?:the\s+)?(.+?)(?:\s+(?:question|field))?\s*[.!?]?\s*$/i
		);
		if (remove) {
			ops.push({ op: 'remove', label: remove[1].replace(opQuotes, '').trim() });
			continue;
		}
		const add =
			line.match(/\badd\s+(?:(?:a|an|another)\s+)?(.+?)\s+question\b/i) ??
			line.match(/\bask\s+(?:about|for)\s+(?:the\s+)?(.+?)\s*[.!?]?\s*$/i);
		if (add) ops.push({ op: 'ask', topic: add[1].replace(opQuotes, '').trim() });
	}
	return ops;
}

/** Loose label match: an instruction names a question by part of its label. */
function matchesLabel(label: string, needle: string): boolean {
	const a = label.toLowerCase();
	const b = needle.toLowerCase();
	return a === b || a.includes(b) || b.includes(a);
}

/** The label a minted question takes when no registry question matches the topic. */
function fieldLabelFor(topic: string): string {
	const known: Record<string, string> = { travel: 'Travel plans' };
	const label = known[topic.toLowerCase()] ?? topic;
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Executes parsed field operations against a copied working view of the
 * registry and reprojects the draft's pool and sections from it — the same
 * derivation every serve applies, so the After side previews exactly what
 * applying will make the form say. Real registry mutations happen only on
 * apply (`syncDraftFields`); until then everything here is simulated.
 */
function applyFieldOps(draft: SurfaceTemplate, ops: FieldOp[], changes: string[]): void {
	const working = orderedRegistry().map((field) => structuredClone(field));
	for (const op of ops) {
		if (op.op === 'ask') {
			const existing = working.find(
				(field) => !field.formScope && matchesLabel(field.label, op.topic)
			);
			if (existing) {
				if (!existing.collectAt.includes('apply')) {
					existing.collectAt = [...existing.collectAt, 'apply'];
					changes.push(`asked the existing “${existing.label}” question on the application`);
				}
				continue;
			}
			const label = fieldLabelFor(op.topic);
			const placement = suggestPlacement({ kind: 'text', label }, working);
			working.splice(placement.index, 0, {
				id: mintId('fld'),
				kind: 'text',
				label,
				required: {},
				collectAt: ['apply'],
				group: placement.group,
				position: placement.index
			});
			const reason = placement.reason.replace(/\.$/, '');
			changes.push(
				`added the “${label}” question (${reason.charAt(0).toLowerCase()}${reason.slice(1)})`
			);
		} else if (op.op === 'requirement') {
			const field = working.find(
				(entry) => entry.collectAt.includes('apply') && matchesLabel(entry.label, op.label)
			);
			if (!field || Boolean(field.required.apply) === op.required) continue;
			field.required = { ...field.required, apply: op.required };
			changes.push(`made “${field.label}” ${op.required ? 'required' : 'optional'} on the application`);
		} else {
			const field = working.find(
				(entry) =>
					entry.collectAt.includes('apply') && !entry.formScope && matchesLabel(entry.label, op.label)
			);
			if (!field) continue;
			if (field.locked) throw new ReviseRefusal(lockedFieldRefusal);
			field.collectAt = field.collectAt.filter((context) => context !== 'apply');
			changes.push(`removed the “${field.label}” question from the application`);
		}
	}
	if (changes.length === 0) return;
	working.forEach((field, index) => {
		field.position = index;
	});
	draft.fields = contextFields(working, 'apply').map((field) => asSurfaceField(field, 'apply'));
	for (const block of draft.blocks) {
		if (block.type === 'form-section' && block.groups) {
			block.fieldRefs = sectionFieldIds(working, block.groups, 'apply');
		}
	}
}

/**
 * The surface counterpart of `reviseDraft`: deterministic keyword-driven
 * transformations of a public surface's blocks, on a deep copy, with the same
 * one-sentence account. The stored template is never touched.
 */
function reviseSurfaceDraft(
	current: SurfaceTemplate,
	instruction: string
): { draft: SurfaceTemplate; note: string } {
	const draft = structuredClone(current);
	const changes: string[] = [];
	const hero = draft.blocks.find((block) => block.type === 'hero');
	const listing = draft.blocks.find((block) => block.type === 'schedule-days');

	if (listing && /track/i.test(instruction) && listing.grouping !== 'track') {
		listing.grouping = 'track';
		changes.push('regrouped the schedule by track');
	}
	if (listing && /compact/i.test(instruction) && listing.density !== 'compact') {
		listing.density = 'compact';
		changes.push('tightened the listing to the compact density');
	}
	if (listing && /hide (the )?rooms?/i.test(instruction) && listing.showRoom) {
		listing.showRoom = false;
		changes.push('hid the room on each session');
	} else if (listing && /show (the )?rooms?/i.test(instruction) && !listing.showRoom) {
		listing.showRoom = true;
		changes.push('showed the room on each session');
	}
	// Field work first: an instruction naming a question is a registry
	// operation through the placement seam, not a section-copy tweak. The
	// generic section branch below only answers when no field op matched.
	const fieldOps = draft.kind === 'application-form' ? parseFieldOps(instruction) : [];
	if (fieldOps.length > 0) {
		applyFieldOps(draft, fieldOps, changes);
	} else if (draft.kind === 'application-form' && /section|question/i.test(instruction)) {
		const fields = draft.fields ?? [];
		const referenced = new Set(
			draft.blocks.flatMap((block) => (block.type === 'form-section' ? block.fieldRefs : []))
		);
		const unplaced = fields.find((field) => !referenced.has(field.id));
		if (unplaced) {
			// The pool already holds an unasked question: place it before inventing one.
			draft.blocks.push({ type: 'form-section', title: 'One more thing', fieldRefs: [unplaced.id] });
			changes.push(`added a section asking the unplaced “${unplaced.label}” question`);
		} else {
			const extra: SurfaceField = {
				id: `question-${fields.length + 1}`,
				label: 'Anything we should have asked?',
				kind: 'textarea',
				required: false,
				help: 'Optional — whatever the form left no room for.'
			};
			draft.fields = [...fields, extra];
			const last = [...draft.blocks].reverse().find((block) => block.type === 'form-section');
			if (last) last.fieldRefs = [...last.fieldRefs, extra.id];
			else draft.blocks.push({ type: 'form-section', title: 'One more thing', fieldRefs: [extra.id] });
			changes.push('added a follow-up question to the last section');
		}
	}
	if (/short|tight/i.test(instruction)) {
		for (const block of draft.blocks) {
			if (block.type === 'note') block.text = firstSentence(block.text);
		}
		if (hero) hero.intro = firstSentence(hero.intro);
		changes.push('trimmed the intro and notes to their first sentence');
	}
	if (/warm|friendly/i.test(instruction) && hero) {
		hero.intro = `We’re glad you’re here. ${hero.intro}`;
		changes.push('opened the hero more warmly');
	}
	if (changes.length === 0) {
		if (hero) {
			hero.intro = `In short: ${hero.intro.charAt(0).toLowerCase()}${hero.intro.slice(1)}`;
			changes.push('rephrased the hero intro');
		} else {
			changes.push('left the structure unchanged');
		}
	}

	const account = changes.join(', then ');
	return { draft, note: `${account.charAt(0).toUpperCase()}${account.slice(1)}.` };
}

/**
 * Prior content per template revision, kept so a revert can restore what a
 * revision actually said rather than only its metadata. Populated when a
 * revision is applied; seeded history carries no bodies.
 */
const templateSnapshots = new Map<
	string,
	Map<number, { subject: string; blocks: MessageTemplate['blocks']; mergeFields: MergeFieldDef[] }>
>();

function snapshotTemplate(stored: MessageTemplate): void {
	const byRevision = templateSnapshots.get(stored.id) ?? new Map();
	byRevision.set(
		stored.revision,
		structuredClone({ subject: stored.subject, blocks: stored.blocks, mergeFields: stored.mergeFields })
	);
	templateSnapshots.set(stored.id, byRevision);
}

/** The same forward-only history store for surface templates. */
const surfaceSnapshots = new Map<
	string,
	Map<number, { blocks: SurfaceBlock[]; fields?: SurfaceField[]; submitLabel?: string }>
>();

function snapshotSurface(stored: SurfaceTemplate): void {
	const byRevision = surfaceSnapshots.get(stored.id) ?? new Map();
	byRevision.set(
		stored.revision,
		structuredClone({ blocks: stored.blocks, fields: stored.fields, submitLabel: stored.submitLabel })
	);
	surfaceSnapshots.set(stored.id, byRevision);
}

// ---------------------------------------------------------------------------
// Field registry

/** The registry in its user-owned order — the truth every read and splice works over. */
function orderedRegistry(): RegistryField[] {
	return [...db.fieldRegistry].sort((a, b) => a.position - b.position);
}

/** Persists an ordered registry back, renumbering positions to match. Relative user order is never changed here. */
function commitRegistryOrder(ordered: RegistryField[]): void {
	ordered.forEach((field, index) => {
		field.position = index;
	});
	db.fieldRegistry = ordered;
}

const lockedFieldRefusal =
	'Email is how applicants are identified and reached — it cannot be removed from the application';

/**
 * The registry → form derivation seam, applied at serve time: an
 * application-form surface template stores its prose, and every read projects
 * the current registry's apply-context fields into its pool and its sections'
 * fieldRefs. A field edited through any door changes the served form on the
 * next read; nothing keeps a second copy in sync.
 */
function servedSurface(stored: SurfaceTemplate): SurfaceTemplate {
	return projectApplicationForm(stored, db.fieldRegistry);
}

/**
 * Reconciles an applied form draft with the field registry. The form editor is
 * a door onto the one registry, so what the applied draft asks becomes what
 * the registry says the application asks: a question the draft minted
 * registers with `collectAt: ['apply']` at the placement advisor's spot; an
 * existing question the draft asks joins the apply context; requiredness
 * follows the draft's pool; and an apply question the draft dropped leaves the
 * apply context — never deleted, its answers and other contexts stay. The
 * locked email question and fields scoped to other forms are untouched.
 */
function syncDraftFields(draft: SurfaceTemplate): void {
	if (draft.kind !== 'application-form') return;
	const pool = draft.fields ?? [];
	for (const field of pool) {
		const entry = db.fieldRegistry.find((candidate) => candidate.id === field.id);
		if (!entry) {
			const ordered = orderedRegistry();
			const placement = suggestPlacement({ kind: field.kind, label: field.label }, ordered);
			ordered.splice(placement.index, 0, {
				id: field.id,
				kind: field.kind,
				label: field.label,
				...(field.help ? { help: field.help } : {}),
				required: field.required ? { apply: true } : {},
				collectAt: ['apply'],
				...(field.options ? { options: field.options } : {}),
				group: placement.group,
				position: placement.index
			});
			commitRegistryOrder(ordered);
			continue;
		}
		if (!entry.collectAt.includes('apply')) entry.collectAt = [...entry.collectAt, 'apply'];
		if (Boolean(entry.required.apply) !== field.required) {
			entry.required = { ...entry.required, apply: field.required };
		}
	}
	for (const entry of db.fieldRegistry) {
		if (entry.locked || entry.formScope || !entry.collectAt.includes('apply')) continue;
		if (!pool.some((field) => field.id === entry.id)) {
			entry.collectAt = entry.collectAt.filter((context) => context !== 'apply');
		}
	}
}

export const api = {
	workspace: {
		async summary(): Promise<WorkspaceSummary> {
			await latency();
			return db.summary;
		},
		/**
		 * The most recently known summary, synchronously — evidence a screen may
		 * use to shape its loading state (e.g. whether a conditional banner
		 * deserves a placeholder). Null when nothing has been fetched yet.
		 */
		summarySnapshot(): WorkspaceSummary | null {
			return db.summary;
		}
	},

	/**
	 * One namespace owns vocabulary reads and writes. Lists carry every entry,
	 * retired ones included, so a renderer can always resolve what a record
	 * points at; offering an entry for new use is the caller's filter.
	 */
	vocab: {
		async tracks(): Promise<Track[]> {
			await latency();
			return db.tracks.map(asTrack);
		},
		async formats(): Promise<Format[]> {
			await latency();
			return db.formats.map(asFormat);
		},
		async rooms(): Promise<Room[]> {
			await latency();
			return db.schedule.rooms.map(asRoom);
		},
		async addTrack(name: string): Promise<Track> {
			await latency();
			const seed: TrackSeed = { id: `trk-${db.tracks.length + 1}-${name.length}`, name, accent: 'neutral' };
			db.tracks.push(seed);
			return asTrack(seed);
		},
		async addFormat(name: string): Promise<Format> {
			await latency();
			const seed: FormatSeed = { id: `fmt-${db.formats.length + 1}-${name.length}`, name };
			db.formats.push(seed);
			return asFormat(seed);
		},
		async addRoom(name: string, capacity: number): Promise<Room> {
			await latency();
			const seed: RoomSeed = { id: `room-${db.schedule.rooms.length + 1}-${name.length}`, name, capacity };
			db.schedule.rooms.push(seed);
			return asRoom(seed);
		},
		async removeTrack(id: string): Promise<MutationOutcome> {
			await latency();
			const seed = db.tracks.find((track) => track.id === id);
			if (!seed) return { ok: true };
			const reason = removalBlockReason('track', trackUsage(id, usageSource()), seed.status ?? 'active');
			if (reason) return { ok: false, reason };
			db.tracks = db.tracks.filter((track) => track.id !== id);
			return { ok: true };
		},
		async removeFormat(id: string): Promise<MutationOutcome> {
			await latency();
			const seed = db.formats.find((format) => format.id === id);
			if (!seed) return { ok: true };
			const reason = removalBlockReason('format', formatUsage(id, usageSource()), seed.status ?? 'active');
			if (reason) return { ok: false, reason };
			db.formats = db.formats.filter((format) => format.id !== id);
			return { ok: true };
		},
		async removeRoom(id: string): Promise<MutationOutcome> {
			await latency();
			const seed = db.schedule.rooms.find((room) => room.id === id);
			if (!seed) return { ok: true };
			const reason = removalBlockReason('room', roomUsage(id, usageSource()), seed.status ?? 'active');
			if (reason) return { ok: false, reason };
			db.schedule.rooms = db.schedule.rooms.filter((room) => room.id !== id);
			return { ok: true };
		},
		async retireTrack(id: string): Promise<MutationOutcome> {
			await latency();
			return setStatus(db.tracks.find((track) => track.id === id), 'retired');
		},
		async restoreTrack(id: string): Promise<MutationOutcome> {
			await latency();
			return setStatus(db.tracks.find((track) => track.id === id), 'active');
		},
		async retireFormat(id: string): Promise<MutationOutcome> {
			await latency();
			return setStatus(db.formats.find((format) => format.id === id), 'retired');
		},
		async restoreFormat(id: string): Promise<MutationOutcome> {
			await latency();
			return setStatus(db.formats.find((format) => format.id === id), 'active');
		},
		async retireRoom(id: string): Promise<MutationOutcome> {
			await latency();
			return setStatus(db.schedule.rooms.find((room) => room.id === id), 'retired');
		},
		async restoreRoom(id: string): Promise<MutationOutcome> {
			await latency();
			return setStatus(db.schedule.rooms.find((room) => room.id === id), 'active');
		}
	},

	submissions: {
		list: (query: SubmissionQuery = {}) => submissionList.list(query),
		async get(id: string): Promise<Submission | null> {
			await latency();
			return db.submissions.find((submission) => submission.id === id) ?? null;
		},
		async setAside(ids: string[], byRun = 'Set aside by hand'): Promise<void> {
			await latency();
			for (const submission of db.submissions) {
				if (ids.includes(submission.id) && submission.tray !== 'set-aside') {
					moveTrayCount(submission.tray, 'set-aside');
					submission.tray = 'set-aside';
					submission.setAsideBy = byRun;
				}
			}
		},
		async returnToInbox(ids: string[]): Promise<void> {
			await latency();
			for (const submission of db.submissions) {
				if (ids.includes(submission.id) && submission.tray === 'set-aside') {
					moveTrayCount('set-aside', 'inbox');
					submission.tray = 'inbox';
					delete submission.setAsideBy;
				}
			}
		},
		async discard(ids: string[]): Promise<void> {
			await latency();
			for (const submission of db.submissions) {
				if (ids.includes(submission.id) && submission.tray !== 'discarded') {
					moveTrayCount(submission.tray, 'discarded');
					submission.tray = 'discarded';
				}
			}
		},
		async restore(ids: string[]): Promise<void> {
			await latency();
			for (const submission of db.submissions) {
				if (ids.includes(submission.id) && submission.tray === 'discarded') {
					moveTrayCount('discarded', 'inbox');
					submission.tray = 'inbox';
				}
			}
		},
		/**
		 * The compensating write behind a triage receipt. Setting aside, discarding, and
		 * restore all normalize onto the inbox, so undoing them by calling the
		 * opposite operation would quietly move a late submission out of the late
		 * tray; this puts each row back in the exact tray it came from, with the
		 * set-aside attribution it carried.
		 */
		async restoreTray(entries: { id: string; tray: TrayKey; setAsideBy?: string }[]): Promise<void> {
			await latency();
			for (const entry of entries) {
				const submission = db.submissions.find((row) => row.id === entry.id);
				if (!submission || submission.tray === entry.tray) continue;
				moveTrayCount(submission.tray, entry.tray);
				submission.tray = entry.tray;
				if (entry.setAsideBy) submission.setAsideBy = entry.setAsideBy;
				else delete submission.setAsideBy;
			}
		}
	},

	decisions: {
		async decide(ids: string[], decision: Submission['decision']): Promise<void> {
			await latency();
			for (const submission of db.submissions) {
				if (ids.includes(submission.id)) {
					submission.decision = decision;
					submission.notified = false;
				}
			}
			submissionsChanged();
		},
		async reviewNotification(ids: string[]): Promise<MessageReview> {
			await latency();
			const rows = db.submissions.filter((submission) => ids.includes(submission.id));
			const decisionWord: Record<string, string> = {
				accepted: 'Accepted',
				waitlisted: 'Waitlisted',
				declined: 'Declined'
			};
			return {
				templateLabel: 'decision-notice @ revision 2',
				audienceLabel: 'Selected decided submissions (current snapshot)',
				binding: 'current_snapshot',
				recipients: rows.flatMap((submission) =>
					submission.speakers.map((speaker) => ({
						name: speaker.name,
						email: speaker.email,
						state: 'included' as const,
						mergeSample: `${decisionWord[submission.decision] ?? submission.decision} — “${submission.title}”`
					}))
				),
				sender: 'AI Engineer <program@aie-demo.example>',
				replyModel: 'Replies go to the organizer inbox',
				irreversibleNote: 'Email cannot be recalled after the provider accepts it.'
			};
		},
		async notify(ids: string[], subject: string): Promise<OutboxMessage> {
			await latency();
			for (const submission of db.submissions) {
				if (ids.includes(submission.id)) submission.notified = true;
			}
			submissionsChanged();
			return outboxEntry(subject, 'Decision notifications', ids.length, 'sent');
		}
	},

	review: {
		async plans(): Promise<ReviewPlan[]> {
			await latency();
			return db.reviewPlans;
		},
		async myQueue(): Promise<MyReviewItem[]> {
			await latency();
			return db.myQueue;
		},
		async saveReview(submissionId: string, score: number, comment: string): Promise<void> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (item && !item.committed) {
				item.myScore = score;
				item.myComment = comment;
			}
		},
		async commitReview(submissionId: string): Promise<MyReviewItem | null> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (item && item.myScore !== undefined && !item.committed) {
				item.committed = true;
				item.peerScores ??= [Math.max(1, item.myScore - 1), Math.min(5, item.myScore + 1)];
				const plan = db.reviewPlans[0];
				if (plan) plan.done += 1;
			}
			return item ?? null;
		},

		/** Where one submission's average sits inside its track's population. */
		async standing(submissionId: string): Promise<ScoreStanding | null> {
			await latency();
			return standingFor(submissionId);
		},

		/** The same claim for a whole screenful, on one round trip. */
		async standings(submissionIds: string[]): Promise<Record<string, ScoreStanding>> {
			await latency();
			const out: Record<string, ScoreStanding> = {};
			for (const submissionId of submissionIds) {
				const standing = standingFor(submissionId);
				if (standing) out[submissionId] = standing;
			}
			return out;
		},

		/**
		 * Changes an already-committed review. What was committed before is kept
		 * as a revision rather than overwritten: once peer scores are visible,
		 * a changed score is only readable beside the one it replaced.
		 */
		async amend(submissionId: string, score: number, comment: string): Promise<MyReviewItem | null> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (!item || !item.committed) return null;
			item.revisions = [
				...(item.revisions ?? []),
				{ score: item.myScore ?? score, comment: item.myComment ?? '', at: 'just now', postUnlock: true }
			];
			item.myScore = score;
			item.myComment = comment;
			return item;
		},

		/** The compensating write behind an amendment receipt. */
		async revertAmend(submissionId: string): Promise<MyReviewItem | null> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (!item) return null;
			const revisions = item.revisions;
			if (!revisions || revisions.length === 0) return item;
			const previous = revisions[revisions.length - 1];
			item.revisions = revisions.slice(0, -1);
			if (item.revisions.length === 0) delete item.revisions;
			item.myScore = previous.score;
			item.myComment = previous.comment;
			return item;
		},

		/**
		 * My other committed reviews, for reading one score against the rest of
		 * my own scoring rather than against the crowd. The anchor is never in
		 * its own comparison, and an uncommitted review is not evidence yet.
		 */
		async comparables(submissionId: string, slice: 'track' | 'all'): Promise<ComparableCard[]> {
			await latency();
			const anchor = db.submissions.find((row) => row.id === submissionId);
			const cards: ComparableCard[] = [];
			for (const item of db.myQueue) {
				if (item.submissionId === submissionId || !item.committed) continue;
				const submission = db.submissions.find((row) => row.id === item.submissionId);
				if (!submission) continue;
				if (slice === 'track' && submission.trackId !== anchor?.trackId) continue;
				cards.push({ item, submission, standing: standingFor(submission.id) });
			}
			return cards.sort((a, b) => (b.item.myScore ?? 0) - (a.item.myScore ?? 0));
		},

		async accoladeDefs(): Promise<AccoladeDef[]> {
			await latency();
			return accoladeCatalog;
		},

		/**
		 * Pins one of my marks on a submission. A capped key refuses once it is
		 * spent and says which submissions are holding it, because "you already
		 * used all three" is only actionable if you can see where they went.
		 */
		async pinAccolade(submissionId: string, key: AccoladeKey): Promise<MutationOutcome> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (!item || !item.committed) {
				return {
					ok: false,
					reason: `Commit your review of “${submissionTitle(submissionId)}” before pinning an accolade to it`
				};
			}
			if (item.accolades?.includes(key)) return { ok: true };
			const def = accoladeCatalog.find((entry) => entry.key === key);
			if (def?.cap !== undefined) {
				const holders = db.myQueue.filter(
					(entry) => entry.submissionId !== submissionId && entry.accolades?.includes(key)
				);
				if (holders.length >= def.cap) {
					const titles = holders.map((holder) => submissionTitle(holder.submissionId));
					return { ok: false, reason: composeCapRefusal(def, titles) };
				}
			}
			item.accolades = [...(item.accolades ?? []), key];
			return { ok: true };
		},

		async unpinAccolade(submissionId: string, key: AccoladeKey): Promise<MutationOutcome> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (item?.accolades) {
				item.accolades = item.accolades.filter((entry) => entry !== key);
				if (item.accolades.length === 0) delete item.accolades;
			}
			return { ok: true };
		}
	},

	speakers: {
		async list(): Promise<SpeakerRow[]> {
			await latency();
			return db.speakers;
		},
		async get(id: string): Promise<SpeakerRow | null> {
			await latency();
			return db.speakers.find((speaker) => speaker.id === id) ?? null;
		},
		/**
		 * Who submitted, by the address on the submission. Null is the ordinary
		 * answer for most submitters: a surface that asks about an unknown address
		 * gets nothing to show, not an empty profile.
		 */
		async profile(email: string): Promise<SpeakerProfile | null> {
			await latency();
			return profileFor(email);
		},
		async recordConfirmation(id: string): Promise<void> {
			await latency();
			const speaker = db.speakers.find((entry) => entry.id === id);
			if (speaker && speaker.state === 'invited') speaker.state = 'confirmed';
		},
		async acceptCancellation(id: string): Promise<void> {
			await latency();
			const speaker = db.speakers.find((entry) => entry.id === id);
			if (speaker && speaker.state === 'cancel_requested') {
				speaker.state = 'cancelled';
				db.summary.attention = db.summary.attention.filter((item) => item.id !== 'cancel-request');
			}
		}
	},

	tasks: {
		async defs(): Promise<TaskDef[]> {
			await latency();
			return db.taskDefs;
		},
		async assignments(): Promise<TaskAssignment[]> {
			await latency();
			return db.assignments;
		},
		async remind(speakerIds: string[], subject: string): Promise<OutboxMessage> {
			await latency();
			return outboxEntry(subject, 'Task reminder', speakerIds.length, 'sent');
		},
		async markWaived(taskId: string, speakerId: string): Promise<void> {
			await latency();
			const assignment = db.assignments.find((a) => a.taskId === taskId && a.speakerId === speakerId);
			if (assignment) {
				assignment.state = 'waived';
				assignment.overdue = false;
			}
		},
		/**
		 * Accepts what a speaker already delivered: `received` means the material
		 * is in and waiting on the organizer, so this is the step that closes it.
		 * Refused when the assignment is not in that state, so a stale screen
		 * cannot complete something twice.
		 */
		async acceptFulfillment(taskId: string, speakerId: string): Promise<MutationOutcome> {
			await latency();
			const assignment = db.assignments.find((a) => a.taskId === taskId && a.speakerId === speakerId);
			if (!assignment) return { ok: false, reason: 'This task is no longer assigned to this speaker' };
			if (assignment.state !== 'received') {
				return { ok: false, reason: 'This task is no longer waiting on your acceptance' };
			}
			assignment.state = assignment.overdue ? 'late-complete' : 'complete';
			assignment.overdue = false;
			return { ok: true };
		},
		/**
		 * The compensating write behind a task receipt: puts one assignment back
		 * to the exact mark it carried before the commit being undone.
		 */
		async restoreAssignment(
			taskId: string,
			speakerId: string,
			state: TaskAssignment['state'],
			overdue: boolean
		): Promise<void> {
			await latency();
			const assignment = db.assignments.find((a) => a.taskId === taskId && a.speakerId === speakerId);
			if (assignment) {
				assignment.state = state;
				assignment.overdue = overdue;
			}
		}
	},

	schedule: {
		async state(): Promise<ScheduleState> {
			await latency();
			return { ...db.schedule, rooms: db.schedule.rooms.map(asRoom) };
		},
		async suggestSlots(sessionId: string): Promise<SlotSuggestion[]> {
			await latency();
			const suggestions: SlotSuggestion[] = [];
			const duration = sessionDuration(sessionId);
			const dayLength = db.schedule.slotsPerDay * db.schedule.slotMinutes;
			// A suggestion offers a room for new use, so retired rooms are not
			// proposed; sessions already sitting in one keep their slot.
			const offered = db.schedule.rooms.filter((room) => (room.status ?? 'active') === 'active');
			for (const day of db.schedule.days) {
				for (const room of offered) {
					for (let slot = 0; slot < db.schedule.slotsPerDay; slot += 1) {
						const startMin = slot * db.schedule.slotMinutes;
						if (startMin + duration > dayLength) continue;
						if (conflictsFor(sessionId, day.key, room.id, startMin).length === 0) {
							suggestions.push({ dayKey: day.key, roomId: room.id, startMin, note: 'Free slot' });
							if (suggestions.length >= 6) return suggestions;
							break;
						}
					}
				}
			}
			return suggestions;
		},
		async place(sessionId: string, dayKey: string, roomId: string, startMin: number): Promise<Placement> {
			await latency();
			db.schedule.placements = db.schedule.placements.filter((p) => p.sessionId !== sessionId);
			const placement: Placement = {
				sessionId,
				dayKey,
				roomId,
				startMin,
				conflicts: conflictsFor(sessionId, dayKey, roomId, startMin)
			};
			db.schedule.placements.push(placement);
			recomputeAllConflicts();
			syncScheduleCounters();
			return placement;
		},
		async unplace(sessionId: string): Promise<void> {
			await latency();
			db.schedule.placements = db.schedule.placements.filter((p) => p.sessionId !== sessionId);
			recomputeAllConflicts();
			syncScheduleCounters();
		},
		async addBreak(input: {
			label: string;
			dayKey: string;
			roomId: string;
			startMin: number;
			durationMin: number;
		}): Promise<BreakBlock> {
			await latency();
			const brk: BreakBlock = { id: mintId('brk'), ...input };
			db.schedule.breaks.push(brk);
			recomputeAllConflicts();
			syncScheduleCounters();
			return brk;
		},
		async removeBreak(id: string): Promise<void> {
			await latency();
			db.schedule.breaks = db.schedule.breaks.filter((brk) => brk.id !== id);
			recomputeAllConflicts();
			syncScheduleCounters();
		},
		async publish(): Promise<{ ok: true } | { ok: false; reason: string }> {
			await latency();
			const blocks = scheduleBlockCount();
			if (blocks > 0) {
				return { ok: false, reason: `${blocks} blocking conflict${blocks === 1 ? '' : 's'} must be resolved first` };
			}
			db.schedule.published = true;
			return { ok: true };
		}
	},

	messages: {
		async outbox(): Promise<OutboxMessage[]> {
			await latency();
			return db.outbox;
		},
		async readiness(): Promise<EmailReadiness> {
			await latency();
			return db.readiness;
		},
		async send(id: string): Promise<MutationOutcome> {
			await latency();
			const message = db.outbox.find((entry) => entry.id === id);
			if (!message || (message.state !== 'draft' && message.state !== 'held')) {
				return { ok: false, reason: 'This message is no longer a sendable draft' };
			}
			if (db.readiness.outbound !== 'ready') {
				message.state = 'held';
				message.heldReason = 'Outbound email is not ready — finish provider setup; the send stays queued and releases once setup passes.';
				return { ok: false, reason: message.heldReason };
			}
			message.state = 'sent';
			message.sentAt = 'Just now';
			delete message.heldReason;
			const included = message.review
				? message.review.recipients.filter((recipient) => recipient.state === 'included').length
				: message.audienceCount;
			message.deliveredCount = included;
			return { ok: true };
		},
		async compose(subject: string, audience: string, audienceCount: number): Promise<OutboxMessage> {
			await latency();
			return outboxEntry(subject, audience, audienceCount, 'draft');
		}
	},

	/**
	 * Message and public-surface templates share one agent-assisted editing
	 * loop: classify an instruction, stream a draft, apply it as a new revision,
	 * revert to an earlier one. Every method accepts either kind of id; a draft
	 * is always returned for review — nothing an agent writes reaches the
	 * stored template except through `applyRevision`.
	 */
	templates: {
		async list(): Promise<{ messages: MessageTemplate[]; surfaces: SurfaceTemplate[] }> {
			await latency();
			return { messages: db.templates, surfaces: db.surfaces.map(servedSurface) };
		},
		async get(id: string): Promise<AnyTemplate | null> {
			await latency();
			const surface = db.surfaces.find((entry) => entry.id === id);
			if (surface) return servedSurface(surface);
			return db.templates.find((template) => template.id === id) ?? null;
		},
		/**
		 * The models an edit can be pinned to. The routing default (`auto`) is
		 * always first and is the recommended choice.
		 */
		async modelChoices(): Promise<ModelChoice[]> {
			await latency();
			return structuredClone(templateModelChoices);
		},
		/**
		 * Starter instructions for this template's kind — each one is wording
		 * `revise` visibly acts on. Empty for an unknown id.
		 */
		async suggestions(id: string): Promise<TemplateSuggestion[]> {
			await latency();
			const stored: AnyTemplate | undefined =
				db.templates.find((template) => template.id === id) ??
				db.surfaces.find((surface) => surface.id === id);
			return stored ? suggestionsFor(stored) : [];
		},
		/**
		 * How an instruction would be run, before anything is drafted. A pinned
		 * model (any `modelId` other than `auto`) bypasses routing: the label
		 * echoes the pick and the classification is attributed to the organizer.
		 */
		async classify(id: string, instruction: string, modelId?: string): Promise<EditClassification> {
			void id;
			await wait(300);
			return classifyInstruction(instruction, modelId);
		},
		/**
		 * Drafts a revision, reporting progress as it streams — identically for
		 * messages and surfaces. Resolves with the draft and a one-sentence note
		 * of what changed; the stored template is untouched until the draft is
		 * applied. A pinned model shifts pacing slightly (Opus drafts longer and
		 * slower); the transformation itself is model-independent.
		 */
		async revise(
			id: string,
			instruction: string,
			onProgress?: (p: ReviseProgress) => void,
			modelId?: string
		): Promise<{ draft: AnyTemplate; note: string }> {
			// A surface drafts over its served projection, so the draft's field
			// pool is the registry's current answer, not a stale stored copy.
			const surfaceStored = db.surfaces.find((surface) => surface.id === id);
			const stored: AnyTemplate | undefined =
				db.templates.find((template) => template.id === id) ??
				(surfaceStored ? servedSurface(surfaceStored) : undefined);
			if (!stored) throw new Error(`Unknown template: ${id}`);
			const classification = classifyInstruction(instruction, modelId);
			onProgress?.({ status: 'classifying', tokens: 0 });
			await wait(300);
			const pacing =
				(modelId && modelId !== 'auto' && modelPacing[modelId]) || autoPacing;
			const total = Math.round(
				(classification.scope === 'quick' ? 140 : 900) * pacing.tokenFactor
			);
			const step = classification.scope === 'quick' ? 14 : 31;
			let tokens = 0;
			while (tokens < total) {
				await wait(pacing.tickMs);
				tokens = Math.min(total, tokens + step);
				onProgress?.({ status: 'drafting', tokens });
			}
			const { draft, note } = isSurfaceTemplate(stored)
				? reviseSurfaceDraft(stored, instruction)
				: reviseDraft(stored, instruction);
			draft.revision = stored.revision + 1;
			draft.revisions = [
				...stored.revisions,
				{ number: draft.revision, at: 'Just now', by: 'agent', note }
			];
			onProgress?.({ status: 'done', tokens: total });
			return { draft, note };
		},
		/**
		 * Commits a reviewed draft as the template's next revision. Refused when
		 * the stored template moved on while the draft was under review, so a
		 * stale draft can never silently overwrite newer work.
		 */
		async applyRevision(id: string, draft: AnyTemplate): Promise<MutationOutcome> {
			await latency();
			if (isSurfaceTemplate(draft)) {
				const index = db.surfaces.findIndex((surface) => surface.id === id);
				if (index === -1) return { ok: false, reason: 'This template no longer exists' };
				const stored = db.surfaces[index];
				if (stored.revision !== draft.revision - 1) {
					return { ok: false, reason: 'This template changed while you were editing' };
				}
				snapshotSurface(stored);
				db.surfaces[index] = structuredClone(draft);
				// The draft's field work joins the registry; the next serve
				// projects it back into the form from there.
				syncDraftFields(draft);
				return { ok: true };
			}
			const index = db.templates.findIndex((template) => template.id === id);
			if (index === -1) return { ok: false, reason: 'This template no longer exists' };
			const stored = db.templates[index];
			if (stored.revision !== draft.revision - 1) {
				return { ok: false, reason: 'This template changed while you were editing' };
			}
			snapshotTemplate(stored);
			db.templates[index] = structuredClone(draft);
			return { ok: true };
		},
		/**
		 * Commits a single in-place edit as the template's next revision,
		 * attributed to the organizer with the edit's own note. `next` is the
		 * full document the client rebuilt from the copy on screen, at that
		 * copy's revision; refused when the stored template moved on since that
		 * copy was read, so a stale edit can never silently overwrite newer
		 * work.
		 */
		async commitInline(id: string, next: AnyTemplate, note: string): Promise<MutationOutcome> {
			await latency();
			if (isSurfaceTemplate(next)) {
				const index = db.surfaces.findIndex((surface) => surface.id === id);
				if (index === -1) return { ok: false, reason: 'This template no longer exists' };
				const stored = db.surfaces[index];
				if (stored.revision !== next.revision) {
					return { ok: false, reason: 'This template changed while you were editing' };
				}
				snapshotSurface(stored);
				const committed = structuredClone(next);
				committed.revision = stored.revision + 1;
				committed.revisions = [
					...stored.revisions,
					{ number: committed.revision, at: 'Just now', by: 'you', note }
				];
				db.surfaces[index] = committed;
				return { ok: true };
			}
			const index = db.templates.findIndex((template) => template.id === id);
			if (index === -1) return { ok: false, reason: 'This template no longer exists' };
			const stored = db.templates[index];
			if (stored.revision !== next.revision) {
				return { ok: false, reason: 'This template changed while you were editing' };
			}
			snapshotTemplate(stored);
			const committed = structuredClone(next);
			committed.revision = stored.revision + 1;
			committed.revisions = [
				...stored.revisions,
				{ number: committed.revision, at: 'Just now', by: 'you', note }
			];
			db.templates[index] = committed;
			return { ok: true };
		},
		/**
		 * Restores an earlier revision's content as a new revision on top —
		 * history moves forward, never rewrites. Refused when no stored copy of
		 * that revision's content exists to restore.
		 */
		async revertTo(id: string, revisionNumber: number): Promise<MutationOutcome> {
			await latency();
			const surface = db.surfaces.find((entry) => entry.id === id);
			if (surface) {
				const snapshot = surfaceSnapshots.get(id)?.get(revisionNumber);
				if (!snapshot) {
					return { ok: false, reason: `No stored copy of revision ${revisionNumber} to restore` };
				}
				// The revert itself is revertable: keep what is being replaced.
				snapshotSurface(surface);
				const restored = structuredClone(snapshot);
				surface.blocks = restored.blocks;
				if (restored.fields) surface.fields = restored.fields;
				else delete surface.fields;
				if (restored.submitLabel !== undefined) surface.submitLabel = restored.submitLabel;
				else delete surface.submitLabel;
				surface.revision += 1;
				surface.revisions = [
					...surface.revisions,
					{ number: surface.revision, at: 'Just now', by: 'you', note: `Reverted to revision ${revisionNumber}` }
				];
				return { ok: true };
			}
			const stored = db.templates.find((template) => template.id === id);
			if (!stored) return { ok: false, reason: 'This template no longer exists' };
			const snapshot = templateSnapshots.get(id)?.get(revisionNumber);
			if (!snapshot) {
				return { ok: false, reason: `No stored copy of revision ${revisionNumber} to restore` };
			}
			// The revert itself is revertable: keep what is being replaced.
			snapshotTemplate(stored);
			const restored = structuredClone(snapshot);
			stored.subject = restored.subject;
			stored.blocks = restored.blocks;
			stored.mergeFields = restored.mergeFields;
			stored.revision += 1;
			stored.revisions = [
				...stored.revisions,
				{ number: stored.revision, at: 'Just now', by: 'you', note: `Reverted to revision ${revisionNumber}` }
			];
			return { ok: true };
		}
	},

	/**
	 * The person-and-talk field registry: one list of everything the event
	 * collects, projected into contexts (apply/onboard/profile). Ordering is
	 * user-owned — the placement advisor speaks once, when a field first
	 * enters, and `move` is the only thing that reorders after that. The
	 * application-form surface's question pool is served derived from this
	 * registry (see `servedSurface`), so field mutations here change the form
	 * without any second write.
	 */
	fields: {
		/** Every registry field, in user-owned position order. */
		async list(): Promise<RegistryField[]> {
			await latency();
			return orderedRegistry();
		},
		/**
		 * Registers a new field. The deterministic advisor classifies it and
		 * picks where it enters the current order; the returned placement carries
		 * the index, group, and the one-sentence reason a surface can show.
		 */
		async add(input: {
			kind: FieldKind;
			label: string;
			help?: string;
			options?: string[];
			collectAt: FieldContext[];
			/** Contexts that require an answer; the rest collect it as optional. */
			requiredIn?: FieldContext[];
			/** Names the one form this question belongs to, for per-form extras. */
			formScope?: string;
		}): Promise<{ field: RegistryField; placement: PlacementSuggestion }> {
			await latency();
			const ordered = orderedRegistry();
			const placement = suggestPlacement({ kind: input.kind, label: input.label }, ordered);
			const required: Partial<Record<FieldContext, boolean>> = {};
			for (const context of input.requiredIn ?? []) required[context] = true;
			const field: RegistryField = {
				id: mintId('fld'),
				kind: input.kind,
				label: input.label,
				...(input.help ? { help: input.help } : {}),
				required,
				collectAt: [...input.collectAt],
				...(input.options ? { options: [...input.options] } : {}),
				group: placement.group,
				position: placement.index,
				...(input.formScope ? { formScope: input.formScope } : {})
			};
			ordered.splice(placement.index, 0, field);
			commitRegistryOrder(ordered);
			return { field, placement };
		},
		/**
		 * Edits a field's definition in place. The locked email field refuses a
		 * `collectAt` that drops the apply context — the funnel's one structural
		 * key stays on the application.
		 */
		async update(
			id: string,
			patch: Partial<Pick<RegistryField, 'label' | 'help' | 'options' | 'required' | 'collectAt'>>
		): Promise<MutationOutcome> {
			await latency();
			const field = db.fieldRegistry.find((entry) => entry.id === id);
			if (!field) return { ok: false, reason: 'This field no longer exists' };
			if (field.locked && patch.collectAt && !patch.collectAt.includes('apply')) {
				return { ok: false, reason: lockedFieldRefusal };
			}
			if (patch.label !== undefined) field.label = patch.label;
			if (patch.help !== undefined) field.help = patch.help;
			if (patch.options !== undefined) field.options = patch.options;
			if (patch.required !== undefined) field.required = patch.required;
			if (patch.collectAt !== undefined) field.collectAt = patch.collectAt;
			return { ok: true };
		},
		/** Deletes a field. The locked email field refuses; an already-gone id is a quiet success. */
		async remove(id: string): Promise<MutationOutcome> {
			await latency();
			const field = db.fieldRegistry.find((entry) => entry.id === id);
			if (!field) return { ok: true };
			if (field.locked) return { ok: false, reason: lockedFieldRefusal };
			commitRegistryOrder(orderedRegistry().filter((entry) => entry.id !== id));
			return { ok: true };
		},
		/** Reorders one field to `toIndex` in the list. This is the user owning the order; the advisor is never consulted again. */
		async move(id: string, toIndex: number): Promise<MutationOutcome> {
			await latency();
			const ordered = orderedRegistry();
			const from = ordered.findIndex((entry) => entry.id === id);
			if (from === -1) return { ok: false, reason: 'This field no longer exists' };
			const [field] = ordered.splice(from, 1);
			ordered.splice(Math.max(0, Math.min(ordered.length, toIndex)), 0, field);
			commitRegistryOrder(ordered);
			return { ok: true };
		},
		/**
		 * The compensating write behind a removal receipt: puts the exact field
		 * back at the index it held. A no-op when the id is present again.
		 */
		async restore(field: RegistryField, index: number): Promise<void> {
			await latency();
			if (db.fieldRegistry.some((entry) => entry.id === field.id)) return;
			const ordered = orderedRegistry();
			ordered.splice(Math.max(0, Math.min(ordered.length, index)), 0, structuredClone(field));
			commitRegistryOrder(ordered);
		}
	},

	theme: {
		async get(): Promise<EventTheme> {
			await latency();
			return db.theme;
		},
		async set(theme: EventTheme): Promise<void> {
			await latency();
			db.theme = { ...normalizeThemeRecipe(theme), markText: theme.markText.trim().slice(0, 3) };
		}
	},

	forms: {
		async list(): Promise<FormSummary[]> {
			await latency();
			return db.forms;
		}
	},

	settings: {
		async get(): Promise<EventSettings | null> {
			await latency();
			return db.settings;
		},
		async update(patch: Partial<EventSettings>): Promise<EventSettings | null> {
			await latency();
			if (db.settings) {
				Object.assign(db.settings, patch);
				if (db.settings.startDate && db.settings.endDate) {
					db.settings.dates = formatDateRange(db.settings.startDate, db.settings.endDate);
					if (db.summary.event) db.summary.event.dates = db.settings.dates;
				}
				if (db.summary.event) {
					db.summary.event.name = db.settings.name;
					db.summary.event.location = db.settings.location;
				}
			}
			return db.settings;
		},
		async members(): Promise<Member[]> {
			await latency();
			return db.members;
		},
		async invite(email: string, role: string): Promise<Member> {
			await latency();
			const member: Member = {
				id: `mem-${db.members.length + 1}-${email.length}`,
				name: email.split('@')[0],
				email,
				role,
				status: 'invited'
			};
			db.members.push(member);
			return member;
		},
		async changeRole(id: string, role: string): Promise<MutationOutcome> {
			await latency();
			const member = db.members.find((entry) => entry.id === id);
			if (!member) return { ok: false, reason: 'This member no longer exists' };
			if (member.role === 'Workspace Admin' && role !== 'Workspace Admin' && countActiveAdmins() <= 1) {
				return { ok: false, reason: 'The workspace needs at least one Workspace Admin' };
			}
			member.role = role;
			return { ok: true };
		},
		async removeMember(id: string): Promise<MutationOutcome> {
			await latency();
			const member = db.members.find((entry) => entry.id === id);
			if (!member) return { ok: true };
			if (member.role === 'Workspace Admin' && (member.status ?? 'active') === 'active' && countActiveAdmins() <= 1) {
				return { ok: false, reason: 'The workspace needs at least one Workspace Admin' };
			}
			db.members = db.members.filter((entry) => entry.id !== id);
			return { ok: true };
		}
	}
};

function countActiveAdmins(): number {
	return db.members.filter(
		(member) => member.role === 'Workspace Admin' && (member.status ?? 'active') === 'active'
	).length;
}

function formatDateRange(startIso: string, endIso: string): string {
	const start = new Date(`${startIso}T12:00:00`);
	const end = new Date(`${endIso}T12:00:00`);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${startIso} – ${endIso}`;
	const month = (date: Date) => date.toLocaleDateString('en-US', { month: 'short' });
	const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
	if (sameMonth) {
		return start.getDate() === end.getDate()
			? `${month(start)} ${start.getDate()}, ${start.getFullYear()}`
			: `${month(start)} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
	}
	return `${month(start)} ${start.getDate()} – ${month(end)} ${end.getDate()}, ${end.getFullYear()}`;
}
