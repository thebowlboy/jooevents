<script lang="ts">
	/**
	 * The vocabulary the program is built from: rooms, tracks, and formats. Each
	 * list is headed and described in its own words, and every row states what
	 * already points at it before offering to remove it.
	 */
	import { onMount, tick } from 'svelte';
	import { Button, Field } from '$lib/ui';
	import { presentProgramRoomCapacity } from '$lib/api/program-vocabulary-presentation';
	import type { SettingsPagePort } from '$lib/api/settings-page-port';
	import { removalBlockReason, usageLabel, type VocabKind } from '$lib/api/vocab';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import type {
		Format,
		MutationOutcome,
		Room,
		Track,
		VocabStatus,
		VocabUsage
	} from '$lib/api/types';

	let {
		port,
		loading = false
	}: { readonly port: SettingsPagePort; readonly loading?: boolean } = $props();

	/** One list row: what it is, what points at it, and what may be done to it. */
	interface VocabEntry {
		kind: VocabKind;
		id: string;
		label: string;
		status: VocabStatus;
		usage: VocabUsage;
		/** Row detail the entry carries beyond its name, e.g. a room's capacity. */
		meta?: string;
		/** Why deletion is unavailable; empty while deletion is offered. */
		blockReason: string;
	}

	const kindNoun: Record<VocabKind, string> = { room: 'room', track: 'track', format: 'format' };

	/**
	 * Each list is headed and described in its own words. Both the waiting and
	 * the resolved panel read this, so the heading a person starts reading is
	 * the heading they keep.
	 */
	const vocabOrder: VocabKind[] = ['room', 'track', 'format'];
	const vocabGroups: Record<VocabKind, { label: string; about: string }> = {
		room: {
			label: 'Rooms',
			about: 'Where sessions happen. Capacity and equipment drive scheduling conflicts.'
		},
		track: {
			label: 'Tracks',
			about:
				'Content lanes you group talks into. Route reviewers, balance the program, color the schedule.'
		},
		format: {
			label: 'Formats',
			about: 'Session shapes and their default lengths — how long each kind of session runs.'
		}
	};

	let rooms = $state<Room[]>([]);
	let tracks = $state<Track[]>([]);
	let formats = $state<Format[]>([]);

	let newRoomName = $state('');
	let newRoomCapacity = $state<number | null>(null);
	let newTrackName = $state('');
	let newFormatName = $state('');
	/** Entry id, or `add-*`, of the vocabulary call currently in flight. */
	let vocabPending = $state('');
	let vocabRefusals = $state<Record<string, string>>({});
	let vocabMessage = $state('');
	/** Entry id whose row menu is open; one at a time. */
	let vocabMenu = $state('');
	/** Entry id whose unavailable delete has been asked to explain itself. */
	let vocabExplained = $state('');

	onMount(() => {
		if (!loading) void loadVocab();
	});

	/** Usage travels with every entry, so the lists are re-read as a set. */
	export async function reload() {
		await loadVocab();
	}

	async function loadVocab() {
		const [roomRows, trackRows, formatRows] = await Promise.all([
			port.vocab.rooms(),
			port.vocab.tracks(),
			port.vocab.formats()
		]);
		rooms = roomRows;
		tracks = trackRows;
		formats = formatRows;
	}

	function entryOf(
		kind: VocabKind,
		source: { id: string; name: string; status: VocabStatus; usage: VocabUsage },
		meta?: string
	): VocabEntry {
		return {
			kind,
			id: source.id,
			label: source.name,
			status: source.status,
			usage: source.usage,
			meta,
			blockReason: removalBlockReason(kind, source.usage, source.status) ?? ''
		};
	}

	/**
	 * Per-kind wiring for the three identical row operations. The API call and
	 * the local list update travel together so a row can be handled without the
	 * caller knowing which list it came from.
	 */
	const vocabOps: Record<
		VocabKind,
		{
			remove: (id: string) => Promise<MutationOutcome>;
			retire: (id: string) => Promise<MutationOutcome>;
			restore: (id: string) => Promise<MutationOutcome>;
			drop: (id: string) => void;
			mark: (id: string, status: VocabStatus) => void;
		}
	> = {
		room: {
			remove: (id) => port.vocab.removeRoom(id),
			retire: (id) => port.vocab.retireRoom(id),
			restore: (id) => port.vocab.restoreRoom(id),
			drop: (id) => (rooms = rooms.filter((room) => room.id !== id)),
			mark: (id, status) =>
				(rooms = rooms.map((room) => (room.id === id ? { ...room, status } : room)))
		},
		track: {
			remove: (id) => port.vocab.removeTrack(id),
			retire: (id) => port.vocab.retireTrack(id),
			restore: (id) => port.vocab.restoreTrack(id),
			drop: (id) => (tracks = tracks.filter((track) => track.id !== id)),
			mark: (id, status) =>
				(tracks = tracks.map((track) => (track.id === id ? { ...track, status } : track)))
		},
		format: {
			remove: (id) => port.vocab.removeFormat(id),
			retire: (id) => port.vocab.retireFormat(id),
			restore: (id) => port.vocab.restoreFormat(id),
			drop: (id) => (formats = formats.filter((format) => format.id !== id)),
			mark: (id, status) =>
				(formats = formats.map((format) => (format.id === id ? { ...format, status } : format)))
		}
	};

	const roomEntries: VocabEntry[] = $derived(
		rooms.map((room) => entryOf('room', room, presentProgramRoomCapacity(room.capacity).label))
	);
	const trackEntries: VocabEntry[] = $derived(tracks.map((track) => entryOf('track', track)));
	const formatEntries: VocabEntry[] = $derived(formats.map((format) => entryOf('format', format)));

	const roomReady = $derived(
		newRoomName.trim().length > 0 && newRoomCapacity !== null && newRoomCapacity > 0
	);
	const trackReady = $derived(newTrackName.trim().length > 0);
	const formatReady = $derived(newFormatName.trim().length > 0);

	function clearRefusal(map: Record<string, string>, id: string): Record<string, string> {
		return Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));
	}

	/**
	 * Pressing a control marked unavailable is the question "why not?", and it
	 * is answered without attempting anything: the row states the reason and
	 * the live region carries the same words to assistive technology.
	 */
	function explainUnavailable(entry: VocabEntry) {
		vocabExplained = entry.id;
		vocabMessage = entry.blockReason;
	}

	async function removeEntry(entry: VocabEntry) {
		if (vocabPending) return;
		vocabPending = entry.id;
		vocabMessage = '';
		vocabRefusals = clearRefusal(vocabRefusals, entry.id);
		const outcome = await vocabOps[entry.kind].remove(entry.id);
		if (outcome.ok) {
			vocabOps[entry.kind].drop(entry.id);
			recordAction({
				area: 'settings',
				label: `Deleted ${kindNoun[entry.kind]} “${entry.label}”`,
				notUndoableReason: 'Nothing referenced it, so it is gone — add it again to reuse the name.'
			});
		} else {
			// The client offered a delete the server refused: a race, a stale
			// list, or another actor. The reason pins to the row it belongs to.
			vocabRefusals = { ...vocabRefusals, [entry.id]: outcome.reason };
			vocabMessage = outcome.reason;
		}
		vocabPending = '';
	}

	async function setEntryStatus(entry: VocabEntry, status: VocabStatus) {
		if (vocabPending) return;
		vocabMenu = '';
		vocabPending = entry.id;
		vocabMessage = '';
		vocabRefusals = clearRefusal(vocabRefusals, entry.id);
		const ops = vocabOps[entry.kind];
		const outcome = await (status === 'retired' ? ops.retire(entry.id) : ops.restore(entry.id));
		if (outcome.ok) {
			ops.mark(entry.id, status);
			// The control that was pressed is replaced by its inverse, so focus
			// follows the operation to where it now lives.
			tick().then(() => {
				const next = status === 'retired' ? 'vocab-restore' : 'vocab-more';
				document.getElementById(`${next}-${entry.id}`)?.focus();
			});
			recordAction({
				area: 'settings',
				label: `${status === 'retired' ? 'Retired' : 'Restored'} ${kindNoun[entry.kind]} “${entry.label}”`,
				undo: async () => {
					await (status === 'retired' ? ops.restore(entry.id) : ops.retire(entry.id));
				}
			});
		} else {
			vocabRefusals = { ...vocabRefusals, [entry.id]: outcome.reason };
			vocabMessage = outcome.reason;
		}
		vocabPending = '';
	}

	async function addEntry(
		kind: VocabKind,
		call: () => Promise<Room | Track | Format>,
		clear: () => void
	) {
		vocabPending = `add-${kind}`;
		vocabMessage = '';
		const created = await call();
		clear();
		await loadVocab();
		recordAction({
			area: 'settings',
			label: `Added ${kindNoun[kind]} “${created.name}”`,
			undo: async () => {
				await vocabOps[kind].remove(created.id);
			}
		});
		vocabPending = '';
	}

	function addRoom(submitEvent: SubmitEvent) {
		submitEvent.preventDefault();
		if (!roomReady || vocabPending) return;
		const name = newRoomName.trim();
		const capacity = newRoomCapacity ?? 0;
		addEntry('room', () => port.vocab.addRoom(name, capacity), () => {
			newRoomName = '';
			newRoomCapacity = null;
		});
	}

	function addTrack(submitEvent: SubmitEvent) {
		submitEvent.preventDefault();
		if (!trackReady || vocabPending) return;
		const name = newTrackName.trim();
		addEntry('track', () => port.vocab.addTrack(name), () => (newTrackName = ''));
	}

	function addFormat(submitEvent: SubmitEvent) {
		submitEvent.preventDefault();
		if (!formatReady || vocabPending) return;
		const name = newFormatName.trim();
		addEntry('format', () => port.vocab.addFormat(name), () => (newFormatName = ''));
	}

	// A row menu is dismissible from anywhere: Escape returns focus to its own
	// trigger, a press elsewhere simply closes it.
	function onWindowKeydown(keyEvent: KeyboardEvent) {
		if (keyEvent.key !== 'Escape' || !vocabMenu) return;
		const trigger = document.getElementById(`vocab-more-${vocabMenu}`);
		vocabMenu = '';
		trigger?.focus();
	}

	function onWindowPointerdown(pointerEvent: PointerEvent) {
		if (!vocabMenu) return;
		const target = pointerEvent.target as HTMLElement | null;
		if (!target?.closest('.entry__menu')) vocabMenu = '';
	}
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerdown} />

{#snippet entryList(labelId: string, items: VocabEntry[])}
	{#if items.length === 0}
		<p class="entries__none">None yet</p>
	{:else}
		<ul class="entries" aria-labelledby={labelId}>
			{#each items as item (item.id)}
				{@const refusal = vocabRefusals[item.id] ?? ''}
				<li
					class="entry"
					class:entry--menu={vocabMenu === item.id}
					class:entry--explained={vocabExplained === item.id}>
					<div class="entry__row">
						<span class="entry__text">
							<span class="entry__name">
								{item.label}
								{#if item.status === 'retired'}<span class="entry__state">retired</span>{/if}
							</span>
							<span class="entry__meta"
								>{item.meta ? `${item.meta} · ` : ''}{usageLabel(item.kind, item.usage)}</span>
						</span>
						<span class="entry__actions">
							{#if item.blockReason}
								<!-- Deletion would be refused, so it is not offered — the control
								     keeps its place and its reason instead of disappearing.
								     `aria-disabled` rather than `disabled`: the reason has to stay
								     reachable by keyboard. -->
								<button
									type="button"
									class="ui-button ui-button--secondary ui-button--sm"
									aria-label={`Delete ${item.label}`}
									aria-disabled="true"
									aria-describedby={`vocab-note-${item.id}`}
									onclick={() => explainUnavailable(item)}>Delete</button>
							{:else}
								<Button
									variant="secondary"
									size="sm"
									aria-label={`Delete ${item.label}`}
									disabled={vocabPending !== ''}
									loading={vocabPending === item.id}
									onclick={() => removeEntry(item)}>Delete</Button>
							{/if}
							{#if item.status === 'retired'}
								<Button
									id={`vocab-restore-${item.id}`}
									variant="secondary"
									size="sm"
									aria-label={`Restore ${item.label}`}
									disabled={vocabPending !== ''}
									loading={vocabPending === item.id}
									onclick={() => setEntryStatus(item, 'active')}>Restore</Button>
							{:else}
								<span
									class="entry__menu"
									onfocusout={(focusEvent) => {
										if (!focusEvent.currentTarget.contains(focusEvent.relatedTarget as Node))
											vocabMenu = '';
									}}>
									<button
										type="button"
										id={`vocab-more-${item.id}`}
										class="ui-button ui-button--ghost ui-button--sm entry__more"
										aria-label={`More actions for ${item.label}`}
										aria-expanded={vocabMenu === item.id}
										aria-controls={`vocab-menu-${item.id}`}
										onclick={() => (vocabMenu = vocabMenu === item.id ? '' : item.id)}
										>More</button>
									{#if vocabMenu === item.id}
										<span class="entry__pop" id={`vocab-menu-${item.id}`}>
											<button
												type="button"
												class="ui-button ui-button--ghost ui-button--sm entry__pop-item"
												aria-label={`Retire ${item.label}`}
												onclick={() => setEntryStatus(item, 'retired')}>Retire</button>
										</span>
									{/if}
								</span>
							{/if}
						</span>
					</div>
					{#if refusal || item.blockReason}
						<!-- One slot, two arrivals: the standing explanation of an
						     unavailable delete, or the reason a refused attempt came back
						     with. A refusal is an event and stays put; the explanation is
						     context and shows with the control it belongs to. -->
						<p
							class="entry__note"
							class:entry__note--refused={refusal}
							id={`vocab-note-${item.id}`}>
							{refusal || item.blockReason}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#snippet fieldFill(labelWidth: string)}
	<div class="ui-field">
		<div class="ui-field__heading">
			<span class="ui-label"><span class="ui-skeleton skeleton-line" style="inline-size: {labelWidth}"></span></span>
		</div>
		<span class="ui-skeleton skeleton-control"></span>
	</div>
{/snippet}

{#if loading}
	<section class="panel" id="settings-program-basics" aria-label="Loading program basics">
		<header class="panel__head">
			<div class="panel__title"><h2>Program basics</h2></div>
		</header>
		<div class="vocab">
			{#each vocabOrder as kind (kind)}
				<div class="vocab__group">
					<!-- Group names and their descriptions are certain, so they render as
					     themselves; only the entries and the add form are waiting. -->
					<h3 class="vocab__label">{vocabGroups[kind].label}</h3>
					<p class="vocab__about">{vocabGroups[kind].about}</p>
					<ul class="entries" aria-hidden="true">
						{#each Array(3) as _entry, entryIndex (entryIndex)}
							<li class="entry">
								<div class="entry__row">
									<span class="entry__text">
										<span class="entry__name"><span class="ui-skeleton skeleton-line" style="inline-size: 7rem"></span></span>
										<span class="entry__meta"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></span>
									</span>
									<span class="entry__actions"><span class="ui-skeleton skeleton-action skeleton-action--sm"></span></span>
								</div>
							</li>
						{/each}
					</ul>
					<div class="add" aria-hidden="true">
						<div class="add__fields" class:add__fields--room={kind === 'room'}>
							{@render fieldFill('6rem')}
							{#if kind === 'room'}{@render fieldFill('3rem')}{/if}
						</div>
						<span class="ui-skeleton skeleton-action"></span>
					</div>
				</div>
			{/each}
		</div>
	</section>
{:else}
	<section class="panel" id="settings-program-basics" aria-label="Program basics">
		<header class="panel__head">
			<div class="panel__title">
				<h2>Program basics</h2>
				<!-- The row itself shows the result; this carries it to assistive tech. -->
				<p class="ui-sr-only" role="status">{vocabMessage}</p>
			</div>
		</header>

		<div class="vocab">
			<div class="vocab__group">
				<h3 class="vocab__label" id="vocab-rooms">{vocabGroups.room.label}</h3>
				<p class="vocab__about">{vocabGroups.room.about}</p>
				{@render entryList('vocab-rooms', roomEntries)}
				<form class="add" onsubmit={addRoom}>
					<div class="add__fields add__fields--room">
						<Field id="new-room-name" label="Room name">
							{#snippet children({ id, describedBy })}
								<input
									class="ui-control"
									type="text"
									{id}
									aria-describedby={describedBy}
									disabled={vocabPending !== ''}
									bind:value={newRoomName} />
							{/snippet}
						</Field>
						<Field id="new-room-capacity" label="Seats">
							{#snippet children({ id, describedBy })}
								<input
									class="ui-control"
									type="number"
									min="1"
									step="1"
									{id}
									aria-describedby={describedBy}
									disabled={vocabPending !== ''}
									bind:value={newRoomCapacity} />
							{/snippet}
						</Field>
					</div>
					<Button
						type="submit"
						variant="secondary"
						size="sm"
						disabled={!roomReady || vocabPending !== ''}
						loading={vocabPending === 'add-room'}>Add room</Button>
				</form>
			</div>

			<div class="vocab__group">
				<h3 class="vocab__label" id="vocab-tracks">{vocabGroups.track.label}</h3>
				<p class="vocab__about">{vocabGroups.track.about}</p>
				{@render entryList('vocab-tracks', trackEntries)}
				<form class="add" onsubmit={addTrack}>
					<div class="add__fields">
						<Field id="new-track-name" label="Track name">
							{#snippet children({ id, describedBy })}
								<input
									class="ui-control"
									type="text"
									{id}
									aria-describedby={describedBy}
									disabled={vocabPending !== ''}
									bind:value={newTrackName} />
							{/snippet}
						</Field>
					</div>
					<Button
						type="submit"
						variant="secondary"
						size="sm"
						disabled={!trackReady || vocabPending !== ''}
						loading={vocabPending === 'add-track'}>Add track</Button>
				</form>
			</div>

			<div class="vocab__group">
				<h3 class="vocab__label" id="vocab-formats">{vocabGroups.format.label}</h3>
				<p class="vocab__about">{vocabGroups.format.about}</p>
				{@render entryList('vocab-formats', formatEntries)}
				<form class="add" onsubmit={addFormat}>
					<div class="add__fields">
						<Field id="new-format-name" label="Format name">
							{#snippet children({ id, describedBy })}
								<input
									class="ui-control"
									type="text"
									{id}
									aria-describedby={describedBy}
									disabled={vocabPending !== ''}
									bind:value={newFormatName} />
							{/snippet}
						</Field>
					</div>
					<Button
						type="submit"
						variant="secondary"
						size="sm"
						disabled={!formatReady || vocabPending !== ''}
						loading={vocabPending === 'add-format'}>Add format</Button>
				</form>
			</div>
		</div>
	</section>
{/if}

<style>
	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, a control and an action are
	   control-height. Free-standing sized rectangles drift; these cannot. */
	.skeleton-line {
		display: inline-block;
		block-size: 1em;
		/* One line box exactly: the line inherits the height it stands in for. */
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.skeleton-control {
		display: block;
		block-size: var(--je-control-height);
		border-radius: var(--je-radius-control);
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 6.5rem;
		border-radius: var(--je-radius-control);
		/* Sits on the line bottom: an empty fill has no baseline of its own, and
		   the descender space under one would deepen the row it stands in. */
		vertical-align: bottom;
	}

	.skeleton-action--sm {
		inline-size: 4.5rem;
	}

	.panel {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.panel__head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: var(--je-space-2) var(--je-space-4);
		margin-block-end: var(--je-space-4);
	}

	.panel__title {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.panel__head h2 {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.vocab {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--je-space-6);
	}

	.vocab__group {
		display: grid;
		align-content: start;
		gap: var(--je-space-3);
	}

	.vocab__label {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.vocab__about {
		margin: calc(var(--je-space-2) * -1) 0 0;
		max-inline-size: 46ch;
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.entries {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.entries__none {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* The row is its own positioning context: the menu and the reason belong to
	   it and must not move the rows underneath. */
	.entry {
		position: relative;
	}

	.entry__row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--je-space-2);
		padding-block: var(--je-space-1);
		border-block-end: 1px solid var(--je-color-border-subtle);
	}

	/* Name and usage take one line each, always: a row that sometimes fits both
	   on one line has two heights, and the waiting shell can only mirror one. */
	.entry__text {
		display: grid;
		gap: 2px;
		min-inline-size: 0;
	}

	.entry__name {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-1) var(--je-space-2);
		font-size: var(--je-font-size-md);
		font-weight: 500;
	}

	/* Retirement is a quiet fact about the entry, not a status that needs a
	   badge's weight beside a name. */
	.entry__state {
		font-size: var(--je-font-size-2xs);
		font-weight: 650;
		letter-spacing: var(--je-tracking-caps);
		text-transform: uppercase;
		color: var(--je-color-text-subtle);
	}

	/* Tabular figures are alignment machinery, not emphasis: these usage counts
	   change under the reader, and proportional digits make the sentence around
	   them jitter on refresh. The figures stay at the line's own ink — they are
	   evidence read once, not a column being compared. */
	.entry__meta {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.entry__actions {
		display: flex;
		align-items: center;
		gap: var(--je-space-1);
	}

	.entry__menu {
		position: relative;
		display: inline-flex;
	}

	/* Retire is a real but rare operation, so it lives behind the row's own
	   menu; the trigger appears when the row is hovered or holds focus, and
	   stands permanently where there is no hover. It keeps its place in the row
	   and in the tab order the whole time — a trigger that took its space only
	   when revealed would push the delete beside it sideways under the pointer. */
	.entry__more {
		opacity: 0;
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	.entry:hover .entry__more,
	.entry:focus-within .entry__more {
		opacity: 1;
	}

	/* An absolutely positioned box shrink-to-fits against its containing block,
	   and that block here is the trigger — so the menu inherited the width of the
	   word "More" and crushed the padding off any longer item inside it.
	   max-content sizes the menu to its own content instead; anchored to the row's
	   end, it grows inward, away from the viewport edge. */
	.entry__pop {
		position: absolute;
		z-index: 7;
		inset-block-start: calc(100% + var(--je-space-1));
		inset-inline-end: 0;
		display: grid;
		inline-size: max-content;
		padding: var(--je-space-1);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-md);
	}

	.entry__pop-item {
		justify-content: start;
	}

	/* The explanation an unavailable delete carries: always in the document so
	   the control can point at it, and never taking a row's space until it is
	   asked for — the count beside the name is what stands permanently. */
	.entry__note {
		position: absolute;
		margin: 0;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}

	/* With a pointer it reads beside the control on hover or focus, floating
	   over the row below rather than pushing the list around under the cursor.

	   Two rules keep it from reading as a blocked row. It is inset from the
	   leading edge, so a strip of the row underneath stays visible and the panel
	   reads as something laid over the list rather than as the list's new
	   contents. And it never takes the pointer: a positioned child keeps its
	   ancestor in `:hover`, so an explanation that accepted the cursor pinned its
	   own row open and made the row beneath genuinely unreachable. The panel
	   holds no controls, so nothing is lost by passing the pointer through — the
	   row below hovers the moment the cursor is over it, and answers for
	   itself. */
	@media (hover: hover) {
		.entry:not(.entry--menu):hover .entry__note:not(.entry__note--refused),
		.entry:not(.entry--menu):focus-within .entry__note:not(.entry__note--refused) {
			z-index: 6;
			pointer-events: none;
			inset-block-start: calc(100% - var(--je-space-1));
			inset-inline: var(--je-space-6) 0;
			inline-size: auto;
			block-size: auto;
			overflow: visible;
			clip-path: none;
			padding: var(--je-space-2) var(--je-space-3);
			border: 1px solid var(--je-color-border-strong);
			border-radius: var(--je-radius-control);
			background: var(--je-color-surface);
			box-shadow: var(--je-shadow-md);
			font-size: var(--je-font-size-sm);
			color: var(--je-color-text-muted);
		}
	}

	/* Without hover, pressing the control is how the question gets asked, and
	   the answer stays in that row until another row is asked. Standing the
	   same sentence under every used row would be a wall, not an explanation. */
	@media (hover: none) {
		.entry__more {
			opacity: 1;
		}

		.entry--explained .entry__note:not(.entry__note--refused) {
			position: static;
			inline-size: auto;
			block-size: auto;
			overflow: visible;
			clip-path: none;
			margin: var(--je-space-1) 0 0;
			font-size: var(--je-font-size-xs);
			color: var(--je-color-text-muted);
		}
	}

	/* A refused attempt is an event, not standing context: it states its reason
	   where the entry is and stays until the next attempt. */
	.entry__note--refused {
		position: static;
		inline-size: auto;
		block-size: auto;
		overflow: visible;
		clip-path: none;
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-danger);
	}

	.add {
		display: grid;
		justify-items: start;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-1);
	}

	.add__fields {
		display: grid;
		gap: var(--je-space-2);
		inline-size: 100%;
	}

	.add__fields--room {
		grid-template-columns: minmax(0, 1fr) 6rem;
	}

	@media (max-width: 920px) {
		.vocab {
			grid-template-columns: 1fr;
			gap: var(--je-space-8);
		}
	}
</style>
