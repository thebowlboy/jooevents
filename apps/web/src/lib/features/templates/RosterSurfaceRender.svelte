<script lang="ts">
	import { themeStyleProperties } from '$lib/theme/theme-contract';
	import { excerpt, unitAttributes } from './inline-edit';
	import { compileTextStyle } from './text-style';
	import type {
		EmbedScope,
		EventTheme,
		PublicSpeakerCard,
		SpeakerCategory,
		SurfaceBlock,
		SurfaceTemplate
	} from '$lib/api/types';

	type RosterListBlock = Extract<SurfaceBlock, { type: 'roster-list' }>;

	interface Props {
		template: SurfaceTemplate;
		theme: EventTheme;
		eventName: string;
		/** e.g. "12–14 Oct 2026 · New York City"; empty hides the header and footer meta lines. */
		eventMeta: string;
		/**
		 * The public roster projection — already ordered, already filtered to who
		 * may be shown. The renderer narrows it by `scope` and never by any rule
		 * of its own: who is on the lineup is a roster decision, not a layout one.
		 */
		roster: PublicSpeakerCard[];
		/** The groups, in the order they appear. Unknown category ids render ungrouped. */
		categories?: SpeakerCategory[];
		/** Which slice of the roster this presentation shows. */
		scope?: EmbedScope;
		/** Renders the hero, note, and listing as addressable `data-edit` units for the editor. */
		editable?: boolean;
	/**
	 * Whether the surface paints its own surroundings.
	 *
	 * `page` is the editor's preview: a muted backdrop standing in for the
	 * browser viewport around the published page. `bare` is what a host page
	 * gets — the page alone, because in an embed the surroundings belong to
	 * somebody else's site and painting our own there is the single thing that
	 * makes an embed look bolted on.
	 */
	frame?: 'page' | 'bare';
		/**
		 * Visitor presentation over the same released lineup. Does not rewrite
		 * the published template; a speaker-scoped address still forces profile.
		 */
		layoutOverride?: RosterListBlock['layout'];
		/** Address of one person's profile; absent keeps cards inert. */
		speakerHref?: (speakerId: string) => string;
		/** Replaces the unannounced-lineup empty copy when discovery matched nothing. */
		emptyCopy?: string;
	}

	let {
		template,
		theme,
		eventName,
		eventMeta,
		roster,
		categories = [],
		scope = { kind: 'all' },
		editable = false,
		frame = 'page',
		layoutOverride,
		speakerHref,
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

	/**
	 * The people this presentation shows. `all` is the whole published roster;
	 * a category narrows it; a speaker scope resolves to exactly one card, or to
	 * none when that person is no longer published — in which case the surface
	 * says so rather than silently falling back to everybody.
	 */
	const shown = $derived.by<PublicSpeakerCard[]>(() => {
		if (scope.kind === 'category') {
			return roster.filter((card) => card.categoryId === scope.categoryId);
		}
		if (scope.kind === 'speaker') {
			return roster.filter((card) => card.id === scope.speakerId);
		}
		return roster;
	});

	/**
	 * A roster narrowed to one person renders as that person's profile, whatever
	 * layout the template carries. This is the surface's contract rather than a
	 * special case: `profile` *is* the single-person presentation, and a lone card
	 * sitting in a three-column grid would be the layout describing the template
	 * instead of the content.
	 */
	function effectiveLayout(block: RosterListBlock): RosterListBlock['layout'] {
		if (scope.kind === 'speaker') return 'profile';
		return layoutOverride ?? block.layout;
	}

	/**
	 * One person's card is a card, not a page: the brand header, the hero, the
	 * notes, and the footer are all things the *page* says, and on a partner's
	 * biography page they are three pieces of chrome wrapped around one card.
	 * Whoever put it there already supplied the context. An organizer who wants
	 * the event's framing embeds the lineup or a group instead — which is a
	 * different target in the picker, not a hidden setting.
	 */
	const onePerson = $derived(scope.kind === 'speaker');

	interface RosterGroup {
		key: string;
		label: string;
		accent: SpeakerCategory['accent'] | null;
		items: PublicSpeakerCard[];
	}

	/**
	 * The listing's groups. Category order is the vocabulary's order; within a
	 * group people keep their roster position, which the projection already
	 * applied. Anyone in no group, or in a group this event no longer has, lands
	 * in a trailing unnamed group so nobody can be lost by a vocabulary edit.
	 */
	function groupsFor(block: RosterListBlock): RosterGroup[] {
		if (block.grouping === 'none' || effectiveLayout(block) === 'profile') {
			return [{ key: 'all', label: '', accent: null, items: shown }];
		}
		const named = categories
			.map((category) => ({
				key: category.id,
				label: category.name,
				accent: category.accent,
				items: shown.filter((card) => card.categoryId === category.id)
			}))
			.filter((group) => group.items.length > 0);
		const grouped = new Set(named.flatMap((group) => group.items.map((card) => card.id)));
		const rest = shown.filter((card) => !grouped.has(card.id));
		// A single ungrouped remainder beside no named group is just the list; it
		// gains a heading only when there is something for it to be beside.
		if (rest.length > 0) {
			named.push({
				key: 'ungrouped',
				label: named.length > 0 ? 'Also speaking' : '',
				accent: 'neutral',
				items: rest
			});
		}
		return named;
	}

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) return '?';
		const first = parts[0].charAt(0);
		const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
		return `${first}${last}`.toUpperCase();
	}

	/** What a card says under the name when its content is not approved yet. */
	const provisionalLine = 'Biography to be announced.';
</script>

{#snippet avatar(card: PublicSpeakerCard, size: 'sm' | 'md' | 'lg')}
	<span class="roster__avatar roster__avatar--{size}" aria-hidden="true">{initials(card.name)}</span>
{/snippet}

{#snippet links(card: PublicSpeakerCard)}
	{#if card.links.length > 0}
		<p class="roster__links">
			{#each card.links as link (link.href)}
				<!-- A published page links out; the embed carries no tracking and no
				     referrer beyond what a plain link sends. -->
				<a class="roster__link" href={link.href} rel="noopener noreferrer" target="_blank">
					{link.label}
				</a>
			{/each}
		</p>
	{/if}
{/snippet}

{#snippet sessions(card: PublicSpeakerCard)}
	{#if card.sessions.length > 0}
		<p class="roster__sessions">
			{#each card.sessions as session, index (session.id)}
				{#if index > 0}<span class="roster__sessions-sep" aria-hidden="true"></span>{/if}<span
					class="roster__session">{session.title}</span>
			{/each}
		</p>
	{/if}
{/snippet}

{#snippet personName(card: PublicSpeakerCard, className: string)}
	{@const href = speakerHref?.(card.id)}
	{#if href}
		<a class="{className} roster__person-link" href={href}>{card.name}</a>
	{:else}
		<p class={className}>{card.name}</p>
	{/if}
{/snippet}

{#snippet personCard(card: PublicSpeakerCard, block: RosterListBlock, layout: RosterListBlock['layout'])}
	{#if layout === 'strip'}
		{#if speakerHref}
			<a class="roster__strip-item roster__strip-item--link" href={speakerHref(card.id)}>
				{@render avatar(card, 'sm')}
				<span class="roster__strip-name">{card.name}</span>
			</a>
		{:else}
			<span class="roster__strip-item">
				{@render avatar(card, 'sm')}
				<span class="roster__strip-name">{card.name}</span>
			</span>
		{/if}
	{:else if layout === 'profile'}
		<article class="roster__profile">
			{@render avatar(card, 'lg')}
			<div class="roster__profile-body">
				<p class="roster__profile-name">{card.name}</p>
				{#if block.showHeadline}
					<p class="roster__headline" class:roster__headline--tba={card.provisional}>
						{card.provisional ? provisionalLine : (card.headline ?? '')}
					</p>
				{/if}
				{#if card.biography}<p class="roster__biography">{card.biography}</p>{/if}
				{#if card.location}<p class="roster__location">{card.location}</p>{/if}
				{#if block.showSessions}{@render sessions(card)}{/if}
				{#if block.showLinks}{@render links(card)}{/if}
			</div>
		</article>
	{:else if layout === 'list'}
		{#if speakerHref && !block.showLinks}
			<a class="roster__row roster__row--link" href={speakerHref(card.id)}>
				{@render avatar(card, 'md')}
				<div class="roster__row-body">
					<p class="roster__name">{card.name}</p>
					{#if block.showHeadline}
						<p class="roster__headline" class:roster__headline--tba={card.provisional}>
							{card.provisional ? provisionalLine : (card.headline ?? '')}
						</p>
					{/if}
					{#if block.showSessions}{@render sessions(card)}{/if}
				</div>
			</a>
		{:else}
			<article class="roster__row">
				{@render avatar(card, 'md')}
				<div class="roster__row-body">
					{@render personName(card, 'roster__name')}
					{#if block.showHeadline}
						<p class="roster__headline" class:roster__headline--tba={card.provisional}>
							{card.provisional ? provisionalLine : (card.headline ?? '')}
						</p>
					{/if}
					{#if block.showSessions}{@render sessions(card)}{/if}
					{#if block.showLinks}{@render links(card)}{/if}
				</div>
			</article>
		{/if}
	{:else if speakerHref && !block.showLinks}
		<a class="roster__card roster__card--link" href={speakerHref(card.id)}>
			{@render avatar(card, 'md')}
			<p class="roster__name">{card.name}</p>
			{#if block.showHeadline}
				<p class="roster__headline" class:roster__headline--tba={card.provisional}>
					{card.provisional ? provisionalLine : (card.headline ?? '')}
				</p>
			{/if}
			{#if block.showSessions}{@render sessions(card)}{/if}
		</a>
	{:else}
		<article class="roster__card">
			{@render avatar(card, 'md')}
			{@render personName(card, 'roster__name')}
			{#if block.showHeadline}
				<p class="roster__headline" class:roster__headline--tba={card.provisional}>
					{card.provisional ? provisionalLine : (card.headline ?? '')}
				</p>
			{/if}
			{#if block.showSessions}{@render sessions(card)}{/if}
			{#if block.showLinks}{@render links(card)}{/if}
		</article>
	{/if}
{/snippet}

<div class="roster" class:roster--bare={frame === 'bare'} style={brandStyle}>
	<article class="roster__page" class:roster__page--card={onePerson}>
		{#if !onePerson}
			<header class="roster__brand">
				{#if markText}<span class="roster__mark" aria-hidden="true">{markText}</span>{/if}
				<div class="roster__brand-lines">
					<span class="roster__event">{eventName}</span>
					{#if eventMeta}<span class="roster__dates">{eventMeta}</span>{/if}
				</div>
			</header>
		{/if}

		{#each template.blocks as block, index (index)}
			{#if onePerson && block.type !== 'roster-list'}
				<!-- Nothing: one person's card is a card, not a page. -->
			{:else if block.type === 'hero'}
				<div class="roster__hero">
					<p
						{...unitAttributes(editable, 'roster__title', `blocks.${index}.title`, excerpt(block.title))}
						style={compileTextStyle('hero-title', block.titleStyle)}>
						{block.title}
					</p>
					{#if block.intro}
						<p
							{...unitAttributes(editable, 'roster__intro', `blocks.${index}.intro`, excerpt(block.intro))}
							style={compileTextStyle('hero-intro', block.introStyle)}>
							{block.intro}
						</p>
					{/if}
				</div>
			{:else if block.type === 'roster-list'}
				{@const layout = effectiveLayout(block)}
				{@const groups = groupsFor(block)}
				{@const listClass = `roster__listing roster__listing--${block.density}`}
				<!-- One unit, the whole listing: a press edits its layout knobs
				     (grid/list/strip, grouping, what each card shows), not any one
				     person — people are roster records, edited on the roster. -->
				<div {...unitAttributes(editable, listClass, `blocks.${index}`, 'Roster layout', 'block')}>
					{#if shown.length === 0}
						<p class="roster__empty">
							{#if emptyCopy}
								{emptyCopy}
							{:else if scope.kind === 'speaker'}
								This speaker is not on the published lineup.
							{:else if scope.kind === 'category'}
								Nobody is filed under this group yet.
							{:else}
								The lineup is not announced yet.
							{/if}
						</p>
					{:else}
						{#each groups as group (group.key)}
							<div class="roster__group">
								{#if group.label}
									<p class="roster__group-heading">
										<span class="roster__chip roster__chip--{group.accent ?? 'neutral'}">
											{group.label}
										</span>
									</p>
								{/if}
								<div class="roster__items roster__items--{layout}">
									{#each group.items as card (card.id)}
										{@render personCard(card, block, layout)}
									{/each}
								</div>
							</div>
						{/each}
					{/if}
				</div>
			{:else if block.type === 'note'}
				<p
					{...unitAttributes(editable, 'roster__note', `blocks.${index}.text`, excerpt(block.text))}
					style={compileTextStyle('note', block.style)}>
					{block.text}
				</p>
			{/if}
		{/each}

		{#if !onePerson}
			<footer class="roster__footer">
				<p class="roster__footer-event">{eventName}</p>
				{#if eventMeta}<p class="roster__footer-meta">{eventMeta}</p>{/if}
			</footer>
		{/if}
	</article>
</div>

<style>
	/*
	 * The muted backdrop reads as a browser viewport around the published page,
	 * tinted from the brand's own canvas so a wild recipe stays coherent.
	 *
	 * It is also the **query container**, and that is the load-bearing line for
	 * embedding: every responsive decision below is made against *this box* —
	 * the box a host page hands the embed — and never against the viewport. It
	 * is why the same markup composes in a 300px sidebar and in a 1100px content
	 * column of the same site, which is the whole difference between an embed
	 * that fits anywhere and one that only fits where it was designed. A
	 * container cannot query its own size, so this sits one level above the page.
	 */
	.roster {
		container-type: inline-size;
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-8) var(--je-space-4);
	}

	/*
	 * The page carries its own type scale, in px, and deliberately does not use
	 * the `--je-font-size-*` tokens the rest of the app runs on: those scale with
	 * the operator's density preference, which a visitor's browser never sees.
	 * This is the artifact, not the app around it.
	 */
	.roster__page {
		display: grid;
		gap: var(--je-space-6);
		max-inline-size: 900px;
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


	/* One card carries no page furniture, so it also carries none of the page's
	   own padding — the card's border is the whole edge. */
	.roster__page--card {
		padding: 0;
		background: transparent;
		border: 0;
		box-shadow: none;
	}

	.roster__brand {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		padding-block-end: var(--je-space-4);
		border-block-end: 1px solid var(--je-color-border);
	}

	.roster__mark {
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

	.roster__brand-lines {
		display: grid;
		gap: 2px;
		min-inline-size: 0;
	}

	.roster__event {
		font-size: 0.875em;
		font-weight: 650;
	}

	.roster__dates {
		font-size: 0.8125em;
		color: var(--je-color-text-muted);
	}

	.roster__hero {
		display: grid;
		gap: var(--je-space-2);
	}

	.roster__title {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: 1.75em;
		font-weight: 700;
		line-height: var(--je-leading-tight);
		text-wrap: balance;
	}


	.roster__intro {
		margin: 0;
		font-size: 1em;
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
		max-inline-size: 60ch;
	}

	.roster__listing {
		display: grid;
		gap: var(--je-space-6);
	}

	.roster__listing--compact {
		gap: var(--je-space-4);
	}

	.roster__group {
		display: grid;
		gap: var(--je-space-3);
	}

	.roster__listing--compact .roster__group {
		gap: var(--je-space-2);
	}

	.roster__group-heading {
		margin: 0;
	}

	/* Group chips borrow the product's soft accent families, never status colors.
	   Sized in px because a chip sits inside em-scaled lines of several sizes. */
	.roster__chip {
		display: inline-flex;
		align-items: center;
		padding: 0.25em 0.85em;
		border-radius: 999px;
		font-family: var(--je-font-body);
		font-size: 13px;
		font-weight: 650;
		letter-spacing: 0.01em;
		line-height: var(--je-leading-normal);
		white-space: nowrap;
	}


	.roster__chip--lavender {
		background: var(--je-color-accent-lavender-soft);
		color: var(--je-color-accent-lavender-strong);
	}

	.roster__chip--sea {
		background: var(--je-color-accent-sea-soft);
		color: var(--je-color-accent-sea-strong);
	}

	.roster__chip--neutral {
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text-muted);
	}

	/* ---------------------------------------------------------------------
	   Layouts. One column is the floor for every one of them: a 300px sidebar
	   is a real place to put this, and it must read there before it reads
	   anywhere wider. Columns are added by container width, never by viewport. */

	.roster__items {
		display: grid;
		gap: var(--je-space-3);
	}

	.roster__items--grid {
		grid-template-columns: minmax(0, 1fr);
	}

	@container (min-width: 30rem) {
		.roster__items--grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@container (min-width: 48rem) {
		.roster__items--grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}

	.roster__items--strip {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2) var(--je-space-3);
	}

	/* Cards in one grid row share a height, so their content packs to the top
	   rather than distributing: a person with no biography must not have their
	   name floating in the middle of a card sized by the person beside them. */
	.roster__card {
		display: grid;
		align-content: start;
		justify-items: start;
		gap: var(--je-space-2);
		min-inline-size: 0;
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-4) var(--je-space-5);
	}

	.roster__listing--compact .roster__card {
		gap: var(--je-space-1);
		padding: var(--je-space-3) var(--je-space-4);
	}

	.roster__row {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		align-items: start;
		gap: var(--je-space-2) var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-4) var(--je-space-5);
	}

	.roster__listing--compact .roster__row {
		padding: var(--je-space-2) var(--je-space-3);
	}

	.roster__row-body {
		display: grid;
		gap: var(--je-space-1);
		min-inline-size: 0;
	}

	.roster__profile {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		justify-items: start;
		gap: var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-6);
	}

	@container (min-width: 30rem) {
		.roster__profile {
			grid-template-columns: max-content minmax(0, 1fr);
			align-items: start;
		}
	}

	.roster__profile-body {
		display: grid;
		gap: var(--je-space-2);
		min-inline-size: 0;
	}

	.roster__profile-name {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: 1.5em;
		font-weight: 700;
		line-height: var(--je-leading-snug);
	}


	.roster__strip-item {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-2);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: 999px;
		padding: 0.25em 0.85em 0.25em 0.3em;
		min-inline-size: 0;
	}

	.roster__strip-name {
		font-size: 0.9375em;
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	/* ---------------------------------------------------------------------
	   Card contents */

	.roster__avatar {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		border-radius: 999px;
		background: var(--je-color-action-soft);
		color: var(--je-color-action);
		font-weight: 700;
		letter-spacing: 0.02em;
	}

	.roster__avatar--sm {
		inline-size: 1.5rem;
		block-size: 1.5rem;
		font-size: 0.6875em;
	}

	.roster__avatar--md {
		inline-size: 2.5rem;
		block-size: 2.5rem;
		font-size: 0.8125em;
	}

	.roster__avatar--lg {
		inline-size: 4rem;
		block-size: 4rem;
		font-size: 1.125em;
	}

	.roster__name {
		margin: 0;
		font-size: 1em;
		font-weight: 650;
		line-height: var(--je-leading-snug);
		overflow-wrap: anywhere;
	}

	.roster__person-link {
		color: inherit;
		text-decoration: none;
		border-block-end: 1px solid color-mix(in srgb, currentColor 28%, transparent);
	}

	.roster__person-link:hover,
	.roster__strip-item--link:hover {
		border-block-end-color: currentColor;
	}

	.roster__strip-item--link {
		color: inherit;
		text-decoration: none;
	}

	.roster__avatar-link {
		color: inherit;
		text-decoration: none;
		border-radius: 999px;
	}

	.roster__card--link,
	.roster__row--link {
		color: inherit;
		text-decoration: none;
	}

	.roster__card--link:hover,
	.roster__row--link:hover {
		border-color: color-mix(in srgb, var(--je-color-action) 45%, var(--je-color-border));
	}

	.roster__card--link:focus-visible,
	.roster__row--link:focus-visible,
	.roster__person-link:focus-visible,
	.roster__strip-item--link:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.roster__headline {
		margin: 0;
		font-size: 0.875em;
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
		overflow-wrap: anywhere;
	}

	/* An unapproved card says what is missing in the same place the biography
	   would be, rather than leaving a gap that reads as a rendering fault. */
	.roster__headline--tba {
		font-style: italic;
	}

	.roster__location {
		margin: 0;
		font-size: 0.8125em;
		color: var(--je-color-text-muted);
	}

	.roster__biography {
		margin: 0;
		white-space: pre-line;
		line-height: var(--je-leading-relaxed);
		color: var(--je-color-text);
		overflow-wrap: anywhere;
	}

	.roster__sessions {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-1) var(--je-space-2);
		font-size: 0.875em;
	}

	/* Session titles are separate records, so they get a structural divider
	   rather than the interpunct that joins one item's own attributes. */
	.roster__sessions-sep {
		display: inline-block;
		inline-size: 1px;
		block-size: 0.9em;
		background: var(--je-color-border-strong);
	}

	.roster__session {
		overflow-wrap: anywhere;
	}

	.roster__links {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-1) var(--je-space-3);
		font-size: 0.8125em;
	}

	.roster__link {
		color: var(--je-color-link);
		text-decoration: none;
		border-block-end: 1px solid color-mix(in srgb, currentColor 35%, transparent);
	}

	.roster__link:hover {
		border-block-end-color: currentColor;
	}


	.roster__note {
		margin: 0;
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-3) var(--je-space-4);
		font-size: 0.875em;
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.roster__empty {
		margin: 0;
		font-size: 0.875em;
		color: var(--je-color-text-muted);
	}

	.roster__footer {
		display: grid;
		gap: var(--je-space-1);
		padding-block-start: var(--je-space-4);
		border-block-start: 1px solid var(--je-color-border);
	}

	.roster__footer-event {
		margin: 0;
		font-size: 0.875em;
		font-weight: 650;
	}

	.roster__footer-meta {
		margin: 0;
		font-size: 0.8125em;
		color: var(--je-color-text-muted);
	}

	/* The page's own padding is the one thing that answers to how small the box
	   is rather than to how small the window is — a card embedded in a narrow
	   column should not spend a third of its width on gutters. */
	@container (max-width: 26rem) {
		.roster__page {
			padding: var(--je-space-5) var(--je-space-4);
			gap: var(--je-space-5);
		}

		.roster__card,
		.roster__row,
		.roster__profile {
			padding: var(--je-space-3) var(--je-space-4);
		}
	}

	@media (max-width: 560px) {
		.roster {
			padding: var(--je-space-4) var(--je-space-2);
		}
	}

	/*
	 * Bare: the page alone. The container declaration stays — every responsive
	 * decision inside is still made against the box the host hands us — and only
	 * the preview's own surroundings come off.
	 */
	.roster--bare {
		background: transparent;
		border: 0;
		border-radius: 0;
		padding: 0;
	}

	.roster--bare .roster__page {
		max-inline-size: none;
		box-shadow: none;
	}
</style>
