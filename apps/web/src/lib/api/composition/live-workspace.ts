import type { SafeOperationManifest, SafeUser, SafeWorkspace } from '@jooevents/contracts';
import { createContext } from 'svelte';
import type { EventProgramPort } from '../event-program/port';
import type { ChangesetReviewPort } from '../changesets';
import type { CommunicationsReadinessPagePort } from '../communications-readiness-page-port';
import type { FormsPagePort } from '../forms-page-port';
import type { OrganizerSubmissionsPort } from '../view-models/intake-submissions';
import type { OverviewPagePort } from '../overview-page-port';
import type { SettingsPagePort } from '../settings-page-port';

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
	readonly submissions: OrganizerSubmissionsPort;
	readonly settings: SettingsPagePort;
}

export const [useLiveWorkspacePorts, setLiveWorkspacePorts] = createContext<LiveWorkspacePorts>();
