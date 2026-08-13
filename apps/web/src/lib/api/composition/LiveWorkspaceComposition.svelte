<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { setEventProgramPort } from '$lib/api/event-program/context';
	import { createLiveEventProgramPort } from '$lib/api/event-program/live';
	import { createChangesetReviewLivePort } from '$lib/api/changesets';
	import { createLiveCommunicationsReadinessPagePort } from '$lib/api/communications-readiness-page-live';
	import { createCommunicationsProviderReadLivePort } from '$lib/api/operations/communications-provider-read-live';
	import { setOrganizerFormsPort } from '$lib/api/intake-forms-context';
	import { createIntakeFormsLivePort } from '$lib/api/operations/intake-forms-live';
	import { createLiveFormsPagePort } from '$lib/api/forms-page-port.live';
	import { createIntakeSubmissionsLivePort } from '$lib/api/operations/intake-submissions-live';
	import { createWorkspaceOverviewLivePort } from '$lib/api/operations/workspace-overview-live';
	import { createLiveOverviewPagePort } from '$lib/api/overview-page-live';
	import { createEventSettingsLiveClient } from '$lib/api/operations/event-settings-live';
	import { createFieldRegistryLiveClient } from '$lib/api/operations/field-registry-live';
	import { createWorkspaceTeamLiveClient } from '$lib/api/operations/workspace-team-live';
	import { createEventSettingsWorkspaceAdapter } from '$lib/api/event-settings-workspace-adapter';
	import { createFieldRegistryWorkspaceAdapter } from '$lib/api/field-registry-workspace-adapter';
	import { createProgramVocabularySettingsAdapter } from '$lib/api/program-vocabulary-settings-adapter';
	import { createWorkspaceTeamSettingsPort } from '$lib/api/workspace-team-settings-adapter';
	import { createLiveSettingsPagePort } from '$lib/api/settings-page-port';
	import { createLiveWorkspaceShellPort } from '$lib/api/workspace-shell-live';
	import WorkspaceShell from '$lib/features/workspace/components/WorkspaceShell.svelte';
	import {
		setLiveWorkspacePorts,
		type LiveWorkspaceReady
	} from './live-workspace';

	let {
		ready,
		children
	}: {
		readonly ready: LiveWorkspaceReady;
		readonly children: Snippet;
	} = $props();

	// Gate resolution remounts this composition. Capture its authenticated
	// manifest once so ports and contexts cannot tear across a single render.
	const initial = untrack(() => ready);
	const overviewRead = createWorkspaceOverviewLivePort({ manifest: initial.manifest });
	const eventProgram = setEventProgramPort(createLiveEventProgramPort({ manifest: initial.manifest }));
	const overview = createLiveOverviewPagePort({ overview: overviewRead, event: eventProgram.event });
	const shell = createLiveWorkspaceShellPort({ user: initial.user, overview });
	const changesets = createChangesetReviewLivePort({ manifest: initial.manifest });
	const communicationsReadiness = createLiveCommunicationsReadinessPagePort({
		provider: createCommunicationsProviderReadLivePort({ manifest: initial.manifest })
	});
	const canonicalForms = setOrganizerFormsPort(createIntakeFormsLivePort({ manifest: initial.manifest }));
	const submissions = createIntakeSubmissionsLivePort({
		manifest: initial.manifest,
		// Access context deliberately does not project permission IDs. Until a
		// server-owned disclosure capability exists, contact stays unavailable.
		contactCapability: { kind: 'unavailable', reason: 'not_enabled' }
	});
	const vocabulary = createProgramVocabularySettingsAdapter({
		program: eventProgram,
		changesets
	});
	const fields = createFieldRegistryWorkspaceAdapter({
		client: createFieldRegistryLiveClient({ manifest: initial.manifest })
	});
	const forms = createLiveFormsPagePort({
		forms: canonicalForms,
		fields,
		vocabulary
	});
	const settings = createLiveSettingsPagePort({
		event: createEventSettingsWorkspaceAdapter({
			client: createEventSettingsLiveClient({ manifest: initial.manifest })
		}),
		team: createWorkspaceTeamSettingsPort({
			client: createWorkspaceTeamLiveClient({ manifest: initial.manifest })
		}),
		vocab: vocabulary,
		fields
	});
	setLiveWorkspacePorts(Object.freeze({
		overview,
		eventProgram,
		changesets,
		communicationsReadiness,
		forms,
		submissions,
		settings
	}));
</script>

<WorkspaceShell port={shell}>
	{@render children()}
</WorkspaceShell>
