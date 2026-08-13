<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Field } from '$lib/ui';
	import type {
		EventProgramDraftRequest,
		EventProgramPort
	} from '$lib/api/event-program/port';
	import type {
		ProgramFormatView,
		ProgramRoomView,
		ProgramTrackView,
		ProgramVocabularyDraftView,
		ProgramVocabularySnapshotView
	} from '$lib/api/view-models/program-vocabulary';

	type VocabularyEntry = ProgramRoomView | ProgramTrackView | ProgramFormatView;
	type VocabularyKind = VocabularyEntry['kind'];

	interface Props {
		port: EventProgramPort;
		ondraft?: (draft: ProgramVocabularyDraftView) => void;
	}

	let { port, ondraft }: Props = $props();
	let snapshot = $state<ProgramVocabularySnapshotView | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let pending = $state('');
	let message = $state('');
	let names = $state<Record<string, string>>({});
	let capacities = $state<Record<string, number | null>>({});
	let addNames = $state<Record<VocabularyKind, string>>({ room: '', track: '', format: '' });
	let addCapacity = $state<number | null>(null);
	let mergeSources = $state<Partial<Record<VocabularyKind, string>>>({});
	let mergeTargets = $state<Partial<Record<VocabularyKind, string>>>({});
	const idempotencyKeys = new Map<string, string>();

	const groups = $derived(snapshot ? [
		{ kind: 'room' as const, label: 'Rooms', entries: snapshot.rooms,
			about: 'Where sessions happen. Capacity remains unknown until you set it.' },
		{ kind: 'track' as const, label: 'Tracks', entries: snapshot.tracks,
			about: 'Content lanes used by intake, review, and scheduling.' },
		{ kind: 'format' as const, label: 'Formats', entries: snapshot.formats,
			about: 'Session shapes used by submissions and the schedule.' }
	] : []);

	onMount(load);

	async function load() {
		loading = true;
		loadError = '';
		const result = await port.vocabulary.read();
		loading = false;
		if (result.kind === 'success') {
			snapshot = result.data;
			for (const entry of [...result.data.rooms, ...result.data.tracks, ...result.data.formats]) {
				names[entry.id] = entry.name;
				if (entry.kind === 'room') capacities[entry.id] = entry.capacity;
			}
			return;
		}
		loadError = result.kind === 'unavailable'
			? 'Program vocabulary is not available in this build.'
			: result.kind === 'outcome' && result.outcome.kind === 'program_vocabulary.event_required'
				? 'Create an event before adding rooms, tracks, or formats.'
				: 'Program vocabulary could not be loaded.';
	}

	function reviewedDraftError(
		result: Exclude<Awaited<ReturnType<EventProgramPort['vocabulary']['draft']>>, { kind: 'success' }>
	): string {
		if (result.kind === 'unavailable') return 'This draft operation is not available in this build.';
		if (result.kind === 'transport_error') {
			return result.error.retryable
				? 'The draft could not reach JooEvents. Try again when the connection is back.'
				: 'The draft request was not accepted.';
		}
		if (result.outcome.class === 'stale_revision') {
			return 'The vocabulary changed since this list loaded. Reload before drafting again.';
		}
		if (result.outcome.kind === 'program_vocabulary.delete_referenced') {
			return 'That item is still referenced and cannot be deleted.';
		}
		return 'JooEvents could not prepare that vocabulary draft.';
	}

	async function prepare(key: string, request: EventProgramDraftRequest) {
		pending = key;
		message = '';
		const replayKey = `${request.action}:${JSON.stringify(request.input)}`;
		const idempotencyKey = idempotencyKeys.get(replayKey) ?? crypto.randomUUID();
		idempotencyKeys.set(replayKey, idempotencyKey);
		try {
			const result = await port.vocabulary.draft(request, { idempotencyKey });
			if (result.kind === 'success') {
				message = 'Draft ready for review. The effective vocabulary has not changed.';
				ondraft?.(result.data);
				return;
			}
			message = reviewedDraftError(result);
		} finally {
			pending = '';
		}
	}

	function create(kind: VocabularyKind) {
		if (!snapshot) return;
		const name = addNames[kind].trim();
		if (!name) return;
		if (kind === 'room' && addCapacity !== null
			&& (!Number.isInteger(addCapacity) || addCapacity <= 0)) {
			message = 'Room capacity must be a positive whole number, or left unset.';
			return;
		}
		const request: EventProgramDraftRequest = kind === 'room'
			? { action: 'create', input: { kind, name, capacity: addCapacity,
				expectedSetVersion: snapshot.setVersion } }
			: { action: 'create', input: { kind, name, expectedSetVersion: snapshot.setVersion } };
		void prepare(`add-${kind}`, request);
	}

	function edit(entry: VocabularyEntry) {
		if (!snapshot) return;
		const name = (names[entry.id] ?? entry.name).trim();
		if (!name) return;
		const capacity = entry.kind === 'room' ? (capacities[entry.id] ?? null) : null;
		if (entry.kind === 'room' && capacity !== null
			&& (!Number.isInteger(capacity) || capacity <= 0)) {
			message = 'Room capacity must be a positive whole number, or left unset.';
			return;
		}
		const request: EventProgramDraftRequest = entry.kind === 'room'
			? { action: 'edit', input: {
				kind: entry.kind, id: entry.id, expectedSetVersion: snapshot.setVersion,
				expectedItemVersion: entry.version,
				changes: { name, capacity }
			} }
			: { action: 'edit', input: {
				kind: entry.kind, id: entry.id, expectedSetVersion: snapshot.setVersion,
				expectedItemVersion: entry.version, changes: { name }
			} };
		void prepare(`edit-${entry.id}`, request);
	}

	function lifecycle(action: 'retire' | 'restore' | 'delete', entry: VocabularyEntry) {
		if (!snapshot) return;
		const input = {
			kind: entry.kind,
			id: entry.id,
			expectedSetVersion: snapshot.setVersion,
			expectedItemVersion: entry.version
		};
		const request: EventProgramDraftRequest = action === 'retire'
			? { action, input }
			: action === 'restore' ? { action, input } : { action, input };
		void prepare(`${action}-${entry.id}`, request);
	}

	function merge(kind: VocabularyKind, entries: readonly VocabularyEntry[]) {
		if (!snapshot) return;
		const sourceId = mergeSources[kind];
		const targetId = mergeTargets[kind];
		const source = entries.find((entry) => entry.id === sourceId);
		const target = entries.find((entry) => entry.id === targetId);
		if (!source || !target || source.id === target.id) return;
		void prepare(`merge-${kind}`, {
			action: 'merge',
			input: {
				kind,
				sourceId: source.id,
				targetId: target.id,
				expectedSetVersion: snapshot.setVersion,
				expectedSourceVersion: source.version,
				expectedTargetVersion: target.version
			}
		});
	}

	function plural(count: number, singular: string): string {
		return `${count} ${singular}${count === 1 ? '' : 's'}`;
	}

	function deleteUnavailableCopy(entry: VocabularyEntry): string {
		if (entry.deleteAvailability.kind === 'available') return '';
		return `Delete unavailable: ${plural(entry.deleteAvailability.currentReferences, 'current reference')} and ${plural(entry.deleteAvailability.historicalPins, 'historical pin')} must remain resolvable. Retire or merge this item instead.`;
	}
</script>

<section class="vocabulary-panel" aria-labelledby="program-vocabulary-title" aria-busy={loading}>
	<header class="panel-header">
		<div>
			<h2 id="program-vocabulary-title">Program vocabulary</h2>
			<p>Rooms, tracks, and formats are shared references. Changes are prepared as reviewable drafts.</p>
		</div>
		{#if port.source.kind === 'sample'}
			<span class="sample-label">Sample · {port.source.label}</span>
		{/if}
	</header>

	<p class="status" role="status">{message}</p>
	{#if loading}
		<div class="loading" aria-label="Loading program vocabulary"></div>
	{:else if loadError}
		<div class="error-block">
			<p>{loadError}</p>
			<Button variant="secondary" size="sm" onclick={load}>Try again</Button>
		</div>
	{:else}
		<div class="groups">
			{#each groups as group (group.kind)}
				<section class="group" aria-labelledby={`vocabulary-${group.kind}`}>
					<div class="group-heading">
						<div>
							<h3 id={`vocabulary-${group.kind}`}>{group.label}</h3>
							<p>{group.about}</p>
						</div>
						<span>{group.entries.length}</span>
					</div>

					{#if group.entries.length === 0}
						<p class="empty">No {group.label.toLowerCase()} yet.</p>
					{:else}
						<ul class="entries">
							{#each group.entries as entry (entry.id)}
								<li class:retired={entry.status === 'retired'}>
									<div class="entry-fields">
										<Field id={`vocabulary-name-${entry.id}`} label={`${entry.kind} name`}>
											{#snippet children({ id, describedBy })}
										<input class="ui-control" type="text" maxlength="200" {id} aria-describedby={describedBy}
													disabled={pending !== ''} bind:value={names[entry.id]} />
											{/snippet}
										</Field>
										{#if entry.kind === 'room'}
											<Field id={`vocabulary-capacity-${entry.id}`} label="Seats" optional>
												{#snippet children({ id, describedBy })}
													<input class="ui-control" type="number" min="1" step="1" {id}
														aria-describedby={describedBy} disabled={pending !== ''}
														bind:value={capacities[entry.id]} />
												{/snippet}
											</Field>
										{/if}
									</div>
									<div class="entry-meta">
										<span class:retired-label={entry.status === 'retired'}>{entry.status}</span>
										<span>{entry.usage.currentReferences} current · {entry.usage.historicalPins} historical</span>
									</div>
									<div class="entry-actions">
										<Button variant="secondary" size="sm" loading={pending === `edit-${entry.id}`}
											disabled={pending !== ''} onclick={() => edit(entry)}>Draft change</Button>
										{#if entry.status === 'active'}
											<Button variant="ghost" size="sm" loading={pending === `retire-${entry.id}`}
												disabled={pending !== ''} onclick={() => lifecycle('retire', entry)}>Draft retirement</Button>
										{:else}
											<Button variant="ghost" size="sm" loading={pending === `restore-${entry.id}`}
												disabled={pending !== ''} onclick={() => lifecycle('restore', entry)}>Draft restore</Button>
										{/if}
									<Button variant="danger" size="sm" loading={pending === `delete-${entry.id}`}
										disabled={pending !== '' || entry.deleteAvailability.kind === 'unavailable'}
										aria-describedby={entry.deleteAvailability.kind === 'unavailable' ? `delete-note-${entry.id}` : undefined}
										onclick={() => lifecycle('delete', entry)}>Draft delete</Button>
								</div>
								{#if entry.deleteAvailability.kind === 'unavailable'}
									<p class="delete-note" id={`delete-note-${entry.id}`}>{deleteUnavailableCopy(entry)}</p>
								{/if}
								</li>
							{/each}
						</ul>
					{/if}

					<div class="add-row" class:add-room={group.kind === 'room'}>
						<Field id={`add-${group.kind}-name`} label={`New ${group.kind} name`}>
							{#snippet children({ id, describedBy })}
									<input class="ui-control" type="text" maxlength="200" {id} aria-describedby={describedBy}
									disabled={pending !== ''} bind:value={addNames[group.kind]} />
							{/snippet}
						</Field>
						{#if group.kind === 'room'}
							<Field id="add-room-capacity" label="Seats" optional>
								{#snippet children({ id, describedBy })}
									<input class="ui-control" type="number" min="1" step="1" {id}
										aria-describedby={describedBy} disabled={pending !== ''} bind:value={addCapacity} />
								{/snippet}
							</Field>
						{/if}
						<Button variant="secondary" size="sm" loading={pending === `add-${group.kind}`}
							disabled={pending !== '' || !addNames[group.kind].trim()}
							onclick={() => create(group.kind)}>Draft add</Button>
					</div>

					{#if group.entries.length >= 2}
						<div class="merge-row">
							<label>Merge from
								<select class="ui-control" disabled={pending !== ''} bind:value={mergeSources[group.kind]}>
									<option value="">Choose source</option>
									{#each group.entries as entry (entry.id)}<option value={entry.id}>{entry.name}</option>{/each}
								</select>
							</label>
							<label>Into
								<select class="ui-control" disabled={pending !== ''} bind:value={mergeTargets[group.kind]}>
									<option value="">Choose target</option>
									{#each group.entries as entry (entry.id)}<option value={entry.id}>{entry.name}</option>{/each}
								</select>
							</label>
							<Button variant="secondary" size="sm" loading={pending === `merge-${group.kind}`}
								disabled={pending !== '' || !mergeSources[group.kind] || !mergeTargets[group.kind]
									|| mergeSources[group.kind] === mergeTargets[group.kind]}
								onclick={() => merge(group.kind, group.entries)}>Draft merge</Button>
						</div>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
</section>

<style>
	.vocabulary-panel { min-block-size: 20rem; border: 1px solid var(--je-color-border); border-radius: var(--je-radius-md); background: var(--je-color-surface); }
	.panel-header { display: flex; justify-content: space-between; gap: var(--je-space-4); padding: var(--je-space-5); border-block-end: 1px solid var(--je-color-border); }
	h2, h3, p { margin-block-start: 0; }
	.panel-header h2 { margin-block-end: var(--je-space-1); font-size: var(--je-font-size-xl); }
	.panel-header p, .group-heading p { margin-block-end: 0; color: var(--je-color-text-muted); font-size: var(--je-font-size-sm); }
	.sample-label { align-self: start; padding: var(--je-space-1) var(--je-space-2); border-radius: var(--je-radius-round); background: var(--je-color-info-soft); color: var(--je-color-info); font-size: var(--je-font-size-xs); font-weight: 700; }
	.status { min-block-size: 1.25rem; margin: var(--je-space-3) var(--je-space-5) 0; color: var(--je-color-text-muted); font-size: var(--je-font-size-sm); }
	.groups { display: grid; gap: var(--je-space-5); padding: var(--je-space-5); }
	.group { display: grid; gap: var(--je-space-3); }
	.group + .group { padding-block-start: var(--je-space-5); border-block-start: 1px solid var(--je-color-border); }
	.group-heading { display: flex; justify-content: space-between; gap: var(--je-space-3); }
	.group-heading h3 { margin-block-end: var(--je-space-1); }
	.group-heading > span { color: var(--je-color-text-subtle); font-variant-numeric: tabular-nums; }
	.entries { display: grid; gap: var(--je-space-2); margin: 0; padding: 0; list-style: none; }
	.entries li { display: grid; grid-template-columns: minmax(12rem, 1fr) auto; gap: var(--je-space-2) var(--je-space-4); padding: var(--je-space-3); border: 1px solid var(--je-color-border); border-radius: var(--je-radius-sm); }
	.entries li.retired { background: var(--je-color-surface-sunken); }
	.entry-fields { display: grid; grid-template-columns: minmax(10rem, 1fr) minmax(6rem, .3fr); gap: var(--je-space-2); }
	.entry-meta { display: flex; align-items: center; justify-content: flex-end; gap: var(--je-space-2); color: var(--je-color-text-subtle); font-size: var(--je-font-size-xs); }
	.entry-meta > span:first-child { text-transform: capitalize; }
	.retired-label { color: var(--je-color-warning); }
	.entry-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: var(--je-space-2); }
	.delete-note { grid-column: 1 / -1; margin: 0; color: var(--je-color-text-muted); font-size: var(--je-font-size-xs); }
	.add-row, .merge-row { display: grid; grid-template-columns: minmax(12rem, 1fr) auto; gap: var(--je-space-2); align-items: end; padding: var(--je-space-3); border-radius: var(--je-radius-sm); background: var(--je-color-surface-sunken); }
	.add-row.add-room { grid-template-columns: minmax(12rem, 1fr) minmax(6rem, .3fr) auto; }
	.merge-row { grid-template-columns: repeat(2, minmax(10rem, 1fr)) auto; }
	.merge-row label { display: grid; gap: var(--je-space-1); color: var(--je-color-text-muted); font-size: var(--je-font-size-xs); font-weight: 700; }
	.empty { margin: 0; color: var(--je-color-text-subtle); font-size: var(--je-font-size-sm); }
	.loading { margin: var(--je-space-5); min-block-size: 14rem; border-radius: var(--je-radius-sm); background: var(--je-color-surface-sunken); }
	.error-block { margin: var(--je-space-5); padding: var(--je-space-4); border-radius: var(--je-radius-sm); background: var(--je-color-danger-soft); color: var(--je-color-danger); }
	@media (max-width: 48rem) {
		.panel-header { flex-direction: column; }
		.entries li, .add-row, .add-row.add-room, .merge-row { grid-template-columns: 1fr; }
		.entry-meta { justify-content: flex-start; }
		.entry-fields { grid-template-columns: 1fr; }
	}
</style>
