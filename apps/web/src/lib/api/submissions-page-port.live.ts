import type { DecisionStateRowDto, StructuredOutcome } from '@jooevents/contracts';
import type { SafeApiError } from './client';
import type { SubmissionTriagePageView, SubmissionTriageRowView } from './mappers/submission-triage';
import type {
	DecisionsLiveClient,
	DecisionsLiveReadResult
} from './operations/decisions-live';
import type {
	DirectEntryWireInput,
	DirectEntryFieldIdentity,
	DirectEntryLiveClient,
	DirectEntryLiveCreateResult
} from './operations/direct-entry-live';
import type {
	SubmissionTriageLiveApplyResult,
	SubmissionTriageLiveClient,
	SubmissionTriageLiveReadResult
} from './operations/submission-triage-live';
import type { OrganizerFormsPort } from './view-models/intake-forms';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import { mapLiveReviewPlans } from './review-page-port.live';
import type { ReviewCorePort } from './review-core-port';
import type { SessionCatalogCorePort } from './session-catalog-port';
import type { SpeakerProfileBatchSource } from './speaker-profile-directory.live';
import type { SubmissionsPagePort } from './submissions-page-port';
import type {
	DirectEntryInput,
	Format,
	ReviewRoundStatus,
	ScoreStanding,
	Submission,
	SubmissionOrigin,
	SubmissionPage,
	SubmissionQuery,
	Track,
	TrayKey
} from './types';
import type { ReviewStandingView } from './view-models/review';
import type { ProgramFormatView, ProgramTrackView } from './view-models/program-vocabulary';

type AdapterFailure = Readonly<{ code: string; reason: string; retryable: boolean }>;

/**
 * Safe, reviewed-copy failure at the tuned Submissions boundary. `retryable`
 * classifies the failure for the consuming surface: the server's own verdict
 * for structured outcomes, the client's for transport, and `false` for
 * refusals whose answer a retry from the same session can never change — so
 * a terminal typed state is never flattened onto a retry affordance.
 */
export class SubmissionsPageLiveError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(failure: AdapterFailure) {
		super(failure.reason);
		this.name = 'SubmissionsPageLiveError';
		this.code = failure.code;
		this.retryable = failure.retryable;
	}
}

function outcomeCopy(outcome: StructuredOutcome, subject: string, channel: 'read' | 'change'): string {
	if (outcome.class === 'access_denied') {
		return channel === 'read'
			? `You no longer have permission to read ${subject}.`
			: `You no longer have permission to change ${subject}.`;
	}
	if (outcome.class === 'stale_revision' || outcome.class === 'conflict') {
		return `The ${subject} changed while you were working. Reload and try again.`;
	}
	return channel === 'read'
		? `This ${subject} request could not be completed.`
		: `This ${subject} change could not be completed.`;
}

function readFailure(
	result:
		| Exclude<SubmissionTriageLiveReadResult<unknown>, { readonly kind: 'success' }>
		| Exclude<DecisionsLiveReadResult<unknown>, { readonly kind: 'success' }>
		| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome }
		| { readonly kind: 'transport_error'; readonly error: SafeApiError }
		| { readonly kind: 'unavailable'; readonly reason: string },
	subject: string
): AdapterFailure {
	if (result.kind === 'unavailable') {
		// The composed manifest is captured once; a retry cannot mount the operation.
		return {
			code: result.reason,
			reason: `The ${subject} is not available in this live workspace.`,
			retryable: false
		};
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? `The ${subject} could not be reached. Try again.`
				: `This ${subject} request is not valid.`,
			retryable: result.error.retryable
		};
	}
	return {
		code: result.outcome.kind,
		reason: outcomeCopy(result.outcome, subject, 'read'),
		retryable: result.outcome.retryable
	};
}

function applyFailure(
	result: Exclude<SubmissionTriageLiveApplyResult, { readonly kind: 'success' }>,
	subject: string
): AdapterFailure {
	if (result.kind === 'unavailable') {
		return {
			code: result.reason,
			reason: `This ${subject} change is not available in this live workspace.`,
			retryable: false
		};
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? `The ${subject} change could not reach JooEvents. Try again.`
				: `This ${subject} change is not valid.`,
			retryable: result.error.retryable
		};
	}
	return {
		code: result.outcome.kind,
		reason: outcomeCopy(result.outcome, subject, 'change'),
		retryable: result.outcome.retryable
	};
}

/** The canonical whole-population reads accept at most this many ids per request. */
const READ_CHUNK = 100;

function chunked<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
	const chunks: Value[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

const WIRE_TRAY: Readonly<Record<TrayKey, 'inbox' | 'set_aside' | 'late' | 'spam'>> =
	Object.freeze({
		inbox: 'inbox',
		'set-aside': 'set_aside',
		late: 'late',
		spam: 'spam'
	});

const VIEW_TRAY: Readonly<Record<'inbox' | 'set_aside' | 'late' | 'spam', TrayKey>> =
	Object.freeze({
		inbox: 'inbox',
		set_aside: 'set-aside',
		late: 'late',
		spam: 'spam'
	});

/**
 * Provenance is never guessed: the tuned vocabulary has no `email` arrival
 * source, and no live operation can mint one today, so an `email` row would
 * mean the projection moved ahead of this seam — surfaced as a contract
 * failure rather than silently re-attributed to another source.
 */
function liveSource(source: SubmissionTriageRowView['source']['source']): Submission['source'] {
	if (source === 'public_form') return 'cfp';
	if (source === 'direct_entry') return 'direct_entry';
	if (source === 'import') return 'import';
	throw new SubmissionsPageLiveError({
		code: 'invalid_contract',
		reason: 'This submission list request could not be completed.',
		retryable: false
	});
}

function standingView(standing: ReviewStandingView): ScoreStanding {
	return {
		value: standing.value,
		scaleMax: standing.scaleMax,
		reviews: standing.reviews,
		n: standing.n,
		median: standing.median,
		band: standing.band,
		phrase: standing.phrase,
		slice: {
			label: standing.slice.label ?? '',
			...(standing.slice.trackId !== undefined ? { trackId: standing.slice.trackId } : {})
		},
		...(standing.points ? { points: [...standing.points] } : {}),
		...(standing.bins ? { bins: [...standing.bins] } : {}),
		...(standing.dotK !== undefined ? { dotK: standing.dotK } : {})
	};
}

function liveTrack(track: ProgramTrackView): Track {
	return {
		id: track.id,
		name: track.name,
		accent: track.accent,
		status: track.status,
		usage: { ...track.usage }
	};
}

function liveFormat(format: ProgramFormatView): Format {
	return {
		id: format.id,
		name: format.name,
		status: format.status,
		usage: { ...format.usage }
	};
}

function defaultIdempotencyKey(): string {
	return `je.submissions.page.action.${globalThis.crypto.randomUUID()}`;
}

/** The canonical answer mappings a keyed-in entry must be able to carry. */
const REQUIRED_MAPPINGS = Object.freeze([
	'talk.title',
	'person.name',
	'person.email',
	'talk.track',
	'talk.format'
] as const);

/**
 * Live tuned Submissions page port over the canonical mounts: the triage
 * spine (list, per-row read, tray transitions through draft -> propose ->
 * commit), the Decision spine's state read (decision facts on rows and the
 * accepted row's origin door), the Review core's whole-slice standings and
 * plans, the live Program Vocabulary, the organizer forms catalog, the
 * Session catalog (session identity only), and the direct-entry create
 * carried through the same registered operation. Everything the canonical
 * mounts cannot truthfully serve surfaces a typed refusal or its typed
 * absence — never sample fallback, fabricated counts, or silent no-ops.
 *
 * Recorded substitutions this seam carries deliberately:
 * - `speakers` states the one served participant: the disclosed display name
 *   with the undisclosed address kept as the empty value — contact stays its
 *   own permission-gated capability and is never invented here.
 * - `notified` is true only when the canonical Decision snapshot carries a
 *   provider acceptance for this submission from a release authored at or
 *   after the current Decision head. Correcting a decision therefore clears
 *   the old notification until the corrected result is accepted too.
 * - `signals` is empty because no signal owner exists — no signal records
 *   exist to report.
 * - `visits.previous()` resolves null: no visit owner records operator
 *   entries, so no previous visit exists to serve.
 */
export function createLiveSubmissionsPagePort(input: {
	readonly triage: SubmissionTriageLiveClient;
	readonly directEntry: DirectEntryLiveClient;
	readonly decisions: Pick<DecisionsLiveClient, 'readState'>;
	readonly review: ReviewCorePort;
	readonly vocabulary: Pick<
		ProgramVocabularySettingsPort,
		'source' | 'tracks' | 'formats' | 'addTrack' | 'addFormat'
	>;
	readonly forms: Pick<OrganizerFormsPort, 'source' | 'list' | 'readDetail'>;
	readonly sessions: SessionCatalogCorePort;
	readonly profileBatch?: SpeakerProfileBatchSource;
	readonly newIdempotencyKey?: () => string;
	readonly now?: () => number;
	readonly profileBatch?: import('./speaker-profile-directory.live').SpeakerProfileBatchSource;
}): SubmissionsPagePort {
	if (
		input.review.source.kind !== 'live'
		|| input.vocabulary.source.kind !== 'live'
		|| input.forms.source.kind !== 'live'
		|| input.sessions.source.kind !== 'live'
	) {
		throw new TypeError('live_submissions_source_required');
	}
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;
	const now = input.now ?? Date.now;

	const EMPTY_TOTALS: Readonly<Record<TrayKey, number>> = Object.freeze({
		inbox: 0,
		'set-aside': 0,
		late: 0,
		spam: 0
	});

	async function readTriagePage(query: SubmissionQuery): Promise<SubmissionTriagePageView | null> {
		const result = await input.triage.list({
			...(query.tray ? { tray: WIRE_TRAY[query.tray] } : {}),
			...(query.trackId ? { trackId: query.trackId } : {}),
			...(query.formatId ? { formatId: query.formatId } : {}),
			...(query.search ? { search: query.search } : {})
		});
		if (result.kind === 'outcome'
			&& result.outcome.kind === 'submission_triage.not_initialized') {
			// Whole-population fact, not a failure: triage initializes in the
			// same transaction as every acceptance, so an uninitialized spine
			// states that no submission has ever been accepted for this event.
			return null;
		}
		if (result.kind !== 'success') {
			throw new SubmissionsPageLiveError(readFailure(result, 'submission list'));
		}
		return result.data;
	}

	async function readDecisionRows(
		submissionIds: readonly string[]
	): Promise<ReadonlyMap<string, DecisionStateRowDto>> {
		const rows = new Map<string, DecisionStateRowDto>();
		for (const chunk of chunked(submissionIds, READ_CHUNK)) {
			const result = await input.decisions.readState(chunk);
			if (result.kind !== 'success') {
				throw new SubmissionsPageLiveError(readFailure(result, 'decision state'));
			}
			for (const row of result.data.rows) rows.set(row.submissionId, row);
		}
		return rows;
	}

	async function readStandings(
		submissionIds: readonly string[]
	): Promise<Record<string, ScoreStanding>> {
		const merged: Record<string, ScoreStanding> = {};
		for (const chunk of chunked([...new Set(submissionIds)], READ_CHUNK)) {
			const result = await input.review.readSnapshot({ standingSubmissionIds: [...chunk] });
			if (result.kind !== 'success') {
				throw new SubmissionsPageLiveError(readFailure(result, 'review standings'));
			}
			for (const [submissionId, standing] of Object.entries(result.data.standings)) {
				merged[submissionId] = standingView(standing);
			}
		}
		return merged;
	}

	function submissionRow(
		row: SubmissionTriageRowView,
		decision: DecisionStateRowDto | undefined,
		standing: ScoreStanding | undefined
	): Submission {
		const head = decision?.head ?? null;
		const attribution = row.head.setAsideAttribution;
		return {
			id: row.source.id,
			title: row.source.title,
			// The canonical absence stays the empty value the tuned surface names.
			abstract: row.source.abstract ?? '',
			speakers: [{
				name: row.source.primaryParticipantName ?? '',
				...(row.source.primaryParticipantId
					? { personId: row.source.primaryParticipantId } : {}),
				// The address is a separately permission-gated disclosure; the
				// empty value carries its absence, never an invented contact.
				email: ''
			}],
			trackId: row.source.track?.id ?? '',
			formatId: row.source.format?.id ?? '',
			submittedAt: row.source.submittedAt,
			source: liveSource(row.source.source),
			...(row.source.target.kind === 'session'
				? { targetSessionId: row.source.target.sessionId }
				: {}),
			tray: VIEW_TRAY[row.visibleTray],
			...(attribution?.kind === 'registered_run'
				? { setAsideBy: attribution.standingPolicy.key }
				: {}),
			decision: head === null ? 'undecided' : head.state,
			...(head !== null ? { decidedAt: head.decidedAt } : {}),
			notified: decision?.notificationAcceptedAt != null,
			signals: [],
			...(standing !== undefined ? { reviewAverage: standing.value, standing } : {}),
			// An absent standing is the canonical served absence: no committed
			// scored review exists for this submission, so zero is the truth.
			reviewCount: standing?.reviews ?? 0
		};
	}

	async function assembleRows(
		rows: readonly SubmissionTriageRowView[]
	): Promise<Submission[]> {
		if (rows.length === 0) return [];
		const ids = rows.map((row) => row.source.id);
		const [decisions, standings] = await Promise.all([
			readDecisionRows(ids),
			readStandings(ids)
		]);
		return rows.map((row) =>
			submissionRow(row, decisions.get(row.source.id), standings[row.source.id])
		);
	}

	async function readRow(submissionId: string): Promise<SubmissionTriageRowView> {
		const result = await input.triage.read(submissionId);
		if (result.kind !== 'success') {
			throw new SubmissionsPageLiveError(readFailure(result, 'submission'));
		}
		return result.data;
	}

	/**
	 * One transition for an exact id set: fresh per-row heads and the newest
	 * query guard pin the change, and the triage client carries it through
	 * draft, propose, and commit. Ids travel in canonical code-unit order.
	 */
	async function transition(
		action: 'set_aside' | 'return_to_inbox' | 'mark_spam' | 'not_spam',
		ids: readonly string[]
	): Promise<void> {
		if (ids.length === 0) return;
		const sorted = [...new Set(ids)].sort();
		const reads = [];
		for (const id of sorted) reads.push(await readRow(id));
		const guard = reads.reduce((newest, row) =>
			row.queryGuard.version > newest.queryGuard.version ? row : newest
		).queryGuard;
		const applied = await input.triage.apply({
			action,
			submissionIds: [...sorted],
			expectedHeads: reads.map((row) => ({
				submissionId: row.source.id,
				version: row.head.version
			})),
			expectedQueryGuard: { version: guard.version, digestSha256: guard.digestSha256 }
		}, newIdempotencyKey());
		if (applied.kind !== 'success') {
			throw new SubmissionsPageLiveError(applyFailure(applied, 'submission'));
		}
	}

	// -----------------------------------------------------------------------
	// Direct entry: the organizer keys a proposal in through an open form.

	function directEntryRefusal(code: string, reason: string): SubmissionsPageLiveError {
		// Each of these names a standing gap (no accept-at-creation owner, one
		// speaker only, no qualifying open form); resubmitting the identical
		// entry refuses identically, so the remedy is the copy, never a retry.
		return new SubmissionsPageLiveError({ code, reason, retryable: false });
	}

	async function readFormsCatalog() {
		const result = await input.forms.list();
		if (result.kind !== 'success') {
			throw new SubmissionsPageLiveError(readFailure(result, 'form catalog'));
		}
		return result.data;
	}

	async function readFieldIdentities(): Promise<readonly DirectEntryFieldIdentity[]> {
		const result = await input.directEntry.readFieldIdentities();
		if (result.kind !== 'success') {
			throw new SubmissionsPageLiveError(readFailure(result, 'field registry'));
		}
		return result.data.fields;
	}

	interface DirectEntryFormPlan {
		readonly formId: string;
		readonly expectedFormDefinitionVersion: number;
		readonly fieldByMapping: ReadonlyMap<string, DirectEntryFieldIdentity>;
	}

	/**
	 * Picks the first open form (catalog order) whose published version can
	 * truthfully carry the keyed-in facts. A form that cannot record the
	 * declared title, speaker, track, or format is never chosen — dropping a
	 * declared fact silently would misstate what the organizer entered — and a
	 * category-targeted form qualifies only when its pinned category IS one of
	 * the declared facts, so the entry's routing never contradicts what was
	 * keyed in. General-pool forms are preferred when both are open.
	 */
	async function planDirectEntryForm(entry: DirectEntryInput): Promise<DirectEntryFormPlan> {
		const [catalog, identities] = await Promise.all([
			readFormsCatalog(),
			readFieldIdentities()
		]);
		const identityById = new Map(identities.map((field) => [field.id, field]));
		const open = catalog.forms.filter((form) => form.status === 'open');
		const candidates = entry.targetSessionId
			? open.filter((form) =>
					form.target.kind === 'session' && form.target.sessionId === entry.targetSessionId)
			: [
					...open.filter((form) => form.target.kind === 'general_pool'),
					...open.filter((form) =>
						form.target.kind === 'category'
						&& (form.target.categoryKind === 'track'
							? form.target.categoryId === entry.trackId
							: form.target.categoryId === entry.formatId))
				];
		for (const candidate of candidates) {
			const detail = await input.forms.readDetail(candidate.id);
			if (detail.kind !== 'success') {
				throw new SubmissionsPageLiveError(readFailure(detail, 'form'));
			}
			const form = detail.data;
			// Only an open form with a published version accepts entries. The
			// head version moves on every head change (opening included), so
			// the definition-version pin travels on the wire instead: the
			// server refuses a stale `expectedFormDefinitionVersion` rather
			// than this seam guessing at published-definition coherence.
			if (form.form.status !== 'open' || form.publishedVersion === null) {
				continue;
			}
			const fieldByMapping = new Map<string, DirectEntryFieldIdentity>();
			for (const row of form.fields) {
				if (!row.included) continue;
				const identity = identityById.get(row.field.id);
				if (identity?.mapsTo) fieldByMapping.set(identity.mapsTo, identity);
			}
			const needed = [
				...REQUIRED_MAPPINGS,
				...(entry.abstract !== undefined ? (['talk.abstract'] as const) : [])
			];
			if (needed.every((mapping) => fieldByMapping.has(mapping))) {
				return {
					formId: form.form.id,
					expectedFormDefinitionVersion: form.form.version,
					fieldByMapping
				};
			}
		}
		throw directEntryRefusal(
			'direct_entry_form_unavailable',
			entry.targetSessionId
				? 'No open application form collects proposals for that session.'
				: 'No open application form asks the fields a direct entry needs (title, speaker name and email, track, format). Open your call for proposals first.'
		);
	}

	function directEntryAnswers(
		entry: DirectEntryInput,
		plan: DirectEntryFormPlan
	): DirectEntryWireInput['answers'] {
		const field = (mapping: string) => plan.fieldByMapping.get(mapping)!;
		const speaker = entry.speakers[0]!;
		const answers: DirectEntryWireInput['answers'] = [
			{ kind: 'text', fieldId: field('talk.title').id, value: entry.title },
			{ kind: 'text', fieldId: field('person.name').id, value: speaker.name },
			{ kind: 'email', fieldId: field('person.email').id, value: speaker.email },
			{ kind: 'select', fieldId: field('talk.track').id, choiceId: entry.trackId },
			{ kind: 'select', fieldId: field('talk.format').id, choiceId: entry.formatId }
		];
		if (entry.abstract !== undefined) {
			answers.push({
				kind: 'textarea',
				fieldId: field('talk.abstract').id,
				value: entry.abstract
			});
		}
		return answers.sort((left, right) => (left.fieldId < right.fieldId ? -1 : 1));
	}

	function createFailure(
		result: Exclude<DirectEntryLiveCreateResult, { readonly kind: 'success' }>
	): AdapterFailure {
		if (result.kind === 'unavailable') {
			return {
				code: result.reason,
				reason: 'Direct entry is not available in this live workspace.',
				retryable: false
			};
		}
		if (result.kind === 'transport_error') {
			return {
				code: result.error.code,
				reason: result.error.retryable
					? 'The direct entry could not reach JooEvents. Try again.'
					: 'This direct entry is not valid.',
				retryable: result.error.retryable
			};
		}
		return {
			code: result.outcome.kind,
			reason: outcomeCopy(result.outcome, 'direct entry', 'change'),
			retryable: result.outcome.retryable
		};
	}

	async function readSessionHeads() {
		const result = await input.sessions.readCatalog();
		if (result.kind !== 'success') {
			throw new SubmissionsPageLiveError(readFailure(result, 'session catalog'));
		}
		return result.data.sessions;
	}

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		submissions: Object.freeze({
			async list(query: SubmissionQuery = {}): Promise<SubmissionPage> {
				const page = await readTriagePage(query);
				if (page === null) {
					return { rows: [], trayTotals: { ...EMPTY_TOTALS } };
				}
				return {
					rows: await assembleRows(page.rows),
					trayTotals: {
						inbox: page.trayTotals.inbox,
						'set-aside': page.trayTotals.set_aside,
						late: page.trayTotals.late,
						spam: page.trayTotals.spam
					},
					...(page.search
						? {
								search: {
									query: page.search.query,
									matched: page.search.matched,
									scanned: page.search.scanned
								}
							}
						: {})
				};
			},

			async addDirectEntry(entry: DirectEntryInput): Promise<Submission> {
				if (entry.disposition === 'accepted') {
					throw directEntryRefusal(
						'direct_entry_accept_unavailable',
						'Accepting at creation is not available in this live workspace yet. Add it to the inbox, then accept it on Decisions.'
					);
				}
				if (entry.speakers.length !== 1) {
					throw directEntryRefusal(
						'direct_entry_single_speaker',
						'A live direct entry currently records exactly one speaker.'
					);
				}
				const plan = await planDirectEntryForm(entry);
				const created = await input.directEntry.create({
					formId: plan.formId,
					expectedFormDefinitionVersion: plan.expectedFormDefinitionVersion,
					answers: directEntryAnswers(entry, plan)
				}, newIdempotencyKey());
				if (created.kind !== 'success') {
					throw new SubmissionsPageLiveError(createFailure(created));
				}
				// Refetch, not optimism: the returned row is the canonical
				// re-read of what actually committed, joined with its served
				// decision state — never a locally synthesized echo.
				const row = await readRow(created.data.submissionId);
				const decisions = await readDecisionRows([created.data.submissionId]);
				return submissionRow(row, decisions.get(created.data.submissionId), undefined);
			},


			async setAside(ids: readonly string[]): Promise<void> {
				await transition('set_aside', ids);
			},
			async returnToInbox(ids: readonly string[]): Promise<void> {
				await transition('return_to_inbox', ids);
			},
			async markSpam(ids: readonly string[]): Promise<void> {
				await transition('mark_spam', ids);
			},
			async notSpam(ids: readonly string[]): Promise<void> {
				await transition('not_spam', ids);
			}
		}),
		speakers: Object.freeze({
			/** Null is the port's own typed absence for an unknown profile. */
			async profile(): Promise<null> {
				return null;
			},
			...(input.profileBatch ? { profiles: input.profileBatch.profiles } : {})
		}),
		review: Object.freeze({
			async standings(submissionIds: readonly string[]): Promise<Record<string, ScoreStanding>> {
				if (submissionIds.length === 0) return {};
				return readStandings(submissionIds);
			},
			/**
			 * The newest round on the served plan, reduced to the station
			 * groups' one review fact. Null while no round has ever been opened.
			 */
			async round(): Promise<ReviewRoundStatus | null> {
				const result = await input.review.readSnapshot();
				if (result.kind !== 'success') {
					throw new SubmissionsPageLiveError(readFailure(result, 'review plan'));
				}
				const served = result.data.plans.filter((plan) => plan.state !== 'discarded');
				const newest = served.at(-1);
				if (!newest) return null;
				const mapped = mapLiveReviewPlans(result.data.plans, now())
					.find((plan) => plan.id === newest.id);
				if (!mapped) return null;
				const open = newest.state === 'open';
				// The tone comes from the canonical deadline instant, never from
				// parsing the phrase beside it: warning inside the last two days,
				// danger once an open round is past due, calm otherwise.
				const remainingMs = Date.parse(newest.deadlineEffectiveAt) - now();
				const deadlineTone = !open
					? ('calm' as const)
					: remainingMs < 0
						? ('danger' as const)
						: remainingMs <= 48 * 3_600_000
							? ('warning' as const)
							: ('calm' as const);
				return {
					open,
					name: mapped.name,
					percentDone: mapped.total === 0
						? 0
						: Math.round((mapped.done / mapped.total) * 100),
					dueLabel: mapped.deadlineRelative,
					deadlineTone,
					...(mapped.reviewsPerSubmission !== undefined
						? { reviewsPerSubmission: mapped.reviewsPerSubmission }
						: {})
				};
			}
		}),
		arrivals: Object.freeze({
			/**
			 * The pulse needs visit history and a cross-tray arrival read, and
			 * the live workspace records neither yet (the same absence
			 * `visits.previous` serves below). Null is the honest answer, and
			 * the head says nothing about newness rather than inventing a
			 * window nobody measured.
			 */
			async pulse(): Promise<null> {
				return null;
			}
		}),
		visits: Object.freeze({
			/**
			 * No visit owner records operator entries in the live workspace, so
			 * no previous visit exists to serve; null is that served absence
			 * (the tuned surface reads it as a first visit and marks only
			 * same-day arrivals).
			 */
			async previous(): Promise<string | null> {
				return null;
			}
		}),
		vocab: Object.freeze({
			tracks: async () => (await input.vocabulary.tracks()).map(liveTrack),
			formats: async () => (await input.vocabulary.formats()).map(liveFormat),
			addTrack: async (name: string) => liveTrack(await input.vocabulary.addTrack(name)),
			addFormat: async (name: string) => liveFormat(await input.vocabulary.addFormat(name))
		}),
		schedule: Object.freeze({
			/** Session identity only ever comes from the canonical catalog. */
			async collectingSessions(): Promise<readonly { readonly id: string; readonly title: string }[]> {
				return (await readSessionHeads())
					.filter((session) => session.lifecycle === 'collecting')
					.map((session) => ({ id: session.id, title: session.title }));
			},
			/**
			 * Where an accepted submission went, from the Decision spine's own
			 * origin link; the session's title comes from the catalog head, so
			 * the door never invents an identity the program does not hold.
			 */
			async originOf(submissionId: string): Promise<SubmissionOrigin | null> {
				return (await this.originsOf([submissionId]))[submissionId] ?? null;
			},
			async originsOf(
				submissionIds: readonly string[]
			): Promise<Readonly<Record<string, SubmissionOrigin | null>>> {
				const ids = [...new Set(submissionIds)];
				const origins: Record<string, SubmissionOrigin | null> = {};
				for (const id of ids) origins[id] = null;
				if (ids.length === 0) return origins;
				const [decisions, sessions] = await Promise.all([
					readDecisionRows(ids),
					readSessionHeads()
				]);
				const sessionsById = new Map(sessions.map((session) => [session.id, session]));
				for (const id of ids) {
					const origin = decisions.get(id)?.origin ?? null;
					if (origin === null) continue;
					const session = sessionsById.get(origin.sessionId);
					if (!session) {
						throw new SubmissionsPageLiveError({
							code: 'origin_session_missing',
							reason: 'The session this submission graduated into could not be read. Try again.',
							retryable: true
						});
					}
					origins[id] = {
						sessionId: origin.sessionId,
						title: session.title,
						kind: origin.kind === 'spawned' ? 'spawn' : 'attach'
					};
				}
				return origins;
			}
		}),
		forms: Object.freeze({
			/** The served count of forms currently taking submissions. */
			async openCount(): Promise<number> {
				const catalog = await readFormsCatalog();
				return catalog.forms.filter((form) => form.status === 'open').length;
			}
		})
	} satisfies SubmissionsPagePort);
}
