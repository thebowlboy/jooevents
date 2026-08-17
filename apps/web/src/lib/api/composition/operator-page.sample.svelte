<script lang="ts">
	import CommunicationsPage from '$lib/features/communications/CommunicationsPage.svelte';
	import DecisionsPage from '$lib/features/decisions/DecisionsPage.svelte';
	import EmbedsPage from '$lib/features/embeds/EmbedsPage.svelte';
	import FilesPage from '$lib/features/files/FilesPage.svelte';
	import FormsPage from '$lib/features/forms/FormsPage.svelte';
	import ReviewPage from '$lib/features/review/ReviewPage.svelte';
	import LineupPage from '$lib/features/review/LineupPage.svelte';
	import ReviewersPage from '$lib/features/reviewers/ReviewersPage.svelte';
	import SchedulePage from '$lib/features/schedule/SchedulePage.svelte';
	import SettingsPage from '$lib/features/settings/SettingsPage.svelte';
	import SpeakersPage from '$lib/features/speakers/SpeakersPage.svelte';
	import SubmissionsPage from '$lib/features/submissions/SubmissionsPage.svelte';
	import TasksPage from '$lib/features/tasks/TasksPage.svelte';
	import AgentActionsPage from '$lib/features/agent-actions/AgentActionsPage.svelte';
	import TemplatesPage from '$lib/features/templates/TemplatesPage.svelte';
	import OverviewDashboard from '$lib/features/workspace/components/OverviewDashboard.svelte';
	import PulseDashboard from '$lib/features/workspace/components/PulseDashboard.svelte';
	import { useWorkspaceGateway } from '../workspace-gateway';
	import { createSampleCommunicationsPagePort } from '../communications-page-port.sample';
	import { createSampleDecisionsPagePort } from '../decisions-page-port.sample';
	import { createSampleEmbedsPagePort } from '../embeds-page-port.sample';
	import { createSampleOverviewPagePort } from '../overview-page-port.sample';
	import { createSamplePulsePagePort } from '../pulse-page-port.sample';
	import { createSampleFilesPagePort } from '../files/sample';
	import { createSampleFormsPagePort } from '../forms-page-port.sample';
	import { createSampleReviewPagePort } from '../review-page-port.sample';
	import { createSampleReviewersPagePort } from '../reviewers-page-port.sample';
	import { createSampleSchedulePagePort } from '../schedule-page-port.sample';
	import { createSampleSpeakersPagePort } from '../speakers-page-port.sample';
	import { createSampleTasksPagePort } from '../tasks-page-port.sample';
	import { createSampleTemplatesPagePort } from '../templates-page-port.sample';
	import { createSampleSettingsPagePort } from '../settings-page-port';
	import { createSampleSubmissionsPagePort } from '../submissions-page-port.sample';
	import { createSampleAgentActionsPagePort } from '../agent-actions-page-port.sample';
	import { createSampleIntegrationsPagePort } from '../integrations-page-port';
	import { createSampleAcceleventsExportPort } from '../accelevents-export-port';
	import IntegrationsPage from '$lib/features/integrations/IntegrationsPage.svelte';
	import AcceleventsExportPage from '$lib/features/integrations/AcceleventsExportPage.svelte';
	import { settingsSectionOf, type OperatorPageId } from './operator-pages';

	let { area }: { readonly area: OperatorPageId } = $props();
	const { api, source, viewer } = useWorkspaceGateway();
	const overview = createSampleOverviewPagePort({ api, scenario: source.scenario });
	const pulse = createSamplePulsePagePort({ api, scenario: source.scenario });
	const communications = createSampleCommunicationsPagePort(api);
	const decisions = createSampleDecisionsPagePort(api);
	const embeds = createSampleEmbedsPagePort(api);
	const forms = createSampleFormsPagePort(api);
	const review = createSampleReviewPagePort(api, viewer);
	const reviewers = createSampleReviewersPagePort(api);
	const schedule = createSampleSchedulePagePort(api);
	const speakers = createSampleSpeakersPagePort(api);
	const tasks = createSampleTasksPagePort(api);
	const templates = createSampleTemplatesPagePort(api);
	const settings = createSampleSettingsPagePort(api);
	const submissions = createSampleSubmissionsPagePort(api);
	const files = createSampleFilesPagePort();
	const agentActions = createSampleAgentActionsPagePort();
	const integrations = createSampleIntegrationsPagePort();
	const acceleventsExport = createSampleAcceleventsExportPort();
</script>

{#if area === 'overview'}
	<OverviewDashboard port={overview} />
{:else if area === 'pulse'}
	<PulseDashboard port={pulse} />
{:else if area === 'submissions'}
	<SubmissionsPage port={submissions} />
{:else if area === 'review'}
	<ReviewPage port={review} />
{:else if area === 'review_lineup'}
	<LineupPage port={review} />
{:else if area === 'decisions'}
	<DecisionsPage port={decisions} lineupPort={review} />
{:else if area === 'speakers'}
	<SpeakersPage port={speakers} />
{:else if area === 'reviewers'}
	<ReviewersPage port={reviewers} />
{:else if area === 'tasks'}
	<TasksPage port={tasks} />
{:else if area === 'files'}
	<FilesPage port={files} />
{:else if area === 'schedule'}
	<SchedulePage port={schedule} />
{:else if area === 'communications'}
	<CommunicationsPage port={communications} />
{:else if area === 'forms'}
	<FormsPage port={forms} />
{:else if area === 'templates'}
	<TemplatesPage port={templates} />
{:else if area === 'embeds'}
	<EmbedsPage port={embeds} />
{:else if area === 'approvals'}
	<AgentActionsPage port={agentActions} />
{:else if area === 'integrations' || area === 'integrations_airtable'}
	<IntegrationsPage port={integrations} detail={area === 'integrations_airtable'} />
{:else if area === 'integrations_accelevents'}
	<AcceleventsExportPage port={acceleventsExport} />
{:else}
	<SettingsPage port={settings} section={settingsSectionOf(area)} />
{/if}
