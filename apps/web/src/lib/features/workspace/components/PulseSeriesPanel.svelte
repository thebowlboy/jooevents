<script lang="ts">
	/**
	 * One heartbeat on the Pulse page: a flow's running total and its weekly
	 * movement. The plot spends no colour — past weeks in recessive ink, the
	 * week in progress at full ink — because a rate is neither a status nor a
	 * selection, and the digits beside it carry the absolute (the arrivals
	 * tile is the pattern this generalizes).
	 *
	 * The breakdown opens on **press and focus**, never on hover; the resting
	 * caption under the plot is the whole of the discoverability a touch
	 * reader gets. A flow that has not begun renders its worded absence in the
	 * plot's place — absence of measurement is never a zero chart.
	 */
	import { describeArrivalWeek } from '@jooevents/contracts';
	import { Popover } from '$lib/ui';
	import type { PulseSeries, PulseWeek } from '$lib/api/pulse-page-port';

	let {
		series,
		timezone,
		now
	}: {
		readonly series: PulseSeries;
		readonly timezone: string;
		readonly now: number;
	} = $props();

	const weeks = $derived(
		series.weeks.map((week) => ({
			week,
			words: describeArrivalWeek({ week, timezone, now })
		}))
	);
	const peak = $derived(Math.max(1, ...series.weeks.map((week) => week.count)));

	/** Floored so a week that had activity never renders as a week that had none. */
	function barHeight(week: PulseWeek): string {
		if (week.count === 0) return '0';
		return `${Math.max(12, Math.round((week.count / peak) * 100))}%`;
	}

	const figureName = $derived(
		`${series.label}: ${series.windowCount} in the last ${series.windowDays} days, of ${series.total} ${series.totalNote} — show the weekly breakdown`
	);
</script>

<article class="beat">
	<span class="beat__label">{series.label}</span>
	{#if series.absence !== undefined}
		<p class="beat__absence">{series.absence}</p>
	{:else}
		<!-- The rate is this panel's answer; the running total lives in the hero
		     band above and in this plot's own table, so it does not shout twice. -->
		<span class="beat__value">
			<span class="beat__figure">{series.windowCount}</span>
			<span class="beat__note">in the last {series.windowDays} days</span>
		</span>
		<Popover label={figureName} kind="figure" fill>
			{#snippet trigger()}
				<span class="beat__spark">
					<span class="beat__plot" aria-hidden="true">
						{#each series.weeks as week, index (week.startsAt)}
							<span class="beat__slot">
								<span
									class="beat__bar"
									class:beat__bar--current={index === series.weeks.length - 1}
									style:block-size={barHeight(week)}></span>
							</span>
						{/each}
					</span>
					<!-- The resting statement of what the figure is: the only thing
					     saying so before anything is hovered. -->
					<span class="beat__caption">{series.weeks.length} weeks</span>
				</span>
			{/snippet}
			{#snippet children()}
				<table class="beat-panel__table">
					<thead>
						<tr><th scope="col">Week</th><th scope="col">Dates</th><th scope="col">Count</th></tr>
					</thead>
					<tbody>
						{#each weeks as row (row.week.startsAt)}
							<tr class:beat-panel__row--current={row.words?.current}>
								<th scope="row">{row.words?.relative ?? 'Week'}</th>
								<td class="beat-panel__dates">{row.words?.range ?? ''}</td>
								<td class="beat-panel__count">{row.week.count}</td>
							</tr>
						{/each}
					</tbody>
					<tfoot>
						<tr>
							<th scope="row" colspan="2">Total {series.totalNote}</th>
							<td class="beat-panel__count">{series.total}</td>
						</tr>
					</tfoot>
				</table>
			{/snippet}
		</Popover>
	{/if}
</article>

<style>
	.beat {
		display: grid;
		gap: var(--je-space-2);
		align-content: start;
		padding: var(--je-space-3) var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.beat__label {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* A flow that has not begun says why in words, holding roughly the block
	   the resolved composition occupies so a band of three panels does not
	   read as one full and two broken. */
	.beat__absence {
		margin: 0;
		min-block-size: 6.25rem;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.beat__value {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-2);
		min-inline-size: 0;
	}

	.beat__figure {
		font-size: var(--je-font-size-xl);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: var(--je-leading-tight);
	}

	.beat__note {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		min-inline-size: 0;
	}

	.beat__spark {
		display: flex;
		align-items: flex-end;
		gap: var(--je-space-2);
		min-inline-size: 0;
	}

	/* Twelve weekly slots on one baseline. Gaps are surface rather than a
	   stroke, and a week with nothing shows as an empty slot above the rule —
	   which is information, not a rendering fault. */
	.beat__plot {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		flex: 1 1 auto;
		min-inline-size: 3.5rem;
		block-size: 2.75rem;
		border-block-end: 1px solid var(--je-color-border);
		padding-block-end: 1px;
	}

	.beat__slot {
		flex: 1;
		display: flex;
		align-items: flex-end;
		min-inline-size: 0;
		max-inline-size: 1.5rem;
		block-size: 100%;
	}

	/* Emphasis rather than hue: a rate is not a status, so it spends no
	   status colour and the accent budget stays where it buys something. */
	.beat__bar {
		inline-size: 100%;
		border-radius: 2px 2px 0 0;
		background: var(--je-color-text-subtle);
	}

	.beat__bar--current {
		background: var(--je-color-text);
	}

	.beat__caption {
		flex: 0 0 auto;
		font-size: var(--je-font-size-2xs);
		font-weight: 400;
		line-height: 1;
		color: var(--je-color-text-subtle);
		white-space: nowrap;
	}

	.beat-panel__table {
		inline-size: 100%;
		border-collapse: collapse;
		font-size: var(--je-font-size-xs);
	}

	.beat-panel__table th,
	.beat-panel__table td {
		padding-block: 2px;
		text-align: start;
		font-weight: 400;
		color: var(--je-color-text-muted);
	}

	.beat-panel__table thead th {
		color: var(--je-color-text-subtle);
		border-block-end: 1px solid var(--je-color-border);
		padding-block-end: var(--je-space-1);
	}

	.beat-panel__table tfoot th,
	.beat-panel__table tfoot td {
		border-block-start: 1px solid var(--je-color-border);
		padding-block-start: var(--je-space-1);
		color: var(--je-color-text);
		font-weight: 600;
	}

	.beat-panel__dates {
		color: var(--je-color-text-subtle);
	}

	/* A column of counts is read down, so it aligns and takes tabular figures. */
	.beat-panel__count {
		text-align: end;
		font-variant-numeric: tabular-nums;
	}

	.beat-panel__row--current th,
	.beat-panel__row--current td {
		color: var(--je-color-text);
		font-weight: 600;
	}
</style>
