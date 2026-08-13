<script lang="ts">
	import LiveUnavailablePage from '$lib/features/workspace/components/LiveUnavailablePage.svelte';
	import CommunicationsReadinessPage from '$lib/features/communications/CommunicationsReadinessPage.svelte';
	import OverviewDashboard from '$lib/features/workspace/components/OverviewDashboard.svelte';
	import FormsPage from '$lib/features/forms/FormsPage.svelte';
	import OrganizerSubmissionsLivePage from '$lib/features/submissions/OrganizerSubmissionsLivePage.svelte';
	import SettingsPage from '$lib/features/settings/SettingsPage.svelte';
	import { useLiveWorkspacePorts } from './live-workspace';
	import type { OperatorPageId } from './operator-pages';

	let { area }: { readonly area: OperatorPageId } = $props();
	const ports = useLiveWorkspacePorts();

	const labels: Readonly<Record<OperatorPageId, string>> = Object.freeze({
		overview: 'Overview',
		submissions: 'Submissions',
		review: 'Review',
		review_lineup: 'Line-up',
		decisions: 'Decisions',
		speakers: 'Speakers',
		reviewers: 'Reviewers',
		tasks: 'Tasks',
		schedule: 'Schedule',
		communications: 'Communications',
		forms: 'Forms',
		templates: 'Templates',
		embeds: 'Embeds',
		settings: 'Settings'
	});
</script>

{#if area === 'overview'}
	<OverviewDashboard port={ports.overview} />
{:else if area === 'submissions'}
	<OrganizerSubmissionsLivePage port={ports.submissions} vocabulary={ports.eventProgram.vocabulary} />
{:else if area === 'forms'}
	<FormsPage port={ports.forms} />
{:else if area === 'communications'}
	<CommunicationsReadinessPage port={ports.communicationsReadiness} />
{:else if area === 'settings'}
	<SettingsPage port={ports.settings} />
{:else}
	<LiveUnavailablePage title={labels[area]} />
{/if}
