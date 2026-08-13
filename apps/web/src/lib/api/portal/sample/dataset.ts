import type {
	PortalEngagementDto,
	PortalEventDto,
	PortalFileDto,
	PortalParticipantDto,
	PortalProfileDto,
	PortalResourceDto,
	PortalSubmissionDto,
	PortalTaskDto,
	PortalTaskState
} from '@jooevents/contracts';

/**
 * A submission as a dataset authors one. Lateness is a comparison between the
 * arrival and the event's close, so the API derives it and a dataset never
 * states it — the two can then never disagree.
 */
export type PortalSubmissionSeed = Omit<PortalSubmissionDto, 'late'>;

/**
 * A task as a dataset authors one. `late` is not a state anyone sets: it is a
 * due date that passed while the task was still open, so a dataset authors the
 * real state and the API applies the deadline.
 */
export type PortalTaskSeed = Omit<PortalTaskDto, 'state'> & {
	state: Exclude<PortalTaskState, 'late'>;
};

/**
 * One participant's whole world, as one internally coherent story. Coherence
 * rules for authors:
 * - every speaker listed on a submission or engagement must be the dataset's
 *   own participant or a co-speaker with a distinct participant id — identity
 *   is a relationship, never a matched email address;
 * - an engagement's `submissionId` must name a submission in the same dataset,
 *   and a task's `sessionId` an engagement's session;
 * - `statusNotifiedAt` is set only for statuses the participant has been told,
 *   and only those statuses may appear at all;
 * - a timeline entry must correspond to something else in the dataset: a
 *   status the submission carries, an appeal it holds, an engagement it has.
 */
export interface PortalDataset {
	key: string;
	name: string;
	description: string;
	participant: PortalParticipantDto;
	event: PortalEventDto;
	submissions: PortalSubmissionSeed[];
	engagements: PortalEngagementDto[];
	tasks: PortalTaskSeed[];
	files: PortalFileDto[];
	resources: PortalResourceDto[];
	profile: PortalProfileDto;
}
