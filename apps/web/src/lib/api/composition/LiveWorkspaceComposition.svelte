<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { setEventProgramPort } from '$lib/api/event-program/context';
	import { createLiveEventProgramPort } from '$lib/api/event-program/live';
	import { createLiveCommunicationsReadinessPagePort } from '$lib/api/communications-readiness-page-live';
	import { createCommunicationsAuthoringLivePort } from '$lib/api/operations/communications-authoring-live';
	import { createCommunicationsProviderReadLivePort } from '$lib/api/operations/communications-provider-read-live';
	import { createCommunicationsProviderSetupLivePort } from '$lib/api/operations/communications-provider-setup-live';
	import { setOrganizerFormsPort } from '$lib/api/intake-forms-context';
	import { createIntakeFormsLivePort } from '$lib/api/operations/intake-forms-live';
	import { createLiveFormsPagePort } from '$lib/api/forms-page-port.live';
	import { createDecisionsLiveClient } from '$lib/api/operations/decisions-live';
	import { createDirectEntryLiveClient } from '$lib/api/operations/direct-entry-live';
	import { createEngagementsLiveClient } from '$lib/api/operations/engagements-live';
	import { createIntakeSubmissionsLivePort } from '$lib/api/operations/intake-submissions-live';
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
	import { createLiveSpeakersPagePort } from '$lib/api/speakers-page-port.live';
	import { createLiveFilesPagePort } from '$lib/api/files/files-page-port.live';
	import type { ReviewPagePort } from '$lib/api/review-page-port';
	import { createLiveScheduleProposalCountsSource } from './schedule-proposal-counts.live';
	import { createEventSettingsLiveClient } from '$lib/api/operations/event-settings-live';
	import { createFieldRegistryLiveClient } from '$lib/api/operations/field-registry-live';
	import { createTemplateArtifactLiveClient } from '$lib/api/operations/template-artifacts-live';
	import { createTemplateEditLiveClient } from '$lib/api/operations/template-edit-live';
	import { createReleaseLiveClient } from '$lib/api/operations/release-live';
	import { createTasksLiveClient } from '$lib/api/operations/tasks-live';
	import { createLiveTasksPagePort } from '$lib/api/tasks-page-port.live';
	import { createTaskReminderLiveSender } from '$lib/api/task-reminder-live';
	import { createReleaseWorkspacePort } from '$lib/api/release-workspace-adapter';
	import { createLiveTemplatesPagePort } from '$lib/api/templates-page-port.live';
	import { createTemplatePublicationLivePort } from '$lib/api/template-publication-live';
	import { createLiveEmbedsPagePort } from '$lib/api/embeds-page-port.live';
	import { createWorkspaceTeamLiveClient } from '$lib/api/operations/workspace-team-live';
	import { createEventLiveClient } from '$lib/api/operations/event-live';
	import { createWorkspaceShellSummaryLivePort } from '$lib/api/operations/workspace-shell-summary-live';
	import { createWorkspaceSenderIdentityLiveClient } from '$lib/api/operations/workspace-sender-identity-live';
	import { createLiveSenderIdentitySettingsPort } from '$lib/api/sender-identity-settings-port';
	import { createEventSettingsWorkspaceAdapter } from '$lib/api/event-settings-workspace-adapter';
	import { createFieldRegistryWorkspaceAdapter } from '$lib/api/field-registry-workspace-adapter';
	import { createProgramVocabularySettingsAdapter } from '$lib/api/program-vocabulary-settings-adapter';
	import { createWorkspaceTeamSettingsPort } from '$lib/api/workspace-team-settings-adapter';
	import { createLiveSettingsPagePort } from '$lib/api/settings-page-port';
	import { createLiveApiKeysPagePort } from '$lib/api/api-keys-page-port.live';
	import { createLiveAgentActionsPagePort } from '$lib/api/agent-actions-page-port';
	import {
		createLiveWorkspaceEventCollection,
		createLiveWorkspaceShellPort
	} from '$lib/api/workspace-shell-live';
	import {
		createLivePulsePagePort,
		createPulseHistoryLivePort
	} from '$lib/api/pulse-page-port.live';
	import { createLiveIntegrationsPagePort } from '$lib/api/integrations-page-port';
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
	const communicationsReadiness = createLiveCommunicationsReadinessPagePort({
		provider: createCommunicationsProviderReadLivePort({ manifest: initial.manifest })
	});
	// The overview derives its one live attention row — email setup — from the
	// same canonical readiness read the Communications surface consumes.
	const overview = createLiveOverviewPagePort({
		overview: overviewRead,
		event: eventProgram.event,
		readiness: communicationsReadiness
	});
	const shellEvents = createEventLiveClient({ manifest: initial.manifest });
	const shell = createLiveWorkspaceShellPort({
		user: initial.user,
		overview,
		shellSummary: createWorkspaceShellSummaryLivePort({ manifest: initial.manifest }),
		events: createLiveWorkspaceEventCollection({
			events: shellEvents,
			// The same guarded create the first-run panel uses, so one Event is
			// created one way whichever control started it.
			createEvent: overview.createEvent
		})
	});
	// One canonical communication authoring/preview/send client; the Decisions
	// notify loop and any future Messages surface ride the same lane.
	const communicationsAuthoring = createCommunicationsAuthoringLivePort({
		manifest: initial.manifest
	});
	const canonicalForms = setOrganizerFormsPort(createIntakeFormsLivePort({ manifest: initial.manifest }));
	const vocabulary = createProgramVocabularySettingsAdapter({ program: eventProgram });
	const fields = createFieldRegistryWorkspaceAdapter({
		client: createFieldRegistryLiveClient({ manifest: initial.manifest })
	});
	const templateArtifacts = createTemplateArtifactLiveClient({ manifest: initial.manifest });
	const releaseClient = createReleaseLiveClient({ manifest: initial.manifest });
	const release = createReleaseWorkspacePort(releaseClient);
	const forms = createLiveFormsPagePort({
		forms: canonicalForms,
		fields,
		vocabulary,
		templates: {
			async applicationFormSurfaceId() {
				const result = await templateArtifacts.list('surface');
				if (result.kind === 'success') {
					return result.data.find((artifact) =>
						artifact.current.document.kind === 'surface'
						&& artifact.current.document.surfaceKind === 'application-form'
					)?.head.artifactId ?? null;
				}
				if (result.kind === 'outcome'
					&& result.outcome.kind === 'template.artifact.event_required') return null;
				throw new Error('The application form Template could not be loaded.');
			}
		}
	});
	// One canonical Event Settings adapter feeds both the Settings surface and
	// the schedule geometry derivation, so the grid and the settings form can
	// never disagree about the served day window.
	const eventSettings = createEventSettingsWorkspaceAdapter({
		client: createEventSettingsLiveClient({ manifest: initial.manifest })
	});
	const workspaceTeam = createWorkspaceTeamSettingsPort({
		client: createWorkspaceTeamLiveClient({ manifest: initial.manifest })
	});
	// The Settings Email section's delivery seam: the canonical readiness read
	// plus the owner-lane setup executors (readiness check, DNS diagnostics,
	// setup guide, test send). Refusals stay typed; nothing here sends product mail.
	const providerSetup = createCommunicationsProviderSetupLivePort();
	const settings = createLiveSettingsPagePort({
		event: eventSettings,
		team: workspaceTeam,
		vocab: vocabulary,
		fields,
		senderIdentity: createLiveSenderIdentitySettingsPort({
			client: createWorkspaceSenderIdentityLiveClient({ manifest: initial.manifest })
		}),
		emailDelivery: {
			readiness: (options) => communicationsReadiness.read(options),
			guide: (options) => providerSetup.getSetupGuide(options),
			runReadinessCheck: (options) => providerSetup.runReadinessCheck(options),
			checkDns: (options) => providerSetup.checkDeliverability(options),
			sendTest: (recipient, options) => providerSetup.sendDiagnosticTest(recipient, options)
		},
		apiKeys: createLiveApiKeysPagePort({ manifest: initial.manifest })
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
	const engagementsClient = createEngagementsLiveClient({ manifest: initial.manifest });
	const schedule = createLiveSchedulePagePort({
		placements: createSchedulePlacementLivePort({ manifest: initial.manifest }),
		sessions: sessionCatalog,
		vocabulary,
		proposals: createLiveScheduleProposalCountsSource({
			list: (query, options) => triage.list(query, options),
			decisions: { readState: (ids, options) => decisionsClient.readState(ids, options) }
		}),
		settings: eventSettings,
		publication: release
	});
	const reviewers = createLiveReviewersPagePort({
		roster: createReviewerRosterLivePort({ manifest: initial.manifest }),
		review: reviewCore,
		team: workspaceTeam,
		vocabulary,
		schedule: { state: () => schedule.schedule.state() }
	});
	// The tuned Submissions surface: triage rows joined with decision heads
	// and whole-slice standings, plus the direct-entry door through the same
	// registered operation. The tuned Decisions surface consumes the same list
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
		submissions: { list: (query) => submissions.submissions.list(query) },
		communications: communicationsAuthoring,
		readiness: communicationsReadiness
	});
	// The tuned Speakers surface: the engagement snapshot joined with the same
	// canonical Session catalog and triage clients the other surfaces share,
	// plus the permission-gated contact disclosure. The disclosure capability is
	// composed as attemptable — the server evaluates the exact permission on
	// every read, and a refusal keeps the address an empty value; no browser
	// role guess ever grants disclosure.
	const taskClient = createTasksLiveClient({ manifest: initial.manifest });
	const speakers = createLiveSpeakersPagePort({
		engagements: engagementsClient,
		sessions: sessionCatalog,
		triage,
		contacts: createIntakeSubmissionsLivePort({
			manifest: initial.manifest,
			contactCapability: { kind: 'available' }
		}),
		tasks: taskClient
	});
	const templates = createLiveTemplatesPagePort({
		artifacts: templateArtifacts,
		model: createTemplateEditLiveClient({ manifest: initial.manifest }),
		event: eventSettings,
		schedule: { state: () => schedule.schedule.state() },
		vocabulary: {
			tracks: () => vocabulary.tracks(),
			speakerCategories: () => speakers.vocab.speakerCategories()
		},
		speakers: { list: () => speakers.speakers.list() },
		forms: { list: () => forms.forms.list() },
		fields,
		publication: createTemplatePublicationLivePort({
			artifacts: templateArtifacts,
			release: releaseClient,
			forms: canonicalForms
		})
	});
	const embeds = createLiveEmbedsPagePort({ release, templates });
	const tasks = createLiveTasksPagePort({
		tasks: taskClient,
		speakers,
		templates,
		remind: createTaskReminderLiveSender({ communications: communicationsAuthoring })
	});
	// The Files surface joins the canonical roster (names for received
	// material) and the vocabulary (track names for share audiences); both
	// joins are tolerant, so a failed side read degrades labels, not the page.
	const files = createLiveFilesPagePort({
		manifest: initial.manifest,
		roster: { list: () => speakers.speakers.list() },
		vocabulary: { tracks: () => vocabulary.tracks() }
	});
	const pulse = createLivePulsePagePort({
		sources: {
			event: eventProgram.event,
			vocabulary: eventProgram.vocabulary,
			triage,
			decisions: decisionsClient,
			engagements: engagementsClient,
			sessions: sessionCatalog,
			history: createPulseHistoryLivePort({ manifest: initial.manifest })
		}
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
		pulse,
		eventProgram,
		communicationsReadiness,
		forms,
		submissions,
		decisions,
		embeds,
		settings,
		review,
		reviewers,
		schedule,
		speakers,
		files,
		templates,
		tasks,
		agentActions: createLiveAgentActionsPagePort(),
		integrations: createLiveIntegrationsPagePort()
	}));
</script>

<WorkspaceShell port={shell}>
	{@render children()}
</WorkspaceShell>
