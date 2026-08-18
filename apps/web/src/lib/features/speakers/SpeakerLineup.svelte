<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { flip } from 'svelte/animate';
	import { CodeXml, GripVertical, Plus } from 'lucide-svelte';
	import { Button, createRowDrag, motionMs, statusIcon } from '$lib/ui';
	import type { SpeakersPagePort } from '$lib/api/speakers-page-port';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import type { EngagementState, SpeakerCategory, SpeakerLineupRow } from '$lib/api/types';

	/**
	 * The public lineup: who appears on the roster surface, in what order, under
	 * which group.
	 *
	 * This is deliberately a second view of the same roster rather than a second
	 * roster. The default view chases people — states, tasks, cancellations. This
	 * one curates what the outside world sees, which is a different job with a
	 * different shape: one flat sequence, because that sequence *is* the fact
	 * being edited, and every public presentation reads it.
	 *
	 * Order is global and flat even though the published page groups by category.
	 * A drag inside a grouped list would have to answer "does this also change
	 * the group?", and the honest answer — sometimes — makes a drop ambiguous.
	 * One list, one meaning: position within the whole roster, which a grouped
	 * page applies inside each group.
	 */

	interface Props {
		port: SpeakersPagePort;
	}

	let { port }: Props = $props();

	const api = $derived(port);

	let categories = $state<SpeakerCategory[] | null>(null);
	let speakers = $state<SpeakerLineupRow[] | null>(null);
	let pending = $state('');
	let error = $state('');
	let loadError = $state('');
	let retrying = $state(false);
	let announcement = $state('');

	async function load() {
		try {
			const [nextSpeakers, nextCategories] = await Promise.all([
				api.lineup.list(),
				api.vocab.speakerCategories()
			]);
			speakers = nextSpeakers;
			categories = nextCategories;
			loadError = '';
		} catch (cause) {
			loadError = cause instanceof Error
				? cause.message
				: 'The public lineup could not be loaded.';
		}
	}

	async function retry() {
		retrying = true;
		try {
			await load();
		} finally {
			retrying = false;
		}
	}

	onMount(() => void load());

	const rows = $derived(speakers ?? []);
	const shown = $derived(rows.filter((row) => row.publiclyVisible));
	const hidden = $derived(rows.filter((row) => !row.publiclyVisible));

	function categoryName(id: string | undefined): string {
		if (!id) return 'No group';
		return categories?.find((entry) => entry.id === id)?.name ?? 'No group';
	}

	async function refresh() {
		await load();
	}

	function failureCopy(cause: unknown, fallback: string): string {
		return cause instanceof Error ? cause.message : fallback;
	}

	// -----------------------------------------------------------------------
	// Order. A drop is arrangement, not composition: it commits immediately with
	// its own receipt, and the compensating undo puts the row back at the index
	// it left — which is the index it had in the list the person was looking at.

	const rowDrag = createRowDrag({
		rowSelector: '.lnrow',
		onMove: (from, to) => void moveRow(from, to)
	});

	async function moveRow(from: number, to: number) {
		if (pending || from === to) return;
		const row = shown[from];
		if (!row) return;
		// The list on screen is the published subset; the API's index is over the
		// whole roster, so the destination resolves through the row it lands on.
		const others = shown.filter((_, index) => index !== from);
		const successor = to >= others.length ? null : others[to];
		const wholeOrder = rows.map((entry) => entry.id).filter((id) => id !== row.id);
		const target = successor ? wholeOrder.indexOf(successor.id) : wholeOrder.length;
		const wasAt = rows.findIndex((entry) => entry.id === row.id);

		pending = `move-${row.id}`;
		error = '';
		try {
			const outcome = await api.lineup.reorder(row.id, target);
			if (!outcome.ok) {
				error = outcome.reason;
				return;
			}
			await refresh();
			announcement = `${row.name} moved to position ${to + 1} of ${shown.length}.`;
			recordAction({
				area: 'speakers',
				label: `Moved ${row.name} in the lineup`,
				undo: async () => {
					await api.lineup.reorder(row.id, wasAt);
					await refresh();
				}
			});
		} catch (cause) {
			error = failureCopy(cause, 'The lineup order could not be changed.');
		} finally {
			pending = '';
		}
	}

	// -----------------------------------------------------------------------
	// Grouping and visibility: single-field edits on one record, so they commit
	// in place, each with the receipt that carries them back.

	async function assignCategory(row: SpeakerLineupRow, next: string) {
		const before = row.categoryId ?? null;
		const value = next || null;
		if (before === value) return;
		pending = `cat-${row.id}`;
		error = '';
		try {
			const outcome = await api.lineup.setCategory(row.id, value);
			if (!outcome.ok) {
				error = outcome.reason;
				return;
			}
			await refresh();
			recordAction({
				area: 'speakers',
				label: value
					? `Filed ${row.name} under ${categoryName(value)}`
					: `Removed ${row.name} from ${categoryName(before ?? undefined)}`,
				undo: async () => {
					await api.lineup.setCategory(row.id, before);
					await refresh();
				}
			});
		} catch (cause) {
			error = failureCopy(cause, 'The speaker group could not be changed.');
		} finally {
			pending = '';
		}
	}

	async function setVisible(row: SpeakerLineupRow, publiclyVisible: boolean) {
		pending = `vis-${row.id}`;
		error = '';
		try {
			const outcome = await api.lineup.setVisibility(row.id, publiclyVisible);
			if (!outcome.ok) {
				error = outcome.reason;
				return;
			}
			await refresh();
			announcement = publiclyVisible
				? `${row.name} is on the public lineup.`
				: `${row.name} is off the public lineup.`;
			recordAction({
				area: 'speakers',
				label: publiclyVisible ? `Published ${row.name}` : `Took ${row.name} off the lineup`,
				undo: async () => {
					await api.lineup.setVisibility(row.id, !publiclyVisible);
					await refresh();
				}
			});
		} catch (cause) {
			error = failureCopy(cause, 'The public lineup could not be changed.');
		} finally {
			pending = '';
		}
	}

	// -----------------------------------------------------------------------
	// New group

	let addOpen = $state(false);
	let newName = $state('');
	let newInput = $state<HTMLInputElement>();

	async function openAdd() {
		addOpen = true;
		await tick();
		newInput?.focus();
	}

	async function addCategory(event: SubmitEvent) {
		event.preventDefault();
		const name = newName.trim();
		if (!name || pending) return;
		pending = 'add-category';
		error = '';
		try {
			const created = await api.vocab.addSpeakerCategory(name);
			await load();
			newName = '';
			addOpen = false;
			announcement = `“${created.name}” is now a speaker group.`;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'The speaker group could not be added.';
		} finally {
			pending = '';
		}
	}

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) return '?';
		const first = parts[0].charAt(0);
		const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
		return `${first}${last}`.toUpperCase();
	}

	/** Why someone is off the lineup, in the roster's own vocabulary. */
	const engagementWords: Record<EngagementState, string> = {
		invited: 'Awaiting confirmation',
		confirmed: 'Confirmed — not published',
		declined: 'Declined',
		cancel_requested: 'Cancellation requested',
		cancelled: 'Cancelled'
	};
</script>

<div class="lineup">
	<header class="lineup__head">
		<div class="lineup__intro">
			<h2 class="lineup__title">Public lineup</h2>
			<p class="lineup__copy">
				People under “On the lineup” appear on your speaker page and in every embed, in this
				order. Drag to change it; grouped pages keep this order inside each group.
			</p>
		</div>
		<!-- The two doors out: what it looks like, and how it gets onto a site.
		     One fact, one door each — both resolve to the addresses the rest of
		     the product uses for the same two jobs. -->
		<div class="lineup__doors">
			<a class="ui-button ui-button--secondary ui-button--sm" href="/app/embeds?embed=srf-speaker-roster">
				<CodeXml size={14} aria-hidden="true" />Embed the lineup
			</a>
			<a class="ui-button ui-button--ghost ui-button--sm" href="/app/templates?tab=surfaces&template=srf-speaker-roster">
				Change how it looks
			</a>
		</div>
	</header>

	{#if error}<p class="lineup__error" role="alert">{error}</p>{/if}
	{#if loadError}
		<div class="lineup__load-error" role="alert">
			<p>{loadError}</p>
			<Button variant="secondary" size="sm" disabled={retrying} loading={retrying} onclick={retry}>
				Try again
			</Button>
		</div>
	{/if}
	<p class="ui-sr-only" role="status">{announcement}</p>

	<section class="card" aria-label="Speaker groups">
		<header class="card__head">
			<h3 class="card__title">Speaker groups</h3>
			{#if !addOpen}
				<Button variant="ghost" size="sm" onclick={openAdd}>
					<Plus size={14} aria-hidden="true" />New group
				</Button>
			{/if}
		</header>
		{#if categories === null}
			<p class="groups__line" aria-busy="true">
				<span class="ui-skeleton sk-chip"></span><span class="ui-skeleton sk-chip"></span>
			</p>
		{:else if categories.length === 0}
			<p class="groups__none">
				No groups yet — the lineup renders as one list, which is the right answer until a keynote
				needs to lead. Add a group to file people under headings.
			</p>
		{:else}
			<p class="groups__line">
				{#each categories as category (category.id)}
					<span class="ui-badge ui-badge--{category.accent}">
						{category.name}
						<span class="groups__count">{category.speakerCount}</span>
					</span>
				{/each}
			</p>
			<p class="groups__note">
				Groups appear in the order you add them. Everyone in no group is listed after them.
			</p>
		{/if}
		{#if addOpen}
			<form class="groups__form" onsubmit={addCategory}>
				<label class="ui-sr-only" for="lineup-new-group">Group name</label>
				<input
					id="lineup-new-group"
					class="ui-control groups__input"
					type="text"
					placeholder="Keynotes"
					maxlength="32"
					bind:this={newInput}
					bind:value={newName} />
				<Button type="submit" size="sm" disabled={!newName.trim()} loading={pending === 'add-category'}>
					Add
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onclick={() => {
						addOpen = false;
						newName = '';
					}}>Cancel</Button>
			</form>
		{/if}
	</section>

	<section class="card" aria-label="On the lineup">
		<header class="card__head">
			<h3 class="card__title">On the lineup</h3>
			<span class="card__count">{speakers ? shown.length : '–'}</span>
		</header>
		{#if !speakers}
			<ul class="lnrows" aria-busy="true">
				{#each Array(4) as _, index (index)}
					<li class="lnrow lnrow--fill" aria-hidden="true">
						<span class="lnrow__pos"><span class="ui-skeleton sk-line" style="inline-size: 1rem"></span></span>
						<span class="ui-avatar lnrow__mark ui-skeleton"></span>
						<span class="lnrow__who"><span class="ui-skeleton sk-line" style="inline-size: 9rem"></span></span>
						<span class="ui-skeleton sk-control lnrow__pick"></span>
						<span class="ui-skeleton sk-chip"></span>
					</li>
				{/each}
			</ul>
		{:else if shown.length === 0}
			<p class="lineup__empty">
				Nobody is on the public lineup yet. Publishing a speaker below puts them on the page — their
				biography follows once their content is approved.
			</p>
		{:else}
			<ul class="lnrows" use:rowDrag.container>
				{#each shown as row, index (row.id)}
					<li class="lnrow" animate:flip={{ duration: motionMs('normal') }}>
						<span class="lnrow__pos" aria-hidden="true">{index + 1}</span>
						<span class="ui-avatar lnrow__mark" aria-hidden="true">{initials(row.name)}</span>
						<span class="lnrow__who">
							<a class="lnrow__name" href={`/app/speakers?speaker=${row.rosterId}`}>{row.name}</a>
							{#if !row.contentApproved}
								{@const Pending = statusIcon.draft}
								<!-- The one fact about a published speaker that changes what a
								     visitor sees, said where the decision to publish is made. -->
								<span class="ui-badge ui-badge--neutral"
									><Pending class="ui-badge__icon" aria-hidden="true" />Bio not approved</span>
							{/if}
						</span>
						<!-- Group and actions travel together. `display: contents` at desktop
					     leaves the row's five columns exactly as they are; at touch width
					     the wrapper becomes the row's second line, which is the only way
					     one grid can be narrow-then-wide without squeezing the name. -->
						<span class="lnrow__tail">
							<span class="lnrow__group">
								<label class="ui-sr-only" for={`lineup-cat-${row.id}`}>
									Speaker group for {row.name}
								</label>
								<select
									id={`lineup-cat-${row.id}`}
									class="ui-select lnrow__pick"
									value={row.categoryId ?? ''}
									disabled={pending !== '' || (categories?.length ?? 0) === 0}
									onchange={(event) => assignCategory(row, event.currentTarget.value)}>
									<option value="">No group</option>
									{#each categories ?? [] as category (category.id)}
										<option value={category.id}>{category.name}</option>
									{/each}
								</select>
							</span>
							<span class="lnrow__actions">
									<Button
										variant="ghost"
										size="sm"
										disabled={pending !== ''}
										loading={pending === `vis-${row.id}`}
										onclick={() => setVisible(row, false)}>Take off</Button>
									<button
										type="button"
										class="ui-button ui-button--ghost ui-button--icon ui-button--sm ui-drag-handle lnrow__grip"
										aria-label={`Reorder ${row.name} — drag, or press the arrow keys`}
										disabled={pending !== ''}
										use:rowDrag.handle>
										<GripVertical size={14} aria-hidden="true" />
									</button>
								</span>
							</span>
						</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if speakers && hidden.length > 0}
		<section class="card" aria-label="Not on the lineup">
			<header class="card__head">
				<h3 class="card__title">Not on the lineup</h3>
				<span class="card__count">{hidden.length}</span>
			</header>
			<ul class="lnrows">
				{#each hidden as row (row.id)}
					<li class="lnrow lnrow--off">
						<span class="lnrow__pos" aria-hidden="true">—</span>
						<span class="ui-avatar lnrow__mark" aria-hidden="true">{initials(row.name)}</span>
						<span class="lnrow__who">
							<a class="lnrow__name" href={`/app/speakers?speaker=${row.rosterId}`}>{row.name}</a>
							<span class="lnrow__state">{engagementWords[row.state]}</span>
						</span>
						<span class="lnrow__tail">
							<span class="lnrow__group lnrow__group--quiet">{categoryName(row.categoryId)}</span>
							<span class="lnrow__actions">
								<Button
									variant="secondary"
									size="sm"
									disabled={pending !== ''}
									loading={pending === `vis-${row.id}`}
									onclick={() => setVisible(row, true)}>Put on the lineup</Button>
							</span>
						</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.lineup {
		display: grid;
		gap: var(--je-space-4);
	}

	.lineup__head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--je-space-3);
		margin-block-end: var(--je-space-2);
	}

	.lineup__intro {
		display: grid;
		gap: var(--je-space-1);
		min-inline-size: 0;
	}

	.lineup__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 650;
	}

	.lineup__copy {
		margin: 0;
		max-inline-size: 68ch;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.lineup__doors {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.lineup__error {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-danger);
	}

	.lineup__load-error {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-2);
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-danger);
		border-radius: var(--je-radius-control);
		background: var(--je-color-danger-soft);
		color: var(--je-color-danger);
	}

	.lineup__load-error p {
		margin: 0;
		font-size: var(--je-font-size-sm);
	}

	.card {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.card__head {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-block-size: var(--je-control-height-sm);
		margin-block-end: var(--je-space-2);
	}

	.card__title {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.card__count {
		margin-inline-start: auto;
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-muted);
	}

	.groups__line {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin: 0;
	}

	.groups__count {
		margin-inline-start: var(--je-space-1);
		font-variant-numeric: tabular-nums;
		opacity: 0.75;
	}

	.groups__note,
	.groups__none {
		margin: var(--je-space-2) 0 0;
		max-inline-size: 68ch;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.groups__form {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-3);
	}

	.groups__input {
		inline-size: auto;
		min-inline-size: 12rem;
	}

	/* Rows: position, person, group, actions. The container is positioned so the
	   drag indicator can place itself against it. */
	.lnrows {
		position: relative;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.lnrow {
		display: grid;
		grid-template-columns: 2ch max-content minmax(0, 1fr) max-content max-content;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
		padding: var(--je-space-2);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface);
	}

	.lnrow + .lnrow {
		border-block-start: 1px solid var(--je-color-border);
	}

	.lnrow--off {
		color: var(--je-color-text-muted);
	}

	.lnrow__pos {
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-muted);
		text-align: end;
	}

	.lnrow__mark {
		flex: none;
	}

	.lnrow__who {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-2);
		min-inline-size: 0;
	}

	.lnrow__name {
		font-weight: 600;
		color: var(--je-color-text);
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	.lnrow__name:hover {
		text-decoration: underline;
	}

	.lnrow__state {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Transparent at desktop: the row's five columns are exactly what they were
	   before the tail existed. It becomes a real box only at touch width. */
	.lnrow__tail {
		display: contents;
	}

	.lnrow__pick {
		inline-size: auto;
		min-inline-size: 9rem;
		height: var(--je-control-height-sm);
		font-size: var(--je-font-size-sm);
	}

	.lnrow__group--quiet {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.lnrow__actions {
		display: flex;
		align-items: center;
		gap: var(--je-space-1);
	}

	.lnrow__grip {
		touch-action: none;
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
		inline-size: 6.5rem;
	}

	.sk-control {
		display: block;
		block-size: var(--je-control-height-sm);
		inline-size: 9rem;
		border-radius: var(--je-radius-control);
	}

	.lineup__empty {
		margin: 0;
		max-inline-size: 68ch;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	@media (max-width: 780px) {
		/* The row becomes two lines rather than five squeezed columns: identity
		   first, then the controls that act on it. The tail carries both controls
		   as one grid item, because grid columns are shared down the whole list
		   and a select sitting in the position column would widen it for every
		   row — pushing every name across the screen. */
		.lnrow {
			grid-template-columns: 2ch max-content minmax(0, 1fr);
			grid-template-areas:
				'pos mark who'
				'tail tail tail';
			row-gap: var(--je-space-2);
		}

		.lnrow__pos {
			grid-area: pos;
		}

		.lnrow__mark {
			grid-area: mark;
		}

		.lnrow__who {
			grid-area: who;
		}

		.lnrow__tail {
			display: grid;
			grid-area: tail;
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: center;
			gap: var(--je-space-2);
			min-inline-size: 0;
			max-inline-size: 100%;
		}

		.lnrow__group {
			min-inline-size: 0;
			overflow-wrap: anywhere;
		}

		.lnrow__pick {
			inline-size: 100%;
			min-inline-size: 0;
			max-inline-size: 100%;
			height: var(--je-control-height-sm);
		}

		.lnrow__actions {
			flex-wrap: wrap;
			justify-content: flex-end;
			min-inline-size: 0;
		}

		.lnrow__actions :global(.ui-button) {
			min-block-size: var(--je-control-height-sm);
		}
	}
</style>
