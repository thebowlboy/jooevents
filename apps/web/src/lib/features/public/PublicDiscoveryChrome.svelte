<script lang="ts">
	import { createSettler } from '$lib/ui/settle';
	import type {
		FacetOption,
		SchedulePresentation,
		SessionResultCopy,
		SpeakerOrder,
		SpeakerPresentation
	} from './program-discovery';

	interface DayTab {
		readonly key: string;
		readonly label: string;
	}

	interface Props {
		kind: 'schedule' | 'speakers';
		search: string;
		onSearch: (value: string) => void;
		tracks?: readonly FacetOption[];
		formats?: readonly FacetOption[];
		rooms?: readonly FacetOption[];
		trackId?: string | null;
		formatId?: string | null;
		roomId?: string | null;
		onFacet?: (key: 'track' | 'format' | 'room', value: string | null) => void;
		days?: readonly DayTab[];
		selectedDayKey?: string | null;
		previousDayKey?: string | null;
		nextDayKey?: string | null;
		onDay?: (key: string | null) => void;
		schedulePresentation?: SchedulePresentation;
		speakerPresentation?: SpeakerPresentation;
		speakerOrder?: SpeakerOrder;
		onSchedulePresentation?: (value: SchedulePresentation) => void;
		onSpeakerPresentation?: (value: SpeakerPresentation) => void;
		onSpeakerOrder?: (value: SpeakerOrder) => void;
		result?: SessionResultCopy | null;
		backHref?: string | null;
		backLabel?: string;
		/** Off on a single-person profile so search cannot hide the person just opened. */
		browse?: boolean;
	}

	let {
		kind,
		search,
		onSearch,
		tracks = [],
		formats = [],
		rooms = [],
		trackId = null,
		formatId = null,
		roomId = null,
		onFacet,
		days = [],
		selectedDayKey = null,
		previousDayKey = null,
		nextDayKey = null,
		onDay,
		schedulePresentation = 'list',
		speakerPresentation = 'gallery',
		speakerOrder = 'lineup',
		onSchedulePresentation,
		onSpeakerPresentation,
		onSpeakerOrder,
		result = null,
		backHref = null,
		backLabel = 'Back to the lineup',
		browse = true
	}: Props = $props();

	let typed = $state('');
	const settler = createSettler();

	$effect(() => {
		typed = search;
	});

	$effect(() => () => settler.cancel());

	function queueSearch(value: string) {
		typed = value;
		settler.schedule(() => onSearch(value));
	}

	const searchLabel = $derived(kind === 'schedule' ? 'Search the program' : 'Search the lineup');
	const searchPlaceholder = $derived(
		kind === 'schedule' ? 'Search title or speaker name' : 'Search speaker name'
	);
	const searchHint = $derived(
		kind === 'schedule'
			? 'Searches session title and speaker name.'
			: 'Searches speaker name.'
	);
</script>

<div class="discover">
	{#if backHref}
		<p class="discover__back">
			<a class="discover__back-link" href={backHref}>{backLabel}</a>
		</p>
	{/if}

	{#if browse}
	<div class="discover__bar">
		<div class="discover__search">
			<label class="visually-hidden" for="public-discover-q">{searchLabel}</label>
			<input
				id="public-discover-q"
				class="ui-control"
				type="search"
				placeholder={searchPlaceholder}
				autocomplete="off"
				spellcheck="false"
				value={typed}
				aria-describedby="public-discover-hint"
				oninput={(event) => queueSearch(event.currentTarget.value)}
				onkeydown={(event) => {
					if (event.key !== 'Enter') return;
					event.preventDefault();
					settler.flush();
				}} />
		</div>

		{#if kind === 'schedule' && onFacet}
			{#if tracks.length > 0}
				<label class="discover__facet">
					<span class="discover__facet-label">Track</span>
					<select
						class="ui-select"
						aria-label="Filter by track"
						value={trackId ?? ''}
						onchange={(event) => onFacet('track', event.currentTarget.value || null)}>
						<option value="">All tracks</option>
						{#each tracks as track (track.id)}
							<option value={track.id}>{track.label}</option>
						{/each}
					</select>
				</label>
			{/if}
			{#if formats.length > 0}
				<label class="discover__facet">
					<span class="discover__facet-label">Format</span>
					<select
						class="ui-select"
						aria-label="Filter by format"
						value={formatId ?? ''}
						onchange={(event) => onFacet('format', event.currentTarget.value || null)}>
						<option value="">All formats</option>
						{#each formats as format (format.id)}
							<option value={format.id}>{format.label}</option>
						{/each}
					</select>
				</label>
			{/if}
			{#if rooms.length > 0}
				<label class="discover__facet">
					<span class="discover__facet-label">Room</span>
					<select
						class="ui-select"
						aria-label="Filter by room"
						value={roomId ?? ''}
						onchange={(event) => onFacet('room', event.currentTarget.value || null)}>
						<option value="">All rooms</option>
						{#each rooms as room (room.id)}
							<option value={room.id}>{room.label}</option>
						{/each}
					</select>
				</label>
			{/if}
		{/if}
	</div>

	<p id="public-discover-hint" class="discover__hint">{searchHint}</p>
	{/if}

	{#if browse && kind === 'schedule' && days.length > 0 && onDay}
		<div class="discover__days" role="group" aria-label="Program days">
			<button
				type="button"
				class="discover__chev"
				aria-label="Previous day"
				disabled={!previousDayKey}
				onclick={() => previousDayKey && onDay(previousDayKey)}>
				‹
			</button>
			<button
				type="button"
				class="discover__day"
				class:discover__day--active={selectedDayKey === null}
				aria-pressed={selectedDayKey === null}
				onclick={() => onDay(null)}>
				All days
			</button>
			{#each days as day (day.key)}
				<button
					type="button"
					class="discover__day"
					class:discover__day--active={selectedDayKey === day.key}
					aria-pressed={selectedDayKey === day.key}
					onclick={() => onDay(day.key)}>
					{day.label}
				</button>
			{/each}
			<button
				type="button"
				class="discover__chev"
				aria-label="Next day"
				disabled={!nextDayKey}
				onclick={() => nextDayKey && onDay(nextDayKey)}>
				›
			</button>
		</div>
	{/if}

	{#if browse}
	<div class="discover__present">
		{#if kind === 'schedule' && onSchedulePresentation}
			<div class="ui-segmented" role="group" aria-label="Schedule presentation">
				<button
					type="button"
					class="ui-segmented__item"
					aria-pressed={schedulePresentation === 'list'}
					onclick={() => onSchedulePresentation('list')}>
					List
				</button>
				<button
					type="button"
					class="ui-segmented__item"
					aria-pressed={schedulePresentation === 'agenda'}
					onclick={() => onSchedulePresentation('agenda')}>
					Agenda
				</button>
			</div>
		{/if}
		{#if kind === 'speakers' && onSpeakerPresentation}
			<div class="ui-segmented" role="group" aria-label="Speaker presentation">
				<button
					type="button"
					class="ui-segmented__item"
					aria-pressed={speakerPresentation === 'gallery'}
					onclick={() => onSpeakerPresentation('gallery')}>
					Gallery
				</button>
				<button
					type="button"
					class="ui-segmented__item"
					aria-pressed={speakerPresentation === 'list'}
					onclick={() => onSpeakerPresentation('list')}>
					List
				</button>
			</div>
		{/if}
		{#if kind === 'speakers' && onSpeakerOrder}
			<div class="ui-segmented" role="group" aria-label="Lineup order">
				<button
					type="button"
					class="ui-segmented__item"
					aria-pressed={speakerOrder === 'lineup'}
					onclick={() => onSpeakerOrder('lineup')}>
					Lineup order
				</button>
				<button
					type="button"
					class="ui-segmented__item"
					aria-pressed={speakerOrder === 'surname'}
					onclick={() => onSpeakerOrder('surname')}>
					By surname
				</button>
			</div>
		{/if}
	</div>
	{/if}

	{#if browse && result}
		<p class="discover__count" role="status">
			{result.headline}
			{#if result.scope}
				<span class="discover__scope">· searched {result.scope}</span>
			{/if}
		</p>
	{/if}
</div>

<style>
	.discover {
		container-type: inline-size;
		display: grid;
		gap: var(--je-space-3);
		min-inline-size: 0;
	}

	.discover__back {
		margin: 0;
	}

	.discover__back-link {
		color: var(--je-color-link);
		font-size: 0.9375rem;
		font-weight: 650;
		text-decoration: none;
		border-block-end: 1px solid color-mix(in srgb, currentColor 35%, transparent);
	}

	.discover__back-link:hover {
		border-block-end-color: currentColor;
	}

	.discover__bar {
		display: grid;
		gap: var(--je-space-2);
		min-inline-size: 0;
	}

	.discover__search {
		min-inline-size: 0;
	}

	.discover__facet {
		display: grid;
		gap: 0.2rem;
		min-inline-size: 0;
	}

	.discover__facet-label {
		font-size: 0.75rem;
		font-weight: 650;
		color: var(--je-color-text-muted);
	}

	.discover__hint {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--je-color-text-muted);
	}

	.discover__days {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		min-inline-size: 0;
	}

	.discover__day,
	.discover__chev {
		min-block-size: 2.75rem;
		min-inline-size: 2.75rem;
		padding-inline: 0.85rem;
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface);
		color: var(--je-color-text);
		font-size: 0.875rem;
		font-weight: 650;
		cursor: pointer;
	}

	.discover__day--active {
		border-color: var(--je-color-action);
		background: var(--je-color-action-soft);
		color: var(--je-color-action);
	}

	.discover__chev:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.discover__day:focus-visible,
	.discover__chev:focus-visible,
	.discover__back-link:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.discover__present {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		min-inline-size: 0;
	}

	.discover__present :global(.ui-segmented__item) {
		min-block-size: 2.5rem;
	}

	.discover__count {
		margin: 0;
		font-size: 0.875rem;
		color: var(--je-color-text);
	}

	.discover__scope {
		color: var(--je-color-text-muted);
	}

	.visually-hidden {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	@container (min-width: 40rem) {
		.discover__bar {
			grid-template-columns: minmax(0, 1.4fr) repeat(auto-fit, minmax(8.5rem, 1fr));
			align-items: end;
		}
	}

	@container (max-width: 20rem) {
		.discover__day,
		.discover__chev {
			min-inline-size: 0;
			padding-inline: 0.65rem;
		}
	}
</style>
