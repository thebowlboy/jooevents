<script lang="ts">
	import { page } from '$app/state';
	import { FlaskConical, Minus, RotateCw } from 'lucide-svelte';
	import {
		activeScenarioKey,
		sampleLatencyMs,
		scenarios,
		setLatencyCookie,
		setScenarioCookie
	} from '$lib/api/sample/registry';

	// The tool rests as a corner pill and expands only while choosing, so it
	// never sits on top of the page being experienced.
	let open = $state(false);
	let root = $state<HTMLElement>();
	const active = activeScenarioKey();
	const latency = sampleLatencyMs();

	const latencyOptions = [
		{ ms: 160, label: 'Fast' },
		{ ms: 600, label: 'Pending' },
		{ ms: 2000, label: 'Slow' }
	];

	function setLatency(ms: number) {
		if (ms === latency) return;
		setLatencyCookie(ms);
		location.reload();
	}

	// Scenarios only affect workspace surfaces; stay out of entry/public flows.
	const relevant = $derived(/^\/(app|design-system)(\/|$)/.test(page.url.pathname));

	function toggle() {
		open = !open;
	}

	function activate(key: string) {
		if (key === active) {
			open = false;
			return;
		}
		setScenarioCookie(key);
		location.reload();
	}

	function onWindowPointerdown(event: PointerEvent) {
		if (open && root && !root.contains(event.target as Node)) open = false;
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (open && event.key === 'Escape') open = false;
	}
</script>

<svelte:window onpointerdown={onWindowPointerdown} onkeydown={onWindowKeydown} />

{#if !relevant}
	<!-- Not a sample-data surface. -->
{:else if open}
	<div class="dev" role="group" aria-label="Sample-data scenario switcher (dev only)" bind:this={root}>
		<header class="dev__head">
			<span class="dev__title"><FlaskConical size={13} aria-hidden="true" />Scenario</span>
			<span class="dev__page">{page.url.pathname}</span>
			<button type="button" class="dev__chrome" aria-label="Collapse scenario switcher" onclick={toggle}>
				<Minus size={13} />
			</button>
		</header>
		<ul class="dev__list">
			{#each scenarios as scenario (scenario.key)}
				<li>
					<button
						type="button"
						class="dev__item"
						class:dev__item--active={scenario.key === active}
						aria-pressed={scenario.key === active}
						onclick={() => activate(scenario.key)}>
						<span class="dev__name">
							{scenario.name}
							{#if scenario.key === active}<span class="dev__now">active</span>{/if}
						</span>
						<span class="dev__desc">{scenario.description}</span>
					</button>
				</li>
			{/each}
		</ul>
		<div class="dev__latency">
			<span class="dev__latency-label">Sample latency</span>
			<div class="ui-segmented" role="group" aria-label="Sample transport latency">
				{#each latencyOptions as option (option.ms)}
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={latency === option.ms}
						onclick={() => setLatency(option.ms)}>{option.label}</button>
				{/each}
			</div>
		</div>
		<p class="dev__hint"><RotateCw size={11} aria-hidden="true" />Selecting reloads the page with the scenario cookie set.</p>
	</div>
{:else}
	<button type="button" class="dev dev--pill" aria-label="Open scenario switcher" onclick={toggle}>
		<FlaskConical size={14} aria-hidden="true" />
	</button>
{/if}

<style>
	.dev {
		position: fixed;
		inset-block-end: var(--je-space-4);
		inset-inline-end: var(--je-space-4);
		z-index: 90;
		inline-size: 17rem;
		max-block-size: min(60vh, 26rem);
		overflow-y: auto;
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		box-shadow: var(--je-shadow-lg);
		font-size: var(--je-font-size-sm);
	}

	.dev--pill {
		inline-size: auto;
		display: grid;
		place-items: center;
		padding: var(--je-space-2);
		border-radius: var(--je-radius-round);
		color: var(--je-color-text-muted);
		cursor: pointer;
	}

	.dev--pill:hover {
		color: var(--je-color-text);
		border-color: var(--je-color-border-strong);
	}

	.dev__head {
		position: sticky;
		inset-block-start: 0;
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		padding: var(--je-space-2) var(--je-space-3);
		background: var(--je-color-surface);
		border-block-end: 1px solid var(--je-color-border);
	}

	.dev__title {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		font-weight: 650;
	}

	.dev__page {
		flex: 1;
		min-inline-size: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: end;
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
		font-family: var(--je-font-mono);
	}

	.dev__chrome {
		display: grid;
		place-items: center;
		border: 0;
		background: transparent;
		padding: var(--je-space-1);
		border-radius: var(--je-radius-xs);
		color: var(--je-color-text-muted);
		cursor: pointer;
	}

	.dev__chrome:hover {
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text);
	}

	.dev__list {
		list-style: none;
		margin: 0;
		padding: var(--je-space-2);
		display: grid;
		gap: var(--je-space-1);
	}

	.dev__item {
		display: grid;
		gap: 0;
		inline-size: 100%;
		text-align: start;
		padding: var(--je-space-2);
		border: 1px solid transparent;
		border-radius: var(--je-radius-control);
		background: transparent;
		cursor: pointer;
	}

	.dev__item:hover {
		background: var(--je-color-page);
	}

	.dev__item--active {
		border-color: var(--je-color-action);
		background: var(--je-color-surface-selected);
	}

	.dev__name {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-2);
		font-weight: 600;
	}

	.dev__now {
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-action);
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
	}

	.dev__desc {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.dev__latency {
		display: grid;
		gap: var(--je-space-1);
		padding: var(--je-space-2) var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border);
	}

	.dev__latency-label {
		font-size: var(--je-font-size-2xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.dev__hint {
		display: flex;
		align-items: center;
		gap: var(--je-space-1);
		margin: 0;
		padding: var(--je-space-2) var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border);
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
	}
</style>
