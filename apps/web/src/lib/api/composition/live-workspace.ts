import type { SafeOperationManifest, SafeUser, SafeWorkspace } from '@jooevents/contracts';
import { createContext } from 'svelte';
import type { EventProgramPort } from '../event-program/port';
import type { ChangesetReviewPort } from '../changesets';
import type { CommunicationsReadinessPagePort } from '../communications-readiness-page-port';
import type { DecisionsPagePort } from '../decisions-page-port';
import type { EmbedsPagePort } from '../embeds-page-port';
import type { FilesPagePort } from '../files/files-page-port';
import type { FormsPagePort } from '../forms-page-port';
import type { OverviewPagePort } from '../overview-page-port';
import type { ReviewPagePort } from '../review-page-port';
import type { ReviewersPagePort } from '../reviewers-page-port';
import type { SchedulePagePort } from '../schedule-page-port';
import type { SettingsPagePort } from '../settings-page-port';
import type { SpeakersPagePort } from '../speakers-page-port';
import type { SubmissionsPagePort } from '../submissions-page-port';
import type { TemplatesPagePort } from '../templates-page-port';
import type { TasksPagePort } from '../tasks-page-port';

/** Authenticated inputs from which the live workspace composition is built. */
export interface LiveWorkspaceReady {
	readonly user: SafeUser;
	readonly workspace: SafeWorkspace;
	readonly manifest: SafeOperationManifest;
}

export interface LiveWorkspacePorts {
	readonly overview: OverviewPagePort;
	readonly eventProgram: EventProgramPort;
	readonly changesets: ChangesetReviewPort;
	readonly communicationsReadiness: CommunicationsReadinessPagePort;
	readonly forms: FormsPagePort;
	/** The tuned Submissions surface over the live triage/decision/review joins. */
	readonly submissions: SubmissionsPagePort;
	/** The tuned Decisions surface over the live decide loop. */
	readonly decisions: DecisionsPagePort;
	/** Published surface catalogue and reviewed framing-origin controls. */
	readonly embeds: EmbedsPagePort;
	readonly settings: SettingsPagePort;
	/**
	 * Resolves the tuned Review page port. The tuned surface reads `viewer`
	 * synchronously to decide whose screen it renders, and the live viewer is a
	 * served fact — the review snapshot's own discriminator — never a browser
	 * guess, so the port can only exist after that read lands. One construction
	 * is memoized per composition; a failed read stays retryable on the next
	 * visit instead of caching a broken surface.
	 */
	readonly review: () => Promise<ReviewPagePort>;
	readonly reviewers: ReviewersPagePort;
	readonly schedule: SchedulePagePort;
	/** The tuned Speakers surface over the live engagement vertical. */
	readonly speakers: SpeakersPagePort;
	/** The Files surface: received uploads, resource shares, and file requests. */
	readonly files: FilesPagePort;
	/** Canonical Template artifacts plus the inert assisted-draft loop. */
	readonly templates: TemplatesPagePort;
	/** Canonical speaker Task board and reviewed mutation loop. */
	readonly tasks: TasksPagePort;
}

export const [useLiveWorkspacePorts, setLiveWorkspacePorts] = createContext<LiveWorkspacePorts>();
