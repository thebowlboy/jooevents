/**
 * The speaker record over the resettable sample workspace.
 *
 * Everything but the submitted material already exists in the fixture, so this
 * adapter joins existing reads rather than adding a store: the roster row, the
 * grid's placement, the public lineup projection, the task definitions and
 * assignments, the person's thread, and the submissions carrying their address.
 * The material itself comes from `sample/task-content`, which is the one thing
 * the workspace never held.
 *
 * The join happens here rather than in the page because the record must arrive
 * whole. A page that assembled it from six promises would render a person as
 * quiet while their bounce was still in flight, and "nothing needs you" is the
 * one sentence this surface cannot be wrong about.
 */

import { sessionPlacementDisplay } from './session-placement';
import { sampleTaskSettlement, sampleTaskSubmission } from './sample/task-content';
import { speakerRecordHref } from './speaker-record';
import type {
	SpeakerDeliverable,
	SpeakerOtherEngagement,
	SpeakerRecordPort,
	SpeakerRecordProvenance,
	SpeakerRecordSession,
	SpeakerRecordSnapshot,
	SpeakerRecordSubmission,
	TaskSettlement
} from './speaker-record-port';
import type { AssignmentState, Submission } from './types';
import type { WorkspaceApi } from './workspace-gateway';

const sameAddress = (left: string, right: string): boolean =>
	left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * Settlements committed during this session.
 *
 * The fixture authors who accepted or waived the work that was already closed
 * when the scenario loaded; an act performed here knows its own answer, so it
 * records one rather than leaving a freshly accepted row without the
 * accepted-at line it had a moment before. `restore` drops it again, because a
 * compensated act did not happen.
 */
const sessionSettlements = new Map<string, TaskSettlement>();

const settlementKey = (taskId: string, speakerId: string) => `${taskId}:${speakerId}`;

/** A wall-clock stamp in the same shape the fixture's authored ones carry. */
function nowLabel(): string {
	return new Date().toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	});
}

function provenanceOf(
	own: readonly Submission[],
	originIds: ReadonlySet<string>
): SpeakerRecordProvenance {
	const source =
		own.find((submission) => originIds.has(submission.id)) ??
		own.find((submission) => submission.decision === 'accepted') ??
		null;
	if (!source) return { kind: 'editorial' };
	if (source.source === 'direct_entry') {
		return source.enteredBy
			? { kind: 'direct_entry', by: source.enteredBy }
			: { kind: 'direct_entry' };
	}
	if (source.source === 'import') return { kind: 'import' };
	return { kind: 'submission', submissionId: source.id, title: source.title };
}

export function createSampleSpeakerRecordPort(api: WorkspaceApi): SpeakerRecordPort {
	async function read(engagementId: string): Promise<SpeakerRecordSnapshot | null> {
		const roster = await api.speakers.list();
		const engagement = roster.find((row) => row.id === engagementId);
		// An address that names no engagement is answered as nothing, not as an
		// empty record: the page says the id does not resolve rather than
		// rendering a person-shaped frame with no person in it.
		if (!engagement) return null;

		const [schedule, defs, assignments, thread, submissionPage, publicRoster, sampleProfile] =
			await Promise.all([
				api.schedule.state(),
				api.tasks.defs(),
				api.tasks.assignments(),
				api.communications.thread(engagement.id),
				api.submissions.list({}),
				api.speakers.publicRoster(),
				api.speakers.profile(engagement.email)
			]);

		const sessions: SpeakerRecordSession[] = engagement.sessions.map((session) => {
			const placement = sessionPlacementDisplay(schedule, session.id);
			return {
				id: session.id,
				title: session.title,
				...(placement ? { placement } : {}),
				href: `/app/schedule?session=${session.id}`
			};
		});

		const originIds = new Set(
			engagement.sessions.flatMap(
				(session) =>
					schedule.sessions.find((entry) => entry.id === session.id)?.originSubmissionIds ?? []
			)
		);
		const own = submissionPage.rows.filter((submission) =>
			submission.speakers.some((speaker) => sameAddress(speaker.email, engagement.email))
		);

		const submissions: SpeakerRecordSubmission[] = own.map((submission) => ({
			id: submission.id,
			title: submission.title,
			decision: submission.decision,
			notified: submission.notified,
			href: `/app/submissions?submission=${submission.id}`,
			decisionHref: `/app/decisions?submission=${submission.id}`
		}));

		// Definition order, so the record lists one person's work in the same
		// sequence the task matrix lists everybody's.
		const deliverables: SpeakerDeliverable[] = defs.flatMap((def) => {
			const assignment = assignments.find(
				(entry) => entry.taskId === def.id && entry.speakerId === engagement.id
			);
			if (!assignment) return [];
			const settlement =
				sessionSettlements.get(settlementKey(def.id, engagement.id)) ??
				sampleTaskSettlement(def.id, engagement.id);
			return [
				{
					def,
					// Copied, not shared: the fixture hands out its live assignment
					// rows, and a snapshot that aliased them would change under a
					// reader the moment an act committed — which is exactly what a
					// snapshot is for not doing.
					assignment: { ...assignment },
					submission: sampleTaskSubmission(def.id, engagement.id),
					...(settlement ? { settlement } : {})
				}
			];
		});

		const card = publicRoster.find((entry) => entry.id === engagement.id) ?? null;
		const profilePersonId = engagement.personId ?? engagement.id;
		const textField = (value: string) => ({
			revision: 1, digestSha256: 'a'.repeat(64), value
		});
		const links = sampleProfile?.links ?? [];
		const profile = {
			schemaVersion: 1 as const,
			workspaceId: '00000000-0000-4000-8000-000000000001',
			eventId: '00000000-0000-4000-8000-000000000002',
			personId: profilePersonId,
			profile: sampleProfile ? {
				schemaVersion: 1 as const,
				workspaceId: '00000000-0000-4000-8000-000000000001',
				personId: profilePersonId,
				version: 1,
				headline: textField(sampleProfile.headline),
				biography: textField(''),
				location: textField(sampleProfile.location ?? ''),
				links: { revision: 1, digestSha256: 'a'.repeat(64), value: links },
				updatedAt: '2026-08-18T00:00:00.000Z'
			} : null,
			approvals: []
		};

		const otherEngagements: SpeakerOtherEngagement[] = roster
			.filter((row) => row.id !== engagement.id && sameAddress(row.email, engagement.email))
			.map((row) => ({
				id: row.id,
				state: row.state,
				sessionTitles: row.sessions.map((session) => session.title),
				href: speakerRecordHref(row.id)
			}));

		return {
			engagement,
			sessions,
			publication: {
				onLineup: engagement.publiclyVisible,
				provisional: engagement.publiclyVisible && !engagement.contentApproved,
				// The fixture holds one publication generation, so a published
				// schedule is release 1. It stays absent until one exists rather
				// than claiming a release number nothing minted.
				...(schedule.published ? { releaseNumber: 1 } : {})
			},
			provenance: provenanceOf(own, originIds),
			otherEngagements,
			deliverables,
			thread,
			submissions,
			publicCard: card
				? {
						...(card.headline ? { headline: card.headline } : {}),
						...(card.location ? { location: card.location } : {}),
						links: card.links,
						provisional: card.provisional
					}
				: null,
			profile,
			/*
			 * A per-person slice of the readable operation log is a named live
			 * increment; the fixture holds no operation log at all. Returning
			 * nothing is the honest answer — the alternative was filtering the
			 * workspace activity feed by display name, which would attribute
			 * rows to a person the fixture never keyed to them.
			 */
			history: []
		};
	}

	return Object.freeze({
		record: Object.freeze({ read }),
		engagement: Object.freeze({
			recordConfirmation: (engagementId: string) => api.speakers.recordConfirmation(engagementId),
			acceptCancellation: (engagementId: string) => api.speakers.acceptCancellation(engagementId)
		}),
		profile: Object.freeze({
			async update() {
				return { ok: false as const, reason: 'Profile editing is available in a connected workspace.' };
			},
			async approve() {
				return { ok: false as const, reason: 'Profile approval is available in a connected workspace.' };
			}
		}),
		deliverables: Object.freeze({
			async accept(taskId: string, speakerId: string) {
				const outcome = await api.tasks.acceptFulfillment(taskId, speakerId);
				if (outcome.ok) {
					sessionSettlements.set(settlementKey(taskId, speakerId), { at: nowLabel(), by: 'you' });
				}
				return outcome;
			},
			async waive(taskId: string, speakerId: string) {
				await api.tasks.markWaived(taskId, speakerId);
				sessionSettlements.set(settlementKey(taskId, speakerId), { at: nowLabel(), by: 'you' });
			},
			async restore(
				taskId: string,
				speakerId: string,
				state: AssignmentState,
				overdue: boolean
			) {
				await api.tasks.restoreAssignment(taskId, speakerId, state, overdue);
				sessionSettlements.delete(settlementKey(taskId, speakerId));
			}
		})
	});
}
