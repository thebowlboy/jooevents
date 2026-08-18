/**
 * Everything the product holds about one person, as one read.
 *
 * The record page is a projection: it renders committed facts or a typed
 * absence, and it invents nothing. That only holds if the surface receives the
 * whole answer at once — an attention section assembled from four separate
 * reads would show a person as quiet while their bounce was still in flight.
 * So the port answers one snapshot, and the page derives every ranking,
 * sentence, and refusal from it.
 *
 * The one fact no other port serves is a task's *submitted material*: what the
 * speaker actually sent. Every organizer surface today shows the assignment's
 * state and nothing else, which is why a `received` form task could be accepted
 * without anyone reading it.
 */

import type {
	AssignmentState,
	CommunicationThread,
	DecisionState,
	EngagementState,
	MutationOutcome,
	SessionPlacementDisplay,
	SpeakerLink,
	SpeakerProfile,
	SpeakerRow,
	TaskAssignment,
	TaskDef
} from './types';

/** One answer inside a submitted form, in the pinned form version's order. */
export interface SubmittedAnswer {
	readonly fieldId: string;
	readonly label: string;
	/** Verbatim. An empty string is a question they left blank, not a missing row. */
	readonly value: string;
}

/** One file a speaker delivered, as the Files card states it. */
export interface SubmittedFile {
	readonly id: string;
	readonly name: string;
	/** What kind of file this is, in words: `PNG image`, `PDF document`. */
	readonly kindLabel: string;
	readonly sizeLabel: string;
	readonly href: string;
}

/**
 * What a speaker committed against one assignment.
 *
 * `draft` is present in the model on purpose and is never rendered: a portal
 * autosave is the speaker's own workspace, and the organizer sees material only
 * from the submit commit onward. Carrying the variant lets the derivation state
 * that rule once, in one place, instead of hoping every caller remembers it.
 */
export type TaskSubmission =
	| { readonly kind: 'form'; readonly submittedAt: string; readonly answers: readonly SubmittedAnswer[] }
	| { readonly kind: 'upload'; readonly submittedAt: string; readonly files: readonly SubmittedFile[] }
	| { readonly kind: 'confirm'; readonly submittedAt: string; readonly statement: string }
	| { readonly kind: 'link'; readonly submittedAt: string; readonly label: string; readonly href: string }
	| { readonly kind: 'draft'; readonly startedAt: string };

/** Who closed an assignment and when — the accepted-at and waived-by lines. */
export interface TaskSettlement {
	readonly at: string;
	readonly by: string;
}

/** One assignment with the material behind it. */
export interface SpeakerDeliverable {
	readonly def: TaskDef;
	readonly assignment: TaskAssignment;
	/** Null when nothing has been committed against this assignment. */
	readonly submission: TaskSubmission | null;
	/** Present once the assignment was accepted or waived and the act is known. */
	readonly settlement?: TaskSettlement;
}

/** One session this engagement holds, joined to where the grid puts it. */
export interface SpeakerRecordSession {
	readonly id: string;
	readonly title: string;
	/** Absent when the session is not placed, or the schedule cannot say. */
	readonly placement?: SessionPlacementDisplay;
	/** The schedule slot, already focused. */
	readonly href: string;
}

/** How this person reached the roster — the `21` §5 attribution grammar. */
export type SpeakerRecordProvenance =
	| { readonly kind: 'submission'; readonly submissionId: string; readonly title: string }
	| { readonly kind: 'direct_entry'; readonly by?: string }
	| { readonly kind: 'import' }
	| { readonly kind: 'editorial' };

/** Where this person stands publicly: the lineup, and any release naming them. */
export interface SpeakerRecordPublication {
	readonly onLineup: boolean;
	/** On the lineup with nothing approved to show — the roster's "TBA" state. */
	readonly provisional: boolean;
	/** The live release that names them; absent until a release exists. */
	readonly releaseNumber?: number;
}

/** One proposal carrying this person's address, and where its decision stands. */
export interface SpeakerRecordSubmission {
	readonly id: string;
	readonly title: string;
	readonly decision: DecisionState;
	readonly notified: boolean;
	readonly href: string;
	readonly decisionHref: string;
}

/** Another engagement of the same person, as a read-only door to its record. */
export interface SpeakerOtherEngagement {
	readonly id: string;
	readonly state: EngagementState;
	readonly sessionTitles: readonly string[];
	readonly href: string;
}

/** Their published profile exactly as the public roster composes it. */
export interface SpeakerPublicCard {
	readonly headline?: string;
	readonly location?: string;
	readonly links: readonly SpeakerLink[];
	/** True while they are listed but nothing of theirs is approved to show. */
	readonly provisional: boolean;
}

/** One line of the readable operation log, scoped to this person. */
export interface SpeakerHistoryEntry {
	readonly id: string;
	readonly at: string;
	readonly actor: 'you' | 'person' | 'agent';
	readonly text: string;
}

/**
 * The whole answer for one engagement.
 *
 * `history` may legitimately be empty while the rest is full: a per-person slice
 * of the operation log is a named live increment that nothing serves yet, and
 * the page renders that absence as itself rather than filling it with rows from
 * a workspace-wide feed that were never keyed to this person.
 */
export interface SpeakerRecordSnapshot {
	readonly engagement: SpeakerRow;
	readonly sessions: readonly SpeakerRecordSession[];
	readonly publication: SpeakerRecordPublication;
	readonly provenance: SpeakerRecordProvenance;
	readonly otherEngagements: readonly SpeakerOtherEngagement[];
	readonly deliverables: readonly SpeakerDeliverable[];
	readonly thread: CommunicationThread | null;
	readonly submissions: readonly SpeakerRecordSubmission[];
	/** Present only while they are on the public lineup. */
	readonly publicCard: SpeakerPublicCard | null;
	/** What they say about themselves; null when no profile carries their address. */
	readonly profile: SpeakerProfile | null;
	readonly history: readonly SpeakerHistoryEntry[];
}

/** Factual capabilities consumed by the speaker record page. */
export interface SpeakerRecordPort {
	readonly record: {
		/** Null when no engagement carries this id — an honest not-found, not an empty record. */
		read(engagementId: string): Promise<SpeakerRecordSnapshot | null>;
	};
	readonly engagement: {
		recordConfirmation(engagementId: string): Promise<MutationOutcome>;
	};
	/**
	 * The same registered acts the Tasks matrix commits through, so accepting a
	 * deliverable from the record and accepting it from the board are one
	 * operation with one refusal vocabulary. `restore` is the compensator behind
	 * both receipts.
	 */
	readonly deliverables: {
		accept(taskId: string, speakerId: string): Promise<MutationOutcome>;
		waive(taskId: string, speakerId: string): Promise<void>;
		restore(
			taskId: string,
			speakerId: string,
			state: AssignmentState,
			overdue: boolean
		): Promise<void>;
	};
}
