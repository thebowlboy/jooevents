import type {
	EngagementHeadDto,
	StructuredOutcome
} from '@jooevents/contracts';
import type { SafeApiError } from './client';
import type {
	EngagementsLiveClient,
	EngagementsLiveReadResult,
	EngagementsLiveRespondResult
} from './operations/engagements-live';
import type { SubmissionTriageLiveClient } from './operations/submission-triage-live';
import type {
	SessionCatalogCorePort,
	SessionCatalogReadResult
} from './session-catalog-port';
import type { SpeakersPagePort } from './speakers-page-port';
import type {
	CommunicationThread,
	EngagementState,
	MutationOutcome,
	SpeakerCategory,
	SpeakerRow,
	SpeakerSession,
	TaskAssignment,
	TaskDef
} from './types';
import type { OrganizerSubmissionsPort } from './view-models/intake-submissions';
import type { TaskLiveClient, TaskLiveResult } from './operations/tasks-live';
import { taskAssignmentView, taskDefinitionView } from './mappers/tasks';

/**
 * The tuned page capabilities this deliberately partial live mount cannot
 * truthfully serve yet, each refused with its own name so a failure states
 * exactly which owner has not joined. The lineup family is the recorded
 * BLOCKED-13 posture: the roster view is live while lineup order, grouping,
 * and visibility have no canonical owner, so every lineup mutation refuses.
 */
export type SpeakersPageLiveUnmountedCapability =
	| 'speaker_lineup_reorder'
	| 'speaker_lineup_category'
	| 'speaker_lineup_visibility'
	| 'speaker_categories';

type AdapterFailure = Readonly<{ code: string; reason: string }>;

/** Safe, reviewed-copy failure at the tuned Speakers boundary. */
export class SpeakersPageLiveError extends Error {
	readonly code: string;

	constructor(failure: AdapterFailure) {
		super(failure.reason);
		this.name = 'SpeakersPageLiveError';
		this.code = failure.code;
	}
}

const UNMOUNTED_COPY: Readonly<Record<SpeakersPageLiveUnmountedCapability, string>> =
	Object.freeze({
		speaker_lineup_reorder:
			'Reordering the public lineup is not available in this live workspace yet.',
		speaker_lineup_category:
			'Speaker groups are not available in this live workspace yet.',
		speaker_lineup_visibility:
			'Changing who appears on the public lineup is not available in this live workspace yet.',
		speaker_categories: 'Speaker groups are not available in this live workspace yet.'
	});

function unmounted(capability: SpeakersPageLiveUnmountedCapability): SpeakersPageLiveError {
	return new SpeakersPageLiveError({ code: capability, reason: UNMOUNTED_COPY[capability] });
}

function refusal(capability: SpeakersPageLiveUnmountedCapability): MutationOutcome {
	return { ok: false, reason: UNMOUNTED_COPY[capability] };
}

function outcomeCopy(outcome: StructuredOutcome, subject: string, channel: 'read' | 'change'): string {
	if (outcome.class === 'access_denied') {
		return channel === 'read'
			? `You no longer have permission to read the ${subject}.`
			: `You no longer have permission to change this ${subject}.`;
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
		| Exclude<EngagementsLiveReadResult<unknown>, { readonly kind: 'success' }>
		| Exclude<SessionCatalogReadResult, { readonly kind: 'success' }>
		| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome }
		| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Exclude<TaskLiveResult<unknown>, { readonly kind: 'success' }>
	| { readonly kind: 'unavailable'; readonly reason: string },
	subject: string
): AdapterFailure {
	if (result.kind === 'unavailable') {
		return { code: result.reason, reason: `The ${subject} is not available in this live workspace.` };
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? `The ${subject} could not be reached. Try again.`
				: `This ${subject} request is not valid.`
		};
	}
	return { code: result.outcome.kind, reason: outcomeCopy(result.outcome, subject, 'read') };
}

function respondFailure(
	result: Exclude<EngagementsLiveRespondResult, { readonly kind: 'success' }>
): AdapterFailure {
	if (result.kind === 'unavailable') {
		return {
			code: result.reason,
			reason: 'Responding to engagements is not available in this live workspace.'
		};
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? 'The engagement change could not reach JooEvents. Try again.'
				: 'This engagement change is not valid.'
		};
	}
	return { code: result.outcome.kind, reason: outcomeCopy(result.outcome, 'engagement', 'change') };
}

/**
 * The web projection of a canonical head: `cancel_requested` is a stored
 * request beside a non-cancelled state, never a fifth canonical state value.
 */
function webEngagementState(head: EngagementHeadDto): EngagementState {
	if (head.state === 'cancelled') return 'cancelled';
	return head.cancellationRequest !== null ? 'cancel_requested' : head.state;
}

/** Contact reads run per distinct submission, a bounded batch at a time. */
const CONTACT_BATCH = 8;

function chunked<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
	const chunks: Value[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

function defaultIdempotencyKey(): string {
	return `je.speakers.page.action.${globalThis.crypto.randomUUID()}`;
}

/**
 * Live tuned Speakers page port over the canonical engagement vertical: the
 * whole-event engagement snapshot joined with the Session catalog (session
 * identity and roster visibility), submission provenance (participant name and
 * title through the triage per-row read), and the permission-gated contact
 * disclosure. The two response acts are consequential commits carried through
 * `engagement.change.draft` -> propose -> commit, fenced on the engagement
 * version read immediately before drafting.
 *
 * One row per engagement — the `(session, person)` pair — never per human:
 * the same person accepted onto two sessions is truthfully two engagements,
 * and nothing here merges or dedupes people by email (recorded BLOCKED-8).
 *
 * Served truths this seam states deliberately, each at its site below:
 * task counts and task lists are projections of the same canonical Task board
 * used by the Tasks area; communication threads are null (nothing has ever been sent),
 * speaker categories are empty and every lineup mutation refuses typed
 * (BLOCKED-13), `position` is a derived stable order (invitedAt, then name)
 * because no lineup order owner exists, and `contentApproved` is false
 * because no content-approval record exists to read.
 */
export function createLiveSpeakersPagePort(input: {
	readonly engagements: EngagementsLiveClient;
	readonly sessions: SessionCatalogCorePort;
	readonly triage: Pick<SubmissionTriageLiveClient, 'read'>;
	readonly contacts: Pick<OrganizerSubmissionsPort, 'source' | 'contact'>;
	readonly tasks?: Pick<TaskLiveClient, 'readBoard'>;
	readonly newIdempotencyKey?: () => string;
}): SpeakersPagePort {
	if (input.sessions.source.kind !== 'live' || input.contacts.source.kind !== 'live') {
		throw new TypeError('live_speakers_source_required');
	}
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;

	async function readSnapshot() {
		const result = await input.engagements.readSnapshot();
		if (result.kind !== 'success') {
			throw new SpeakersPageLiveError(readFailure(result, 'speaker roster'));
		}
		return result.data;
	}

	async function readCatalog() {
		const result = await input.sessions.readCatalog();
		if (result.kind !== 'success') {
			throw new SpeakersPageLiveError(readFailure(result, 'session catalog'));
		}
		return result.data;
	}

	/**
	 * Submission provenance for acceptance-seeded rows: the submission's title
	 * is not needed here, but its primary participant name is the one name
	 * projection the canonical mounts serve. Every mounted seed path writes
	 * exactly the submission's primary participant, so the name names the
	 * engaged person; a future multi-participant seed needs a person-name owner
	 * before it can be projected here.
	 */
	async function readNames(
		submissionIds: readonly string[]
	): Promise<ReadonlyMap<string, string>> {
		const names = new Map<string, string>();
		for (const batch of chunked(submissionIds, CONTACT_BATCH)) {
			await Promise.all(batch.map(async (submissionId) => {
				const result = await input.triage.read(submissionId);
				if (result.kind !== 'success') {
					throw new SpeakersPageLiveError(readFailure(result, 'speaker roster'));
				}
				const name = result.data.source.primaryParticipantName;
				if (name !== null) names.set(submissionId, name);
			}));
		}
		return names;
	}

	/**
	 * The address is a separately permission-gated disclosure, read per viewer:
	 * a structured refusal (no authority, or no address recorded) keeps the
	 * empty value — the roster renders without the address rather than failing
	 * — while a transport failure is a failed load like any other read. When
	 * composition supplies no disclosure capability at all, every address is
	 * the empty value by construction.
	 */
	async function readEmails(
		submissionIds: readonly string[]
	): Promise<ReadonlyMap<string, string>> {
		const emails = new Map<string, string>();
		const contact = input.contacts.contact;
		if (contact.kind === 'unavailable') return emails;
		for (const batch of chunked(submissionIds, CONTACT_BATCH)) {
			await Promise.all(batch.map(async (submissionId) => {
				const result = await contact.read(submissionId);
				if (result.kind === 'outcome') return;
				if (result.kind !== 'success') {
					throw new SpeakersPageLiveError(readFailure(result, 'speaker contact'));
				}
				emails.set(submissionId, result.data.email);
			}));
		}
		return emails;
	}

	async function listRows(): Promise<SpeakerRow[]> {
		const [snapshot, catalog, taskBoard] = await Promise.all([
			readSnapshot(),
			readCatalog(),
			input.tasks?.readBoard().then((result) => {
				if (result.kind !== 'success') {
					throw new SpeakersPageLiveError(readFailure(result, 'task board'));
				}
				return result.data;
			}) ?? Promise.resolve(null)
		]);
		const submissionIds = [...new Set(
			snapshot.engagements.flatMap((head) => head.submissionId === null ? [] : [head.submissionId])
		)];
		const [names, emails] = await Promise.all([
			readNames(submissionIds),
			readEmails(submissionIds)
		]);
		const sessionsById = new Map(catalog.sessions.map((session) => [session.id, session]));
		const taskAssignments = taskBoard?.assignments.map((entry) => taskAssignmentView(entry)) ?? [];
		const rows = snapshot.engagements.map((head) => {
			const session = sessionsById.get(head.sessionId);
			const sessions: SpeakerSession[] = session
				? [{ id: session.id, title: session.title }]
				: [];
			const assigned = taskAssignments.filter((entry) => entry.speakerId === head.id);
			return {
				id: head.id,
				// The empty value is the typed absence for a row without a mounted
				// name or address owner — never an invented person.
				name: (head.submissionId !== null ? names.get(head.submissionId) : undefined) ?? '',
				email: (head.submissionId !== null ? emails.get(head.submissionId) : undefined) ?? '',
				state: webEngagementState(head),
				sessions,
				tasksDone: assigned.filter((entry) =>
					entry.state === 'complete' || entry.state === 'late-complete'
				).length,
				tasksTotal: assigned.filter((entry) => entry.state !== 'waived').length,
				overdueTasks: assigned.filter((entry) => entry.overdue).length,
				// Roster visibility is the Session head's own roster reference for
				// this person; an engagement whose person left every roster shows
				// hidden, which is what the public composition would render.
				publiclyVisible: session
					? session.roster.participants.some(
							(participant) => participant.personId === head.personId && participant.publiclyVisible
						)
					: false,
				// No content-approval record exists canonically, so nothing can
				// have been approved.
				contentApproved: false,
				...(head.cancellationRequest?.note != null
					? { note: head.cancellationRequest.note }
					: {})
			};
		});
		// Derived lineup order (recorded BLOCKED-13): no canonical order owner
		// exists, so position is a stable derivation — invitation instant, then
		// name, then id — and the returned list is stated in that order.
		const order = rows
			.map((row, index) => ({ row, head: snapshot.engagements[index]! }))
			.sort((left, right) =>
				left.head.invitedAt.localeCompare(right.head.invitedAt)
				|| left.row.name.localeCompare(right.row.name)
				|| left.head.id.localeCompare(right.head.id)
			);
		return order.map((entry, index) => ({ ...entry.row, position: index }));
	}

	/**
	 * One consequential response act, fenced on the engagement version read
	 * immediately before drafting. A missing row and every refusal resolve
	 * `{ ok: false }` with reviewed copy — the page shows the reason and
	 * reloads — while transport-level read failures throw like every load.
	 */
	async function respond(
		engagementId: string,
		act: 'record_confirmation' | 'accept_cancellation'
	): Promise<MutationOutcome> {
		const snapshot = await readSnapshot();
		const head = snapshot.engagements.find((entry) => entry.id === engagementId);
		if (!head) {
			return { ok: false, reason: 'This engagement is no longer on the roster. Reload and try again.' };
		}
		const result = await input.engagements.respond(
			act === 'record_confirmation'
				? {
						action: 'record_confirmation',
						engagementId,
						expectedEngagementVersion: head.version,
						// The operator wire admits exactly the organizer-recorded
						// attribution; the committed head names the recording user.
						attribution: 'organizer_recorded'
					}
				: {
						action: 'accept_cancellation',
						engagementId,
						expectedEngagementVersion: head.version
					},
			newIdempotencyKey()
		);
		return result.kind === 'success'
			? { ok: true }
			: { ok: false, reason: respondFailure(result).reason };
	}

	return Object.freeze({
		speakers: Object.freeze({
			list: listRows,
			recordConfirmation: (id: string) => respond(id, 'record_confirmation'),
			acceptCancellation: (id: string) => respond(id, 'accept_cancellation'),
			async reorder(): Promise<MutationOutcome> {
				return refusal('speaker_lineup_reorder');
			},
			async setCategory(): Promise<MutationOutcome> {
				return refusal('speaker_lineup_category');
			},
			async setVisibility(): Promise<MutationOutcome> {
				return refusal('speaker_lineup_visibility');
			}
		}),
		tasks: Object.freeze({
			async defs(): Promise<TaskDef[]> {
				if (!input.tasks) return [];
				const result = await input.tasks.readBoard();
				if (result.kind !== 'success') throw new SpeakersPageLiveError(readFailure(result, 'task board'));
				return result.data.definitions.map((entry) => taskDefinitionView(entry));
			},
			async assignments(): Promise<TaskAssignment[]> {
				if (!input.tasks) return [];
				const result = await input.tasks.readBoard();
				if (result.kind !== 'success') throw new SpeakersPageLiveError(readFailure(result, 'task board'));
				return result.data.assignments.map((entry) => taskAssignmentView(entry));
			}
		}),
		communications: Object.freeze({
			/**
			 * Null is the typed absence the page renders as "nothing has been
			 * sent". The send wave's delivery history is mounted, but a
			 * per-person thread entry must state one of the view model's four
			 * outcomes (delivered/sent/bounced/scheduled) and the composed
			 * lane's only terminal state — not-delivered because no provider
			 * is activated — is none of them; projecting it onto "bounced"
			 * would fabricate a provider event. The thread joins when the
			 * outcome vocabulary can carry that state honestly.
			 */
			async thread(): Promise<CommunicationThread | null> {
				return null;
			}
		}),
		vocab: Object.freeze({
			/** No lineup grouping owner exists; no groups exist to list. */
			async speakerCategories(): Promise<SpeakerCategory[]> {
				return [];
			},
			/**
			 * The create has no outcome channel, so the refusal rejects typed
			 * instead of resolving a category that was never created.
			 */
			async addSpeakerCategory(): Promise<SpeakerCategory> {
				throw unmounted('speaker_categories');
			}
		})
	} satisfies SpeakersPagePort);
}
