import type {
	EngagementHeadDto,
	SpeakerProfileApproveInput,
	SpeakerProfileReviewQueueDto,
	StructuredOutcome,
	TaskBoardSnapshotDto
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
import { createInFlightSlot, shareInFlight } from './in-flight';
import { taskAssignmentView, taskDefinitionView } from './mappers/tasks';
import type {
	SpeakerProfileReviewQueueLiveReadResult,
	SpeakerProfilesLiveClient
} from './operations/speaker-profiles-live';

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

/** Auto mode releases every profile edit. Review mode releases only a profile
 * whose present current fields all have exact human approval evidence. */
function profileContentApproved(
	queue: SpeakerProfileReviewQueueDto | null,
	personId: string
): boolean {
	if (queue === null) return false;
	if (!queue.policy.reviewRequired) return true;
	const profile = queue.profiles.find((entry) => entry.personId === personId);
	if (!profile || profile.presentFields.length === 0) return false;
	const approved = new Set(profile.approvedFields);
	return profile.presentFields.every((field) => approved.has(field));
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
 * person-level lineup; and `contentApproved` follows the event's canonical
 * profile policy plus exact current-field approval evidence.
 */
export function createLiveSpeakersPagePort(input: {
	readonly engagements: EngagementsLiveClient;
	readonly sessions: SessionCatalogCorePort;
	readonly triage: Pick<SubmissionTriageLiveClient, 'read'> &
		Partial<Pick<SubmissionTriageLiveClient, 'list'>>;
	readonly contacts: Pick<OrganizerSubmissionsPort, 'source' | 'contact'>;
	readonly tasks?: Pick<TaskLiveClient, 'readBoard'>;
	readonly communications?: {
		thread(personId: string): Promise<CommunicationThread | null>;
	};
	readonly profiles?: SpeakerProfilesLiveClient;
	readonly newIdempotencyKey?: () => string;
}): SpeakersPagePort {
	if (input.sessions.source.kind !== 'live' || input.contacts.source.kind !== 'live') {
		throw new TypeError('live_speakers_source_required');
	}
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;
	const rosterSlot = createInFlightSlot<SpeakerRow[]>();
	const taskBoardSlot = createInFlightSlot<TaskBoardSnapshotDto>();

	async function readTaskBoard() {
		if (!input.tasks) return null;
		return shareInFlight(taskBoardSlot, async () => {
			const result = await input.tasks!.readBoard();
			if (result.kind !== 'success') {
				throw new SpeakersPageLiveError(readFailure(result, 'task board'));
			}
			return result.data;
		});
	}

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

	async function readProfileReview(): Promise<SpeakerProfileReviewQueueDto | null> {
		if (!input.profiles) return null;
		const result = await input.profiles.readReviewQueue();
		if (result.kind !== 'success') {
			throw new SpeakersPageLiveError(readFailure(
				result as Exclude<SpeakerProfileReviewQueueLiveReadResult, { readonly kind: 'success' }>,
				'speaker profile review'
			));
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
		if (submissionIds.length === 0) return names;
		let missing = submissionIds;
		const list = input.triage.list;
		if (list) {
			const listed = await list({});
			if (listed.kind === 'success') {
				for (const row of listed.data.rows) {
					const name = row.source.primaryParticipantName;
					if (name !== null) names.set(row.source.id, name);
				}
				missing = submissionIds.filter((submissionId) => !names.has(submissionId));
				if (missing.length === 0) return names;
			}
		}
		for (const batch of chunked(missing, CONTACT_BATCH)) {
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
		if (contact.kind === 'unavailable' || submissionIds.length === 0) return emails;
		const result = await contact.readMany(submissionIds);
		if (result.kind === 'outcome') return emails;
		if (result.kind !== 'success') {
			throw new SpeakersPageLiveError(readFailure(result, 'speaker contact'));
		}
		for (const row of result.data) emails.set(row.submissionId, row.email);
		return emails;
	}

	async function listRows(): Promise<SpeakerRow[]> {
		const [snapshot, catalog, lineup, taskBoard, profileReview] = await Promise.all([
			readSnapshot(),
			readCatalog(),
			readLineup(),
			readTaskBoard(),
			readProfileReview()
		]);
		const submissionIds = [...new Set(
			snapshot.engagements.flatMap((head) => head.submissionId === null ? [] : [head.submissionId])
		)];
		const [names, emails] = await Promise.all([
			readNames(submissionIds),
			readEmails(submissionIds)
		]);
		const namesByPerson = new Map<string, Set<string>>();
		const emailsByPerson = new Map<string, Set<string>>();
		for (const head of snapshot.engagements) {
			if (head.submissionId === null) continue;
			const name = names.get(head.submissionId);
			if (name !== undefined) {
				const values = namesByPerson.get(head.personId) ?? new Set<string>();
				values.add(name);
				namesByPerson.set(head.personId, values);
			}
			const email = emails.get(head.submissionId);
			if (email !== undefined) {
				const values = emailsByPerson.get(head.personId) ?? new Set<string>();
				values.add(email);
				emailsByPerson.set(head.personId, values);
			}
		}
		const onePersonFact = (
			facts: ReadonlyMap<string, ReadonlySet<string>>,
			personId: string
		): string | undefined => {
			const values = facts.get(personId);
			return values?.size === 1 ? values.values().next().value : undefined;
		};
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
				// A person may have more than one session engagement. An engagement
				// added from the existing roster has no Submission of its own, so it
				// inherits a fact only when this viewer can resolve exactly one value
				// from another engagement for the same canonical person.
				name: (head.submissionId !== null ? names.get(head.submissionId) : undefined)
					?? onePersonFact(namesByPerson, head.personId)
					?? '',
				email: (head.submissionId !== null ? emails.get(head.submissionId) : undefined)
					?? onePersonFact(emailsByPerson, head.personId)
					?? '',
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
				contentApproved: profileContentApproved(profileReview, head.personId),
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
		const [lineup, snapshot, catalog, profileReview] = await Promise.all([
			readLineup(), readSnapshot(), readCatalog(), readProfileReview()
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
				contentApproved: profileContentApproved(profileReview, entry.personId),
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
		...(input.profiles === undefined ? {} : {
			profileReview: Object.freeze({
				async read(): Promise<SpeakerProfileReviewQueueDto> {
					return (await readProfileReview())!;
				},
				async approve(authorInput: SpeakerProfileApproveInput): Promise<MutationOutcome> {
					const result = await input.profiles!.approve(
						authorInput,
						newIdempotencyKey()
					);
					return result.kind === 'success'
						? { ok: true }
						: {
							ok: false,
							reason: result.kind === 'outcome'
								? outcomeCopy(result.outcome, 'speaker profile', 'change')
								: result.kind === 'unavailable'
									? 'Speaker profile approval is not available in this workspace.'
									: result.error.retryable
										? 'Speaker profile approval could not be reached. Try again.'
										: 'This speaker profile approval is not valid.'
						};
				}
			})
		}),
		speakers: Object.freeze({
			list: () => shareInFlight(rosterSlot, listRows),
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
				const board = await readTaskBoard();
				return board?.definitions.map((entry) => taskDefinitionView(entry)) ?? [];
			},
			async assignments(): Promise<TaskAssignment[]> {
				const board = await readTaskBoard();
				return board?.assignments.map((entry) => taskAssignmentView(entry)) ?? [];
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
