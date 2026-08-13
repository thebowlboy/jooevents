<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/ui';
	import type { EventProgramPort } from '$lib/api/event-program/port';
	import type { CurrentEventView } from '$lib/api/view-models/event';
	import EventFirstRun from './EventFirstRun.svelte';

	interface Props { port: EventProgramPort; }
	let { port }: Props = $props();
	let projection = $state<CurrentEventView | null>(null);
	let loading = $state(true);
	let error = $state('');

	onMount(load);

	async function load() {
		loading = true;
		error = '';
		const result = await port.event.read();
		loading = false;
		if (result.kind === 'success') {
			projection = result.data;
			return;
		}
		error = result.kind === 'unavailable'
			? 'Event overview is not available in this build.'
			: 'The current event could not be loaded.';
	}
</script>

<div class="event-overview" aria-busy={loading}>
	{#if loading}
		<div class="loading" aria-label="Loading current event"></div>
	{:else if error}
		<section class="error-block" aria-label="Event unavailable">
			<p>{error}</p>
			<Button variant="secondary" size="sm" onclick={load}>Try again</Button>
		</section>
	{:else if projection?.kind === 'no_event'}
		<EventFirstRun {port} {projection} oncreated={(created) => {
			projection = {
				kind: 'current_event',
				eventSetVersion: created.eventSetVersion,
				event: created.event
			};
		}} />
	{:else if projection?.kind === 'current_event'}
		<section class="current-event" aria-labelledby="current-event-title">
			<header>
				<div>
					<p class="eyebrow">Current event</p>
					<h1 id="current-event-title">{projection.event.name}</h1>
				</div>
				{#if port.source.kind === 'sample'}
					<span class="sample-label">Sample · {port.source.label}</span>
				{/if}
			</header>
			<dl>
				<div><dt>Dates</dt><dd>{projection.event.startDate} – {projection.event.endDate}</dd></div>
				<div><dt>Timezone</dt><dd>{projection.event.timezone}</dd></div>
			</dl>
		</section>
	{/if}
</div>

<style>
	.event-overview { min-block-size: 18rem; }
	.loading { min-block-size: 18rem; border-radius: var(--je-radius-lg); background: var(--je-color-surface-sunken); }
	.current-event, .error-block { max-inline-size: 48rem; padding: var(--je-space-8); border: 1px solid var(--je-color-border); border-radius: var(--je-radius-lg); background: var(--je-color-surface); box-shadow: var(--je-shadow-sm); }
	header { display: flex; align-items: start; justify-content: space-between; gap: var(--je-space-4); }
	h1 { margin: var(--je-space-1) 0 0; font: 700 var(--je-font-size-2xl)/var(--je-leading-tight) var(--je-font-display); }
	.eyebrow { margin: 0; color: var(--je-color-text-subtle); font-size: var(--je-font-size-xs); font-weight: 700; letter-spacing: var(--je-tracking-caps); text-transform: uppercase; }
	.sample-label { flex: none; padding: var(--je-space-1) var(--je-space-2); border-radius: var(--je-radius-round); background: var(--je-color-info-soft); color: var(--je-color-info); font-size: var(--je-font-size-xs); font-weight: 700; }
	dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--je-space-4); margin: var(--je-space-6) 0 0; }
	dl div { padding: var(--je-space-3); border-radius: var(--je-radius-sm); background: var(--je-color-surface-sunken); }
	dt { color: var(--je-color-text-subtle); font-size: var(--je-font-size-xs); font-weight: 700; text-transform: uppercase; letter-spacing: var(--je-tracking-caps); }
	dd { margin: var(--je-space-1) 0 0; color: var(--je-color-text); }
	.error-block p { color: var(--je-color-danger); }
	@media (max-width: 40rem) {
		.current-event, .error-block { padding: var(--je-space-5); }
		header { flex-direction: column; }
		dl { grid-template-columns: 1fr; }
	}
</style>
