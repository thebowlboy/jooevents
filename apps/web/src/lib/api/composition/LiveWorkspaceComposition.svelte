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
	import { createDecisionsLiveClient } from '$lib/api/operations/decisions-live';
	import { createDirectEntryLiveClient } from '$lib/api/operations/direct-entry-live';
	import { createLiveDecisionsPagePort } from '$lib/api/decisions-page-port.live';
	import { createLiveSubmissionsPagePort } from '$lib/api/submissions-page-port.live';
	import { createReviewLivePort } from '$lib/api/operations/review-live';
	import { createReviewerRosterLivePort } from '$lib/api/operations/reviewer-roster-live';
	import { createSchedulePlacementLivePort } from '$lib/api/operations/schedule-placement-live';
	import { createSessionCatalogLivePort } from '$lib/api/operations/session-catalog-live';
	import { createSubmissionTriageLiveClient } from '$lib/api/operations/submission-triage-live';
	import { createWorkspaceOverviewLivePort } from '$lib/api/operations/workspace-overview-live';
	import { createLiveOverviewPagePort } from '$lib/api/overview-page-live';
	import { createLiveReviewPagePort } from '$lib/api/review-page-port.live';
	import {
		classifyReviewResolutionFailure,
		ReviewResolutionError
	} from './review-resolution';
	import { createLiveReviewersPagePort } from '$lib/api/reviewers-page-port.live';
	import { createLiveSchedulePagePort } from '$lib/api/schedule-page-port.live';
	import type { ReviewPagePort } from '$lib/api/review-page-port';
	import { createLiveScheduleProposalCountsSource } from './schedule-proposal-counts.live';
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
	// One canonical Event Settings adapter feeds both the Settings surface and
	// the schedule geometry derivation, so the grid and the settings form can
	// never disagree about the served day window.
	const eventSettings = createEventSettingsWorkspaceAdapter({
		client: createEventSettingsLiveClient({ manifest: initial.manifest })
	});
	const settings = createLiveSettingsPagePort({
		event: eventSettings,
		team: createWorkspaceTeamSettingsPort({
			client: createWorkspaceTeamLiveClient({ manifest: initial.manifest })
		}),
		vocab: vocabulary,
		fields
	});

	// The joined program aggregates share one canonical core per concern:
	// one Session catalog client feeds the schedule board and the submissions
	// surface's session doors, one Review core serves the Review surface, the
	// roster's load counts, and both decision-evidence reads, one Decision
	// spine client serves row state and the decide loop, and the reviewers
	// port's single schedule read delegates to the live schedule port's own
	// state — session identity flows only from the catalog.
	const reviewCore = createReviewLivePort({ manifest: initial.manifest });
	const triage = createSubmissionTriageLiveClient({ manifest: initial.manifest });
	const sessionCatalog = createSessionCatalogLivePort({ manifest: initial.manifest });
	const decisionsClient = createDecisionsLiveClient({ manifest: initial.manifest });
	const schedule = createLiveSchedulePagePort({
		placements: createSchedulePlacementLivePort({ manifest: initial.manifest }),
		sessions: sessionCatalog,
		vocabulary,
		proposals: createLiveScheduleProposalCountsSource({
			list: (query, options) => triage.list(query, options),
			decisions: { readState: (ids, options) => decisionsClient.readState(ids, options) }
		}),
		settings: eventSettings
	});
	const reviewers = createLiveReviewersPagePort({
		roster: createReviewerRosterLivePort({ manifest: initial.manifest }),
		review: reviewCore,
		vocabulary,
		schedule: { state: () => schedule.schedule.state() }
	});
	// The tuned Submissions surface: triage rows joined with decision heads
	// and whole-slice standings, plus the direct-entry door through the same
	// changeset lifecycle. The tuned Decisions surface consumes the same list
	// so both tables state one truth.
	const submissions = createLiveSubmissionsPagePort({
		triage,
		directEntry: createDirectEntryLiveClient({ manifest: initial.manifest }),
		decisions: decisionsClient,
		review: reviewCore,
		vocabulary,
		forms: canonicalForms,
		sessions: sessionCatalog
	});
	const decisions = createLiveDecisionsPagePort({
		decisions: decisionsClient,
		review: reviewCore,
		vocabulary,
		settings: eventSettings,
		schedule: { state: () => schedule.schedule.state() },
		submissions: { list: (query) => submissions.submissions.list(query) }
	});

	// The tuned Review surface renders under the authority the server states.
	// Its port's `viewer` is a static construction input, so the port exists
	// only after one snapshot read discloses the served discriminator; the
	// promise is memoized per composition. Failures are classified, never
	// flattened: a non-retryable structured outcome (access denied, an
	// unavailable operation in the captured manifest) keeps the memo and
	// renders as a terminal typed state — retrying a read whose refusal is
	// already known would promise a recovery that cannot happen — while only
	// transport and retryable failures clear the memo so the next visit or an
	// explicit retry re-reads.
	let reviewConstruction: Promise<ReviewPagePort> | null = null;
	function review(): Promise<ReviewPagePort> {
		reviewConstruction ??= (async () => {
			const snapshot = await reviewCore.readSnapshot();
			if (snapshot.kind !== 'success') {
				throw classifyReviewResolutionFailure(snapshot);
			}
			return createLiveReviewPagePort({
				review: reviewCore,
				vocabulary,
				viewer: snapshot.data.viewer
			});
		})().catch((error: unknown) => {
			// Unexpected throws (a construction defect, an aborted request that
			// surfaced as an exception) stay retryable rather than caching a
			// broken surface for the rest of the session.
			if (!(error instanceof ReviewResolutionError) || !error.terminal) {
				reviewConstruction = null;
			}
			throw error;
		});
		return reviewConstruction;
	}

	setLiveWorkspacePorts(Object.freeze({
		overview,
		eventProgram,
		changesets,
		communicationsReadiness,
		forms,
		submissions,
		decisions,
		settings,
		review,
		reviewers,
		schedule
	}));
</script>

<WorkspaceShell port={shell}>
	{@render children()}
</WorkspaceShell>
