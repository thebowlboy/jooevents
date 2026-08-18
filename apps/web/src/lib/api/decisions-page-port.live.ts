import {
	DECISION_DECIDE_ROWS_MAX,
	decisionTargetUnavailableDetailSchema,
	type DecisionStateRowDto,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { SafeApiError } from './client';
import { accoladePortKey } from './accolades';
import type {
	CommunicationAuthoringPayloadRefView,
	CommunicationAudienceOptionPageView,
	MessagePreviewSummaryView,
	MessageTemplatePageView
} from './view-models/communications-authoring';
import type { CommunicationsAuthoringPort } from './communications-authoring-port';
import type { CommunicationsReadinessPagePort } from './communications-readiness-page-port';
import type { DecisionsPagePort } from './decisions-page-port';
import type {
	DecisionsLiveClient,
	DecisionsLiveDecideResult,
	DecisionsLiveReadResult
} from './operations/decisions-live';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import { mapLiveReviewPlans } from './review-page-port.live';
import type { ReviewCorePort } from './review-core-port';
import { createInFlightSlot, shareInFlight } from './in-flight';
import type { SpeakerProfileBatchSource } from './speaker-profile-directory.live';
import type {
	AccoladeDef,
	DecisionState,
	EmailReadiness,
	EventSettings,
	MessageReview,
	MessageTemplate,
	MyReviewItem,
	NotificationDispatch,
	RecipientRow,
	RenderedEmailPreview,
	ReviewPlan,
	ScheduleState,
	ScoreStanding,
	SubmissionPage,
	SubmissionQuery,
	Track
} from './types';
import type { ReviewSnapshotView, ReviewStandingView } from './view-models/review';
import type { ProgramTrackView } from './view-models/program-vocabulary';

/**
 * The tuned page capabilities this deliberately partial live mount cannot
 * truthfully serve yet, each refused with its own name so a failure states
 * exactly which owner has not joined.
 */
export type DecisionsPageLiveUnmountedCapability =
	| 'decision_review_evidence'
	| 'decision_undecided_unavailable'
	| 'decision_withdrawn_authoring';

type AdapterFailure = Readonly<{ code: string; reason: string; retryable: boolean }>;

/**
 * Safe, reviewed-copy failure at the tuned Decisions boundary. `retryable`
 * classifies the failure for the consuming surface the way the review
 * resolution seam records: the server's own verdict for structured outcomes,
 * the client's for transport, and `false` for refusals whose answer a retry
 * from the same session can never change — so a terminal typed state is never
 * flattened onto a retry affordance.
 */
export class DecisionsPageLiveError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(failure: AdapterFailure) {
		super(failure.reason);
		this.name = 'DecisionsPageLiveError';
		this.code = failure.code;
		this.retryable = failure.retryable;
	}
}

const UNMOUNTED_COPY: Readonly<Record<DecisionsPageLiveUnmountedCapability, string>> =
	Object.freeze({
		decision_review_evidence:
			'Individual committed reviews are not served on this surface; the standing beside the row is the whole aggregate evidence.',
		decision_undecided_unavailable:
			'A committed decision cannot be returned to undecided from here.',
		decision_withdrawn_authoring:
			'Withdrawal belongs to the submitter; it cannot be set from this surface.'
	});

function unmounted(capability: DecisionsPageLiveUnmountedCapability): DecisionsPageLiveError {
	// A capability this mount deliberately does not carry cannot appear on retry.
	return new DecisionsPageLiveError({
		code: capability,
		reason: UNMOUNTED_COPY[capability],
		retryable: false
	});
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

const TARGET_UNAVAILABLE_REASON: Readonly<Record<string, string>> = Object.freeze({
	target_graduated: 'has already graduated into the program',
	target_closed: 'is no longer collecting proposals',
	target_missing: 'no longer exists'
});

/**
 * The typed re-offer surface for a refused attach: the server's structured
 * `decision.target_unavailable` refusal names its two decided exits, and this
 * copy re-offers exactly those — re-target another collecting session or
 * accept as a new session — never a silent fallback the organizer did not
 * choose.
 */
function decideFailure(
	result: Exclude<DecisionsLiveDecideResult, { readonly kind: 'success' }>
): AdapterFailure {
	if (result.kind === 'unavailable') {
		return {
			code: result.reason,
			reason: 'Deciding is not available in this live workspace.',
			retryable: false
		};
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? 'The decision could not reach JooEvents. Try again.'
				: 'This decision is not valid.',
			retryable: result.error.retryable
		};
	}
	if (result.outcome.kind === 'decision.target_unavailable') {
		const detail = decisionTargetUnavailableDetailSchema.safeParse(result.outcome.detail);
		const because = detail.success
			? TARGET_UNAVAILABLE_REASON[detail.data.reason] ?? 'cannot take this proposal'
			: 'cannot take this proposal';
		return {
			code: result.outcome.kind,
			reason: `The session this proposal targeted ${because}. Re-target it at another collecting session, or accept it as a new session in the program pool.`,
			// Retrying the identical accept refuses identically; the two decided
			// exits in the copy are the only ways forward.
			retryable: false
		};
	}
	return {
		code: result.outcome.kind,
		reason: outcomeCopy(result.outcome, 'decision', 'change'),
		retryable: result.outcome.retryable
	};
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

function myReviewItem(item: NonNullable<ReviewSnapshotView['queue']>[number]): MyReviewItem {
	const current = item.committed ? item.current : undefined;
	const score = current ? current.score : item.draft?.score;
	const comment = current ? current.comment : item.draft?.comment;
	return {
		submissionId: item.submissionId,
		...(score !== undefined ? { myScore: score } : {}),
		...(comment !== undefined ? { myComment: comment } : {}),
		committed: item.committed,
		...(item.peerScores ? { peerScores: [...item.peerScores] } : {})
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

/** The canonical whole-population reads accept at most this many ids per request. */
const READ_CHUNK = 100;

function chunked<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
	const chunks: Value[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

function defaultIdempotencyKey(): string {
	return `je.decisions.page.action.${globalThis.crypto.randomUUID()}`;
}

/**
 * Live tuned Decisions page port over the canonical mounts: candidate rows
 * come from the composed live Submissions surface (triage joined with the
 * Decision spine's head state), aggregate review evidence comes from the
 * Review core's whole-slice standings (chunked ≤100-id reads), and a verdict
 * is a consequential decide carried through draft -> propose -> commit with
 * per-row version/digest guards read immediately before drafting.
 *
 * Graduation routing is deliberately left to the server's recorded rule: an
 * accepted submission with a resolvable collecting target attaches, anything
 * else spawns a new session. A refused attach surfaces the typed
 * `decision.target_unavailable` re-offer (re-target or spawn) — never an
 * automatic exit the organizer did not choose. Notification affordances are
 * typed refusals until the send wave; nothing is ever pretended sent.
 */
export function createLiveDecisionsPagePort(input: {
	readonly decisions: DecisionsLiveClient;
	readonly review: ReviewCorePort;
	readonly vocabulary: Pick<ProgramVocabularySettingsPort, 'source' | 'tracks'>;
	readonly settings: { get(): Promise<EventSettings | null> };
	readonly schedule: { state(): Promise<ScheduleState> };
	readonly submissions: { list(query?: SubmissionQuery): Promise<SubmissionPage> };
	/** The mounted communication authoring/preview/send lane the notify loop rides. */
	readonly communications: Pick<
		CommunicationsAuthoringPort,
		| 'source'
		| 'listTemplates'
		| 'listAudienceOptions'
		| 'storeAuthoringPayload'
		| 'createDraft'
		| 'reviseDraft'
		| 'prepareBatchPreview'
		| 'adoptBatchPreview'
		| 'listPreviewRecipients'
		// The send ceremony renders what it is about to send; this is the read
		// that produces one recipient's actual rendered copy.
		| 'getPreview'
		| 'sendMessages'
		| 'getDeliveryHistory'
	>;
	/** The one factual provider-readiness read; never a browser guess. */
	readonly readiness: Pick<CommunicationsReadinessPagePort, 'read'>;
	readonly newIdempotencyKey?: () => string;
	readonly now?: () => number;
	readonly profileBatch?: SpeakerProfileBatchSource;
}): DecisionsPagePort {
	if (
		input.review.source.kind !== 'live'
		|| input.vocabulary.source.kind !== 'live'
		|| input.communications.source.kind !== 'live'
	) {
		throw new TypeError('live_decisions_source_required');
	}
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;
	const now = input.now ?? Date.now;
	const snapshotSlots = new Map<string, { current: Promise<ReviewSnapshotView> | null }>();

	async function readSnapshot(
		request: { standingSubmissionIds?: string[] } = {}
	): Promise<ReviewSnapshotView> {
		const key = JSON.stringify({ ids: request.standingSubmissionIds ?? [] });
		let slot = snapshotSlots.get(key);
		if (!slot) {
			slot = createInFlightSlot();
			snapshotSlots.set(key, slot);
		}
		return shareInFlight(slot, async () => {
			const result = await input.review.readSnapshot(request);
			if (result.kind !== 'success') {
				throw new DecisionsPageLiveError(readFailure(result, 'review snapshot'));
			}
			return result.data;
		});
	}

	async function readDecisionRows(
		submissionIds: readonly string[]
	): Promise<ReadonlyMap<string, DecisionStateRowDto>> {
		const rows = new Map<string, DecisionStateRowDto>();
		for (const chunk of chunked(submissionIds, READ_CHUNK)) {
			const result = await input.decisions.readState(chunk);
			if (result.kind !== 'success') {
				throw new DecisionsPageLiveError(readFailure(result, 'decision state'));
			}
			for (const row of result.data.rows) rows.set(row.submissionId, row);
		}
		return rows;
	}

	// --- Decision-notification review and send (the mounted send lane) -----

	/** The two decision outcomes the seeded notification lane carries (BLOCKED-4). */
	const NOTIFIABLE = Object.freeze({
		accepted: Object.freeze({
			templateKey: 'decision.accepted',
			recipeId: 'recipe.communication.decision-set.accepted'
		}),
		declined: Object.freeze({
			templateKey: 'decision.declined',
			recipeId: 'recipe.communication.decision-set.declined'
		})
	});
	type NotifiableStatus = keyof typeof NOTIFIABLE;
	const REVIEW_SUBJECT = 'Your submission decision';

	interface NotificationSegment {
		readonly status: NotifiableStatus;
		readonly templateName: string;
		readonly templateRevision: MessageTemplatePageView['rows'][number]['revision'];
		readonly purposeRevision: CommunicationAudienceOptionPageView['rows'][number]['audienceDraft']['purposeRevision'];
		readonly audienceLabel: string;
		readonly audiencePayload: CommunicationAuthoringPayloadRefView;
		readonly draftId: string;
		readonly draftVersion: number;
		readonly subject: string;
		readonly summary: MessagePreviewSummaryView;
	}

	/**
	 * The adopted previews the open dialog reviewed, keyed by the exact
	 * un-notified id set. `notify` sends exactly these adoptions (re-adopting
	 * only when the operator edited the subject); a send against decisions
	 * that drifted since refuses typed server-side, never silently re-plans.
	 */
	let pendingNotification: { readonly key: string; segments: NotificationSegment[] } | null =
		null;

	/**
	 * Which adopted preview each listed recipient belongs to. One notify batch
	 * adopts a preview per decision outcome, so a recipient's rendered copy has
	 * to be asked for against the identity that actually resolved them — the
	 * acceptance preview cannot render a waitlisted person.
	 */
	const previewIdentityByRecipient = new Map<string, MessagePreviewSummaryView['identity']>();

	function notificationKey(ids: readonly string[]): string {
		return [...new Set(ids)].sort().join('\n');
	}

	function sendFailure(
		result: Exclude<
			Awaited<ReturnType<CommunicationsAuthoringPort['sendMessages']>>,
			{ readonly kind: 'success' }
		>,
		subject: string
	): AdapterFailure {
		if (result.kind === 'unavailable' || result.kind === 'transport_error') {
			return readFailure(result, subject);
		}
		if (result.outcome.kind === 'communication.preview_changed') {
			return {
				code: result.outcome.kind,
				reason:
					'The decisions changed while you were reviewing. Reopen the notification dialog to review the current audience; nothing was sent.',
				retryable: false
			};
		}
		return {
			code: result.outcome.kind,
			reason: outcomeCopy(result.outcome, subject, 'change'),
			retryable: result.outcome.retryable
		};
	}

	async function adoptSegmentPreview(segment: {
		readonly draftId: string;
		readonly draftVersion: number;
	}): Promise<MessagePreviewSummaryView> {
		const prepared = await input.communications.prepareBatchPreview({
			draftId: segment.draftId,
			expectedDraftVersion: segment.draftVersion
		});
		if (prepared.kind !== 'success') {
			throw new DecisionsPageLiveError(readFailure(prepared, 'notification preview'));
		}
		const adopted = await input.communications.adoptBatchPreview(
			{ draftId: segment.draftId, expectedDraftVersion: segment.draftVersion },
			newIdempotencyKey()
		);
		if (adopted.kind !== 'success') {
			throw new DecisionsPageLiveError(sendFailure(adopted, 'notification preview'));
		}
		return adopted.data;
	}

	async function storeNotificationContent(
		segment: Pick<NotificationSegment, 'templateRevision'>,
		subject: string
	): Promise<CommunicationAuthoringPayloadRefView> {
		const stored = await input.communications.storeAuthoringPayload(
			{
				payloadKind: 'message_content',
				schemaVersion: 1,
				value: {
					kind: 'email/v1',
					subject,
					body: {
						kind: 'template_revision/v1',
						templateRevision: {
							templateId: segment.templateRevision.templateId,
							templateRevisionId: segment.templateRevision.templateRevisionId,
							revisionNumber: segment.templateRevision.revisionNumber,
							digestSha256: segment.templateRevision.digestSha256
						}
					}
				}
			},
			newIdempotencyKey()
		);
		if (stored.kind !== 'success') {
			throw new DecisionsPageLiveError(sendFailure(stored, 'notification content'));
		}
		return stored.data;
	}

	function recipientRow(
		row: Awaited<
			ReturnType<CommunicationsAuthoringPort['listPreviewRecipients']>
		> extends infer Result
			? Result extends { readonly kind: 'success'; readonly data: { readonly rows: readonly (infer Row)[] } }
				? Row
				: never
			: never
	): RecipientRow {
		const email = row.channel.disclosure === 'exact_authorized'
			? row.channel.exactValue
			: row.channel.disclosure === 'masked'
				? row.channel.maskedValue
				: '';
		return {
			name: row.safeLabel,
			email,
			state: row.state,
			...(row.state === 'included' ? {} : { reason: row.reasonCode }),
			// Carried so the ceremony can ask for this person's rendered copy;
			// without it a row can be listed but never shown.
			recipientResolutionId: row.recipientResolutionId
		};
	}

	/**
	 * Builds one reviewed, adopted preview per notifiable decision outcome in
	 * the selection: seeded template + minted decision-set audience recipe →
	 * stored content/audience payloads → draft → prepared and adopted preview
	 * → the per-recipient projection the dialog shows. The recipients are the
	 * audience truth (the whole decided set of that outcome), and every step
	 * is a mounted operation — nothing here fabricates a review.
	 */
	async function buildNotificationReview(ids: readonly string[]): Promise<MessageReview> {
		const heads = await readDecisionRows([...new Set(ids)]);
		const statuses = new Set<NotifiableStatus>();
		for (const row of heads.values()) {
			const state = row.head?.state;
			if (state === 'accepted' || state === 'declined') statuses.add(state);
		}
		if (statuses.size === 0) {
			throw new DecisionsPageLiveError({
				code: 'decision_notification_no_notifiable_outcome',
				reason:
					'Only accepted and declined decisions have notification templates in this workspace.',
				retryable: false
			});
		}
		const [templates, options] = await Promise.all([
			input.communications.listTemplates({ lifecycle: 'active' }),
			input.communications.listAudienceOptions()
		]);
		if (templates.kind !== 'success') {
			throw new DecisionsPageLiveError(readFailure(templates, 'notification template list'));
		}
		if (options.kind !== 'success') {
			throw new DecisionsPageLiveError(readFailure(options, 'notification audience list'));
		}
		const segments: NotificationSegment[] = [];
		const recipients: RecipientRow[] = [];
		// A fresh review re-adopts its previews, so last review's resolution ids
		// name identities that are no longer current.
		previewIdentityByRecipient.clear();
		for (const status of ['accepted', 'declined'] as const) {
			if (!statuses.has(status)) continue;
			const registered = NOTIFIABLE[status];
			const template = templates.data.rows.find((row) => row.key === registered.templateKey);
			const option = options.data.rows.find((row) => {
				const source = row.audienceDraft.source;
				return source.kind === 'registered_query' && source.recipeId === registered.recipeId;
			});
			if (!template || !option) {
				throw new DecisionsPageLiveError({
					code: 'decision_notification_defaults_missing',
					reason:
						'The seeded decision-notification template or audience is not available in this workspace.',
					retryable: false
				});
			}
			const contentPayload = await storeNotificationContent(
				{ templateRevision: template.revision },
				REVIEW_SUBJECT
			);
			const audiencePayload = await input.communications.storeAuthoringPayload(
				{
					payloadKind: 'message_audience_draft',
					schemaVersion: 1,
					value: structuredClone(option.audienceDraft) as never
				},
				newIdempotencyKey()
			);
			if (audiencePayload.kind !== 'success') {
				throw new DecisionsPageLiveError(sendFailure(audiencePayload, 'notification audience'));
			}
			const created = await input.communications.createDraft(
				{
					channel: 'email',
					purposeRevision: structuredClone(option.audienceDraft.purposeRevision) as never,
					templateRevision: structuredClone(template.revision) as never,
					initial: {
						kind: 'adopted_payload_refs',
						contentPayload: structuredClone(contentPayload) as never,
						audiencePayload: structuredClone(audiencePayload.data) as never
					}
				},
				newIdempotencyKey()
			);
			if (created.kind !== 'success') {
				throw new DecisionsPageLiveError(sendFailure(created, 'notification draft'));
			}
			const summary = await adoptSegmentPreview({
				draftId: created.data.draftId,
				draftVersion: created.data.version
			});
			const rows = await input.communications.listPreviewRecipients(
				structuredClone(summary.identity) as Parameters<
					CommunicationsAuthoringPort['listPreviewRecipients']
				>[0]
			);
			if (rows.kind !== 'success') {
				throw new DecisionsPageLiveError(readFailure(rows, 'notification recipients'));
			}
			for (const row of rows.data.rows) {
				const projected = recipientRow(row as never);
				if (projected.recipientResolutionId) {
					previewIdentityByRecipient.set(projected.recipientResolutionId, summary.identity);
				}
				recipients.push(projected);
			}
			segments.push({
				status,
				templateName: template.name,
				templateRevision: template.revision,
				purposeRevision: option.audienceDraft.purposeRevision,
				audienceLabel: option.label,
				audiencePayload: audiencePayload.data,
				draftId: created.data.draftId,
				draftVersion: created.data.version,
				subject: REVIEW_SUBJECT,
				summary
			});
		}
		pendingNotification = { key: notificationKey(ids), segments };
		const readiness = await readEmailReadiness();
		const sender = readiness.outbound === 'ready'
			? readiness.provider
			: 'No outbound provider activated — deliveries will be recorded, not delivered';
		return {
			templateLabel: segments
				.map((segment) => `${segment.templateName} @ revision ${segment.templateRevision.revisionNumber}`)
				.join(' + '),
			audienceLabel: segments.map((segment) => segment.audienceLabel).join(' + '),
			binding: 'current_snapshot',
			recipients,
			sender,
			replyModel: 'No reply route is configured for decision notifications.',
			irreversibleNote: 'Email cannot be recalled after the provider accepts it.'
		};
	}

	/**
	 * Reviewed copy for the delivery reasons this lane's ledger can record.
	 * Each sentence completes "…not delivered: …"; a reason with no reviewed
	 * sentence stays unstated rather than printing a raw code at a human.
	 */
	const DELIVERY_REASON_COPY: Readonly<Record<string, string>> = Object.freeze({
		'provider.not_activated': 'no outbound provider is activated',
		'delivery.rejected_terminal': 'the outbound lane rejected them outright',
		'delivery.rejected_safe_retryable':
			'the outbound lane rejected them, and a retry is allowed'
	});

	/** Stated only when every undelivered message in the send agrees on one reason. */
	function deliveryReasonCopy(reasons: ReadonlySet<string>): string | null {
		if (reasons.size !== 1) return null;
		return DELIVERY_REASON_COPY[[...reasons][0]!] ?? null;
	}

	function deliveries(count: number): string {
		return `${count} deliver${count === 1 ? 'y' : 'ies'}`;
	}

	function dispatchNote(committed: number, sent: number, reasons: ReadonlySet<string>): string {
		if (sent === committed) {
			return 'Every message was accepted by the outbound provider; Result not sent clears as that delivery evidence lands.';
		}
		const because = deliveryReasonCopy(reasons);
		const what = sent === 0
			? `${deliveries(committed)} recorded, none delivered`
			: `${committed - sent} of ${deliveries(committed)} not delivered`;
		return `${what}${because === null ? '' : `: ${because}`}. Result not sent stays until an activated provider accepts their delivery.`;
	}

	/**
	 * What the committed batches actually did, read back from the outbound
	 * ledger through the mounted delivery-history projection. Provider
	 * acceptance is the strongest delivery evidence that ledger records, so
	 * `sent` counts accepted deliveries only; the dispatch pass runs inside the
	 * send commit's own request, so this first read already states each batch's
	 * settled truth. A history read that refuses — or an acceptance count the
	 * projection does not know — leaves `sent` null: the commit stands, and an
	 * unread delivery state is stated as unknown rather than as a success.
	 */
	async function readDispatchState(
		batches: readonly { readonly batchId: string; readonly releaseCount: number }[]
	): Promise<NotificationDispatch> {
		const committed = batches.reduce((total, batch) => total + batch.releaseCount, 0);
		const reasons = new Set<string>();
		let sent = 0;
		for (const batch of batches) {
			const history = await input.communications.getDeliveryHistory({
				messageRefId: batch.batchId
			});
			const row = history.kind === 'success'
				? history.data.rows.find((entry) => entry.messageRefId === batch.batchId)
				: undefined;
			if (!row || row.counts.accepted.knowledge !== 'known') {
				return {
					committed,
					sent: null,
					note: 'The release is committed. Its delivery state could not be read here, so nothing about delivery is claimed and Result not sent stays until delivery evidence lands.'
				};
			}
			sent += row.counts.accepted.value;
			if (row.stateReasonCode !== undefined) reasons.add(row.stateReasonCode);
		}
		return { committed, sent, note: dispatchNote(committed, sent, reasons) };
	}

	async function readEmailReadiness(): Promise<EmailReadiness> {
		const result = await input.readiness.read();
		if (result.kind !== 'success') {
			throw new DecisionsPageLiveError(
				result.kind === 'transport_error'
					? readFailure(result, 'email readiness')
					: {
							code: result.kind,
							reason: 'Email delivery readiness could not be read.',
							retryable: result.kind !== 'access_denied'
						}
			);
		}
		const readiness = result.data;
		return {
			provider: readiness.provider?.displayName ?? 'No outbound provider activated',
			outbound: readiness.outbound.state,
			// The v1 projection states these paths do not exist rather than
			// pending: not-applicable is the honest tuned-page mapping.
			callbacks: 'not_applicable',
			inbound: 'not_applicable'
		};
	}

	return Object.freeze({
		workspace: Object.freeze({
			/** No live workspace summary is composed here; null is "not read yet". */
			decisionAttentionExpectedSnapshot(): boolean | null {
				return null;
			}
		}),
		submissions: Object.freeze({
			list(query: { readonly tray: 'inbox' | 'late' }): Promise<SubmissionPage> {
				return input.submissions.list({ tray: query.tray });
			}
		}),
		review: Object.freeze({
			async standings(submissionIds: string[]): Promise<Record<string, ScoreStanding>> {
				const distinct = [...new Set(submissionIds)];
				if (distinct.length === 0) return {};
				const merged: Record<string, ScoreStanding> = {};
				for (const chunk of chunked(distinct, READ_CHUNK)) {
					const snapshot = await readSnapshot({ standingSubmissionIds: [...chunk] });
					for (const [submissionId, standing] of Object.entries(snapshot.standings)) {
						merged[submissionId] = standingView(standing);
					}
				}
				return merged;
			},
			/**
			 * The viewer's own queue as the server states it. An organizer holds
			 * no assignments, so the absent queue is the true empty list; a
			 * reviewer snapshot missing its queue is an absence and refuses.
			 */
			async myQueue(): Promise<MyReviewItem[]> {
				const snapshot = await readSnapshot();
				if (snapshot.queue) return snapshot.queue.map(myReviewItem);
				if (snapshot.viewer.kind === 'organizer') return [];
				throw new DecisionsPageLiveError({
					code: 'review_queue_unavailable',
					reason: 'Your review queue is not available in this live workspace.',
					retryable: false
				});
			},
			async accoladeDefs(): Promise<AccoladeDef[]> {
				return (await readSnapshot()).accoladeDefinitions.map((definition) => ({
					key: accoladePortKey(definition.key),
					label: definition.label,
					...(definition.cap === undefined ? {} : { cap: definition.cap })
				}));
			},
			async plans(): Promise<ReviewPlan[]> {
				return mapLiveReviewPlans((await readSnapshot()).plans, now());
			},
			/**
			 * Decision evidence is aggregates only (recorded default): the
			 * canonical read serves whole-slice standings, never per-reviewer
			 * committed reviews, so this capability refuses rather than serving
			 * an empty list that would claim "no reviews exist".
			 */
			async forSubmission(): Promise<never> {
				throw unmounted('decision_review_evidence');
			}
		}),
		vocab: Object.freeze({
			tracks: async () => (await input.vocabulary.tracks()).map(liveTrack)
		}),
		settings: Object.freeze({
			async get(): Promise<{ readonly name: string } | null> {
				const settings = await input.settings.get();
				return settings ? { name: settings.name } : null;
			}
		}),
		templates: Object.freeze({
			/**
			 * The tuned page needs safe identity for the template door, not the
			 * classified authoring payload. Canonical summaries carry exactly that
			 * identity plus the current subject preview and revision.
			 */
			async list(): Promise<{ readonly messages: MessageTemplate[] }> {
				const result = await input.communications.listTemplates({ lifecycle: 'active' });
				if (result.kind !== 'success') {
					throw new DecisionsPageLiveError(readFailure(result, 'message template list'));
				}
				return {
					messages: result.data.rows.map((row) => ({
						id: row.revision.templateId,
						key: row.key,
						name: row.name,
						purpose: row.purposeRevision.purposeKey,
						subject: row.subjectPreview,
						// Summary reads intentionally do not open template content or
						// authoring history; the template workspace owns those details.
						blocks: [],
						mergeFields: [],
						revision: row.revision.revisionNumber,
						revisions: [],
						usedBy: row.purposeRevision.purposeKey === 'decision_notification'
							? ['Decisions']
							: []
					}))
				};
			}
		}),
		speakers: Object.freeze({
			/** Null is the port's own typed absence for an unknown profile. */
			async profile() {
				return null;
			},
			...(input.profileBatch ? { profiles: input.profileBatch.profiles } : {})
		}),
		schedule: Object.freeze({
			state: () => input.schedule.state()
		}),
		decisions: Object.freeze({
			/**
			 * One consequential decide per chunk of at most the wire's 100 rows,
			 * guarded by the decision heads read immediately before drafting.
			 * `undecided` and `withdrawn` have no organizer authoring path and
			 * refuse typed; corrections choose another guarded result.
			 */
			async decide(
				ids: string[],
				decision: DecisionState,
				trackIdsBySubmission: Readonly<Record<string, string>> = {}
			): Promise<void> {
				if (decision === 'undecided') throw unmounted('decision_undecided_unavailable');
				if (decision === 'withdrawn') throw unmounted('decision_withdrawn_authoring');
				const distinct = [...new Set(ids)];
				if (distinct.length === 0) return;
				const heads = await readDecisionRows(distinct);
				for (const chunk of chunked(distinct, DECISION_DECIDE_ROWS_MAX)) {
					const result = await input.decisions.decide({
						action: 'decide',
						decisions: chunk.map((submissionId) => {
							const head = heads.get(submissionId)?.head ?? null;
							const explicitTrackId = trackIdsBySubmission[submissionId];
							return {
								submissionId,
								state: decision,
								expectedDecisionVersion: head?.version ?? null,
								expectedDecisionDigestSha256: head?.digestSha256 ?? null,
								...(decision === 'accepted' && explicitTrackId
									? { graduation: { kind: 'spawn' as const, trackId: explicitTrackId } }
									: {})
								// Graduation deliberately omitted: the server routes an
								// accept by the submission's effective target (attach a
								// resolvable collecting target, spawn otherwise), and a
								// refused attach re-offers instead of guessing.
							};
						})
					}, newIdempotencyKey());
					if (result.kind !== 'success') {
						throw new DecisionsPageLiveError(decideFailure(result));
					}
				}
			},
			/**
			 * The deliberate-send review: one adopted, immutable preview per
			 * notifiable decision outcome in the selection, its recipients the
			 * decision-set audience truth resolved from current records.
			 */
			async reviewNotification(ids: string[]): Promise<MessageReview> {
				return await buildNotificationReview(ids);
			},
			/**
			 * One recipient's email exactly as this lane rendered it, so the send
			 * ceremony can show the artifact rather than name a template.
			 *
			 * Asked against the adopted preview that resolved this person — a
			 * batch adopts one preview per decision outcome — and refused rather
			 * than guessed when the review that produced the id is no longer the
			 * current one.
			 *
			 * The rendered HTML the server also returns is deliberately not
			 * carried: nothing in this application renders server-produced
			 * markup, and introducing the first such sink is its own reviewed
			 * decision. The plain text is the same message.
			 */
			async previewRecipient(recipientResolutionId: string): Promise<RenderedEmailPreview> {
				const identity = previewIdentityByRecipient.get(recipientResolutionId);
				if (!identity) {
					throw new DecisionsPageLiveError({
						code: 'decision_notification_review_required',
						reason:
							'Review the notification before previewing. Reopen the dialog to load the current audience.',
						retryable: false
					});
				}
				const request = structuredClone(identity) as Parameters<
					CommunicationsAuthoringPort['getPreview']
				>[0];
				request.selectedRecipientResolutionId = recipientResolutionId;
				const detail = await input.communications.getPreview(request);
				if (detail.kind !== 'success') {
					throw new DecisionsPageLiveError(readFailure(detail, 'notification preview'));
				}
				const selected = detail.data.selected;
				if (selected.kind !== 'rendered_email') {
					throw new DecisionsPageLiveError({
						code: 'decision_notification_preview_unavailable',
						reason: 'This recipient has no rendered copy in the reviewed preview.',
						retryable: false
					});
				}
				return {
					subject: selected.render.subject,
					plainText: selected.render.plainText,
					warningCodes: [...selected.render.warningCodes]
				};
			},
			/**
			 * Commits exactly the reviewed adoptions as irreversible release
			 * batches (re-adopting only when the operator edited the subject).
			 * A preview whose evidence no longer reproduces from current
			 * decisions refuses typed server-side — nothing is pretended sent —
			 * and the committed batches' own ledger state is read back so the
			 * surface states what the send did: with no outbound provider
			 * activated every delivery is recorded honestly as not delivered.
			 */
			async notify(ids: string[], subject: string): Promise<NotificationDispatch> {
				const pending = pendingNotification;
				if (!pending || pending.key !== notificationKey(ids)) {
					throw new DecisionsPageLiveError({
						code: 'decision_notification_review_required',
						reason:
							'Review the notification before sending. Reopen the dialog to load the current audience.',
						retryable: false
					});
				}
				// One-shot: whatever happens next, a repeat send starts from a
				// fresh review of current records, never a stale adoption.
				pendingNotification = null;
				// The committed batches, by the identity their ledger state is
				// read back under; every release registers exactly one delivery,
				// so the release count is the committed message count.
				const batches: {
					readonly batchId: string;
					readonly releaseCount: number;
				}[] = [];
				for (const segment of pending.segments) {
					let summary = segment.summary;
					if (subject !== segment.subject) {
						// The reviewed render is digest-pinned, so an edited
						// subject re-authors the content and re-adopts before
						// sending — the sent bytes always carry the operator's
						// final subject.
						const contentPayload = await storeNotificationContent(segment, subject);
						const revised = await input.communications.reviseDraft(
							{
								draftId: segment.draftId,
								expectedVersion: segment.draftVersion,
								contentPayload: structuredClone(contentPayload) as never,
								audiencePayload: structuredClone(segment.audiencePayload) as never
							},
							newIdempotencyKey()
						);
						if (revised.kind !== 'success') {
							throw new DecisionsPageLiveError(sendFailure(revised, 'notification draft'));
						}
						summary = await adoptSegmentPreview({
							draftId: revised.data.draftId,
							draftVersion: revised.data.version
						});
					}
					const sent = await input.communications.sendMessages(
						{
							audienceSpecId: summary.identity.audienceSpecId,
							batchId: `batch.${globalThis.crypto.randomUUID()}`,
							subject,
							audienceLabel: segment.audienceLabel
						},
						newIdempotencyKey()
					);
					if (sent.kind !== 'success') {
						throw new DecisionsPageLiveError(sendFailure(sent, 'notification send'));
					}
					batches.push({
						batchId: sent.data.batchId,
						releaseCount: sent.data.releaseCount
					});
				}
				return await readDispatchState(batches);
			}
		}),
		communications: Object.freeze({
			/** The served provider facts: with nothing activated, outbound stays action_required. */
			readiness: readEmailReadiness
		})
	} satisfies DecisionsPagePort);
}
