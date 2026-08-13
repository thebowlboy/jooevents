import type {
	PortalEventDto,
	PortalSnapshotDto,
	PortalSubmissionDto,
	PortalTaskDto
} from '@jooevents/contracts';
import type { PortalDataset, PortalSubmissionSeed, PortalTaskSeed } from './dataset';

/**
 * What a dataset states, joined to what the deadlines make of it. Reads and
 * the records a change hands back run through these same functions, so a row
 * cannot describe itself one way in a list and another way after an edit.
 */

/** Arriving after the call closed is what makes a submission late. */
export function asPortalSubmission(
	seed: PortalSubmissionSeed,
	event: PortalEventDto
): PortalSubmissionDto {
	return { ...seed, late: Date.parse(seed.submittedAt) > Date.parse(event.cfpClosesAt) };
}

/** An open task whose deadline has passed is late; every other state is authored. */
export function asPortalTask(seed: PortalTaskSeed, now: number): PortalTaskDto {
	const overdue = seed.state === 'todo' && seed.dueAt !== null && Date.parse(seed.dueAt) < now;
	return { ...seed, state: overdue ? 'late' : seed.state };
}

export function portalSnapshotDto(dataset: PortalDataset, now: number): PortalSnapshotDto {
	return {
		schemaVersion: 1,
		participant: dataset.participant,
		event: dataset.event,
		submissions: dataset.submissions.map((seed) => asPortalSubmission(seed, dataset.event)),
		engagements: dataset.engagements,
		tasks: dataset.tasks.map((seed) => asPortalTask(seed, now)),
		files: dataset.files,
		resources: dataset.resources,
		profile: dataset.profile
	};
}
