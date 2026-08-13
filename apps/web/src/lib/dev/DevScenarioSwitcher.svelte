<script lang="ts">
	import { page } from '$app/state';
	import { FlaskConical, Minus, RotateCw } from 'lucide-svelte';
	import {
		activeScenarioKey,
		sampleLatencyMs,
		sampleViewer,
		scenarios,
		setLatencyCookie,
		setScenarioCookie,
		setViewerCookie
	} from '$lib/api/sample/registry';
	import {
		activePortalScenarioKey,
		portalAuthState,
		portalLinkOutcome,
		portalScenarios,
		setPortalAuthCookie,
		setPortalLinkCookie,
		setPortalScenarioCookie
	} from '$lib/api/portal/sample/registry';
	import { operatorEntryAuthState, setOperatorEntryAuthCookie } from '$lib/api/composition/entry-deps';

	// The tool rests as a corner pill and expands only while choosing, so it
	// never sits on top of the page being experienced.
	let open = $state(false);
	let root = $state<HTMLElement>();
	const active = activeScenarioKey();
	const activePortal = activePortalScenarioKey();
	const latency = sampleLatencyMs();
	const viewer = sampleViewer().kind;
	const portalAuth = portalAuthState();
	const linkOutcome = portalLinkOutcome();
	const entryAuth = operatorEntryAuthState();

	const latencyOptions = [
		{ value: '160', label: 'Fast' },
		{ value: '600', label: 'Pending' },
		{ value: '2000', label: 'Slow' }
	];

	const viewerOptions = [
		{ value: 'organizer', label: 'Organizer' },
		{ value: 'reviewer', label: 'Reviewer' }
	];

	const portalAuthOptions = [
		{ value: 'active', label: 'Signed in' },
		{ value: 'anonymous', label: 'Signed out' },
		{ value: 'expired', label: 'Expired' }
	];

	const linkOptions = [
		{ value: 'signed_in', label: 'Valid' },
		{ value: 'link_expired', label: 'Expired' },
		{ value: 'link_used', label: 'Used' },
		{ value: 'link_invalid', label: 'Invalid' }
	];

	const entryAuthOptions = [
		{ value: 'anonymous', label: 'Signed out' },
		{ value: 'active', label: 'Signed in' }
	];

	// Which world the current route belongs to. Controls for the other lane are
	// noise on a surface that cannot show their effect.
	const lane = $derived(
		/^\/portal(\/|$)/.test(page.url.pathname)
			? 'portal'
			: /^\/(app|design-system)(\/|$)/.test(page.url.pathname)
				? 'workspace'
				: /^\/(sign-in|auth|access)(\/|$)/.test(page.url.pathname)
					? 'entry'
					: null
	);

	function reload(): void {
		location.reload();
	}

	function toggle() {
		open = !open;
	}

	function activate(key: string) {
		if (key === active) {
			open = false;
			return;
		}
		setScenarioCookie(key);
		reload();
	}

	function activatePortal(key: string) {
		if (key === activePortal) {
			open = false;
			return;
		}
		setPortalScenarioCookie(key);
		reload();
	}

	function onWindowPointerdown(event: PointerEvent) {
		if (open && root && !root.contains(event.target as Node)) open = false;
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (open && event.key === 'Escape') open = false;
	}
</script>

<svelte:window onpointerdown={onWindowPointerdown} onkeydown={onWindowKeydown} />

{#snippet choice(
	label: string,
	options: { value: string; label: string }[],
	current: string,
	select: (value: string) => void
)}
	<div class="dev__choice">
		<span class="dev__choice-label">{label}</span>
		<div class="ui-segmented" role="group" aria-label={label}>
			{#each options as option (option.value)}
				<button
					type="button"
					class="ui-segmented__item"
					aria-pressed={current === option.value}
					onclick={() => {
						if (current !== option.value) select(option.value);
					}}>{option.label}</button>
			{/each}
		</div>
	</div>
{/snippet}

{#if lane === null}
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
		{#if lane === 'workspace'}
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
			{@render choice('Viewing as', viewerOptions, viewer, (value) => {
				setViewerCookie(value as 'organizer' | 'reviewer');
				reload();
			})}
		{:else if lane === 'portal'}
			<ul class="dev__list">
				{#each portalScenarios as scenario (scenario.key)}
					<li>
						<button
							type="button"
							class="dev__item"
							class:dev__item--active={scenario.key === activePortal}
							aria-pressed={scenario.key === activePortal}
							onclick={() => activatePortal(scenario.key)}>
							<span class="dev__name">
								{scenario.name}
								{#if scenario.key === activePortal}<span class="dev__now">active</span>{/if}
							</span>
							<span class="dev__desc">{scenario.description}</span>
						</button>
					</li>
				{/each}
			</ul>
			{@render choice('Portal access', portalAuthOptions, portalAuth, (value) => {
				setPortalAuthCookie(value as 'anonymous' | 'active' | 'expired');
				reload();
			})}
			{@render choice('Emailed link', linkOptions, linkOutcome, (value) => {
				setPortalLinkCookie(value as 'signed_in' | 'link_expired' | 'link_used' | 'link_invalid');
				reload();
			})}
		{:else}
			{@render choice('Workspace access', entryAuthOptions, entryAuth, (value) => {
				setOperatorEntryAuthCookie(value as 'anonymous' | 'active');
				reload();
			})}
			{@render choice('Emailed link', linkOptions, linkOutcome, (value) => {
				setPortalLinkCookie(value as 'signed_in' | 'link_expired' | 'link_used' | 'link_invalid');
				reload();
			})}
		{/if}
		{@render choice('Sample latency', latencyOptions, String(latency), (value) => {
			setLatencyCookie(Number(value));
			reload();
		})}
		<p class="dev__hint"><RotateCw size={11} aria-hidden="true" />Selecting reloads the page with the cookie set.</p>
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
		border-color: var(--je-color-mark-border);
		background: var(--je-color-mark-surface);
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

	.dev__choice {
		display: grid;
		gap: var(--je-space-1);
		padding: var(--je-space-2) var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border);
	}

	.dev__choice-label {
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
