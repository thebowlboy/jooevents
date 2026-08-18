<script lang="ts">
	import LiveUnavailablePage from '$lib/features/workspace/components/LiveUnavailablePage.svelte';
	import CommunicationsPage from '$lib/features/communications/CommunicationsPage.svelte';
	import DecisionsPage from '$lib/features/decisions/DecisionsPage.svelte';
	import EmbedsPage from '$lib/features/embeds/EmbedsPage.svelte';
	import FilesPage from '$lib/features/files/FilesPage.svelte';
	import OverviewDashboard from '$lib/features/workspace/components/OverviewDashboard.svelte';
	import PulseDashboard from '$lib/features/workspace/components/PulseDashboard.svelte';
	import FormsPage from '$lib/features/forms/FormsPage.svelte';
	import SubmissionsPage from '$lib/features/submissions/SubmissionsPage.svelte';
	import ReviewPage from '$lib/features/review/ReviewPage.svelte';
	import LineupPage from '$lib/features/review/LineupPage.svelte';
	import ReviewersPage from '$lib/features/reviewers/ReviewersPage.svelte';
	import SchedulePage from '$lib/features/schedule/SchedulePage.svelte';
	import SettingsPage from '$lib/features/settings/SettingsPage.svelte';
	import SpeakersPage from '$lib/features/speakers/SpeakersPage.svelte';
	import SpeakerRecordPage from '$lib/features/speakers/SpeakerRecordPage.svelte';
	import TemplatesPage from '$lib/features/templates/TemplatesPage.svelte';
	import TasksPage from '$lib/features/tasks/TasksPage.svelte';
	import AgentActionsPage from '$lib/features/agent-actions/AgentActionsPage.svelte';
	import IntegrationsPage from '$lib/features/integrations/IntegrationsPage.svelte';
	import AcceleventsExportPage from '$lib/features/integrations/AcceleventsExportPage.svelte';
	import { useLiveWorkspacePorts } from './live-workspace';
	import { ReviewResolutionError } from './review-resolution';
	import { isSettingsPage, settingsSectionOf, type OperatorPageId } from './operator-pages';

	let {
		area,
		engagementId
	}: { readonly area: OperatorPageId; readonly engagementId?: string } = $props();
	const ports = useLiveWorkspacePorts();

	/**
	 * Re-keys the review resolver after a retryable failure. The composition's
	 * memo has already cleared for those, so a new key issues a fresh read;
	 * terminal typed failures render without this affordance and keep their
	 * memoized answer.
	 */
	let reviewAttempt = $state(0);

	function terminalReviewFailure(error: unknown): string | null {
		return error instanceof ReviewResolutionError && error.terminal ? error.message : null;
	}

	const labels: Readonly<Record<OperatorPageId, string>> = Object.freeze({
		overview: 'Overview',
		pulse: 'Pulse',
		submissions: 'Submissions',
		review: 'Review',
		review_lineup: 'Line-up',
		decisions: 'Decisions',
		speakers: 'Speakers',
		speaker_record: 'Speaker record',
		reviewers: 'Reviewers',
		tasks: 'Tasks',
		files: 'Files',
		schedule: 'Schedule',
		communications: 'Communications',
		forms: 'Forms',
		templates: 'Templates',
		embeds: 'Embeds',
		approvals: 'Approvals',
		integrations: 'Integrations',
		integrations_airtable: 'Integrations',
		integrations_accelevents: 'Integrations',
		settings: 'Settings',
		settings_event: 'Settings',
		settings_program: 'Settings',
		settings_team: 'Settings',
		settings_email: 'Settings',
		settings_api_keys: 'Settings',
		settings_about: 'Settings'
	});
</script>

{#if area === 'overview'}
	<OverviewDashboard port={ports.overview} />
{:else if area === 'pulse'}
	<PulseDashboard port={ports.pulse} />
{:else if area === 'submissions'}
	<SubmissionsPage port={ports.submissions} />
{:else if area === 'decisions'}
	<DecisionsPage port={ports.decisions} resolveLineupPort={ports.review} />
{:else if area === 'review' || area === 'review_lineup'}
	<!-- The live Review port exists only once the snapshot has disclosed which
	     authority projection the server serves (organizer or reviewer); until
	     then a stable placeholder holds the space the page will occupy. A
	     failed read is classified, never flattened: a terminal typed refusal
	     (access denied, an operation the captured manifest cannot carry)
	     renders as the refusal it is, with no retry affordance, while only
	     transport/retryable failures offer the in-place retry. -->
	{#key reviewAttempt}
		{#await ports.review()}
			<section class="review-resolving" role="status" aria-label={labels[area]}>
				<span class="ui-skeleton review-resolving__heading" aria-hidden="true"></span>
				<span class="ui-skeleton review-resolving__line" aria-hidden="true"></span>
				<span class="ui-sr-only">Loading {labels[area]}…</span>
			</section>
		{:then port}
			{#if area === 'review'}
				<ReviewPage {port} />
			{:else}
				<LineupPage {port} />
			{/if}
		{:catch error}
			{@const terminal = terminalReviewFailure(error)}
			{#if terminal !== null}
				<LiveUnavailablePage title={labels[area]} detail={terminal} />
			{:else}
				<section class="review-failed" role="alert" aria-label={labels[area]}>
					<h2>{labels[area]} could not be loaded</h2>
					<p>The review workspace could not be reached. It may load on another try.</p>
					<button
						class="ui-button ui-button--secondary"
						type="button"
						onclick={() => (reviewAttempt += 1)}>Try again</button>
				</section>
			{/if}
		{/await}
	{/key}
{:else if area === 'speakers'}
	<SpeakersPage port={ports.speakers} />
{:else if area === 'speaker_record'}
	<SpeakerRecordPage port={ports.speakerRecord} engagementId={engagementId ?? ''} />
{:else if area === 'tasks'}
	<TasksPage port={ports.tasks} />
{:else if area === 'files'}
	<FilesPage port={ports.files} />
{:else if area === 'reviewers'}
	<ReviewersPage port={ports.reviewers} />
{:else if area === 'schedule'}
	<SchedulePage port={ports.schedule} />
{:else if area === 'forms'}
	<FormsPage port={ports.forms} />
{:else if area === 'templates'}
	<TemplatesPage port={ports.templates} />
{:else if area === 'embeds'}
	<EmbedsPage port={ports.embeds} />
{:else if area === 'communications'}
	<CommunicationsPage port={ports.communications} />
{:else if area === 'approvals'}
	<AgentActionsPage port={ports.agentActions} />
{:else if area === 'integrations' || area === 'integrations_airtable'}
	<IntegrationsPage port={ports.integrations} detail={area === 'integrations_airtable'} />
{:else if area === 'integrations_accelevents'}
	<AcceleventsExportPage port={ports.acceleventsExport} />
{:else if isSettingsPage(area)}
	<SettingsPage port={ports.settings} section={settingsSectionOf(area)} />
{:else}
	<LiveUnavailablePage title={labels[area]} />
{/if}

<style>
	/* Geometrically stable resolver state: reserves the block the resolved
	   page's own header and first section occupy, so the handoff from the
	   viewer read to the page's skeletons does not collapse the container. */
	.review-resolving {
		display: grid;
		align-content: start;
		gap: var(--je-space-4);
		min-block-size: 18rem;
	}

	.review-resolving__heading {
		display: block;
		inline-size: min(18rem, 60%);
		block-size: 1.75rem;
		border-radius: var(--je-radius-xs);
	}

	.review-resolving__line {
		display: block;
		inline-size: min(28rem, 92%);
		block-size: 1rem;
		border-radius: var(--je-radius-xs);
	}

	/* Retryable failure keeps the resolver's reserved block, so the handoff
	   from skeleton to failure to a retried skeleton never collapses. */
	.review-failed {
		display: grid;
		align-content: center;
		justify-items: center;
		gap: var(--je-space-3);
		min-block-size: 18rem;
		padding: var(--je-space-6);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		text-align: center;
	}

	.review-failed h2,
	.review-failed p {
		margin: 0;
	}

	.review-failed p {
		max-inline-size: 42rem;
		color: var(--je-color-text-muted);
	}
</style>
