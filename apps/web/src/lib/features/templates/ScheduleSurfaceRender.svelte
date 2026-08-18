<script lang="ts">
	import { formatClock, formatClockRange, parseClockMinutes } from '@jooevents/contracts';
	import { themeStyleProperties } from '$lib/theme/theme-contract';
	import { excerpt, unitAttributes } from './inline-edit';
	import { compileTextStyle } from './text-style';
	import type {
		EventTheme,
		Placement,
		ScheduleState,
		SessionItem,
		SurfaceBlock,
		SurfaceTemplate,
		Track
	} from '$lib/api/types';

	type ScheduleDaysBlock = Extract<SurfaceBlock, { type: 'schedule-days' }>;

	interface Props {
		template: SurfaceTemplate;
		theme: EventTheme;
		eventName: string;
		/** e.g. "12–14 Oct 2026 · New York City"; empty hides the header and footer meta lines. */
		eventMeta: string;
		/**
		 * The real schedule state: the preview renders the scenario's actual
		 * program, joined from placements and sessions. Unplaced or still-
		 * collecting sessions never appear — the public surface shows the
		 * published program only.
		 */
		schedule: ScheduleState;
		/** Track vocabulary for names and accent families; unknown tracks render neutral. */
		tracks?: Track[];
		/**
		 * Renders the hero, note, and days-listing layout as addressable
		 * `data-edit` units for the template editor's click-to-edit host. Off by
		 * default so every other consumer of this preview stays inert.
		 */
		editable?: boolean;
		/**
		 * Whether the surface paints its own surroundings.
		 *
		 * `page` is the editor's preview: a muted backdrop standing in for the
		 * browser viewport around the published page. `bare` is what a host page
		 * gets — the page alone, because in an embed the surroundings belong to
		 * somebody else's site, and painting our own there is the one thing that
		 * makes an embed look bolted on rather than part of the page.
		 */
		frame?: 'page' | 'bare';
		/**
		 * Visitor presentation over the same released program. `list` is the
		 * chronological listing; `agenda` is the day/room grid. The published
		 * template is not rewritten.
		 */
		presentation?: 'list' | 'agenda';
		/** Address of one session's detail; absent keeps the listing inert. */
		sessionHref?: (sessionId: string) => string;
		selectedSessionId?: string | null;
		/** Replaces the unpublished-program empty copy when discovery matched nothing. */
		emptyCopy?: string;
	}

	let {
		template,
		theme,
		eventName,
		eventMeta,
		schedule,
		tracks = [],
		editable = false,
		frame = 'page',
		presentation = 'list',
		sessionHref,
		selectedSessionId = null,
		emptyCopy
	}: Props = $props();

	// The event brand is applied as custom properties on this component's root
	// only, so every --je-* consumption inside the preview resolves to the brand
	// while the surrounding operator app keeps its own theme untouched.
	const brandStyle = $derived(
		Object.entries(themeStyleProperties(theme))
			.map(([token, value]) => `${token}: ${value}`)
			.join('; ')
	);

	const markText = $derived(theme.markText || eventName.trim().charAt(0).toUpperCase());

	interface PlacedEntry {
		placement: Placement;
		session: SessionItem;
	}

	// Placed programmed sessions only: a still-collecting slot is never public program.
	const placed: PlacedEntry[] = $derived(
		schedule.placements.flatMap((placement) => {
			const session = schedule.sessions.find((entry) => entry.id === placement.sessionId);
			return session && session.state === 'programmed' ? [{ placement, session }] : [];
		})
	);

	const dayIndex = $derived(new Map(schedule.days.map((day, index) => [day.key, index])));

	function dayLabel(key: string): string {
		return schedule.days.find((day) => day.key === key)?.label ?? key;
	}

	function roomName(id: string): string {
		return schedule.rooms.find((room) => room.id === id)?.name ?? id;
	}

	function trackName(id: string): string {
		return tracks.find((track) => track.id === id)?.name ?? id;
	}

	function trackAccent(id: string): Track['accent'] {
		return tracks.find((track) => track.id === id)?.accent ?? 'neutral';
	}

	const dayStartMin = $derived(parseClockMinutes(schedule.dayStart) ?? 0);

	function clockLabel(offsetMin: number): string {
		return formatClock(dayStartMin + offsetMin);
	}

	function rangeLabel(entry: PlacedEntry): string {
		const from = dayStartMin + entry.placement.startMin;
		return formatClockRange(from, from + entry.session.durationMin);
	}

	function byProgramOrder(a: PlacedEntry, b: PlacedEntry): number {
		return (
			(dayIndex.get(a.placement.dayKey) ?? 0) - (dayIndex.get(b.placement.dayKey) ?? 0) ||
			a.placement.startMin - b.placement.startMin ||
			a.session.title.localeCompare(b.session.title)
		);
	}

	interface SessionGroup {
		key: string;
		label: string;
		/** Set on track groups: the heading renders as an accent chip. Null on day groups. */
		accent: Track['accent'] | null;
		items: PlacedEntry[];
	}

	const dayGroups: SessionGroup[] = $derived(
		schedule.days
			.map(
				(day): SessionGroup => ({
					key: day.key,
					label: day.label,
					accent: null,
					items: placed
						.filter((entry) => entry.placement.dayKey === day.key)
						.sort(byProgramOrder)
				})
			)
			.filter((group) => group.items.length > 0)
	);

	const trackGroups: SessionGroup[] = $derived.by(() => {
		// Vocabulary order first, then any trackId the vocabulary does not know
		// in first-seen program order, so every placed session has a home.
		const order: string[] = [];
		for (const track of tracks) {
			if (placed.some((entry) => entry.session.trackId === track.id)) order.push(track.id);
		}
		for (const entry of placed) {
			if (!order.includes(entry.session.trackId)) order.push(entry.session.trackId);
		}
		return order.map(
			(id): SessionGroup => ({
				key: id,
				label: trackName(id),
				accent: trackAccent(id),
				items: placed.filter((entry) => entry.session.trackId === id).sort(byProgramOrder)
			})
		);
	});

	interface RoomColumn {
		id: string;
		label: string;
		items: PlacedEntry[];
	}

	function roomsFor(group: SessionGroup): RoomColumn[] {
		const order: string[] = [];
		for (const room of schedule.rooms) {
			if (group.items.some((entry) => entry.placement.roomId === room.id)) order.push(room.id);
		}
		for (const entry of group.items) {
			if (!order.includes(entry.placement.roomId)) order.push(entry.placement.roomId);
		}
		return order.map((id) => ({
			id,
			label: roomName(id),
			items: group.items
				.filter((entry) => entry.placement.roomId === id)
				.sort(byProgramOrder)
		}));
	}

	/** The compact card's single meta line: day (when track-grouped) · time · room · speakers. */
	function compactMeta(entry: PlacedEntry, block: ScheduleDaysBlock, withDay: boolean): string {
		const parts = [
			withDay ? dayLabel(entry.placement.dayKey) : null,
			rangeLabel(entry),
			block.showRoom ? roomName(entry.placement.roomId) : null,
			block.showSpeakers && entry.session.speakers.length > 0
				? entry.session.speakers.map((speaker) => speaker.name).join(', ')
				: null
		];
		return parts.filter((part) => part !== null).join(' · ');
	}
</script>

{#snippet trackChip(trackId: string)}
	<span class="schedule__chip schedule__chip--{trackAccent(trackId)}">{trackName(trackId)}</span>
{/snippet}

{#snippet sessionTitle(entry: PlacedEntry)}
	{@const href = sessionHref?.(entry.session.id)}
	{@const current = selectedSessionId === entry.session.id}
	{#if href}
		<a
			class="schedule__session-title schedule__session-title--link"
			href={href}
			aria-current={current ? 'page' : undefined}>
			{entry.session.title}
		</a>
	{:else}
		<p class="schedule__session-title">{entry.session.title}</p>
	{/if}
{/snippet}

{#snippet sessionCard(entry: PlacedEntry, block: ScheduleDaysBlock, withDay: boolean)}
	<!-- When grouped by track, the group heading already names the track, so the
	     per-card chip is suppressed and the card gains its day instead. -->
	{@const showChip = block.showTrack && !withDay}
	{#if block.density === 'compact'}
		<article class="schedule__session schedule__session--compact">
			{@render sessionTitle(entry)}
			<p class="schedule__session-meta">
				<span>{compactMeta(entry, block, withDay)}</span>
				{#if showChip}{@render trackChip(entry.session.trackId)}{/if}
			</p>
		</article>
	{:else}
		<article class="schedule__session">
			<p class="schedule__when">
				{#if withDay}<span class="schedule__when-day">{dayLabel(entry.placement.dayKey)}</span
					>{/if}
				<span class="schedule__when-time">{rangeLabel(entry)}</span>
			</p>
			<div class="schedule__session-body">
				{@render sessionTitle(entry)}
				{#if block.showRoom || showChip}
					<p class="schedule__session-meta">
						{#if block.showRoom}<span>{roomName(entry.placement.roomId)}</span>{/if}
						{#if showChip}{@render trackChip(entry.session.trackId)}{/if}
					</p>
				{/if}
				{#if block.showSpeakers && entry.session.speakers.length > 0}
					<p class="schedule__session-speakers">
						{entry.session.speakers.map((speaker) => speaker.name).join(', ')}
					</p>
				{/if}
			</div>
		</article>
	{/if}
{/snippet}

<div class="schedule" class:schedule--bare={frame === 'bare'} style={brandStyle}>
	<article class="schedule__page">
		<header class="schedule__brand">
			{#if markText}<span class="schedule__mark" aria-hidden="true">{markText}</span>{/if}
			<div class="schedule__brand-lines">
				<span class="schedule__event">{eventName}</span>
				{#if eventMeta}<span class="schedule__dates">{eventMeta}</span>{/if}
			</div>
		</header>

		{#each template.blocks as block, index (index)}
			{#if block.type === 'hero'}
				<div class="schedule__hero">
					<p
						{...unitAttributes(editable, 'schedule__title', `blocks.${index}.title`, excerpt(block.title))}
						style={compileTextStyle('hero-title', block.titleStyle)}>
						{block.title}
					</p>
					{#if block.intro}
						<p
							{...unitAttributes(editable, 'schedule__intro', `blocks.${index}.intro`, excerpt(block.intro))}
							style={compileTextStyle('hero-intro', block.introStyle)}>
							{block.intro}
						</p>
					{/if}
				</div>
			{:else if block.type === 'schedule-days'}
				{@const groups = presentation === 'agenda' || block.grouping !== 'track' ? dayGroups : trackGroups}
				{@const daysClass = `schedule__days${block.density === 'compact' ? ' schedule__days--compact' : ''}`}
				<!-- One unit, the whole listing: a press edits its layout knobs
				     (grouping, density, what each card shows), not any one card. -->
				<div {...unitAttributes(editable, daysClass, `blocks.${index}`, 'Schedule layout', 'block')}>
					{#if groups.length === 0}
						<p class="schedule__empty">
							{emptyCopy ?? 'No sessions are on the published program yet.'}
						</p>
					{:else}
						{#each groups as group (group.key)}
							<div class="schedule__group">
								<p class="schedule__group-heading">
									{#if group.accent}
										<span class="schedule__chip schedule__chip--{group.accent}">{group.label}</span
										>
									{:else}
										{group.label}
									{/if}
								</p>
								{#if presentation === 'agenda'}
									<div class="schedule__agenda">
										{#each roomsFor(group) as column (column.id)}
											<div class="schedule__room">
												<p class="schedule__room-name">{column.label}</p>
												<div class="schedule__list">
													{#each column.items as entry (entry.session.id)}
														{@render sessionCard(entry, block, false)}
													{/each}
												</div>
											</div>
										{/each}
									</div>
								{:else}
									<div class="schedule__list">
										{#each group.items as entry (entry.session.id)}
											{@render sessionCard(entry, block, block.grouping === 'track')}
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					{/if}
				</div>
			{:else if block.type === 'note'}
				<p
					{...unitAttributes(editable, 'schedule__note', `blocks.${index}.text`, excerpt(block.text))}
					style={compileTextStyle('note', block.style)}>
					{block.text}
				</p>
			{/if}
		{/each}

		<footer class="schedule__footer">
			<p class="schedule__footer-event">{eventName}</p>
			{#if eventMeta}<p class="schedule__footer-meta">{eventMeta}</p>{/if}
		</footer>
	</article>
</div>

<style>
	/* The muted backdrop reads as a browser viewport around the published page,
	   tinted from the brand's own canvas so a wild recipe stays coherent. */
	.schedule {
		container-type: inline-size;
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-8) var(--je-space-4);
	}

	/*
	 * The page carries its own type scale, in px, and deliberately does not use
	 * the `--je-font-size-*` tokens the rest of the app runs on: those scale
	 * with the operator's density preference, which an attendee's browser never
	 * sees. This preview shows the artifact, not the app around it — the same
	 * rule EmailRender established. The page ground is the brand canvas, as the
	 * real public page renders on it, with sessions as surface cards.
	 */
	.schedule__page {
		display: grid;
		gap: var(--je-space-6);
		max-inline-size: 720px;
		margin-inline: auto;
		background: var(--je-color-canvas);
		color: var(--je-color-text);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		box-shadow: var(--je-shadow-sm);
		padding: var(--je-space-8) var(--je-space-6);
		font-family: var(--je-font-body);
		font-size: 16px;
		line-height: 1.5;
	}

	.schedule__brand {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		padding-block-end: var(--je-space-4);
		border-block-end: 1px solid var(--je-color-border);
	}

	.schedule__mark {
		display: grid;
		place-items: center;
		inline-size: 2.25rem;
		block-size: 2.25rem;
		flex-shrink: 0;
		background: var(--je-color-action);
		color: var(--je-color-action-contrast);
		border-radius: var(--je-radius-control);
		font-size: 0.875em;
		font-weight: 750;
		letter-spacing: 0.02em;
	}

	.schedule__brand-lines {
		display: grid;
		gap: 2px;
		min-inline-size: 0;
	}

	.schedule__event {
		font-size: 0.875em;
		font-weight: 650;
	}

	.schedule__dates {
		font-size: 0.8125em;
		color: var(--je-color-text-muted);
	}

	.schedule__hero {
		display: grid;
		gap: var(--je-space-2);
	}

	.schedule__title {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: 1.75em;
		font-weight: 700;
		line-height: var(--je-leading-tight);
		text-wrap: balance;
	}

	.schedule__intro {
		margin: 0;
		font-size: 1em;
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
		max-inline-size: 60ch;
	}

	.schedule__days {
		display: grid;
		gap: var(--je-space-6);
	}

	.schedule__days--compact {
		gap: var(--je-space-4);
	}

	.schedule__group {
		display: grid;
		gap: var(--je-space-3);
	}

	.schedule__days--compact .schedule__group {
		gap: var(--je-space-2);
	}

	.schedule__group-heading {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: 1.125em;
		font-weight: 700;
		line-height: var(--je-leading-snug);
	}

	.schedule__list {
		display: grid;
		gap: var(--je-space-3);
	}

	.schedule__days--compact .schedule__list {
		gap: var(--je-space-2);
	}

	.schedule__session {
		display: grid;
		grid-template-columns: 6.5rem minmax(0, 1fr);
		gap: var(--je-space-2) var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-4) var(--je-space-5);
	}

	.schedule__session--compact {
		grid-template-columns: minmax(0, 1fr);
		gap: 2px;
		padding: var(--je-space-2) var(--je-space-3);
	}

	.schedule__when {
		margin: 0;
		display: grid;
		gap: 2px;
		align-content: start;
	}

	.schedule__when-day {
		font-size: 0.8125em;
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.schedule__when-time {
		font-size: 0.875em;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}

	.schedule__session-body {
		display: grid;
		gap: var(--je-space-1);
		min-inline-size: 0;
	}

	.schedule__session-title {
		margin: 0;
		font-size: 1em;
		font-weight: 650;
		line-height: var(--je-leading-snug);
		overflow-wrap: anywhere;
	}

	.schedule__session-title--link {
		color: inherit;
		text-decoration: none;
		border-block-end: 1px solid color-mix(in srgb, currentColor 28%, transparent);
	}

	.schedule__session-title--link:hover {
		border-block-end-color: currentColor;
	}

	.schedule__session-title--link[aria-current='page'] {
		border-block-end-color: var(--je-color-action);
		color: var(--je-color-action);
	}

	.schedule__session-title--link:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.schedule__agenda {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--je-space-4);
		min-inline-size: 0;
	}

	.schedule__room {
		display: grid;
		align-content: start;
		gap: var(--je-space-2);
		min-inline-size: 0;
	}

	.schedule__room-name {
		margin: 0;
		font-size: 0.8125em;
		font-weight: 650;
		color: var(--je-color-text-muted);
	}

	@container (min-width: 40rem) {
		.schedule__agenda {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.schedule__agenda .schedule__session {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	@container (min-width: 60rem) {
		.schedule__agenda {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}

	.schedule__session--compact .schedule__session-title {
		font-size: 0.9375em;
	}

	.schedule__session-meta {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-2);
		font-size: 0.875em;
		color: var(--je-color-text-muted);
	}

	.schedule__session--compact .schedule__session-meta {
		font-size: 0.8125em;
	}

	.schedule__session-speakers {
		margin: 0;
		font-size: 0.875em;
		color: var(--je-color-text);
	}

	/*
	 * Track chips use the product's soft accent families, never status colors.
	 * The accent tokens deliberately come from outside the brand scope: track
	 * identity colors are product-stable, not outputs of the event's recipe —
	 * the real public page ships the same families. Sized in px because the
	 * chip sits inside em-scaled lines of different sizes.
	 */
	.schedule__chip {
		display: inline-flex;
		align-items: center;
		padding: 0.1em 0.7em;
		border-radius: 999px;
		font-family: var(--je-font-body);
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.01em;
		line-height: var(--je-leading-normal);
		white-space: nowrap;
	}

	.schedule__group-heading .schedule__chip {
		font-size: 13px;
		font-weight: 650;
		padding: 0.25em 0.85em;
	}

	.schedule__chip--lavender {
		background: var(--je-color-accent-lavender-soft);
		color: var(--je-color-accent-lavender-strong);
	}

	.schedule__chip--sea {
		background: var(--je-color-accent-sea-soft);
		color: var(--je-color-accent-sea-strong);
	}

	.schedule__chip--neutral {
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text-muted);
	}

	.schedule__note {
		margin: 0;
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-3) var(--je-space-4);
		font-size: 0.875em;
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.schedule__empty {
		margin: 0;
		font-size: 0.875em;
		color: var(--je-color-text-muted);
	}

	.schedule__footer {
		display: grid;
		gap: var(--je-space-1);
		padding-block-start: var(--je-space-4);
		border-block-start: 1px solid var(--je-color-border);
	}

	.schedule__footer-event {
		margin: 0;
		font-size: 0.875em;
		font-weight: 650;
	}

	.schedule__footer-meta {
		margin: 0;
		font-size: 0.8125em;
		color: var(--je-color-text-muted);
	}

	@media (max-width: 560px) {
		.schedule {
			padding: var(--je-space-4) var(--je-space-2);
		}

		.schedule__page {
			padding: var(--je-space-6) var(--je-space-4);
			gap: var(--je-space-5);
		}

		.schedule__session {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--je-space-1);
			padding: var(--je-space-3) var(--je-space-4);
		}

		.schedule__when {
			display: flex;
			flex-wrap: wrap;
			align-items: baseline;
			gap: var(--je-space-2);
		}
	}

	/*
	 * Bare: the page alone. Only the preview's own surroundings come off; every
	 * decision inside is unchanged.
	 */
	.schedule--bare {
		background: transparent;
		border: 0;
		border-radius: 0;
		padding: 0;
	}

	.schedule--bare .schedule__page {
		max-inline-size: none;
		box-shadow: none;
	}
</style>
