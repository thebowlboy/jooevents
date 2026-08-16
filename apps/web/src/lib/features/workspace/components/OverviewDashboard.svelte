<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { AlertTriangle } from 'lucide-svelte';
	import { DATE_CLASS, describeCalendarDeadline } from '@jooevents/contracts';
	import { Badge, Meter, badgeFor, statusIcon, statusToneClass } from '$lib/ui';
	import type { StatusTone } from '$lib/ui';
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
	import type { AreaKey, DeadlineItem } from '$lib/api/types';
	import ActivityFeed from './ActivityFeed.svelte';
	import ArrivalTile from './ArrivalTile.svelte';
	import NewEventModal from './NewEventModal.svelte';
	import StatTile from './StatTile.svelte';
	import DormantShape from './DormantShape.svelte';
	import TrayLedger from './TrayLedger.svelte';

	let { port }: { readonly port: OverviewPagePort } = $props();

	/**
	 * One clock reading for the whole screen, taken at entry.
	 *
	 * Every countdown, deadline state, and arrival window below is a claim about
	 * a single instant, and re-deriving them per expression would let two
	 * regions disagree by a tick — a lane saying "due tomorrow" beside a panel
	 * that has already turned it over to "today".
	 */
	const now = Date.now();

	let summary = $state<OverviewPageSummary | null>(null);
	let loadError = $state('');
	let newEventOpen = $state(false);

	onMount(() => {
		void load();
	});

	// The retry below re-enters this, so it carries both ordering guarantees: a
	// second press while a read is open joins it rather than stacking another,
	// and a superseded answer is dropped instead of overwriting a fresher one.
	let readTicket = 0;
	let inFlight: Promise<void> | null = null;

	function load(): Promise<void> {
		return inFlight ?? read();
	}

	function read(): Promise<void> {
		const ticket = (readTicket += 1);
		const run = (async () => {
			loadError = '';
			try {
				const result = await port.read();
				if (ticket !== readTicket) return;
				if (result.kind === 'success') {
					summary = result.data;
					return;
				}
				loadError = result.kind === 'transport_error'
					? result.retryable
						? 'The overview could not be reached. Try again.'
						: 'The overview response could not be loaded.'
					: result.message;
			} catch {
				// The port owes a structured outcome; a throw is a defect. It still
				// must not read as "loading" forever, so it states itself as a
				// retryable failure rather than leaving the placeholder standing.
				if (ticket !== readTicket) return;
				loadError = 'The overview could not be reached. Try again.';
			} finally {
				if (ticket === readTicket) inFlight = null;
			}
		})();
		inFlight = run;
		return run;
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

	/**
	 * The event's zone is the authority on every date here — never the reader's.
	 * An organizer travelling to their own conference must not see a deadline
	 * move a day because their laptop did.
	 */
	const timezone = $derived(summary?.event?.timezone ?? '');

	/**
	 * Severity words, tones, and glyphs from the one status vocabulary, so an
	 * attention row's loudness is the same fact it is everywhere else. Only
	 * act-now takes the solid tier: a column of solid badges spends the page's
	 * whole emphasis budget on the rows that are merely next.
	 */
	const severityLabel = { now: 'Act now', soon: 'Soon', fyi: 'FYI' } as const;
	const severityMark = { now: badgeFor('actNow'), soon: badgeFor('soon'), fyi: badgeFor('fyi') };

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

	/**
	 * A lane's mark answers its *availability* before its health, because a
	 * stage that has not begun and a stage nobody counted are two different
	 * absences and neither is a health verdict.
	 *
	 * Both glyphs come from the closed vocabulary and already mean exactly
	 * this: `notStarted` is the task board's word for work that has not begun,
	 * `notChecked` is the readiness vocabulary's word for a question nobody
	 * answered. A padlock is deliberately not used — `Lock` is already spent on
	 * a closed form, and one meaning takes one symbol.
	 */
	function laneIcon(stage: OverviewPipelineStage) {
		if (stage.availability.kind === 'locked') return statusIcon.notStarted;
		if (stage.availability.kind === 'unavailable') return statusIcon.notChecked;
		return stageIcon[stage.state];
	}

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

	/* Only deviation speaks: ahead/on lanes carry no pace word. Sentence case,
	   because it renders as a badge beside `Soon` and `Overdue` and a lowercase
	   one read as a stray word rather than a state. */
	function paceWord(stage: OverviewPipelineStage): 'Behind' | 'Overdue' | undefined {
		if (stage.paceTone === 'overdue') return 'Overdue';
		if (stage.paceTone === 'behind') return 'Behind';
		return undefined;
	}

	/**
	 * The meter answers the lane's **health**, not its fraction — a stage at 97%
	 * whose deadline lands tomorrow is amber, and a stage at 20% with three
	 * weeks left is green. The mark at the lane's start carries the same value
	 * as a shape, so the two channels are one fact rather than two opinions.
	 *
	 * It used to fill with a wash of the action hue for "fine", which the design
	 * record forbids reading as a status and which sits three degrees from the
	 * danger family — so a healthy lane and a failing one were nearly the same
	 * colour. Green now means healthy, as it does everywhere else a person has
	 * ever read a bar.
	 */
	const laneTone: Record<OverviewPipelineStage['state'], StatusTone> = {
		ok: 'positive',
		attention: 'caution',
		blocked: 'negative',
		// A capability that is not wired is not a failing stage; it spends no
		// status colour, and an unavailable lane never reaches a meter anyway.
		unavailable: 'neutral'
	};

	function meterPercent(progress: { done: number; required: number }): number {
		if (progress.required <= 0) return 0;
		return Math.max(0, Math.min(100, Math.round((progress.done / progress.required) * 100)));
	}

	/**
	 * A deadline in words, spelled by the one date vocabulary from the stored
	 * date rather than by a string the scenario wrote. The lane end is a narrow
	 * column, so it drops the weekday, the year, and the clock and keeps the two
	 * halves that decide anything: which day, and how far away.
	 */
	function laneDeadline(stage: OverviewPipelineStage) {
		if (!stage.deadline || timezone === '') return null;
		return describeCalendarDeadline({
			displayDate: stage.deadline.displayDate,
			effectiveAt: stage.deadline.effectiveAt,
			timezone,
			now,
			label: stage.deadline.qualifier,
			settled: stage.deadline.settled === true,
			weekday: false,
			year: false,
			showTime: false
		});
	}

	/** The panel's rows keep the weekday and the clock: a deadline is a planning
	    context, and "Friday" is what tells someone whether a working day is left. */
	function panelDeadline(deadline: DeadlineItem) {
		if (timezone === '') return null;
		return describeCalendarDeadline({
			displayDate: deadline.displayDate,
			effectiveAt: deadline.effectiveAt,
			timezone,
			now,
			settled: deadline.settled === true
		});
	}

	function laneName(stage: OverviewPipelineStage, area: string): string {
		const figure = stage.progress
			? `${stage.progress.done} of ${stage.progress.required}`
			: stage.headline;
		const pace = paceWord(stage);
		const deadline = laneDeadline(stage);
		const parts = [
			figure,
			...(pace ? [pace.toLowerCase()] : []),
			...(deadline ? [`${deadline.label} ${deadline.absolute}, ${deadline.relative}`] : [])
		];
		return `${stage.label}: ${parts.join(', ')} — open ${area}`;
	}

	/**
	 * The lanes showing a dash. A dash is legitimate only where no measurement
	 * exists and its reason sits with it — so the reason is said once, under the
	 * list, naming exactly the lanes the reader can see it on. Saying it on each
	 * lane instead would state one fact about the event five times down a column,
	 * which is the defect the empty-cell rule exists to stop.
	 *
	 * The one-lane spelling matches the port's own `availability.message`; this
	 * composes the same sentence over several labels.
	 */
	const uncountedNote = $derived.by(() => {
		const labels = summary
			? summary.pipeline
				.filter((stage) => stage.availability.kind === 'unavailable')
				.map((stage) => stage.label)
			: [];
		if (labels.length === 0) return '';
		const named = labels.length === 1
			? labels[0]
			: `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
		return `JooEvents does not yet count ${named} on this event.`;
	});

	/**
	 * One shared cause, said once above the lanes and carrying its own next step,
	 * rather than repeated down a column. It renders only while the whole intake
	 * chain is held by the same fact — the moment a form opens, the lanes differ
	 * and each states its own condition.
	 */
	const intakeHeld = $derived.by(() => {
		const lanes = summary?.pipeline;
		if (!lanes) return false;
		const locked = (key: OverviewPipelineStage['key']) =>
			lanes.find((stage) => stage.key === key)?.availability.kind === 'locked';
		return locked('collect') && locked('triage');
	});

	/**
	 * The same two questions asked of the snapshot, so the placeholder reserves
	 * the held line and the footnote exactly where the resolved panel puts them.
	 */
	const knownIntakeHeld = known
		? ['collect', 'triage'].every((key) =>
			known.pipeline.find((stage) => stage.key === key)?.availability.kind === 'locked')
		: false;
	const knownHasUncounted = known
		? known.pipeline.some((stage) => stage.availability.kind === 'unavailable')
		: false;

	/** The tray a discarded proposal is recoverable from, for the arrival panel. */
	const discardedHref = $derived(
		summary?.trays.find((tray) => tray.kind === 'discarded')?.href
	);
</script>

{#if !summary && loadError}
	<section class="welcome" aria-label="Overview unavailable">
		<h2 class="welcome__title">The overview could not be loaded</h2>
		<p class="welcome__copy">{loadError}</p>
		<button type="button" class="ui-button ui-button--secondary" onclick={() => void read()}>Try again</button>
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

			<!-- The band's placeholder is the band: the same two components in the
			     same order, each holding the rows its own resolved shape will have.
			     A uniform grey rectangle per tile grew the region by 66px when the
			     summary landed, which moved everything below it mid-read. -->
			<section class="kpis" aria-hidden="true">
				{#if known.arrivals}
					<ArrivalTile />
				{/if}
				{#each known.stats as stat (stat.label)}
					<StatTile
						pending
						label={stat.label}
						value={stat.value}
						sub={stat.sub}
						progress={stat.progress} />
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
						{#if knownIntakeHeld}
							<!-- The held line and its action are a block above the list; a
							     placeholder that omitted them would push every lane upward
							     the moment the summary landed. -->
							<div class="stages__held">
								<p class="stages__held-fact"><span class="ui-skeleton skeleton-line" style="inline-size: min(19rem, 100%)"></span></p>
								<span class="ui-skeleton skeleton-action"></span>
							</div>
						{/if}
						<ul class="stages">
							<!-- Each placeholder lane keeps the shape its own stage resolves
							     to: a meter only where the stage carries a denominator, a
							     lane end only where it names a deadline or falls behind. -->
							{#each known.pipeline as stage (stage.key)}
								<li class="stages__item">
									<span class="lane" class:lane--locked={stage.availability.kind === 'locked'}>
										<span class="lane__mark lane__mark--pending"></span>
										<span class="lane__label"><span class="ui-skeleton skeleton-line" style="inline-size: 4rem"></span></span>
										<!-- A held lane resolves to no figure at all and an uncounted
										     one to a dash, so neither reserves the figure slot the
										     measured lanes use. -->
										{#if stage.availability.kind === 'available'}
											<span class="lane__headline"><span class="ui-skeleton skeleton-line" style="inline-size: 2.5rem"></span></span>
										{:else if stage.availability.kind === 'unavailable'}
											<span class="lane__headline"><span class="ui-skeleton skeleton-line" style="inline-size: 0.75rem"></span></span>
										{/if}
										{#if stage.availability.kind !== 'unavailable'}
											<span class="lane__sub"><span class="ui-skeleton skeleton-line" style="inline-size: 12rem"></span></span>
										{/if}
										{#if stage.progress}
											<span class="lane__meter">
												<span class="lane__track"></span>
												<span class="lane__digits"><span class="ui-skeleton skeleton-line" style="inline-size: 3.5rem"></span></span>
											</span>
										{/if}
										{#if stage.deadline || paceWord(stage)}
											<span class="lane__end">
												{#if paceWord(stage)}
													<span class="ui-skeleton skeleton-chip" style="inline-size: 3.25rem"></span>
												{/if}
												{#if stage.deadline}
													<span class="lane__deadline"><span class="ui-skeleton skeleton-line" style="inline-size: 7.5rem"></span></span>
												{/if}
											</span>
										{/if}
									</span>
								</li>
							{/each}
						</ul>
						{#if knownHasUncounted}
							<p class="stages__note"><span class="ui-skeleton skeleton-line" style="inline-size: min(23rem, 100%)"></span></p>
						{/if}
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
									<span class="dates__line"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></span>
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
						<header class="panel__head"><h2>Holding areas</h2></header>
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
				disabled>Create event</button>
			<button
				type="button"
				class="ui-button ui-button--secondary"
				aria-haspopup="dialog"
				onclick={() => (newEventOpen = true)}>Fill in details myself</button>
		</div>
		<!-- The reason a control refuses renders in place. It used to be a `title`,
		     which never arrives on a disabled control and never arrives on touch at
		     all — so the refusal was invisible exactly where it was needed. -->
		<p class="welcome__note">Describing your event to the assistant is not available yet.</p>
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
		<!-- The arrival tile leads the band: how much has come in, and what is new
		     since this operator last had it in their head, is the question they
		     opened the page holding. It is measured from the rows rather than
		     authored, so it is the one tile that cannot go stale. History and
		     weekly rates live on Pulse, whose door is its own rail row — this
		     band never grows charts of its own. -->
		{#if summary.arrivals && timezone !== ''}
			<ArrivalTile arrivals={summary.arrivals} {timezone} {discardedHref} />
		{/if}
		{#each summary.stats as stat (stat.label)}
			<StatTile
				label={stat.label}
				value={stat.value}
				sub={stat.sub}
				health={stat.health}
				progress={stat.progress} />
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
				{#if summary.sections.attention.kind === 'locked'}
					<p class="panel__calm">{summary.sections.attention.condition}</p>
					<div class="panel__dormant"><DormantShape shape="rows" rows={3} /></div>
				{:else if summary.sections.attention.kind === 'unavailable'}
					<p class="panel__calm">{summary.sections.attention.message}</p>
					<div class="panel__dormant"><DormantShape shape="rows" rows={3} /></div>
				{:else if listItems.length === 0}
					<!-- A live zero, not dormancy: the watch is running and found
					     nothing. No dormant shape — that would claim "not started". -->
					<p class="panel__calm">Nothing is waiting on you right now.</p>
				{:else}
					<ul class="attention">
						{#each listItems as item (item.id)}
							{@const Destination = areaIcon[item.area]}
							{@const mark = severityMark[item.severity]}
							<li class="attention__row">
								<span class="attention__sev">
									<Badge
										tone={mark.tone}
										icon={mark.icon}
										emphasis={item.severity === 'now'}
										value={severityLabel[item.severity]} />
								</span>
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
				{#if intakeHeld}
					<!-- The fact is the line; the verb is the button. One consequence for
					     the whole panel, rather than a door on every held lane leading to
					     the same nothing. -->
					<div class="stages__held">
						<p class="stages__held-fact">No form is open, so nothing has arrived yet.</p>
						<a class="ui-button ui-button--secondary ui-button--sm" href={areaHref.forms}
							>Make a form</a>
					</div>
				{/if}
				<ul class="stages">
					{#each summary.pipeline as stage (stage.key)}
						{@const Health = laneIcon(stage)}
						<li class="stages__item">
							{#if stage.availability.kind === 'locked'}
								<!-- Present, not started. It carries no figure at all: the dash
								     was a refusal to say, and the condition is the answer. Not a
								     door either — there are no rows behind it, and the panel
								     above already offers the one live next step. -->
								<span class="lane lane--locked" data-stage={stage.key}>
									<span class="lane__mark lane__mark--locked" aria-hidden="true"
										><Health size={14} /></span
									>
									<span class="lane__label">{stage.label}</span>
									<span class="lane__sub">{stage.availability.condition}</span>
								</span>
							{:else if stage.availability.kind === 'unavailable'}
								<!-- No measurement exists. The dash says so and the footnote
								     under the list says why, once, for every lane wearing one. -->
								<span class="lane lane--uncounted" data-stage={stage.key}>
									<span class="lane__mark lane__mark--unavailable" aria-hidden="true"
										><Health size={14} /></span
									>
									<span class="lane__label">{stage.label}</span>
									<span class="lane__headline">{stage.headline}</span>
								</span>
							{:else}
								{@const door = laneDoor(stage, summary.navCounts)}
								{@const pace = paceWord(stage)}
								{@const deadline = laneDeadline(stage)}
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
									<!-- Digits carry the absolute; the fill's hue carries the
									     lane's health, never its raw completion. -->
									<span class="lane__meter lane__meter--{statusToneClass[laneTone[stage.state]]}">
										<span class="lane__track">
											<Meter
												value={meterPercent(stage.progress)}
												label={`${stage.label} progress`}
												valueText={`${stage.progress.done} of ${stage.progress.required}`}
												tone={laneTone[stage.state]} />
										</span>
										<span class="lane__digits">{stage.progress.done} of {stage.progress.required}</span>
									</span>
								{/if}
								{#if deadline || pace}
									<span class="lane__end">
										{#if pace}
											<span class="lane__pace"
												><Badge
													tone={pace === 'Overdue' ? 'negative' : 'caution'}
													value={pace} /></span>
										{/if}
										{#if deadline}
											<!-- Which day, and how far away. Neither half works alone:
											     a date with no distance makes someone do arithmetic, a
											     countdown with no date leaves nothing to diarise. -->
											<span
												class="lane__deadline"
												class:lane__deadline--quiet={deadline.ink === 'quiet'}>
												<span class={DATE_CLASS.label}>{deadline.label}</span>
												<span class={DATE_CLASS.column}>{deadline.absolute}</span>
												{#if deadline.ink !== 'quiet'}
													<!-- The countdown belongs to work that is still owed. A
													     settled date is finished, and how long ago it finished
													     is trivia this lane need not carry: "closed 27 Jul" is
													     the fact, and "· 3 weeks ago" was pressure applied to
													     something nobody can act on. -->
													<span class="lane__distance">· {deadline.relative}</span>
												{/if}
											</span>
										{/if}
									</span>
								{/if}
								</a>
							{/if}
						</li>
					{/each}
				</ul>
				{#if uncountedNote}
					<!-- Said once, under the list, the way the tray ledger says once why
					     some of its pills are figures rather than links. -->
					<p class="stages__note">{uncountedNote}</p>
				{/if}
			</section>
		</div>

		<div class="columns__aside">
			<section class="panel" aria-label="Deadlines">
				<header class="panel__head"><h2>Deadlines</h2></header>
				{#if summary.sections.deadlines.kind === 'locked'}
					<!-- A fact about the event, not an absence of wiring: it states what
					     the first deadline will be rather than apologising for having none. -->
					<p class="panel__calm">{summary.sections.deadlines.condition}</p>
					<div class="panel__dormant"><DormantShape shape="rows" rows={3} /></div>
				{:else if summary.sections.deadlines.kind === 'unavailable'}
					<p class="panel__calm">{summary.sections.deadlines.message}</p>
					<div class="panel__dormant"><DormantShape shape="rows" rows={3} /></div>
				{:else if summary.deadlines.length === 0}
					<p class="panel__calm">No event deadlines are recorded.</p>
				{:else}
					<ul class="dates">
						{#each summary.deadlines as deadline (deadline.label)}
							{@const described = panelDeadline(deadline)}
							<li class="dates__row" class:dates__row--quiet={described?.ink === 'quiet'}>
								<span class="dates__label {DATE_CLASS.label}">{deadline.label}</span>
								{#if described && described.state !== 'upcoming'}
									<!-- The state is always a word. Colour ranks it; it never
									     carries it alone. -->
									<Badge tone={described.tone}>{described.stateWord}</Badge>
								{/if}
								<span class="dates__relative {DATE_CLASS.column}">{described?.relative ?? ''}</span>
								<span class="dates__line">
									<!-- The date's own span is the only thing that refuses to wrap;
									     a qualifier inside it would inherit that and push the row
									     past the viewport rather than breaking onto a second line. -->
									<span class="{DATE_CLASS.column} {DATE_CLASS.value}"
										>{described?.absolute ?? ''}</span>{#if deadline.note}<span
											class="dates__note"> · {deadline.note}</span
										>{/if}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="panel" aria-label="Activity">
				<header class="panel__head"><h2>Activity</h2></header>
				{#if summary.sections.activity.kind === 'locked'}
					<p class="panel__calm">{summary.sections.activity.condition}</p>
				{:else if summary.sections.activity.kind === 'unavailable'}
					<p class="panel__calm">{summary.sections.activity.message}</p>
				{:else if summary.activity.length === 0}
					<p class="panel__calm">No recorded activity yet.</p>
				{:else}
					<ActivityFeed items={summary.activity} {timezone} {now} />
				{/if}
			</section>

			<!-- Named for what it lists, not for the guarantee behind it: "Everything
			     has a place" was the design principle worn as a heading, and beside
			     Pipeline / Deadlines / Activity it read as a riddle. The pills are
			     the places things are held outside the main queues; the heading
			     says so and stops. -->
			<section class="panel" aria-label="Holding areas">
				<header class="panel__head"><h2>Holding areas</h2></header>
				{#if summary.sections.trays.kind === 'locked'}
					<p class="panel__calm">{summary.sections.trays.condition}</p>
					<div class="panel__dormant"><DormantShape shape="rows" rows={3} /></div>
				{:else if summary.sections.trays.kind === 'unavailable'}
					<p class="panel__calm">{summary.sections.trays.message}</p>
					<div class="panel__dormant"><DormantShape shape="rows" rows={3} /></div>
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

	.welcome__note {
		margin: var(--je-space-3) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
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
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--je-space-3);
		align-items: stretch;
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

	/* The dormant silhouette under a locked/unavailable sentence; a live zero
	   never gets one (a running watch that found nothing is not dormancy). */
	.panel__dormant {
		margin-block-start: var(--je-space-3);
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
		display: flex;
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
	/* Wrapping is the default rather than a breakpoint's job. A lane carrying a
	   mark, a label, a headline, a sentence, a meter with digits, a pace badge
	   and a deadline needs about 700px; at compact desktop the panel gives it
	   473, and without wrapping flexbox paid for that by shrinking the sentence
	   to **zero width** — the prose vanished silently and the deadline ran out
	   past the panel edge. `flex-basis` on the sentence is what turns that into
	   a second line instead, and it holds at every width without a query. */
	.lane {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-3);
		row-gap: var(--je-space-1);
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

	.lane__mark--unavailable,
	.lane__mark--locked {
		/* Non-text UI, so the 3:1 floor applies and subtle ink clears it at
		   4.14:1. The lane's own words never take this step — see below. */
		color: var(--je-color-text-subtle);
	}

	/* Present, not started. One ink step on the label is the visible level
	   change; the missing figure, meter and lane end are the rest of the
	   quieting. No fill and no border: the live lanes' hover already owns the
	   sunken surface, and on a new event every lane is held, so a per-lane wash
	   would distinguish nothing. What makes it read deliberate is the sentence. */
	.lane--locked .lane__label {
		color: var(--je-color-text-muted);
	}

	/* This sentence is the whole payload of a held lane, so it wraps at every
	   width rather than inheriting the measured lane's single-line ellipsis —
	   truncating it would hide the one thing the lane exists to say. It stays on
	   `text-muted` and never steps to `text-subtle`, which measures 4.14:1 and is
	   below the 4.5:1 floor for ordinary text: dimmed must not mean illegible. */
	.lane--locked .lane__sub {
		white-space: normal;
		overflow: visible;
		text-overflow: clip;
	}

	/* The shared cause, above the lanes it holds, carrying the one next step. */
	.stages__held {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-3);
		margin-block-end: var(--je-space-4);
	}

	.stages__held-fact {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* Said once, under the list, for every lane wearing a dash. */
	.stages__note {
		margin: var(--je-space-4) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
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

	/* A real minimum, not `flex: 1` alone: a basis of zero lets the line stay
	   one line by erasing this sentence, which is the one thing on the row that
	   cannot be recovered from anywhere else. */
	.lane__sub {
		flex: 1 1 10rem;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The meter is a second channel beside the words, never their replacement:
	   digits carry the absolute, the fill's hue carries health alone. */
	.lane__meter {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		flex-shrink: 0;
		align-self: center;
	}

	.lane__track {
		inline-size: 5.5rem;
		display: block;
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

	.lane__pace {
		display: flex;
	}

	.lane__deadline {
		display: flex;
		align-items: baseline;
		gap: 0.25em;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		white-space: nowrap;
	}

	/* A settled date steps back so the live rows around it stand out. */
	.lane__deadline--quiet {
		color: var(--je-color-text-subtle);
	}

	.lane__distance {
		color: var(--je-color-text-subtle);
	}

	.dates {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	/* Qualifier, state, distance on one line; the date itself beneath, spanning.
	   The state column collapses to nothing on a row that has no badge. */
	.dates__row {
		display: grid;
		grid-template-columns: 1fr auto auto;
		align-items: center;
		column-gap: var(--je-space-2);
		padding-block: var(--je-space-2);
	}

	.dates__row + .dates__row {
		border-block-start: 1px solid var(--je-color-border);
	}

	/* Settled and passed dates recede; live ones hold the row's ink. That
	   contrast is what lets a reader see what still needs action. */
	.dates__row--quiet .dates__line,
	.dates__row--quiet .dates__label {
		color: var(--je-color-text-subtle);
	}

	/* The qualifier, at lower ink. Colour and weight come from the shared date
	   label; only the size is this panel's. */
	.dates__label {
		font-size: var(--je-font-size-sm);
	}

	.dates__relative {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		text-align: end;
	}

	/* The date is the value, so it holds the row's ink and reads at body size.
	   It used to be the smallest, faintest thing in a panel about dates, with
	   the word "Proposals close" bolded above it. */
	.dates__line {
		grid-column: 1 / -1;
		font-size: var(--je-font-size-sm);
	}

	.dates__note {
		color: var(--je-color-text-muted);
		font-weight: 400;
	}

	/* Narrow widths restructure rather than squeeze: badge and copy share the
	   first row, the action gets its own row aligned with the copy. */
	@media (max-width: 920px) {
		.kpis {
			grid-template-columns: repeat(2, minmax(0, 1fr));
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
			align-items: center;
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

		.lane__deadline {
			white-space: normal;
			flex-wrap: wrap;
		}
	}
</style>
