<script lang="ts">
	/**
	 * The scope picker: typed refs to records that exist, never tags. It offers
	 * active tracks, active formats, and collecting/programmed sessions; a
	 * retired entry is never offered fresh, but a selection that already points
	 * at one still renders here — flagged — so it can be taken back out.
	 * Selection is a union: any ref matching puts a submission in scope, and
	 * selecting nothing is the generalist default.
	 *
	 * Sessions are categorized by their track — the same grounding, reused —
	 * and carry implied coverage: a session under a selected track or format
	 * renders checked as a soft member of the selection family — the marking
	 * tint at half strength, full ink, a "via track"/"via format" label naming
	 * the cause (track wins when both cover) — not toggleable, with the
	 * structured reason ("Included with …") surfaced by pressing it. The stored
	 * scope stays minimal — selecting a track never mints per-session refs —
	 * so the included state is derived here, never written.
	 */
	import { Check } from 'lucide-svelte';
	import type { Format, ScopeRef, SessionItem, Track } from '$lib/api/types';
	import { createSettler } from '$lib/ui';
	import { scopeKey } from './scope-display';

	let {
		tracks,
		formats,
		sessions,
		selected,
		ontoggle
	}: {
		tracks: Track[];
		formats: Format[];
		sessions: SessionItem[];
		selected: ScopeRef[];
		ontoggle: (ref: ScopeRef) => void;
	} = $props();

	const keys = $derived(new Set(selected.map(scopeKey)));

	const trackOptions = $derived(
		tracks.filter((track) => track.status === 'active' || keys.has(`track:${track.id}`))
	);
	const formatOptions = $derived(
		formats.filter((format) => format.status === 'active' || keys.has(`format:${format.id}`))
	);

	/**
	 * The selected track/format labels that cover one session — the structured
	 * reason behind its included state. Empty when nothing implies coverage.
	 */
	function coveringLabels(session: SessionItem): string[] {
		const labels: string[] = [];
		if (keys.has(`track:${session.trackId}`)) {
			labels.push(tracks.find((track) => track.id === session.trackId)?.name ?? session.trackId);
		}
		if (keys.has(`format:${session.formatId}`)) {
			labels.push(
				formats.find((format) => format.id === session.formatId)?.name ?? session.formatId
			);
		}
		return labels;
	}

	// ---------------------------------------------------------------- filter

	/** What is typed; the rows follow it on every keystroke — the sessions are
	 * already in hand, so a delay would only be a delay. */
	let query = $state('');
	/** What the result line reports: the settled query, so the line neither
	 * floods a screen reader nor describes a set still a word behind. */
	let settled = $state('');
	const settler = createSettler();
	$effect(() => () => settler.cancel());

	function onFilterInput(value: string) {
		query = value;
		settler.schedule(() => (settled = value));
	}

	function matching(q: string): SessionItem[] {
		const needle = q.trim().toLowerCase();
		if (!needle) return sessions;
		return sessions.filter((session) => session.title.toLowerCase().includes(needle));
	}

	/** Sessions grouped by their track, in track order; sessions whose track is
	 * not in the vocabulary trail in a neutral group. Narrowing by the filter
	 * changes which rows show, never what is selected or included. */
	const sessionGroups = $derived.by(() => {
		const shown = matching(query);
		const groups: { key: string; label: string; list: SessionItem[] }[] = [];
		for (const track of tracks) {
			const list = shown.filter((session) => session.trackId === track.id);
			if (list.length > 0) groups.push({ key: track.id, label: track.name, list });
		}
		const known = new Set(tracks.map((track) => track.id));
		const untracked = shown.filter((session) => !known.has(session.trackId));
		if (untracked.length > 0) groups.push({ key: 'no-track', label: 'No track', list: untracked });
		return groups;
	});

	const settledCount = $derived(matching(settled).length);

	// ------------------------------------------------- included explanations

	/** The included session whose reason has been asked for, by scope key.
	 * Pressing an included session is the question "why is this checked?", and
	 * it is answered in place without toggling anything. */
	let explained = $state('');

	function pressSession(session: SessionItem, included: boolean) {
		const key = `session:${session.id}`;
		if (included) {
			explained = explained === key ? '' : key;
			return;
		}
		explained = '';
		ontoggle({ kind: 'session', id: session.id });
	}
</script>

{#snippet option(ref: ScopeRef, label: string, retired: boolean)}
	{@const on = keys.has(scopeKey(ref))}
	<button
		type="button"
		class="option"
		class:option--on={on}
		aria-pressed={on}
		onclick={() => ontoggle(ref)}>
		{#if on}<Check size={12} aria-hidden="true" />{/if}
		{label}
		{#if retired}<span class="option__flag">retired</span>{/if}
	</button>
{/snippet}

{#snippet sessionOption(session: SessionItem)}
	{@const key = `session:${session.id}`}
	{@const explicit = keys.has(key)}
	{@const covers = coveringLabels(session)}
	{@const included = covers.length > 0 && !explicit}
	<button
		type="button"
		class="option"
		class:option--on={explicit}
		class:option--included={included}
		aria-pressed={explicit || included}
		aria-disabled={included ? 'true' : undefined}
		aria-describedby={included && explained === key ? `scope-included-${session.id}` : undefined}
		onclick={() => pressSession(session, included)}>
		{#if explicit || included}<Check size={12} aria-hidden="true" />{/if}
		{session.title}
		{#if included}
			<!-- The state names its cause without a press; part of the button's
			     accessible name, so covered-not-chosen never rides on color
			     alone. Track wins when both cover — the fuller answer is the
			     pressed-for reason line. -->
			<span class="option__via">via {keys.has(`track:${session.trackId}`) ? 'track' : 'format'}</span>
		{/if}
		{#if session.state === 'collecting'}<span class="ui-badge ui-badge--info">Collecting</span>{/if}
		{#if explicit && covers.length > 0}
			<!-- The explicit ref stays removable; the flag says the selection
			     above already covers it, so removing the ref changes nothing
			     about coverage. -->
			<span class="option__flag">also covered by {covers.join(' and ')}</span>
		{/if}
	</button>
	{#if included && explained === key}
		<span class="option__note" id={`scope-included-${session.id}`} role="status">
			Included with {covers.join(' and ')} — it stays in scope while that selection does.
		</span>
	{/if}
{/snippet}

<div class="picker">
	{#if trackOptions.length > 0}
		<div class="group" role="group" aria-label="Tracks">
			<span class="group__name" aria-hidden="true">Tracks</span>
			<div class="group__options">
				{#each trackOptions as track (track.id)}
					{@render option({ kind: 'track', id: track.id }, track.name, track.status === 'retired')}
				{/each}
			</div>
		</div>
	{/if}
	{#if formatOptions.length > 0}
		<div class="group" role="group" aria-label="Formats">
			<span class="group__name" aria-hidden="true">Formats</span>
			<div class="group__options">
				{#each formatOptions as format (format.id)}
					{@render option(
						{ kind: 'format', id: format.id },
						format.name,
						format.status === 'retired'
					)}
				{/each}
			</div>
		</div>
	{/if}
	{#if sessions.length > 0}
		<div class="group sessions" role="group" aria-label="Sessions">
			<span class="group__name" aria-hidden="true">Sessions</span>
			<input
				class="ui-control sessions__filter"
				type="search"
				placeholder="Filter sessions…"
				aria-label="Filter sessions by title"
				value={query}
				oninput={(event) => onFilterInput(event.currentTarget.value)} />
			{#if settled.trim()}
				<!-- One line for the eye and for assistive tech: what matched, in
				     which corpus, for the settled words. At zero it is the honest
				     empty state — the sessions were examined, none carry these
				     words in their titles. -->
				<p class="sessions__result" role="status">
					{#if settledCount === 0}
						No session titles match “{settled.trim()}”.
					{:else}
						{settledCount} of {sessions.length} session titles match “{settled.trim()}”.
					{/if}
				</p>
			{/if}
			{#each sessionGroups as group (group.key)}
				<div class="subgroup" role="group" aria-label={`${group.label} sessions`}>
					<span class="subgroup__name" aria-hidden="true">{group.label}</span>
					<div class="group__options">
						{#each group.list as session (session.id)}
							{@render sessionOption(session)}
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.picker {
		display: grid;
		gap: var(--je-space-3);
	}

	.group {
		display: grid;
		gap: var(--je-space-1);
	}

	.group__name {
		font-size: var(--je-font-size-2xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.group__options {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-1) var(--je-space-2);
	}

	/* Track subgroups sit inside the sessions group: their gap (4) stays under
	   the gap between subgroups (8), which stays under the picker's gap
	   between groups (12). */
	.sessions {
		gap: var(--je-space-2);
	}

	.sessions__filter {
		max-inline-size: 18rem;
		height: var(--je-control-height-sm);
		font-size: var(--je-font-size-sm);
	}

	.sessions__result {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.subgroup {
		display: grid;
		gap: var(--je-space-1);
	}

	/* The header is text, not a color block: the track's name in the quiet
	   voice — grouping is its whole job, so it spends no accent. */
	.subgroup__name {
		font-size: var(--je-font-size-2xs);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.option {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		min-block-size: 1.75rem;
		padding: 0.125rem var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-round);
		background: var(--je-color-surface);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text);
		cursor: pointer;
	}

	.option:hover {
		border-color: var(--je-color-border-strong);
	}

	/* Chosen-for-later is marking, so the selected option tints; the check is
	   the non-color twin of the tint. */
	.option--on,
	.option--on:hover {
		background: var(--je-color-mark-surface);
		border-color: var(--je-color-mark-border);
		font-weight: 600;
	}

	/* The explicit check claims the scope, so it carries the marking ink. */
	.option--on :global(svg) {
		color: var(--je-color-mark-ink);
	}

	/* Included is a soft member of the selection family: covered is a positive
	   state, so it carries the marking tint at half strength and a border
	   midway between plain and chosen — visibly in, visibly not the pressed
	   choice, never disabled-grey. The title keeps full ink and regular
	   weight; only the via-label and the check speak quietly. Hover stays
	   flat because there is nothing here to toggle. */
	.option--included {
		background: color-mix(in srgb, var(--je-color-mark-surface) 50%, var(--je-color-surface));
		border-color: color-mix(in srgb, var(--je-color-mark-border) 50%, var(--je-color-border));
	}

	.option--included:hover {
		border-color: color-mix(in srgb, var(--je-color-mark-border) 50%, var(--je-color-border));
	}

	/* The included check reports coverage; the explicit check claims it. */
	.option--included :global(svg) {
		color: var(--je-color-text-muted);
	}

	.option__via {
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
	}

	/* The answer takes its own line beneath the pressed option so the reason
	   reads in place, inside the group it belongs to. */
	.option__note {
		flex-basis: 100%;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.option__flag {
		font-size: var(--je-font-size-2xs);
		font-weight: 400;
		color: var(--je-color-text-muted);
	}

	@media (pointer: coarse) {
		.option {
			min-block-size: 2.5rem;
		}
	}
</style>
