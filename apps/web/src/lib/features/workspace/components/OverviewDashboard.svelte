<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { AlertTriangle } from 'lucide-svelte';
	import { statusIcon } from '$lib/ui';
	import {
		navGroups,
		navHref,
		navMeta,
		overviewItem,
		settingsItem
	} from '$lib/features/workspace/navigation';
	import type {
		OverviewPagePort,
		OverviewPageSummary,
		OverviewPipelineStage
	} from '$lib/api/overview-page-port';
	import type { AreaKey } from '$lib/api/types';
	import ActivityFeed from './ActivityFeed.svelte';
	import NewEventModal from './NewEventModal.svelte';
	import TrayLedger from './TrayLedger.svelte';

	let { port }: { readonly port: OverviewPagePort } = $props();

	let summary = $state<OverviewPageSummary | null>(null);
	let loadError = $state('');
	let newEventOpen = $state(false);

	onMount(load);

	async function load() {
		loadError = '';
		const result = await port.read();
		if (result.kind === 'success') {
			summary = result.data;
			return;
		}
		loadError = result.kind === 'transport_error'
			? result.retryable
				? 'The overview could not be reached. Try again.'
				: 'The overview response could not be loaded.'
			: result.message;
	}

	// What the shell already knows about this workspace shapes the placeholder.
	// Two regions here can resolve to absent — the act-now banner, and the whole
	// dashboard body on a workspace with no event — and a placeholder for either
	// would collapse everything below it the moment the summary lands.
	const known = untrack(() => port.snapshot());
	const expectEvent = known?.event != null;
	const expectBanner = known?.attention.some((item) => item.severity === 'now') ?? false;
	// The banner takes the first act-now item; the rest stay in the list.
	const expectedListRows = known ? known.attention.length - (expectBanner ? 1 : 0) : 0;

	// The banner tier renders only while an act-now item exists; everything else
	// stays in the list.
	const banner = $derived(summary?.attention.find((item) => item.severity === 'now'));
	const listItems = $derived(summary ? summary.attention.filter((item) => item !== banner) : []);

	const severityLabel = { now: 'Act now', soon: 'Soon', fyi: 'FYI' } as const;

	const areaHref: Record<string, string> = {
		overview: '/app',
		submissions: '/app/submissions',
		review: '/app/review',
		decisions: '/app/decisions',
		speakers: '/app/speakers',
		tasks: '/app/tasks',
		schedule: '/app/schedule',
		messages: '/app/messages',
		forms: '/app/forms',
		settings: '/app/settings'
	};

	/**
	 * An alert lands on the rows its sentence names. The item carries the scoped
	 * address when one exists — "3 decisions not yet notified" opens those
	 * three, not the whole decisions table — and the area root is the
	 * fallback for facts whose scope is the area itself.
	 */
	function destination(item: { area: string; href?: string }): string {
		return item.href ?? areaHref[item.area];
	}

	const navItems = [overviewItem, ...navGroups.flatMap((group) => group.items), settingsItem];

	/* Reuses the destination glyphs from the navigation model, so an attention
	   row's action shows where it lands using the same mark as the sidebar. */
	const areaIcon = Object.fromEntries(navItems.map((item) => [item.key, item.icon]));

	/* Stage health as a shape, not only a hue. */
	const stageIcon = {
		ok: statusIcon.ready,
		attention: statusIcon.warning,
		blocked: statusIcon.blocking,
		unavailable: statusIcon.notConfigured
	} as const;

	const navItemByKey = Object.fromEntries(navItems.map((item) => [item.key, item]));

	/* The area whose screen answers for each stage's facts. Collect and triage
	   both resolve on the submissions screen; comms resolves on messages. */
	const stageArea: Record<OverviewPipelineStage['key'], AreaKey> = {
		collect: 'submissions',
		triage: 'submissions',
		review: 'review',
		decide: 'decisions',
		speakers: 'speakers',
		schedule: 'schedule',
		comms: 'messages'
	};

	/**
	 * A lane lands where its facts already land: the exact address the sidebar
	 * badge aims to for the same area (one shared map, so one fact never gains
	 * two landings). Scoped landings survive only for filters; the schedule
	 * lane lands at the area root — its head-row count is the door to the
	 * conflicts panel, and the attention row above already carries the scoped
	 * address for the conflicts fact itself.
	 */
	function laneDoor(stage: OverviewPipelineStage, counts: OverviewPageSummary['navCounts']) {
		const item = navItemByKey[stageArea[stage.key]];
		return { href: navHref(item, navMeta(counts, item.key)), area: item.label };
	}

	/* Only deviation speaks: ahead/on lanes carry no pace word. */
	function paceWord(stage: OverviewPipelineStage): 'behind' | 'overdue' | undefined {
		return stage.paceTone === 'behind' || stage.paceTone === 'overdue'
			? stage.paceTone
			: undefined;
	}

	/* The meter's fill answers the governing deadline, not the fraction: a high
	   fraction due tomorrow still fills in warning. */
	function meterTone(stage: OverviewPipelineStage): 'neutral' | 'warning' | 'danger' {
		if (stage.paceTone === 'overdue') return 'danger';
		if (stage.paceTone === 'behind') return 'warning';
		return 'neutral';
	}

	function meterPercent(progress: { done: number; required: number }): number {
		if (progress.required <= 0) return 0;
		return Math.max(0, Math.min(100, Math.round((progress.done / progress.required) * 100)));
	}

	function laneName(stage: OverviewPipelineStage, area: string): string {
		const figure = stage.progress
			? `${stage.progress.done} of ${stage.progress.required}`
			: stage.headline;
		const pace = paceWord(stage);
		const parts = [figure, ...(pace ? [pace] : []), ...(stage.deadlineLabel ? [stage.deadlineLabel] : [])];
		return `${stage.label}: ${parts.join(', ')} — open ${area}`;
	}
</script>

{#if !summary && loadError}
	<section class="welcome" aria-label="Overview unavailable">
		<h2 class="welcome__title">The overview could not be loaded</h2>
		<p class="welcome__copy">{loadError}</p>
		<button type="button" class="ui-button ui-button--secondary" onclick={() => void load()}>Try again</button>
	</section>
{:else if !summary}
	<section class="loading" aria-label="Loading overview">
		{#if expectEvent && known}
			<!-- Every placeholder below is the resolved composition's own markup
			     holding skeleton fills, so its geometry comes from the same CSS as
			     the resolved state and cannot drift from it. -->
			{#if expectBanner}
				<section class="banner" aria-hidden="true">
					<span class="banner__plate ui-skeleton"></span>
					<div class="banner__copy">
						<p class="banner__title"><span class="ui-skeleton skeleton-line" style="inline-size: 20rem"></span></p>
						<p class="banner__detail"><span class="ui-skeleton skeleton-line" style="inline-size: 30rem"></span></p>
					</div>
					<span class="ui-skeleton skeleton-action"></span>
				</section>
			{/if}

			<section class="kpis" aria-hidden="true">
				{#each Array(known.stats.length) as _, index (index)}
					<article class="kpi">
						<span class="kpi__label"><span class="ui-skeleton skeleton-line" style="inline-size: 5.5rem"></span></span>
						<span class="kpi__value"><span class="ui-skeleton skeleton-line" style="inline-size: 3.5rem"></span></span>
						<span class="kpi__sub"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></span>
					</article>
				{/each}
			</section>

			<div class="columns">
				<div class="columns__main">
					<section class="panel" aria-hidden="true">
						<header class="panel__head">
							<h2>Needs attention</h2>
							<span class="panel__count"><span class="ui-skeleton skeleton-line" style="inline-size: 0.75rem"></span></span>
						</header>
						{#if expectedListRows === 0}
							<p class="panel__calm"><span class="ui-skeleton skeleton-line" style="inline-size: 15rem"></span></p>
						{:else}
							<ul class="attention">
								{#each Array(expectedListRows) as _, index (index)}
									<li class="attention__row">
										<span class="ui-skeleton skeleton-chip attention__sev"></span>
										<div class="attention__copy">
											<p class="attention__title"><span class="ui-skeleton skeleton-line" style="inline-size: 17rem"></span></p>
											<p class="attention__detail"><span class="ui-skeleton skeleton-line" style="inline-size: 26rem"></span></p>
										</div>
										<span class="ui-skeleton skeleton-action attention__action"></span>
									</li>
								{/each}
							</ul>
						{/if}
					</section>

					<section class="panel" aria-hidden="true">
						<header class="panel__head"><h2>Pipeline</h2></header>
						<ul class="stages">
							<!-- Each placeholder lane keeps the shape its own stage resolves
							     to: a meter only where the stage carries a denominator, a
							     lane end only where it names a deadline or falls behind. -->
							{#each known.pipeline as stage (stage.key)}
								<li class="stages__item">
									<span class="lane">
										<span class="lane__mark lane__mark--pending"></span>
										<span class="lane__label"><span class="ui-skeleton skeleton-line" style="inline-size: 4rem"></span></span>
										<span class="lane__headline"><span class="ui-skeleton skeleton-line" style="inline-size: 2.5rem"></span></span>
										<span class="lane__sub"><span class="ui-skeleton skeleton-line" style="inline-size: 12rem"></span></span>
										{#if stage.progress}
											<span class="lane__meter">
												<span class="lane__track"></span>
												<span class="lane__digits"><span class="ui-skeleton skeleton-line" style="inline-size: 3.5rem"></span></span>
											</span>
										{/if}
										{#if stage.deadlineLabel || paceWord(stage)}
											<span class="lane__end">
												{#if paceWord(stage)}
													<span class="ui-skeleton skeleton-chip" style="inline-size: 3.25rem"></span>
												{/if}
												{#if stage.deadlineLabel}
													<span class="lane__deadline"><span class="ui-skeleton skeleton-line" style="inline-size: 6rem"></span></span>
												{/if}
											</span>
										{/if}
									</span>
								</li>
							{/each}
						</ul>
					</section>
				</div>

				<div class="columns__aside">
					<section class="panel" aria-hidden="true">
						<header class="panel__head"><h2>Deadlines</h2></header>
						<ul class="dates">
							{#each Array(known.deadlines.length) as _, index (index)}
								<li class="dates__row">
									<span class="dates__label"><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></span>
									<span class="dates__relative"><span class="ui-skeleton skeleton-line" style="inline-size: 4rem"></span></span>
									<span class="dates__absolute"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></span>
								</li>
							{/each}
						</ul>
					</section>

					<!-- The feed and the ledger are owned by their own components, so
					     these two bodies stand in for one of their rows each: the same
					     row rhythm expressed in the same tokens, one line box tall. -->
					<section class="panel" aria-hidden="true">
						<header class="panel__head"><h2>Activity</h2></header>
						<ol class="feed-rows">
							{#each Array(known.activity.length) as _, index (index)}
								<li class="feed-rows__row">
									<span class="ui-avatar ui-avatar--sm feed-rows__mark"></span>
									<span class="ui-skeleton skeleton-line" style="inline-size: min(15rem, 100%)"></span>
								</li>
							{/each}
						</ol>
					</section>

					<section class="panel" aria-hidden="true">
						<header class="panel__head"><h2>Everything has a place</h2></header>
						<ul class="ledger-rows">
							{#each Array(known.trays.length) as _, index (index)}
								<li><span class="ui-skeleton skeleton-pill"></span></li>
							{/each}
						</ul>
						{#if known.trays.some((tray) => !tray.href)}
							<!-- The ledger says once, under the pills, why some of them are
							     figures rather than links; the evidence for that line is in
							     the summary already fetched, so it holds its own space. -->
							<p class="ledger-note"><span class="ui-skeleton skeleton-line" style="inline-size: min(21rem, 100%)"></span></p>
						{/if}
					</section>
				</div>
			</div>
		{:else if known}
			<!-- Evidence says this workspace has no event: the composition that
			     arrives is the welcome panel, so that is what holds the space. -->
			<section class="welcome" aria-hidden="true">
				<p class="welcome__title sk-head"><span class="ui-skeleton skeleton-line" style="inline-size: 18rem"></span></p>
				<p class="welcome__copy">
					<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
					<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
					<span class="ui-skeleton skeleton-line" style="inline-size: 60%"></span>
				</p>
				<div class="welcome__actions">
					<span class="ui-skeleton skeleton-action skeleton-action--lg"></span>
					<span class="ui-skeleton skeleton-action skeleton-action--lg"></span>
				</div>
			</section>
		{:else}
			<!-- The live source has not resolved whether an Event exists, so this
			     neutral resolver claims neither the dashboard nor the first-run state. -->
			<section class="welcome welcome--loading" aria-hidden="true">
				<p class="welcome__title sk-head"><span class="ui-skeleton skeleton-line" style="inline-size: 18rem"></span></p>
				<p class="welcome__copy"><span class="ui-skeleton skeleton-line" style="inline-size: 24rem"></span></p>
			</section>
		{/if}
	</section>
{:else if !summary.event}
	<section class="welcome" aria-label="Create your first event">
		<h2 class="welcome__title">Welcome to JooEvents</h2>
		<p class="welcome__copy">
			Create your first event to unlock the workspace — describe it in your own words and let
			the assistant draft it, or fill in the details yourself. Everything in the sidebar opens
			up as soon as the event exists.
		</p>
		<div class="welcome__actions">
			<button
				type="button"
				class="ui-button ui-button--primary"
				disabled
				title="AI-assisted event drafting is not available yet">Create event</button>
			<button
				type="button"
				class="ui-button ui-button--secondary"
				aria-haspopup="dialog"
				onclick={() => (newEventOpen = true)}>Fill in details myself</button>
		</div>
	</section>
{:else}
	{#if banner}
		<section class="banner" aria-label="Act now">
			<span class="banner__plate" aria-hidden="true"><AlertTriangle size={16} /></span>
			<div class="banner__copy">
				<p class="banner__title">{banner.title}</p>
				<p class="banner__detail">{banner.detail}</p>
			</div>
			<a class="ui-button ui-button--primary ui-button--sm banner__action" href={destination(banner)}>{banner.action}</a>
		</section>
	{/if}

	<section class="kpis" aria-label="Key numbers">
		{#each summary.stats as stat (stat.label)}
			<article class="kpi">
				<span class="kpi__label">{stat.label}</span>
				<span class="kpi__value">{stat.value}</span>
				<span class="kpi__sub" class:kpi__sub--attention={stat.tone === 'attention'}>{stat.sub}</span>
			</article>
		{/each}
	</section>

	<div class="columns">
		<div class="columns__main">
			<!-- The attention queue is required reading and outranks orientation,
			     so it renders before the pipeline lanes. -->
			<section class="panel" aria-label="Needs attention">
				<header class="panel__head">
					<h2>Needs attention</h2>
					<span class="panel__count">{listItems.length}</span>
				</header>
				{#if summary.sections.attention.kind === 'unavailable'}
					<p class="panel__calm">{summary.sections.attention.message}</p>
				{:else if listItems.length === 0}
					<p class="panel__calm">Nothing is waiting on you right now.</p>
				{:else}
					<ul class="attention">
						{#each listItems as item (item.id)}
							{@const Destination = areaIcon[item.area]}
							<li class="attention__row">
								<span
									class="ui-badge attention__sev"
									class:ui-badge--danger={item.severity === 'now'}
									class:ui-badge--warning={item.severity === 'soon'}
									class:ui-badge--solid={item.severity !== 'fyi'}
									class:ui-badge--neutral={item.severity === 'fyi'}>{severityLabel[item.severity]}</span>
								<div class="attention__copy">
									<p class="attention__title">{item.title}</p>
									<p class="attention__detail">{item.detail}</p>
								</div>
								<a class="ui-button ui-button--secondary ui-button--sm attention__action" href={destination(item)}
									><Destination aria-hidden="true" />{item.action}</a
								>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="panel" aria-label="Pipeline">
				<header class="panel__head"><h2>Pipeline</h2></header>
				<ul class="stages">
					{#each summary.pipeline as stage (stage.key)}
						{@const Health = stageIcon[stage.state]}
						<li class="stages__item">
							{#if stage.availability.kind === 'unavailable'}
								<!-- Capability availability is not event progress. The neutral
								     lane keeps the tuned map visible without becoming a false door. -->
								<span class="lane" data-stage={stage.key}>
									<span class="lane__mark lane__mark--unavailable" aria-hidden="true"
										><Health size={14} /></span
									>
									<span class="lane__label">{stage.label}</span>
									<span class="lane__headline">{stage.headline}</span>
									<span class="lane__sub">{stage.sub}</span>
								</span>
							{:else}
								{@const door = laneDoor(stage, summary.navCounts)}
								{@const pace = paceWord(stage)}
								<!-- The whole lane is one door; nothing inside it is separately
								     pressable, so the row can be a plain link. -->
								<a
									class="lane"
									href={door.href}
									data-stage={stage.key}
									aria-label={laneName(stage, door.area)}>
								<span class="lane__mark lane__mark--{stage.state}" aria-hidden="true"
									><Health size={14} /></span
								>
								<span class="lane__label">{stage.label}</span>
								<span class="lane__headline">{stage.headline}</span>
								<span class="lane__sub">{stage.sub}</span>
								{#if stage.progress}
									<!-- Digits carry the absolute; the fill's hue carries only
									     pace, never raw completion. -->
									<span class="lane__meter lane__meter--{meterTone(stage)}">
										<span class="lane__track"
											><span
												class="lane__fill"
												style:inline-size="{meterPercent(stage.progress)}%"></span
											></span
										>
										<span class="lane__digits">{stage.progress.done} of {stage.progress.required}</span>
									</span>
								{/if}
								{#if stage.deadlineLabel || pace}
									<span class="lane__end">
										{#if pace}
											<span
												class="ui-badge ui-badge--solid lane__pace"
												class:ui-badge--warning={pace === 'behind'}
												class:ui-badge--danger={pace === 'overdue'}>{pace}</span>
										{/if}
										{#if stage.deadlineLabel}
											<span class="lane__deadline">{stage.deadlineLabel}</span>
										{/if}
									</span>
								{/if}
								</a>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		</div>

		<div class="columns__aside">
			<section class="panel" aria-label="Deadlines">
				<header class="panel__head"><h2>Deadlines</h2></header>
				{#if summary.sections.deadlines.kind === 'unavailable'}
					<p class="panel__calm">{summary.sections.deadlines.message}</p>
				{:else if summary.deadlines.length === 0}
					<p class="panel__calm">No event deadlines are recorded.</p>
				{:else}
					<ul class="dates">
						{#each summary.deadlines as deadline (deadline.label)}
							<li class="dates__row">
								<span class="dates__label">{deadline.label}</span>
								<span
									class="dates__relative"
									class:dates__relative--warning={deadline.tone === 'warning'}
									class:dates__relative--blocked={deadline.tone === 'blocked'}>{deadline.relative}</span>
								<span class="dates__absolute">{deadline.absolute}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="panel" aria-label="Activity">
				<header class="panel__head"><h2>Activity</h2></header>
				{#if summary.sections.activity.kind === 'unavailable'}
					<p class="panel__calm">{summary.sections.activity.message}</p>
				{:else if summary.activity.length === 0}
					<p class="panel__calm">No recorded activity yet.</p>
				{:else}
					<ActivityFeed items={summary.activity} />
				{/if}
			</section>

			<section class="panel" aria-label="Everything has a place">
				<header class="panel__head"><h2>Everything has a place</h2></header>
				{#if summary.sections.trays.kind === 'unavailable'}
					<p class="panel__calm">{summary.sections.trays.message}</p>
				{:else}
					<TrayLedger trays={summary.trays} />
				{/if}
			</section>
		</div>
	</div>
{/if}

{#if newEventOpen}
	<NewEventModal
		bind:open={newEventOpen}
		createEvent={(input) => port.createEvent(input)}
		oncreated={() => location.assign('/app')} />
{/if}

<style>
	/* The loading region stacks the same three top-level compositions the
	   resolved screen does, with the same gap the content column uses. */
	.loading {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-6);
	}

	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, a chip is badge-height, an action
	   is control-height. Free-standing sized rectangles drift; these cannot. */
	/* A heading's line box without the heading element: the placeholder keeps
	   the leading its resolved heading is given. */
	.sk-head {
		line-height: var(--je-leading-tight);
	}

	.skeleton-line {
		display: inline-block;
		block-size: 1em;
		/* One line box exactly: the line inherits the height it stands in for. */
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.skeleton-chip {
		display: inline-block;
		block-size: 1.35rem;
		inline-size: 4.5rem;
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 8.5rem;
		border-radius: var(--je-radius-control);
	}

	.skeleton-action--lg {
		block-size: var(--je-control-height);
		inline-size: 11rem;
	}

	/* A stage mark before its state is known: a disc of the mark's own size,
	   tinted as a placeholder rather than claiming healthy, attention, or
	   blocked. */
	.lane__mark--pending {
		block-size: 0.875rem;
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-round);
	}

	/* The activity feed and the tray ledger are their own components, so these
	   two bodies restate one of their rows in the same tokens: an avatar rail
	   beside one line of small text, and a chip around one line of chip text. */
	.feed-rows {
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: var(--je-font-size-sm);
	}

	.feed-rows__row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: start;
		gap: var(--je-space-2);
		padding-block: var(--je-space-2);
	}

	.feed-rows__row + .feed-rows__row {
		border-block-start: 1px solid var(--je-color-border-subtle);
	}

	.feed-rows__mark {
		margin-block-start: calc((var(--je-font-size-sm) * var(--je-leading-normal) - 1.5rem) / 2);
	}

	.ledger-rows {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: var(--je-font-size-sm);
	}

	.skeleton-pill {
		display: block;
		inline-size: 6rem;
		block-size: calc(1lh + var(--je-space-1) * 2 + 2px);
	}

	/* The ledger's own note geometry, so the panel keeps its resolved height. */
	.ledger-note {
		margin: var(--je-space-3) 0 0;
		font-size: var(--je-font-size-xs);
	}

	.welcome {
		max-inline-size: 34rem;
		margin-block-start: var(--je-space-10);
		margin-inline: auto;
		text-align: center;
		display: grid;
		gap: var(--je-space-4);
		justify-items: center;
	}

	.welcome__title {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: var(--je-font-size-2xl);
	}

	.welcome__copy {
		margin: 0;
		color: var(--je-color-text-muted);
	}

	.welcome__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		justify-content: center;
	}

	.welcome--loading {
		min-block-size: 12rem;
		align-content: center;
	}

	/* Banner: the single act-now surface. The red is carried by the area
	   treatment (tinted surface + emphasis plate), not a stripe. */
	.banner {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) max-content;
		align-items: center;
		gap: var(--je-space-3) var(--je-space-4);
		padding: var(--je-space-3) var(--je-space-4);
		border: 1px solid color-mix(in srgb, var(--je-color-danger-fill) 38%, transparent);
		border-radius: var(--je-radius-surface);
		background:
			linear-gradient(var(--je-color-danger-soft), var(--je-color-danger-soft)),
			var(--je-color-surface);
	}

	.banner__plate {
		display: grid;
		place-items: center;
		inline-size: 2rem;
		block-size: 2rem;
		border-radius: var(--je-radius-control);
		background: var(--je-color-danger-emphasis);
		color: var(--je-color-danger-emphasis-contrast);
	}

	.banner__copy {
		min-width: 0;
	}

	.banner__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.banner__detail {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* KPI row */
	.kpis {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: var(--je-space-3);
	}

	.kpi {
		display: grid;
		gap: var(--je-space-1);
		padding: var(--je-space-3) var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.kpi__label {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.kpi__value {
		font-size: var(--je-font-size-xl);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.kpi__sub {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.kpi__sub--attention {
		color: var(--je-color-warning);
		font-weight: 600;
	}

	/* Columns */
	.columns {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
		gap: var(--je-space-4);
		align-items: start;
	}

	.columns__main,
	.columns__aside {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-4);
		min-width: 0;
	}

	.panel {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.panel__head {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-2);
		margin-block-end: var(--je-space-3);
	}

	.panel__head h2 {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.panel__count {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.panel__calm {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.attention {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.attention__row {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) max-content;
		grid-template-areas: 'sev copy action';
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
		padding-block: var(--je-space-3);
	}

	.attention__row + .attention__row {
		border-block-start: 1px solid var(--je-color-border);
	}

	.attention__sev {
		grid-area: sev;
	}

	.attention__copy {
		grid-area: copy;
		min-width: 0;
	}

	.attention__action {
		grid-area: action;
	}

	.attention__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.attention__detail {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.stages {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.stages__item + .stages__item {
		border-block-start: 1px solid var(--je-color-border);
	}

	/* One lane, one door: the row itself is the link, bled to the panel edge so
	   the hover plate reads as the whole row without moving its text. */
	.lane {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-3);
		padding: var(--je-space-2);
		margin-inline: calc(-1 * var(--je-space-2));
		border-radius: var(--je-radius-control);
		color: inherit;
		text-decoration: none;
	}

	a.lane:hover {
		background: var(--je-color-surface-sunken);
	}

	a.lane:active {
		background: color-mix(in srgb, var(--je-color-surface-sunken) 75%, var(--je-color-border));
	}

	a.lane:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	/* Was a colour-only dot. Stage health now carries a shape as well as a hue,
	   so the row survives a monochrome print, a low-contrast screen, and the
	   ~8% of men with a red/green deficiency. */
	.lane__mark {
		align-self: center;
		inline-size: 0.875rem;
		display: grid;
		place-items: center;
		flex-shrink: 0;
	}

	.lane__mark--ok {
		color: var(--je-color-success);
	}

	.lane__mark--attention {
		color: var(--je-color-warning);
	}

	.lane__mark--blocked {
		color: var(--je-color-danger);
	}

	.lane__mark--unavailable {
		color: var(--je-color-text-subtle);
	}

	.lane__label {
		inline-size: 5.5rem;
		flex-shrink: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.lane__headline {
		font-size: var(--je-font-size-md);
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}

	.lane__sub {
		flex: 1;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The meter is a second channel beside the words, never their replacement:
	   digits carry the absolute, the fill's hue carries pace alone. */
	.lane__meter {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		flex-shrink: 0;
		align-self: center;
	}

	.lane__track {
		inline-size: 5.5rem;
		block-size: 0.3125rem;
		border-radius: var(--je-radius-round);
		background: var(--je-color-border-subtle);
		overflow: hidden;
	}

	.lane__fill {
		display: block;
		block-size: 100%;
		border-radius: inherit;
	}

	/* Ahead or on pace stays quiet: a muted wash of the action hue, no status
	   colour spent on a lane that needs nothing. */
	.lane__meter--neutral .lane__fill {
		background: color-mix(in srgb, var(--je-color-action) 45%, transparent);
	}

	.lane__meter--warning .lane__fill {
		background: var(--je-color-warning-fill);
	}

	.lane__meter--danger .lane__fill {
		background: var(--je-color-danger-fill);
	}

	.lane__digits {
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-muted);
		white-space: nowrap;
	}

	.lane__end {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		flex-shrink: 0;
		align-self: center;
	}

	.lane__deadline {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		white-space: nowrap;
	}

	.dates {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.dates__row {
		display: grid;
		grid-template-columns: 1fr auto;
		column-gap: var(--je-space-2);
		padding-block: var(--je-space-2);
	}

	.dates__row + .dates__row {
		border-block-start: 1px solid var(--je-color-border);
	}

	.dates__label {
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.dates__relative {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		text-align: end;
	}

	.dates__relative--warning {
		color: var(--je-color-warning);
		font-weight: 600;
	}

	.dates__relative--blocked {
		color: var(--je-color-danger);
		font-weight: 600;
	}

	.dates__absolute {
		grid-column: 1 / -1;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Narrow widths restructure rather than squeeze: badge and copy share the
	   first row, the action gets its own row aligned with the copy. */
	@media (max-width: 920px) {
		.kpis {
			grid-template-columns: repeat(2, 1fr);
		}

		.columns {
			grid-template-columns: 1fr;
		}

		.banner {
			grid-template-columns: max-content minmax(0, 1fr);
			grid-template-areas:
				'plate copy'
				'. action';
		}

		.banner__plate {
			grid-area: plate;
		}

		.banner__copy {
			grid-area: copy;
		}

		.banner__action {
			grid-area: action;
			justify-self: start;
		}

		.attention__row {
			grid-template-columns: max-content minmax(0, 1fr);
			grid-template-areas:
				'sev copy'
				'. action';
			align-items: start;
		}

		.attention__action {
			justify-self: start;
		}

		/* A lane stacks instead of squeezing: label line, prose line, then the
		   meter at full width, then the deadline line. Absent channels produce
		   no empty lines. */
		.lane {
			flex-wrap: wrap;
			align-items: center;
			row-gap: var(--je-space-1);
		}

		.lane__label {
			inline-size: auto;
		}

		.lane__sub {
			flex-basis: 100%;
			white-space: normal;
			overflow: visible;
		}

		.lane__meter {
			flex-basis: 100%;
		}

		.lane__track {
			flex: 1;
			inline-size: auto;
		}

		.lane__end {
			flex-basis: 100%;
		}
	}
</style>
