import type { PortalFileDto, PortalTimelineEventDto } from '@jooevents/contracts';
import { sampleLatencyMs } from '../../sample/registry';
import {
	mapPortalEngagement,
	mapPortalProfile,
	mapPortalSnapshot,
	mapPortalSubmission,
	mapPortalTask,
	submissionEditability,
	type PortalProjectionContext
} from '../mappers';
import type {
	PortalEngagementView,
	PortalMutationOutcome,
	PortalProfileView,
	PortalSnapshotView,
	PortalSubmissionView,
	PortalTaskView
} from '../view-models';
import { resolvePortalDataset } from './registry';
import { asPortalSubmission, asPortalTask, portalSnapshotDto } from './projection';
import type { PortalDataset, PortalSubmissionSeed } from './dataset';

/**
 * Participant portal API, served from an in-memory sample world. Surfaces call
 * these functions exactly as they will call the real transport: reads answer
 * with projections, changes answer with an outcome that is either the refreshed
 * record or a named refusal, and a session's changes persist until reload.
 *
 * Nothing here can reach organizer state. What the participant has been told is
 * the only decision information this module has.
 */

/**
 * One appeal per submission, and at most this many across the whole event: a
 * batch of declines must not become a batch of appeals.
 */
const APPEAL_CEILING = 2;

const latency = () => new Promise((resolve) => setTimeout(resolve, sampleLatencyMs()));

/** The API over one participant's world; the shipped instance holds the selected scenario. */
export function createPortalApi(db: PortalDataset) {
	let appended = 0;

	const nowMs = () => Date.now();
	const nowIso = () => new Date().toISOString();

	const context = (): PortalProjectionContext => ({
		participantId: db.participant.id,
		event: db.event,
		now: nowMs()
	});

	const submissionView = (seed: PortalSubmissionSeed): PortalSubmissionView =>
		mapPortalSubmission(asPortalSubmission(seed, db.event), context());

	function appendTimeline(
		submissionId: string | null,
		entry: Omit<PortalTimelineEventDto, 'id' | 'occurredAt'>
	): void {
		const submission = db.submissions.find((candidate) => candidate.id === submissionId);
		if (!submission) return;
		appended += 1;
		submission.timeline.push({ id: `tl-live-${appended}`, occurredAt: nowIso(), ...entry });
	}

	function submittedAppealCount(): number {
		return db.submissions.filter((submission) => submission.appeal.kind === 'submitted').length;
	}

	function nextFileVersion(taskId: string): number {
		const versions = db.files.filter((file) => file.taskId === taskId).map((file) => file.version);
		return versions.length === 0 ? 1 : Math.max(...versions) + 1;
	}

	return {
		async snapshot(): Promise<PortalSnapshotView> {
			await latency();
			return mapPortalSnapshot(portalSnapshotDto(db, nowMs()), nowMs());
		},

		async submission(id: string): Promise<PortalSubmissionView | null> {
			await latency();
			const seed = db.submissions.find((submission) => submission.id === id);
			return seed ? submissionView(seed) : null;
		},

		/**
		 * A correction to what was submitted. The pinned form version and the set
		 * of questions never move: only the answers do, and only while the record
		 * is still open for correction.
		 */
		async editAnswers(input: {
			readonly submissionId: string;
			readonly answers: readonly { readonly fieldId: string; readonly value: string }[];
		}): Promise<PortalMutationOutcome<PortalSubmissionView>> {
			await latency();
			const seed = db.submissions.find((submission) => submission.id === input.submissionId);
			if (!seed) return { ok: false, reason: 'unknown_record' };
			const editability = submissionEditability(asPortalSubmission(seed, db.event), context());
			if (editability.kind === 'locked') {
				switch (editability.reason) {
					case 'cfp_closed':
						return { ok: false, reason: 'cfp_closed' };
					case 'not_editable':
						return { ok: false, reason: 'submission_not_editable' };
					case 'decided':
						return { ok: false, reason: 'submission_decided' };
					case 'withdrawn':
						return { ok: false, reason: 'submission_withdrawn' };
				}
			}
			for (const change of input.answers) {
				const answer = seed.answers.find((candidate) => candidate.fieldId === change.fieldId);
				if (answer) answer.value = change.value;
			}
			appendTimeline(seed.id, {
				actor: 'you',
				kind: 'edited',
				summary:
					seed.speakers.length > 1
						? 'You edited this submission. Your co-speakers were told.'
						: 'You edited this submission.'
			});
			return { ok: true, data: submissionView(seed) };
		},

		async withdrawSubmission(id: string): Promise<PortalMutationOutcome<PortalSubmissionView>> {
			await latency();
			const seed = db.submissions.find((submission) => submission.id === id);
			if (!seed) return { ok: false, reason: 'unknown_record' };
			if (seed.status === 'withdrawn') return { ok: false, reason: 'submission_withdrawn' };
			if (seed.status !== 'submitted' && seed.status !== 'in_review') {
				return { ok: false, reason: 'submission_not_withdrawable' };
			}
			seed.status = 'withdrawn';
			seed.statusNotifiedAt = null;
			appendTimeline(seed.id, {
				actor: 'you',
				kind: 'withdrawn',
				summary:
					seed.speakers.length > 1
						? 'You withdrew this submission. Your co-speakers were told.'
						: 'You withdrew this submission.'
			});
			return { ok: true, data: submissionView(seed) };
		},

		async appealDecision(input: {
			readonly submissionId: string;
			readonly reason: string;
		}): Promise<PortalMutationOutcome<PortalSubmissionView>> {
			await latency();
			const seed = db.submissions.find((submission) => submission.id === input.submissionId);
			if (!seed) return { ok: false, reason: 'unknown_record' };
			if (seed.appeal.kind === 'submitted') return { ok: false, reason: 'appeal_already_used' };
			if (seed.appeal.kind === 'unavailable' || seed.status !== 'declined') {
				return { ok: false, reason: 'appeal_unavailable' };
			}
			if (submittedAppealCount() >= APPEAL_CEILING) {
				return { ok: false, reason: 'appeal_rate_limited' };
			}
			seed.appeal = { kind: 'submitted', submittedAt: nowIso(), reason: input.reason };
			appendTimeline(seed.id, {
				actor: 'you',
				kind: 'appeal_submitted',
				summary: 'You asked the organizers to look at this decision again.'
			});
			return { ok: true, data: submissionView(seed) };
		},

		/**
		 * Answering an invitation. The answer is attributed to whoever gave it,
		 * because on a co-presented session one speaker answers for the group.
		 */
		async respondToEngagement(input: {
			readonly engagementId: string;
			readonly response: 'confirm' | 'decline';
		}): Promise<PortalMutationOutcome<PortalEngagementView>> {
			await latency();
			const engagement = db.engagements.find((candidate) => candidate.id === input.engagementId);
			if (!engagement) return { ok: false, reason: 'unknown_record' };
			if (engagement.status !== 'invited') return { ok: false, reason: 'engagement_not_open' };
			const confirmed = input.response === 'confirm';
			engagement.status = confirmed ? 'confirmed' : 'declined';
			engagement.confirmation = confirmed ? { by: 'you', at: nowIso() } : null;
			appendTimeline(engagement.submissionId, {
				actor: 'you',
				kind: 'engagement_responded',
				summary: confirmed
					? engagement.speakers.length > 1
						? `You confirmed ${engagement.sessionTitle} for everyone listed.`
						: `You confirmed ${engagement.sessionTitle}.`
					: `You told the organizers you cannot do ${engagement.sessionTitle}.`
			});
			return { ok: true, data: mapPortalEngagement(engagement, context()) };
		},

		/**
		 * Marking a task done. Completion is explicit, and an upload adds a
		 * version rather than replacing what was sent before.
		 */
		async completeTask(input: {
			readonly taskId: string;
			readonly fileName?: string;
		}): Promise<PortalMutationOutcome<PortalTaskView>> {
			await latency();
			const seed = db.tasks.find((task) => task.id === input.taskId);
			if (!seed) return { ok: false, reason: 'unknown_record' };
			if (seed.state !== 'todo') return { ok: false, reason: 'task_not_actionable' };
			const past = seed.dueAt !== null && Date.parse(seed.dueAt) < nowMs();
			if (past && seed.closePolicy === 'hard') return { ok: false, reason: 'task_closed' };
			if (seed.completion.mode === 'upload') {
				const file: PortalFileDto = {
					id: `fil-live-${db.files.length + 1}`,
					name: input.fileName ?? 'upload',
					sizeBytes: 0,
					version: nextFileVersion(seed.id),
					uploadedAt: nowIso(),
					taskId: seed.id
				};
				db.files.push(file);
				seed.completion = { ...seed.completion, receivedFileId: file.id };
			}
			seed.state = 'complete';
			const engagement = db.engagements.find((candidate) => candidate.sessionId === seed.sessionId);
			appendTimeline(engagement?.submissionId ?? null, {
				actor: 'you',
				kind: 'task_completed',
				summary: `You completed “${seed.title}”.`
			});
			return { ok: true, data: mapPortalTask(asPortalTask(seed, nowMs())) };
		},

		async saveProfileField(input: {
			readonly fieldId: string;
			readonly value: string;
		}): Promise<PortalMutationOutcome<PortalProfileView>> {
			await latency();
			const field = db.profile.fields.find((candidate) => candidate.id === input.fieldId);
			if (!field) return { ok: false, reason: 'unknown_record' };
			if (field.access.kind === 'locked') return { ok: false, reason: 'field_locked' };
			field.value = input.value;
			return { ok: true, data: mapPortalProfile(db.profile) };
		},

		/** The way out of a locked field: ask a person, rather than a disabled input. */
		async requestProfileChange(input: {
			readonly fieldId: string;
		}): Promise<PortalMutationOutcome<PortalProfileView>> {
			await latency();
			const field = db.profile.fields.find((candidate) => candidate.id === input.fieldId);
			if (!field) return { ok: false, reason: 'unknown_record' };
			if (field.access.kind !== 'locked') return { ok: false, reason: 'field_editable' };
			field.access = { ...field.access, changeRequested: true };
			return { ok: true, data: mapPortalProfile(db.profile) };
		}
	};
}

const db = structuredClone(resolvePortalDataset());

/** Which participant story is loaded, so a surface can name the fiction it shows. */
export const portalScenario: { key: string; name: string; description: string } = {
	key: db.key,
	name: db.name,
	description: db.description
};

export const api = createPortalApi(db);
