<script lang="ts">
	import type { Snippet } from 'svelte';
	import { tick } from 'svelte';
	import { navigating, page } from '$app/state';
	import { afterNavigate } from '$app/navigation';
	import { ChevronsUpDown, Lock, Menu, Plus, X } from 'lucide-svelte';
	import wordmarkUrl from '$lib/assets/brand/jooevents-wordmark-login-256.png';
	import { useWorkspaceGateway } from '$lib/api/workspace-gateway';
	import { PENDING_MIN_VISIBLE_MS, Popover, trackPending } from '$lib/ui';
	import type { WorkspaceSummary } from '$lib/api/types';
	import {
		destinationLabel,
		isActive as matchesPath,
		navGroups,
		navHref,
		navMeta,
		overviewItem,
		settingsItem
	} from '../navigation';

	const { api, source } = useWorkspaceGateway();
	const sampleMode = source.kind === 'sample';
	const sampleScenario = source.scenario;

	let {
		title,
		activePath,
		children
	}: {
		/** Overrides the destination title derived from the address. */
		title?: string;
		/** Pins the selected destination; only the design reference needs this. */
		activePath?: string;
		children: Snippet;
	} = $props();

	let summary = $state<WorkspaceSummary | null>(null);
	let navOpen = $state(false);
	let isNarrow = $state(false);
	let closeButton = $state<HTMLButtonElement>();
	let menuButton = $state<HTMLButtonElement>();

	// The shell is layout-owned chrome: it outlives every in-app navigation, so the
	// sidebar is fetched once and afterwards refreshed in place. Counts change
	// quietly under the person; they never revert to a skeleton they already passed.
	let summaryRequest = 0;
	async function loadSummary() {
		const request = (summaryRequest += 1);
		const next = await api.workspace.summary();
		if (request === summaryRequest) summary = next;
	}

	// Runs for the initial navigation as well as later ones.
	afterNavigate(() => {
		void loadSummary();
		if (navOpen) closeNav();
	});

	// The shell presents exactly one destination at a time.
	//
	// Selection, title, and content are three views of `presented` — a single
	// value — so they cannot disagree. Deriving them separately is what allowed a
	// torn frame, where the sidebar had already moved to the destination while the
	// title and the content still described the page being left behind.
	//
	// `page.url` and the content slot are swapped together by the router, so
	// following it is atomic by construction. The one case that needs help is a
	// slow destination: rather than sit on stale content, the shell hands over
	// early and renders the destination's unresolved state itself. Handover moves
	// all three views at once, so that state is coherent too — it is the
	// destination, not yet resolved.
	const handover = trackPending(() => navigating.to !== null, {
		minVisibleMs: PENDING_MIN_VISIBLE_MS
	});

	const presented = $derived(
		handover.visible ? (navigating.to?.url.pathname ?? page.url.pathname) : page.url.pathname
	);

	const current = $derived(activePath ?? presented);
	const destination = $derived(title ?? destinationLabel(presented) ?? 'Workspace');

	function isActive(href: string) {
		return matchesPath(current, href);
	}

	function metaFor(key: (typeof overviewItem)['key']) {
		return summary ? navMeta(summary.navCounts, key) : undefined;
	}

	function isLocked(key: (typeof overviewItem)['key']) {
		return summary?.lockedAreas.includes(key) ?? false;
	}

	async function openNav() {
		navOpen = true;
		await tick();
		closeButton?.focus();
	}

	async function closeNav() {
		navOpen = false;
		await tick();
		menuButton?.focus();
	}

	// The drawer presentation is owned by the same width query as the CSS; when
	// the layout returns to the static sidebar, the open state must not linger.
	$effect(() => {
		const query = window.matchMedia('(max-width: 920px)');
		const apply = () => {
			isNarrow = query.matches;
			if (!query.matches) navOpen = false;
		};
		apply();
		query.addEventListener('change', apply);
		return () => query.removeEventListener('change', apply);
	});

	$effect(() => {
		if (!navOpen) return;
		const root = document.documentElement;
		const previousRoot = root.style.overflow;
		const previousBody = document.body.style.overflow;
		root.style.overflow = 'hidden';
		document.body.style.overflow = 'hidden';
		return () => {
			root.style.overflow = previousRoot;
			document.body.style.overflow = previousBody;
		};
	});

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && navOpen) closeNav();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="shell">
	<aside
		class="side"
		class:side--open={navOpen}
		inert={isNarrow && !navOpen}
		role={navOpen ? 'dialog' : undefined}
		aria-modal={navOpen ? 'true' : undefined}
		aria-label={navOpen ? 'Navigation' : undefined}>
		<div class="side__top">
			<a class="side__brand" href="/app">
				<img src={wordmarkUrl} alt="JooEvents" width="120" height="22" />
			</a>
			<button
				type="button"
				class="ui-button ui-button--ghost ui-button--icon ui-button--sm side__close"
				aria-label="Close navigation"
				bind:this={closeButton}
				onclick={closeNav}>
				<X size={16} />
			</button>
		</div>

		{#if !summary}
			{@const known = api.workspace.summarySnapshot()}
			<!-- The chip and the create button are different compositions, so what
			     is already known about the workspace decides which one holds the
			     space; each placeholder is that composition with skeleton fills. -->
			{#if known && !known.event}
				<span class="ui-skeleton side__create-skeleton" aria-hidden="true"></span>
			{:else}
				<div class="side__event side__event--loading" aria-hidden="true">
					<span class="side__event-name"><span class="ui-skeleton side__event-fill"></span></span>
					<span class="side__event-dates"><span class="ui-skeleton side__event-fill side__event-fill--short"></span></span>
				</div>
			{/if}
		{:else if summary.event}
			<button type="button" class="side__event">
				<span class="ui-sr-only">Switch event:</span>
				<span class="side__event-name">{summary.event.name}</span>
				<span class="side__event-dates">{summary.event.dates} · {summary.event.location}</span>
				<span class="side__event-caret" aria-hidden="true"><ChevronsUpDown size={14} /></span>
			</button>
		{:else}
			<button type="button" class="ui-button ui-button--primary side__create">
				<Plus size={16} aria-hidden="true" />Create your first event
			</button>
		{/if}

		<nav class="side__nav" aria-label="Workspace">
			<a
				class="side__link"
				class:side__link--active={isActive(overviewItem.href)}
				href={overviewItem.href}
				aria-current={isActive(overviewItem.href) ? 'page' : undefined}>
				<overviewItem.icon size={16} aria-hidden="true" />{overviewItem.label}
			</a>
			{#each navGroups as group (group.label)}
				<span class="side__group">{group.label}</span>
				{#each group.items as item (item.href)}
					{#if isLocked(item.key)}
						<span class="side__link side__link--locked" title="Unlocks once your first event exists">
							<item.icon size={16} aria-hidden="true" />{item.label}
							<span class="side__meta side__meta--lock"><Lock size={12} aria-hidden="true" /><span class="ui-sr-only">Locked until an event exists</span></span>
						</span>
					{:else}
						{@const meta = metaFor(item.key)}
						<!-- One link per row: a blocking count re-aims where it goes, it never
						     becomes a second target inside the row. -->
						<a
							class="side__link"
							class:side__link--active={isActive(item.href)}
							href={navHref(item, meta)}
							aria-current={isActive(item.href) ? 'page' : undefined}>
							<item.icon size={16} aria-hidden="true" />{item.label}
							{#if meta}
								<span
									class="side__meta"
									class:side__meta--warning={meta.tone === 'warning'}
									class:side__meta--danger={meta.tone === 'danger'}>{meta.value}</span>
							{/if}
						</a>
					{/if}
				{/each}
			{/each}
		</nav>
		<div class="side__foot">
			<a
				class="side__link"
				class:side__link--active={isActive(settingsItem.href)}
				href={settingsItem.href}
				aria-current={isActive(settingsItem.href) ? 'page' : undefined}>
				<settingsItem.icon size={16} aria-hidden="true" />{settingsItem.label}
			</a>
			<div class="side__user">
				<span class="ui-avatar ui-avatar--sm">JK</span>
				<span class="side__user-name">Jere K.</span>
			</div>
		</div>
	</aside>

	{#if navOpen}
		<button type="button" class="scrim" aria-hidden="true" tabindex={-1} onclick={closeNav}></button>
	{/if}

	<div class="body" inert={navOpen}>
		<header class="top">
			<button
				type="button"
				class="ui-button ui-button--ghost ui-button--icon top__menu"
				aria-label="Open navigation"
				aria-expanded={navOpen}
				bind:this={menuButton}
				onclick={openNav}>
				<Menu size={18} />
			</button>
			<h1 class="top__title">{destination}</h1>
			{#if sampleMode}
				<!-- This badge governs the truth value of every other number on screen,
				     so it says which story they belong to when asked. -->
				<Popover label="Sample data — what these numbers are">
					{#snippet trigger()}
						<span class="ui-badge ui-badge--neutral">Sample data</span>
					{/snippet}
					{#snippet children()}
						<p class="sample__name">{sampleScenario.name}</p>
						<p class="sample__copy">{sampleScenario.description}</p>
						<p class="sample__copy">
							Every count, row, and name in this workspace comes from that scenario. Nothing is a
							real event, and changes you commit last until the page is reloaded.
						</p>
					{/snippet}
				</Popover>
			{/if}
			<span class="ui-avatar ui-avatar--sm top__avatar">JK</span>

			{#if handover.visible}
				<span class="top__arriving" aria-hidden="true"><span></span></span>
			{/if}
		</header>

		<main class="content">
			{#if handover.visible}
				<!-- The destination, not yet resolved. Interim treatment: the chosen
				     candidate from /design-system/loading replaces this composition,
				     which is the one place the shell renders a destination's waiting
				     state. `role="status"` makes the visible sentence the
				     announcement, so nothing is said twice. -->
				<section class="waiting" role="status">
					<p class="waiting__line">Loading {destination}…</p>
				</section>
			{:else}
				{@render children()}
			{/if}
		</main>
	</div>
</div>

<style>
	.shell {
		min-height: 100svh;
		display: flex;
		background: var(--je-color-page);
	}

	/* Sidebar */
	.side {
		position: sticky;
		inset-block-start: 0;
		block-size: 100svh;
		overflow-y: auto;
		inline-size: var(--je-sidebar-width);
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: var(--je-space-4);
		padding: var(--je-space-4) var(--je-space-3);
		background: var(--je-color-canvas);
		border-inline-end: 1px solid var(--je-color-border);
	}

	.side__top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-inline: var(--je-space-2);
	}

	.side__brand {
		display: block;
		border-radius: var(--je-radius-xs);
	}

	.side__brand img {
		display: block;
	}

	.side__close {
		display: none;
	}

	.side__event {
		position: relative;
		display: grid;
		gap: var(--je-space-1);
		text-align: start;
		padding: var(--je-space-2) var(--je-space-3);
		padding-inline-end: var(--je-space-8);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface);
		cursor: pointer;
		min-block-size: 3.25rem;
	}

	.side__event--loading {
		cursor: default;
	}

	/* Each fill is one line box inside the line it stands in for, so the chip
	   keeps the height its resolved name and dates give it. */
	.side__event-fill {
		display: inline-block;
		block-size: 1em;
		block-size: 1lh;
		inline-size: 80%;
		vertical-align: bottom;
	}

	.side__event-fill--short {
		inline-size: 55%;
	}

	.side__create-skeleton {
		display: block;
		block-size: var(--je-control-height);
		border-radius: var(--je-radius-control);
	}

	.side__event:hover:not(.side__event--loading) {
		border-color: var(--je-color-border-strong);
	}

	.side__create {
		inline-size: 100%;
	}

	.side__event-name {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.side__event-dates {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.side__event-caret {
		position: absolute;
		inset-inline-end: var(--je-space-2);
		inset-block-start: 50%;
		translate: 0 -50%;
		color: var(--je-color-text-muted);
	}

	.side__nav {
		display: flex;
		flex-direction: column;
		gap: 0;
		flex: 1;
	}

	.side__group {
		margin-block-start: var(--je-space-4);
		padding-inline: var(--je-space-2);
		font-size: var(--je-font-size-2xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.side__link {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		padding: var(--je-space-2);
		border-radius: var(--je-radius-control);
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
		text-decoration: none;
	}

	.side__link:hover {
		background: var(--je-color-surface);
		color: var(--je-color-text);
	}

	/* Acknowledgement for the window before the destination is presented. The
	   press is a fact about the input, so it can be reported instantly without
	   claiming the destination is already current — which is the claim that would
	   put the sidebar and the content out of step. */
	.side__link:active {
		background: var(--je-color-surface-selected);
		color: var(--je-color-text);
	}

	/* Selected reads as "chosen", not "alarmed": ink text on a quiet selected
	   surface, with a small brand mark instead of a colored fill. */
	.side__link--active {
		background: var(--je-color-surface-selected);
		color: var(--je-color-text);
		font-weight: 600;
	}

	.side__link--active::before {
		content: '';
		position: absolute;
		inset-inline-start: 0;
		inset-block: 20%;
		inline-size: 3px;
		border-radius: var(--je-radius-round);
		background: var(--je-color-action);
	}

	.side__link--locked {
		color: var(--je-color-text-disabled);
		cursor: not-allowed;
	}

	.side__link--locked:hover {
		background: transparent;
		color: var(--je-color-text-disabled);
	}

	/* Every count occupies the same box whether or not it is chipped, so the
	   digits form one right-aligned column down the rail. A chip changes only
	   background, colour, and weight — never geometry — because padding applied
	   to some rows and not others reads as a misaligned list. */
	.side__meta {
		margin-inline-start: auto;
		padding: 0.0625rem var(--je-space-2);
		border-radius: var(--je-radius-round);
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
		font-weight: 500;
		color: var(--je-color-text-muted);
	}

	/* Actionable counts are chips; blocking counts are solid. Inventory counts
	   stay quiet text. */
	.side__meta--warning,
	.side__meta--danger {
		font-weight: 650;
	}

	.side__meta--warning {
		background: var(--je-color-warning-soft);
		color: var(--je-color-warning);
	}

	.side__meta--danger {
		background: var(--je-color-danger-emphasis);
		color: var(--je-color-danger-emphasis-contrast);
	}

	.side__meta--lock {
		display: inline-flex;
		color: var(--je-color-text-disabled);
	}

	.side__foot {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-2);
		border-block-start: 1px solid var(--je-color-border);
		padding-block-start: var(--je-space-3);
	}

	.side__user {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		padding-inline: var(--je-space-2);
	}

	.side__user-name {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* Body */
	.body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.top {
		position: sticky;
		inset-block-start: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		block-size: var(--je-topbar-height);
		padding-inline: var(--je-space-6);
		background: var(--je-color-canvas);
		border-block-end: 1px solid var(--je-color-border);
	}

	.top__menu {
		display: none;
	}

	/* Sits on the topbar's existing hairline, so the wait costs no layout and the
	   content below never shifts when it appears or leaves. The travelling segment
	   uses the same action color as the selected rail: one language for "you chose
	   this" and "it is on its way". */
	.top__arriving {
		position: absolute;
		inset-inline: 0;
		inset-block-end: -1px;
		block-size: 2px;
		overflow: hidden;
	}

	.top__arriving > span {
		display: block;
		inline-size: 45%;
		block-size: 100%;
		background: var(--je-color-action);
		animation: je-indeterminate var(--je-duration-loop) var(--je-ease) infinite alternate;
	}

	@media (prefers-reduced-motion: reduce) {
		/* Same information, no travel: the hairline is simply lit while a
		   destination is on its way. */
		.top__arriving > span {
			inline-size: 100%;
			opacity: 0.55;
			animation: none;
		}
	}

	.top__title {
		margin: 0;
		font-size: var(--je-font-size-base);
		font-weight: 600;
	}

	.top__avatar {
		margin-inline-start: auto;
	}

	.sample__name {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.sample__copy {
		margin: 0;
		color: var(--je-color-text-muted);
	}

	.content {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: var(--je-space-6);
		padding: var(--je-space-6);
		inline-size: 100%;
		max-inline-size: var(--je-page-max);
		margin-inline: auto;
	}

	/* Holds the content region's ordinary footprint so handing over to the
	   destination's waiting state cannot collapse the page and then expand it
	   again when the destination resolves. */
	.waiting {
		display: flex;
		min-block-size: 24rem;
		flex: 1;
	}

	.waiting__line {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.scrim {
		display: none;
	}

	/* Touch / narrow */
	@media (max-width: 920px) {
		.side {
			position: fixed;
			inset-block: 0;
			inset-inline-start: 0;
			block-size: 100dvh;
			overscroll-behavior: contain;
			z-index: 40;
			translate: -100% 0;
			transition: translate var(--je-duration-normal) var(--je-ease);
			box-shadow: var(--je-shadow-lg);
		}

		.side--open {
			translate: 0 0;
		}

		.side__close {
			display: inline-flex;
		}

		.scrim {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 30;
			border: 0;
			background: var(--je-color-scrim);
			touch-action: none;
		}

		.top {
			padding-inline: var(--je-space-4);
		}

		.top__menu {
			display: inline-flex;
		}

		.content {
			padding: var(--je-space-4);
		}
	}
</style>
