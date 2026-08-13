<script lang="ts">
	import CommunicationsPage from '$lib/features/communications/CommunicationsPage.svelte';
	import DecisionsPage from '$lib/features/decisions/DecisionsPage.svelte';
	import EmbedsPage from '$lib/features/embeds/EmbedsPage.svelte';
	import FormsPage from '$lib/features/forms/FormsPage.svelte';
	import ReviewPage from '$lib/features/review/ReviewPage.svelte';
	import LineupPage from '$lib/features/review/LineupPage.svelte';
	import ReviewersPage from '$lib/features/reviewers/ReviewersPage.svelte';
	import SchedulePage from '$lib/features/schedule/SchedulePage.svelte';
	import SettingsPage from '$lib/features/settings/SettingsPage.svelte';
	import SpeakersPage from '$lib/features/speakers/SpeakersPage.svelte';
	import SubmissionsPage from '$lib/features/submissions/SubmissionsPage.svelte';
	import TasksPage from '$lib/features/tasks/TasksPage.svelte';
	import TemplatesPage from '$lib/features/templates/TemplatesPage.svelte';
	import OverviewDashboard from '$lib/features/workspace/components/OverviewDashboard.svelte';
	import { useWorkspaceGateway } from '../workspace-gateway';
	import { createSampleCommunicationsPagePort } from '../communications-page-port.sample';
	import { createSampleDecisionsPagePort } from '../decisions-page-port.sample';
	import { createSampleEmbedsPagePort } from '../embeds-page-port.sample';
	import { createSampleOverviewPagePort } from '../overview-page-port.sample';
	import { createSampleFormsPagePort } from '../forms-page-port.sample';
	import { createSampleReviewPagePort } from '../review-page-port.sample';
	import { createSampleReviewersPagePort } from '../reviewers-page-port.sample';
	import { createSampleSchedulePagePort } from '../schedule-page-port.sample';
	import { createSampleSpeakersPagePort } from '../speakers-page-port.sample';
	import { createSampleTasksPagePort } from '../tasks-page-port.sample';
	import { createSampleTemplatesPagePort } from '../templates-page-port.sample';
	import { createSampleSettingsPagePort } from '../settings-page-port';
	import { createSampleSubmissionsPagePort } from '../submissions-page-port.sample';
	import type { OperatorPageId } from './operator-pages';

	let { area }: { readonly area: OperatorPageId } = $props();
	const { api, source, viewer } = useWorkspaceGateway();
	const overview = createSampleOverviewPagePort({ api, scenario: source.scenario });
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
</script>

{#if area === 'overview'}
	<OverviewDashboard port={overview} />
{:else if area === 'submissions'}
	<SubmissionsPage port={submissions} />
{:else if area === 'review'}
	<ReviewPage port={review} />
{:else if area === 'review_lineup'}
	<LineupPage port={review} />
{:else if area === 'decisions'}
	<DecisionsPage port={decisions} />
{:else if area === 'speakers'}
	<SpeakersPage port={speakers} />
{:else if area === 'reviewers'}
	<ReviewersPage port={reviewers} />
{:else if area === 'tasks'}
	<TasksPage port={tasks} />
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
{:else}
	<SettingsPage port={settings} />
{/if}
