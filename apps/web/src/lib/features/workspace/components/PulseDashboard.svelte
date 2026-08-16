<script lang="ts">
	/**
	 * Pulse: what has been happening across the event, week by week. Purely
	 * descriptive — volumes, rates, and distributions with no judgment
	 * attached. Pace against the clock stays on the Overview's pipeline
	 * lanes; nothing here renders a pace verdict, and nothing on the Overview
	 * renders history. Flows chart over time because their facts carry
	 * timestamps; stocks appear only as current values.
	 */
	import { onMount, untrack } from 'svelte';
	import { Badge, TrackChip, badgeFor } from '$lib/ui';
	import type { PulsePagePort, PulsePageSummary } from '$lib/api/pulse-page-port';
	import type { DecisionState } from '$lib/api/types';
	import CountRows from './CountRows.svelte';
	import DormantShape from './DormantShape.svelte';
	import PulseSeriesPanel from './PulseSeriesPanel.svelte';
	import PulseStoryPanel from './PulseStoryPanel.svelte';

	let { port }: { readonly port: PulsePagePort } = $props();

	/** One clock reading for the whole screen, taken at entry. */
	const now = Date.now();

	let summary = $state<PulsePageSummary | null>(null);
	let loadError = $state('');

	onMount(() => {
		void load();
	});

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
						? 'The pulse could not be reached. Try again.'
						: 'The pulse response could not be loaded.'
					: result.message;
			} catch {
				if (ticket !== readTicket) return;
				loadError = 'The pulse could not be reached. Try again.';
			} finally {
				if (ticket === readTicket) inFlight = null;
			}
		})();
		inFlight = run;
		return run;
	}

	// What is already known shapes the placeholder, so the loading region
	// mirrors the exact panels that resolve — a chart where a chart will be,
	// a worded absence where one will stand.
	const known = untrack(() => port.snapshot());
	const expectEvent = known?.event != null;

	const timezone = $derived(summary?.event?.timezone ?? '');

	/* One state, one name, in the closed vocabulary — the same words and tones
	   these states wear on the decisions board. */
	const decisionWord: Record<DecisionState, string> = {
		accepted: 'Accepted',
		waitlisted: 'Waitlisted',
		declined: 'Declined',
		withdrawn: 'Withdrawn',
		undecided: 'Not decided'
	};

	const decisionOrder: readonly DecisionState[] = [
		'accepted',
		'waitlisted',
		'declined',
		'withdrawn',
		'undecided'
	];

	const breakdownRows = $derived(
		summary
			? [...summary.breakdown.rows].sort(
					(left, right) => decisionOrder.indexOf(left.state) - decisionOrder.indexOf(right.state)
				)
			: []
	);

	function decisionMark(state: DecisionState) {
		// Undecided is a resting state, not an outcome; it takes the neutral
		// badge without a glyph rather than borrowing an outcome's mark.
		return state === 'undecided' ? null : badgeFor(state);
	}

	/** The event's own vocabulary order, so each chip wears one colour whatever
	    its current rank in the panel. */
	const trackOrder = $derived(summary ? summary.tracks.rows.map((row) => row.id) : []);

	/**
	 * `absence` carries two different facts, and only one of them may wear the
	 * dormant shape. On the decision spread it is usually *this has not begun*
	 * — but where every proposal sits in one state it is a stated measurement
	 * ("All 9 proposals are waiting for your answer") over real records. A
	 * silhouette behind that sentence would assert "not started" about nine
	 * live proposals, so the total is the discriminator: a population of zero
	 * is dormancy, anything else is a fact and keeps the plain sentence.
	 */
	const breakdownDormant = $derived(
		summary?.breakdown.absence !== undefined && summary.breakdown.total === 0
	);
	const knownBreakdownDormant = known
		? known.breakdown.absence !== undefined && known.breakdown.total === 0
		: false;

	/**
	 * Ranked for comparison: the panel's question is which tracks are thin, so
	 * the biggest speaker count leads and the shortfall reads off the bottom.
	 * The ranking is the order itself — numbering the rows would restate what
	 * position already shows.
	 */
	const rankedTracks = $derived(
		summary
			? [...summary.tracks.rows].sort(
					(left, right) => right.speakers - left.speakers || right.accepted - left.accepted
				)
			: []
	);
</script>

{#if !summary && loadError}
	<section class="welcome" aria-label="Pulse unavailable">
		<h2 class="welcome__title">The pulse could not be loaded</h2>
		<p class="welcome__copy">{loadError}</p>
		<button type="button" class="ui-button ui-button--secondary" onclick={() => void read()}>Try again</button>
	</section>
{:else if !summary}
	<section class="loading" aria-label="Loading pulse">
		{#if expectEvent && known}
			<p class="intro" aria-hidden="true"><span class="ui-skeleton sk-line" style="inline-size: 26rem"></span></p>
			<section class="panel" aria-hidden="true">
				<header class="panel__head"><h2>The event so far</h2></header>
				{#if known.hero.absence !== undefined}
					<p class="panel__calm">{known.hero.absence}</p>
				{:else}
					<span class="sk-story__figures">
						{#each known.hero.figures as figure (figure.label)}
							<span class="sk-story__figure">
								<span class="ui-skeleton sk-line" style="inline-size: 4rem"></span>
								<span class="sk-story__value"><span class="ui-skeleton sk-line" style="inline-size: 2.5rem"></span></span>
							</span>
						{/each}
					</span>
					{#if known.hero.funnel}
						<span class="sk-story__chart"></span>
					{/if}
				{/if}
			</section>
			<section class="beats" aria-hidden="true">
				{#each known.series as series (series.key)}
					<article class="sk-beat">
						<span class="sk-beat__label"><span class="ui-skeleton sk-line" style="inline-size: 7rem"></span></span>
						{#if series.absence !== undefined}
							<!-- Evidence already says this flow has not begun, so the
							     placeholder is the dormant composition itself rather than a
							     skeleton promising a chart that is not coming. -->
							<p class="sk-beat__absence">{series.absence}</p>
							<DormantShape shape="bars" />
						{:else}
							<span class="sk-beat__value"><span class="ui-skeleton sk-line" style="inline-size: 3.5rem"></span></span>
							<span class="sk-beat__plot"></span>
						{/if}
					</article>
				{/each}
			</section>
			<div class="pair" aria-hidden="true">
				<section class="panel">
					<header class="panel__head"><h2>Where every proposal stands</h2></header>
					{#if known.breakdown.absence !== undefined}
						{#if knownBreakdownDormant}
							<span class="dormant-slot"><DormantShape shape="rows" rows={4} /></span>
						{/if}
						<p class="panel__calm">{known.breakdown.absence}</p>
					{:else}
						<ul class="sk-rows">
							{#each Array(known.breakdown.rows.length) as _, index (index)}
								<li class="sk-rows__row">
									<span class="ui-skeleton sk-chip"></span>
									<span class="ui-skeleton sk-line" style="inline-size: 1.5rem"></span>
								</li>
							{/each}
						</ul>
					{/if}
				</section>
				<section class="panel">
					<header class="panel__head"><h2>How the program is filling</h2></header>
					{#if known.tracks.absence !== undefined}
						<span class="dormant-slot"><DormantShape shape="rows" rows={3} /></span>
						<p class="panel__calm">{known.tracks.absence}</p>
					{:else}
						<ul class="sk-rows">
							{#each Array(known.tracks.rows.length) as _, index (index)}
								<li class="sk-rows__row">
									<span class="ui-skeleton sk-chip"></span>
									<span class="ui-skeleton sk-line" style="inline-size: 1.5rem"></span>
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			</div>
		{:else}
			<section class="welcome welcome--loading" aria-hidden="true">
				<p class="welcome__title sk-head"><span class="ui-skeleton sk-line" style="inline-size: 18rem"></span></p>
				<p class="welcome__copy"><span class="ui-skeleton sk-line" style="inline-size: 24rem"></span></p>
			</section>
		{/if}
	</section>
{:else if !summary.event}
	<section class="welcome" aria-label="The pulse starts with your first event">
		<h2 class="welcome__title">The pulse starts with your first event</h2>
		<p class="welcome__copy">
			This workspace has no event yet. Once one exists and proposals arrive, arrivals, reviews,
			and decisions chart here week by week.
		</p>
		<a class="ui-button ui-button--secondary" href="/app">Back to overview</a>
	</section>
{:else}
	<p class="intro">
		How the event has been moving — running totals, weekly rates, and where every proposal
		stands. What needs you stays on the Overview.
	</p>

	<PulseStoryPanel hero={summary.hero} {timezone} {now} />

	<section class="beats" aria-label="Week by week">
		{#each summary.series as series (series.key)}
			<PulseSeriesPanel {series} {timezone} {now} />
		{/each}
	</section>

	<div class="pair">
		<section class="panel" aria-label="Where every proposal stands">
			<header class="panel__head">
				<h2>Where every proposal stands</h2>
				<span class="panel__count">{summary.breakdown.total}</span>
			</header>
			{#if summary.breakdown.absence !== undefined}
				{#if breakdownDormant}
					<!-- Nothing to spread yet: the list's own silhouette, then the
					     condition beneath it where the panel's note already sits. -->
					<span class="dormant-slot"><DormantShape shape="rows" rows={4} /></span>
				{/if}
				<p class="panel__calm">{summary.breakdown.absence}</p>
			{:else}
				<CountRows rows={breakdownRows} value={(row) => row.count}>
					{#snippet lead(row)}
						{@const mark = decisionMark(row.state)}
						{#if mark}
							<Badge tone={mark.tone} icon={mark.icon} value={decisionWord[row.state]} />
						{:else}
							<Badge tone="neutral" value={decisionWord[row.state]} />
						{/if}
					{/snippet}
					{#snippet digits(row)}{row.count}{/snippet}
				</CountRows>
				{#if summary.breakdown.note}
					<p class="panel__note">{summary.breakdown.note}</p>
				{/if}
			{/if}
		</section>

		<section class="panel" aria-label="How the program is filling">
			<header class="panel__head"><h2>How the program is filling</h2></header>
			{#if summary.tracks.absence !== undefined}
				<!-- Track fill is dormant whenever it is absent: the rows exist only
				     once a track has an accepted speaker, so there is no stated
				     measurement to confuse this with. -->
				<span class="dormant-slot"><DormantShape shape="rows" rows={3} /></span>
				<p class="panel__calm">{summary.tracks.absence}</p>
			{:else}
				<!-- One shared scale across the bars, so the lengths *are* the
				     speaker ratio between tracks; the digits carry the absolutes
				     and the acceptance context stays a quiet clause. -->
				<CountRows rows={rankedTracks} value={(row) => row.speakers}>
					{#snippet lead(row)}
						<TrackChip id={row.id} name={row.name} order={trackOrder} />
					{/snippet}
					{#snippet digits(row)}
						{row.speakers}
						<span class="pair__of"
							>{row.speakers === 1 ? 'speaker' : 'speakers'} · {row.accepted} of {row.proposals} accepted</span>
					{/snippet}
				</CountRows>
			{/if}
			{#if summary.tracks.rosterLine}
				<p class="panel__note">{summary.tracks.rosterLine}</p>
			{/if}
		</section>
	</div>
{/if}

<style>
	.loading {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-6);
	}

	/* Orientation for a direct arrival: the plain statement of what this
	   surface is, under the playful title the topbar carries. */
	.intro {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		max-inline-size: 52rem;
	}

	.beats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: var(--je-space-3);
		align-items: stretch;
	}

	.pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: var(--je-space-4);
		align-items: start;
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

	/* The shape owns no outer spacing — a primitive's box is its own — so the
	   panel supplies the interval between the silhouette and the sentence that
	   names its condition. */
	.dormant-slot {
		display: block;
		margin-block-end: var(--je-space-3);
	}

	.panel__calm {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.panel__note {
		margin: var(--je-space-3) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* The qualifier stays in the sentence at the line's own quiet ink; only
	   the compared count holds column weight. */
	.pair__of {
		font-weight: 400;
		color: var(--je-color-text-muted);
	}

	/* Skeletons restate the beat panel's geometry in the same tokens: label
	   line, figure line, the plot's rule at its resolved height, window line. */
	.sk-beat {
		display: grid;
		gap: var(--je-space-2);
		align-content: start;
		padding: var(--je-space-3) var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.sk-beat__label {
		font-size: var(--je-font-size-xs);
	}

	/* The hero's placeholder keeps its resolved rhythm: label-over-figure
	   pairs at display size, then the chart's rule at its resolved height. */
	.sk-story__figures {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-3) var(--je-space-8);
		margin-block-end: var(--je-space-4);
		font-size: var(--je-font-size-xs);
	}

	.sk-story__figure {
		display: grid;
		gap: var(--je-space-1);
	}

	.sk-story__value {
		font-size: var(--je-font-size-2xl);
		line-height: var(--je-leading-tight);
	}

	.sk-story__chart {
		display: block;
		block-size: 7rem;
		border-block-end: 1px solid var(--je-color-border);
		margin-block-end: calc(var(--je-space-2) + 1lh);
	}

	.sk-beat__value {
		font-size: var(--je-font-size-xl);
		font-weight: 600;
		line-height: var(--je-leading-tight);
	}

	.sk-beat__plot {
		display: block;
		block-size: 2.75rem;
		border-block-end: 1px solid var(--je-color-border);
	}

	.sk-beat__absence {
		margin: 0;
		min-block-size: 6.25rem;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.sk-rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.sk-rows__row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-3);
		padding-block: var(--je-space-2);
	}

	.sk-rows__row + .sk-rows__row {
		border-block-start: 1px solid var(--je-color-border);
	}

	.sk-line {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.sk-chip {
		display: inline-block;
		block-size: 1.35rem;
		inline-size: 6rem;
	}

	.sk-head {
		line-height: var(--je-leading-tight);
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

	.welcome--loading {
		min-block-size: 12rem;
		align-content: center;
	}
</style>
