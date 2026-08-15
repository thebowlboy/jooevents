import type {
	BreakBlock,
	Format,
	MutationOutcome,
	Placement,
	Room,
	ScheduleState,
	SessionItem,
	SessionState,
	SpeakerProfile,
	SpeakerRow,
	Submission,
	SurfaceTemplate,
	Track
} from './types';

/** Factual capabilities consumed by the tuned schedule board and session drawers. */
export interface SchedulePagePort {
	readonly workspace: {
		/** Synchronous loading-shape evidence; null means it has not been read yet. */
		scheduleAttentionExpectedSnapshot(): boolean | null;
	};
	readonly schedule: {
		state(): Promise<ScheduleState>;
		proposalTargets(): Promise<Record<string, number>>;
		place(sessionId: string, dayKey: string, roomId: string, startMin: number): Promise<Placement>;
		unplace(sessionId: string): Promise<void>;
		addBreak(input: {
			label: string;
			dayKey: string;
			roomId: string;
			startMin: number;
			durationMin: number;
		}): Promise<BreakBlock>;
		removeBreak(id: string): Promise<void>;
		publish(): Promise<{ ok: true } | { ok: false; reason: string }>;
		createSession(input: {
			title: string;
			trackId: string;
			formatId: string;
			durationMin: number;
			state: SessionState;
		}): Promise<SessionItem>;
		retargetSession(id: string, formatId: string, trackId: string): Promise<SessionItem>;
		removeSession(id: string): Promise<MutationOutcome>;
		transitionSession(id: string, to: SessionState): Promise<MutationOutcome>;
		sessionOrigins(sessionId: string): Promise<{
			id: string;
			title: string;
			source: Submission['source'];
			speakerEmails: string[];
		}[]>;
		attachCandidates(sessionId: string): Promise<Submission[]>;
		attachSubmission(sessionId: string, submissionId: string): Promise<MutationOutcome>;
		detachSubmission(sessionId: string, submissionId: string): Promise<MutationOutcome>;
		addDirectParticipant(
			sessionId: string,
			person: { name: string; email: string }
		): Promise<MutationOutcome>;
		addParticipantFromRoster(sessionId: string, speakerId: string): Promise<MutationOutcome>;
		removeParticipant(sessionId: string, email: string): Promise<MutationOutcome>;
	};
	readonly vocab: {
		tracks(): Promise<Track[]>;
		formats(): Promise<Format[]>;
		addRoom(name: string, capacity: number): Promise<Room>;
		removeRoom(id: string): Promise<MutationOutcome>;
		/** Minted where they are chosen (the direct-entry pattern): the New
		 * session dialog creates a track or format in place and uses it
		 * immediately, instead of sending the organizer to Settings mid-entry. */
		addTrack(name: string): Promise<Track>;
		addFormat(name: string): Promise<Format>;
	};
	readonly speakers: {
		list(): Promise<SpeakerRow[]>;
		profile(email: string): Promise<SpeakerProfile | null>;
	};
	readonly templates: {
		list(): Promise<{ readonly surfaces: SurfaceTemplate[] }>;
	};
}
