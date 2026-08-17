<script lang="ts">
	/**
	 * Coverage per scope target, server-counted and render-only. Scoped counts
	 * deliberately exclude generalists, so the generalist line stays beside the
	 * rows — a zero next to "2 generalists review everything" reads as covered
	 * by them, not as a gap. Session rows count implied coverage: a reviewer
	 * scoped to the session's track or format covers it without holding the
	 * session ref, so the number is honest while stored scope stays minimal.
	 * The reviewers count is a door onto this page's own `?scope=` filter,
	 * which widens session addresses the same way — the door and the list
	 * agree. The submissions count is a door only where the submissions page
	 * supports that exact address filter (track and format — a session has no
	 * submissions filter there, so those rows make no claim; their applicant
	 * counts await the submission→target join).
	 */
	import type { CoverageRow, ReviewerCoverage } from '$lib/api/types';
	import { TrackChip } from '$lib/ui';

	let {
		coverage,
		generalists,
		trackOrder,
		activeCount,
		invitedCount
	}: {
		coverage: ReviewerCoverage;
		generalists: number;
		/** The event's own track order — the shared accent walk, so a track row
		 * here wears the same chip as the roster and every other surface. */
		trackOrder: readonly string[];
		/** Active reviewers on the roster; 0 means nobody has arrived yet. */
		activeCount: number;
		invitedCount: number;
	} = $props();

	// A composition that cannot count coverage says so in place of the rows. The
	// panel keeps its heading either way: the reader asked a question, and
	// "this workspace cannot answer it" is an answer, where an empty panel or a
	// permanent skeleton is not.
	const served = $derived<CoverageRow[]>(coverage.kind === 'served' ? coverage.rows : []);

	const trackRows = $derived(served.filter((row) => row.ref.kind === 'track'));
	const formatRows = $derived(served.filter((row) => row.ref.kind === 'format'));
	const sessionRows = $derived(served.filter((row) => row.ref.kind === 'session'));

	/** Where the submissions count lands; null renders the count as plain text. */
	function submissionsHref(row: CoverageRow): string | null {
		if (row.ref.kind === 'track') return `/app/submissions?trackId=${row.ref.id}`;
		if (row.ref.kind === 'format') return `/app/submissions?formatId=${row.ref.id}`;
		return null;
	}

	function plural(count: number, one: string, many: string): string {
		return count === 1 ? one : many;
	}
</script>

{#snippet rows(list: CoverageRow[])}
	{#each list as row (`${row.ref.kind}:${row.ref.id}`)}
		{@const href = submissionsHref(row)}
		<li class="row">
			<span class="row__label">
				{#if row.ref.kind === 'track'}
					<!-- A track value rendered as a value keeps its one product-wide
					     representation, so this list and the roster chips above answer
					     to the same hue. -->
					<TrackChip name={row.label} id={row.ref.id} order={trackOrder} />
				{:else}
					{row.label}
				{/if}
				{#if row.retired}
					<span class="row__flag">retired — consider re-scoping</span>
				{/if}
			</span>
			<span class="row__count">
				<a href={`/app/reviewers?scope=${row.ref.kind}:${row.ref.id}`}>
					{row.reviewers} scoped {plural(row.reviewers, 'reviewer', 'reviewers')}
				</a>
			</span>
			<span class="row__count">
				{#if href}
					<a {href}>{row.submissions} {plural(row.submissions, 'submission', 'submissions')}</a>
				{/if}
			</span>
		</li>
	{/each}
{/snippet}

<section class="panel" aria-label="Review coverage">
	<div class="panel__head">
		<h2 class="panel__title">Coverage</h2>
		{#if activeCount > 0}
			<!-- Always visible beside the rows, so a zero in a scoped count is
			     never misread as uncovered while generalists carry everything.
			     Suppressed only while nobody has arrived, when the waiting note
			     below is the whole answer. -->
			<p class="panel__generalists">
				{#if generalists > 0}
					{generalists}
					{plural(generalists, 'generalist reviews', 'generalists review')} everything
				{:else}
					No generalists — only scoped reviewers cover submissions
				{/if}
			</p>
		{/if}
	</div>

	{#if coverage.kind === 'unavailable'}
		<p class="panel__waiting">{coverage.reason}</p>
	{:else if activeCount === 0}
		<!-- One cause shared by every row belongs to the surface, not the rows:
		     with nobody arrived there is no coverage to enumerate. -->
		<p class="panel__waiting">
			Nobody has arrived yet — {invitedCount}
			{plural(invitedCount, 'invitation is', 'invitations are')} recorded. Coverage appears as
			reviewers sign in.
		</p>
	{:else if served.length === 0}
		<p class="panel__waiting">
			No tracks, formats, or collecting sessions to cover yet. Coverage appears once the event
			vocabulary exists.
		</p>
	{:else}
		<div class="groups">
			{#if trackRows.length > 0}
				<div class="group">
					<h3 class="group__name">Tracks</h3>
					<ul class="group__rows">{@render rows(trackRows)}</ul>
				</div>
			{/if}
			{#if formatRows.length > 0}
				<div class="group">
					<h3 class="group__name">Formats</h3>
					<ul class="group__rows">{@render rows(formatRows)}</ul>
				</div>
			{/if}
			{#if sessionRows.length > 0}
				<div class="group group--sessions">
					<h3 class="group__name">Collecting sessions</h3>
					<ul class="group__rows">{@render rows(sessionRows)}</ul>
					<p class="group__note">Applicants aren’t counted here yet.</p>
				</div>
			{/if}
		</div>
	{/if}
</section>

<style>
	.panel {
		padding: var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		/* The groups compose against the panel's own width, not the viewport. */
		container-type: inline-size;
		container-name: coverage;
	}

	.panel__head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-2) var(--je-space-4);
		margin-block-end: var(--je-space-3);
	}

	.panel__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.panel__generalists {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.panel__waiting {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* Three groups, one question. Each mini-table hugs its own content so the
	   gap inside a row (label to count, a fixed space-4) stays strictly smaller
	   than the boundary between groups — the nesting invariant that makes them
	   read as separate. Because leftover width varies with the container, the
	   boundary is also named by a hairline rather than left to space alone:
	   stacked groups take a horizontal rule; side by side, a vertical one. */
	.groups {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-3);
	}

	.group + .group {
		border-block-start: 1px solid var(--je-color-border);
		padding-block-start: var(--je-space-3);
	}

	/* Tracks and Formats share a row once the panel is wide enough for two
	   mini-tables; Collecting sessions keeps its own full-width band — its rows
	   claim less (no submissions door yet) and carry their own note, and its
	   session titles want the reading measure, not a squeezed column. */
	@container coverage (min-inline-size: 48rem) {
		.groups {
			display: grid;
			grid-template-columns: fit-content(55%) minmax(0, 1fr);
			gap: var(--je-space-3) var(--je-space-6);
		}

		.group:not(.group--sessions) + .group:not(.group--sessions) {
			border-block-start: none;
			padding-block-start: 0;
			border-inline-start: 1px solid var(--je-color-border);
			padding-inline-start: var(--je-space-6);
		}

		.group--sessions {
			grid-column: 1 / -1;
		}
	}

	.group__name {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	/* The columns live on the list; each row opts in with subgrid so every
	   count lands on one shared vertical line down the group. The label column
	   sizes to its content (shrinkable, never stretched), so slack pools after
	   the row instead of inside it — the counts stay beside what they count. */
	.group__rows {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		grid-template-columns: minmax(0, max-content) max-content max-content;
		gap: var(--je-space-1) var(--je-space-4);
	}

	.row {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: baseline;
	}

	.row__label {
		font-size: var(--je-font-size-sm);
		min-inline-size: 0;
	}

	/* The label column is the reading column, and the full name lives in
	   `title`, which a touch reader never receives — so the chip wraps rather
	   than truncating, the same override the submissions and decisions records
	   apply to the shared chip at record width. */
	.row__label :global(.ui-track) {
		white-space: normal;
	}

	.row__label :global(.ui-track__label) {
		overflow: visible;
		text-overflow: clip;
		white-space: normal;
	}

	.row__flag {
		display: block;
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
	}

	.row__count {
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
		text-align: end;
	}

	.group__note {
		margin: var(--je-space-2) 0 0;
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
	}
</style>
