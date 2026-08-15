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

	let {
		coverage,
		generalists,
		activeCount,
		invitedCount
	}: {
		coverage: ReviewerCoverage;
		generalists: number;
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
				{row.label}
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
				<div class="group">
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

	.groups {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: var(--je-space-6);
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
	   count lands on one shared vertical line down the group. */
	.group__rows {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content max-content;
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

	@media (max-width: 920px) {
		.groups {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
