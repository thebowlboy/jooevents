<script lang="ts">
	/**
	 * One settings section, composed. Every section is its own address, so this
	 * holds what all of them share — whether an event exists yet, the width the
	 * panels below read, and the page's own on-this-page rail — and hands the
	 * rest to the panel that owns it.
	 */
	import { onMount } from 'svelte';
	import type { SettingsPagePort } from '$lib/api/settings-page-port';
	import type { EventSettings } from '$lib/api/types';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import AboutPanel from './AboutPanel.svelte';
	import ApiKeysPanel from './ApiKeysPanel.svelte';
	import EmailSenderPanel from './EmailSenderPanel.svelte';
	import EventIdentityPanel from './EventIdentityPanel.svelte';
	import OnThisPageRail from './OnThisPageRail.svelte';
	import ProgramBasicsPanel from './ProgramBasicsPanel.svelte';
	import SpeakerFieldsSection from './SpeakerFieldsSection.svelte';
	import StartPanel from './StartPanel.svelte';
	import TeamPanel from './TeamPanel.svelte';
	import {
		settingsRail,
		settingsSectionByKey,
		settingsSections,
		type SettingsSectionKey
	} from './sections';

	let {
		port,
		section
	}: { readonly port: SettingsPagePort; readonly section: SettingsSectionKey } = $props();

	let loaded = $state(false);
	let settings = $state<EventSettings | null>(null);
	let narrow = $state(false);
	let fieldsSection = $state<SpeakerFieldsSection>();
	let programPanel = $state<ProgramBasicsPanel>();

	// What the shell already knows decides which composition holds the space: a
	// workspace with no event resolves to the start panel, not to these panels.
	const known = $derived(port.workspace.summarySnapshot());
	const expectEvent = $derived(known?.event != null);
	const rail = $derived(settingsRail(settingsSectionByKey(section)));

	onMount(async () => {
		// About describes the software, and Email and API keys describe the
		// workspace, so all three read before any event exists. None asks this
		// shell for one; each panel owns its own read and its own waiting shell.
		if (section === 'about' || section === 'email' || section === 'api_keys') {
			loaded = true;
			return;
		}
		const current = await port.event.get();
		settings = current ? { ...current } : null;
		loaded = true;
	});

	// The members list is a table on wide viewports and a card list on narrow
	// ones, and the identity form is one column or two, so the width decision is
	// read once here rather than per row.
	$effect(() => {
		const query = window.matchMedia('(max-width: 920px)');
		const apply = () => (narrow = query.matches);
		apply();
		query.addEventListener('change', apply);
		return () => query.removeEventListener('change', apply);
	});
</script>

<!-- The surface's own head says what Settings is made of. Tabs, not a second
     menu: the design system's "tabs preserve context within one entity", and
     each tab is the section's real address, so the switch is a navigation the
     back button and deep links already understand. The rail names the area;
     which part of it is chosen here, the same division of labour as trays and
     zones on the other surfaces. -->
<nav class="ui-tabs sections" aria-label="Settings sections">
	{#each settingsSections as entry (entry.key)}
		<a
			class="ui-tab"
			href={entry.href}
			aria-current={entry.key === section ? 'page' : undefined}>{entry.label}</a>
	{/each}
</nav>

<div class="settings" class:settings--railed={rail.visible}>
	<div class="settings__main">
		{#if section === 'about'}
			<AboutPanel />
		{:else if section === 'email'}
			<!-- Workspace-scoped: a workspace with no event still sends mail, so
			     this section is not gated on the event read above. -->
			<EmailSenderPanel {port} />
			<CommitReceipt />
		{:else if section === 'api_keys'}
			<!-- Workspace-scoped credentials: readable before any event exists. -->
			<ApiKeysPanel apiKeys={port.apiKeys} {narrow} />
		{:else if !loaded && known !== null && !expectEvent}
			{#if known}
				<!-- Evidence says this workspace has no event yet, so the start panel is
				     the composition that holds the space. -->
				<StartPanel loading />
			{/if}
		{:else if !loaded}
			<!-- Each placeholder is its resolved panel's own markup holding skeleton
			     fills, so the waiting page and the resolved page share one geometry. -->
			{#if section === 'event'}
				<EventIdentityPanel {port} {narrow} loading />
			{:else if section === 'program'}
				<ProgramBasicsPanel {port} loading />
			{:else}
				<TeamPanel {port} {narrow} loading />
			{/if}
		{:else if !settings}
			<StartPanel />
		{:else if section === 'event'}
			<EventIdentityPanel {port} event={settings} {narrow} />
		{:else if section === 'program'}
			<ProgramBasicsPanel {port} bind:this={programPanel} />
		{:else}
			<TeamPanel {port} {narrow} />
		{/if}

		{#if section === 'program'}
			<!-- Outside the loading conditional on purpose: the section owns its own
			     waiting shell, so it mounts as soon as evidence says an event exists
			     and is not torn down and refetched when the panel above resolves. A
			     workspace without an event resolves to the start panel alone, this
			     section included. -->
			{#if loaded ? settings !== null : expectEvent}
				<SpeakerFieldsSection
					id="settings-speaker-fields"
					fields={port.fields}
					bind:this={fieldsSection} />
			{/if}

			<!-- The undoable work in Settings is all on this section, so the receipt
			     stands with it and refreshes exactly what its compensator changed. -->
			<CommitReceipt
				onUndone={() => {
					programPanel?.reload();
					fieldsSection?.reload();
				}} />
		{/if}
	</div>

	{#if rail.visible}
		<OnThisPageRail entries={rail.entries} />
	{/if}
</div>

<style>
	/* Head to content is a section-tier boundary; the tab underline already
	   draws the line, so the space says the rest. */
	.sections {
		margin-block-end: var(--je-space-6);
	}

	.settings {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-items: start;
		gap: var(--je-space-6);
	}

	/* Section to section, so the panels keep the rhythm they had when they all
	   stood on one page. */
	.settings__main {
		display: grid;
		align-content: start;
		gap: var(--je-space-6);
		min-inline-size: 0;
	}

	/* The rail is a column of its own only where the content column can spare
	   the width; below that it is not rendered at all. */
	@media (min-width: 1180px) {
		.settings--railed {
			grid-template-columns: minmax(0, 1fr) 11rem;
		}
	}
</style>
