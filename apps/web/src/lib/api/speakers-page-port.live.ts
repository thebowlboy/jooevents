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
	SpeakerLineupRow,
	SpeakerRow,
	SpeakerSession,
	TaskAssignment,
	TaskDef
} from './types';
import type { OrganizerSubmissionsPort } from './view-models/intake-submissions';
import type { TaskLiveClient, TaskLiveResult } from './operations/tasks-live';
import { taskAssignmentView, taskDefinitionView } from './mappers/tasks';

/** Failure translated at the live Speakers boundary into reviewed UI copy. */
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

function lineupFailure(
	result: Exclude<Awaited<ReturnType<EngagementsLiveClient['changeLineup']>>, { readonly kind: 'success' }>
): AdapterFailure {
	if (result.kind === 'unavailable') {
		return { code: result.reason, reason: 'Editing the public lineup is not available in this workspace.' };
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? 'The lineup change could not reach JooEvents. Try again.'
				: 'This lineup change is not valid.'
		};
	}
	return { code: result.outcome.kind, reason: outcomeCopy(result.outcome, 'public lineup', 'change') };
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
 * disclosure. The two response acts are direct audited commits fenced on the
 * engagement version read immediately before the request.
 *
 * One row per engagement — the `(session, person)` pair — never per human:
 * the same person accepted onto two sessions is truthfully two engagements,
 * and nothing here merges or dedupes people by email (recorded BLOCKED-8).
 *
 * Served truths this seam states deliberately, each at its site below:
 * task counts and task lists are projections of the same canonical Task board
 * used by the Tasks area; communication threads are null (nothing has ever been
 * sent); category, order, and public-lineup visibility come from the canonical
 * person-level lineup; and `contentApproved` is false because no
 * content-approval record exists to read.
 */
export function createLiveSpeakersPagePort(input: {
	readonly engagements: EngagementsLiveClient;
	readonly sessions: SessionCatalogCorePort;
	readonly triage: Pick<SubmissionTriageLiveClient, 'read'>;
	readonly contacts: Pick<OrganizerSubmissionsPort, 'source' | 'contact'>;
	readonly tasks?: Pick<TaskLiveClient, 'readBoard'>;
	readonly communications?: {
		thread(personId: string): Promise<CommunicationThread | null>;
	};
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

	async function readLineup() {
		const result = await input.engagements.readLineup();
		if (result.kind !== 'success') {
			throw new SpeakersPageLiveError(readFailure(result, 'public lineup'));
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
		const [snapshot, catalog, lineup, taskBoard] = await Promise.all([
			readSnapshot(),
			readCatalog(),
			readLineup(),
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
		const lineupByPerson = new Map(lineup.entries.map((entry) => [entry.personId, entry]));
		const taskAssignments = taskBoard?.assignments.map((entry) => taskAssignmentView(entry)) ?? [];
		const rows = snapshot.engagements.map((head) => {
			const session = sessionsById.get(head.sessionId);
			const sessions: SpeakerSession[] = session
				? [{ id: session.id, title: session.title }]
				: [];
			const assigned = taskAssignments.filter((entry) => entry.speakerId === head.id);
			return {
				id: head.id,
				personId: head.personId,
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
				publiclyVisible: lineupByPerson.get(head.personId)?.publiclyVisible ?? false,
				// No content-approval record exists canonically, so nothing can
				// have been approved.
				contentApproved: false,
				...(head.cancellationRequest?.note != null
					? { note: head.cancellationRequest.note }
					: {})
			};
		});
		// The engagement table remains one row per (session, person). Sort it
		// deterministically, while carrying canonical person-level lineup
		// positions for any UI that needs to relate a row to the public roster.
		const order = rows
			.map((row, index) => ({ row, head: snapshot.engagements[index]! }))
			.sort((left, right) =>
				left.head.invitedAt.localeCompare(right.head.invitedAt)
				|| left.row.name.localeCompare(right.row.name)
				|| left.head.id.localeCompare(right.head.id)
			);
		return order.map((entry, index) => ({
			...entry.row,
			position: lineupByPerson.get(entry.head.personId)?.position ?? index,
			...(lineupByPerson.get(entry.head.personId)?.categoryId
				? { categoryId: lineupByPerson.get(entry.head.personId)!.categoryId! }
				: {})
		}));
	}

	async function listLineupRows(): Promise<SpeakerLineupRow[]> {
		const [lineup, snapshot, catalog] = await Promise.all([
			readLineup(), readSnapshot(), readCatalog()
		]);
		const submissionIds = [...new Set(
			snapshot.engagements.flatMap((head) => head.submissionId === null ? [] : [head.submissionId])
		)];
		const namesBySubmission = await readNames(submissionIds);
		const sessionsById = new Map(catalog.sessions.map((session) => [session.id, session]));
		const engagementsByPerson = new Map<string, typeof snapshot.engagements>();
		for (const head of snapshot.engagements) {
			const current = engagementsByPerson.get(head.personId) ?? [];
			engagementsByPerson.set(head.personId, [...current, head]);
		}
		return lineup.entries.map((entry) => {
			const engagements = engagementsByPerson.get(entry.personId) ?? [];
			const primary = engagements[0];
			const sessionRows = engagements.flatMap((head) => {
				const session = sessionsById.get(head.sessionId);
				return session ? [{ id: session.id, title: session.title }] : [];
			});
			const states = engagements.map(webEngagementState);
			const state: EngagementState = states.includes('cancel_requested')
				? 'cancel_requested'
				: states.includes('confirmed')
					? 'confirmed'
					: states.includes('invited')
						? 'invited'
						: states.includes('declined') ? 'declined' : 'cancelled';
			const submissionId = primary?.submissionId ?? null;
			return {
				id: entry.personId,
				rosterId: primary?.id ?? entry.personId,
				name: submissionId === null ? '' : namesBySubmission.get(submissionId) ?? '',
				state,
				sessions: sessionRows,
				publiclyVisible: entry.publiclyVisible,
				contentApproved: false,
				position: entry.position,
				...(entry.categoryId === null ? {} : { categoryId: entry.categoryId })
			};
		});
	}

	async function changeLineup(
		build: (lineup: Awaited<ReturnType<typeof readLineup>>) => Parameters<EngagementsLiveClient['changeLineup']>[0]
	): Promise<MutationOutcome> {
		const lineup = await readLineup();
		const result = await input.engagements.changeLineup(build(lineup), newIdempotencyKey());
		return result.kind === 'success'
			? { ok: true }
			: { ok: false, reason: lineupFailure(result).reason };
	}

	/**
	 * One consequential response act, fenced on the engagement version read
	 * immediately before changing. A missing row and every refusal resolve
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
			acceptCancellation: (id: string) => respond(id, 'accept_cancellation')
		}),
		lineup: Object.freeze({
			list: listLineupRows,
			reorder(id: string, toIndex: number): Promise<MutationOutcome> {
				return changeLineup((lineup) => {
					const personIds = lineup.entries.map((entry) => entry.personId);
					const from = personIds.indexOf(id);
					if (from < 0) return {
						action: 'reorder', expectedLineupVersion: lineup.version, personIds
					};
					const [personId] = personIds.splice(from, 1);
					personIds.splice(Math.max(0, Math.min(toIndex, personIds.length)), 0, personId!);
					return { action: 'reorder', expectedLineupVersion: lineup.version, personIds };
				});
			},
			setCategory(id: string, categoryId: string | null): Promise<MutationOutcome> {
				return changeLineup((lineup) => ({
					action: 'set_category', expectedLineupVersion: lineup.version,
					personId: id, categoryId
				}));
			},
			setVisibility(id: string, publiclyVisible: boolean): Promise<MutationOutcome> {
				return changeLineup((lineup) => ({
					action: 'set_visibility', expectedLineupVersion: lineup.version,
					personId: id, publiclyVisible
				}));
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
			async thread(personId: string): Promise<CommunicationThread | null> {
				return input.communications?.thread(personId) ?? null;
			}
		}),
		vocab: Object.freeze({
			async speakerCategories(): Promise<SpeakerCategory[]> {
				const lineup = await readLineup();
				return lineup.categories.map((category) => ({
					id: category.id,
					name: category.name,
					accent: category.accent,
					status: category.status,
					speakerCount: lineup.entries.filter((entry) => entry.categoryId === category.id).length
				}));
			},
			async addSpeakerCategory(name: string): Promise<SpeakerCategory> {
				const lineup = await readLineup();
				const result = await input.engagements.changeLineup({
					action: 'add_category', expectedLineupVersion: lineup.version, name
				}, newIdempotencyKey());
				if (result.kind !== 'success' || result.data.category === null) {
					throw new SpeakersPageLiveError(lineupFailure(result.kind === 'success'
						? { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } }
						: result));
				}
				return {
					id: result.data.category.id,
					name: result.data.category.name,
					accent: result.data.category.accent,
					status: result.data.category.status,
					speakerCount: 0
				};
			}
		})
	} satisfies SpeakersPagePort);
}
