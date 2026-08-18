<script module lang="ts">
	/** The comparison slices a line-up can be read through. */
	export type SliceKey = 'track' | 'all';

	export const sliceKeys = ['track', 'all'] as const;
</script>

<script lang="ts">
	/**
	 * One committed review read against the rest of my own scoring.
	 *
	 * A standing mark says where a score sits in the crowd; it cannot say whether
	 * *I* score consistently. That question is only answerable by putting my
	 * reviews beside each other, so this composition anchors on one of them and
	 * lines the others up in the same card: same fields, same order, same score
	 * treatment. Difference in the cards is difference in the reviews.
	 *
	 * Every card can be revised, the anchor included: the anchor is the review a
	 * person came here to settle, and the whole point of having the comparison in
	 * view is being able to act on what it shows without leaving it. A revision is
	 * attributable — the card keeps a badge saying it changed after the reveal, and
	 * the receipt can put the old score back.
	 *
	 * The scope it compares is not its own: the anchor and the slice arrive as
	 * props, so the same panel serves the addressable route and the modal opened
	 * over the review queue, and both keep that scope in the URL.
	 */
	import { onMount } from 'svelte';
	import { Flame, Gem, Star, Zap } from 'lucide-svelte';
	import { ClampedText, TrackChip, situationIcon, trackPending } from '$lib/ui';
	import type { IconComponent } from '$lib/ui';
	import type { ReviewPagePort } from '$lib/api/review-page-port';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import StandingMark from '$lib/features/workspace/components/StandingMark.svelte';
	import type {
		AccoladeDef,
		AccoladeKey,
		ComparableCard,
		MyReviewItem,
		ScoreStanding
	} from '$lib/api/types';

	interface Props {
		port: ReviewPagePort;
		/** The committed review everything else is read against; null has nothing to compare. */
		anchorId: string | null;
		slice: SliceKey;
		onSliceChange: (next: SliceKey) => void;
		/** The panel's own heading, omitted where the surface already names itself. */
		heading?: string;
		/** Which scrollport the sticky reference sticks inside. */
		surface?: 'page' | 'modal';
		/** A review changed here; surfaces showing the same review keep in step. */
		onReviewChange?: (item: MyReviewItem) => void;
	}

	let {
		port,
		anchorId,
		slice,
		onSliceChange,
		heading,
		surface = 'page',
		onReviewChange
	}: Props = $props();

	const api = $derived(port);

	const slices: { key: SliceKey; label: string }[] = [
		{ key: 'track', label: 'Same track' },
		{ key: 'all', label: 'All my reviews' }
	];

	const accoladeIcon: Record<AccoladeKey, IconComponent> = {
		top_pick: Star,
		hidden_gem: Gem,
		crowd_draw: Flame,
		bold_bet: Zap
	};

	let trackNames = $state<Record<string, string>>({});
	let trackOrder = $state<string[]>([]);
	let accoladeDefs = $state<AccoladeDef[]>([]);
	let vocabLoaded = $state(false);

	let anchor = $state<ComparableCard | null>(null);
	let anchorResolved = $state(false);

	let comparables = $state<ComparableCard[]>([]);
	let listLoaded = $state(false);

	let revisingId = $state<string | null>(null);
	let revisionScore = $state<number | undefined>(undefined);
	let committingId = $state<string | null>(null);

	// Switching slice re-reads a list that is already on screen, so it dims in
	// place rather than collapsing back to skeletons: the cards a person was
	// reading stay where they are until the new set lands.
	let sliceReloading = $state(false);
	const sliceReload = trackPending(() => sliceReloading);

	onMount(async () => {
		const [tracks, defs] = await Promise.all([api.vocab.tracks(), api.review.accoladeDefs()]);
		trackNames = Object.fromEntries(tracks.map((track) => [track.id, track.name]));
		trackOrder = tracks.map((track) => track.id);
		accoladeDefs = defs;
		vocabLoaded = true;
	});

	/* Both loads are keyed by the scope and guarded by a token, so an anchor or
	   slice changed mid-flight cannot be overwritten by the request it replaced. */
	let anchorRequest = 0;
	$effect(() => {
		const id = anchorId;
		const token = (anchorRequest += 1);
		anchor = null;
		anchorResolved = false;
		if (!id) {
			anchorResolved = true;
			return;
		}
		void (async () => {
			const [queue, submission, standing] = await Promise.all([
				api.review.myQueue(),
				api.submissions.get(id),
				api.review.standing(id)
			]);
			if (token !== anchorRequest) return;
			const item = queue.find((entry) => entry.submissionId === id);
			// Only a committed review can anchor a comparison: an unfinished one is
			// a draft opinion, and lining other reviews up against it would invite
			// the anchoring the review plan exists to prevent.
			anchor =
				item && item.committed && submission
					? { item: { ...item }, submission, standing }
					: null;
			anchorResolved = true;
		})();
	});

	// Plain mirrors, deliberately not reactive: they decide whether a load is a
	// first load or a reload, and reading them reactively here would make this
	// effect depend on its own writes.
	let hasList = false;
	let listAnchor: string | null = null;
	let listRequest = 0;
	$effect(() => {
		const id = anchorId;
		const current = slice;
		const token = (listRequest += 1);
		// A half-open revise panel belongs to the set it was opened from.
		revisingId = null;
		if (!id) {
			comparables = [];
			listLoaded = false;
			hasList = false;
			listAnchor = null;
			return;
		}
		// Only a re-sliced list is a reload. A different anchor is a different
		// subject, so it earns the waiting composition rather than a dimmed set of
		// cards that belong to the review being left behind.
		const resliced = hasList && listAnchor === id;
		listAnchor = id;
		if (resliced) sliceReloading = true;
		else {
			listLoaded = false;
			hasList = false;
		}
		void (async () => {
			const cards = await api.review.comparables(id, current);
			if (token !== listRequest) return;
			comparables = cards.map((card) => ({ ...card, item: { ...card.item } }));
			listLoaded = true;
			hasList = true;
			sliceReloading = false;
		})();
	});

	const ready = $derived(vocabLoaded && anchorResolved);
	const missingAnchor = $derived(ready && anchor === null);

	function trackName(trackId?: string): string | null {
		return trackId ? (trackNames[trackId] ?? 'Unassigned track') : null;
	}

	/** A revision is only meaningful as a pair, so the card says one happened. */
	function revised(item: MyReviewItem): boolean {
		return (item.revisions?.length ?? 0) > 0;
	}

	/** The plan's scale, taken from the standing that already carries it. */
	function scaleOf(standing: ScoreStanding | null): number[] {
		return Array.from({ length: standing?.scaleMax ?? 5 }, (_, index) => index + 1);
	}

	function pinned(item: MyReviewItem): AccoladeDef[] {
		if (!item.accolades || item.accolades.length === 0) return [];
		return accoladeDefs.filter((def) => item.accolades?.includes(def.key));
	}

	function switchSlice(next: SliceKey) {
		if (slice === next) return;
		onSliceChange(next);
	}

	function toggleRevise(card: ComparableCard) {
		const id = card.item.submissionId;
		if (revisingId === id) {
			revisingId = null;
			return;
		}
		revisingId = id;
		revisionScore = card.item.myScore;
	}

	/** Puts a freshly amended item back into whichever role it was revised in. */
	function applyRevision(submissionId: string, item: MyReviewItem) {
		if (anchor && anchor.item.submissionId === submissionId) {
			anchor = { ...anchor, item: { ...item } };
		}
		comparables = comparables.map((card) =>
			card.item.submissionId === submissionId ? { ...card, item: { ...item } } : card
		);
		onReviewChange?.(item);
	}

	async function commitRevision(card: ComparableCard) {
		const id = card.item.submissionId;
		const previous = card.item.myScore;
		if (revisionScore === undefined || revisionScore === previous || committingId) return;
		const next = revisionScore;
		committingId = id;
		try {
			const amended = await api.review.amend(id, next, card.item.myComment ?? '');
			if (!amended) return;
			applyRevision(id, amended);
			// The receipt names both scores, because "revised" without the pair it
			// replaced is not something anyone can check afterwards.
			recordAction({
				area: 'review',
				label: `Revised your review of “${card.submission.title}” — ${previous} → ${next}`,
				undo: async () => {
					const reverted = await api.review.revertAmend(id);
					if (reverted) applyRevision(id, reverted);
				}
			});
			revisingId = null;
		} finally {
			committingId = null;
		}
	}
</script>

{#snippet accolades(item: MyReviewItem)}
	{@const marks = pinned(item)}
	{#if marks.length > 0}
		<p class="marks">
			{#each marks as def (def.key)}
				{@const Mark = accoladeIcon[def.key]}
				<span class="ui-badge ui-badge--neutral"
					><Mark class="ui-badge__icon" aria-hidden="true" />{def.label}</span>
			{/each}
		</p>
	{/if}
{/snippet}

<!-- One composition for both roles. The anchor and every comparable carry the
     same fields in the same order, so a difference between two cards is a
     difference between two reviews rather than between two layouts. -->
{#snippet card(row: ComparableCard)}
	{@const id = row.item.submissionId}
	{@const open = revisingId === id}
	{@const busy = committingId === id}
	<div class="card__head">
		<h3 class="card__title">{row.submission.title}</h3>
		{#if revised(row.item)}
			<span class="ui-badge ui-badge--warning">Revised after reveal</span>
		{/if}
	</div>
	<p class="card__track">
		<TrackChip
			name={trackName(row.submission.trackId)}
			id={row.submission.trackId}
			order={trackOrder} />
	</p>
	<div class="card__abstract">
		<ClampedText lines={2} label={row.submission.title}>{row.submission.abstract}</ClampedText>
	</div>
	<div class="score">
		<span class="score__value">{row.item.myScore ?? '—'}</span>
		<StandingMark standing={row.standing} form="mark" stripWidth="9rem" context={row.submission.title} />
	</div>
	{#if row.item.myComment}
		<p class="comment">{row.item.myComment}</p>
	{:else}
		<p class="comment comment--none">No comment</p>
	{/if}
	{@render accolades(row.item)}
	<div class="revise">
		<button
			type="button"
			class="ui-button ui-button--secondary ui-button--sm"
			aria-expanded={open}
			onclick={() => toggleRevise(row)}>Revise score</button>
		{#if open}
			<div class="revise__panel">
				<span class="revise__label" id="{id}-revise-label">New score</span>
				<div class="ui-segmented" role="group" aria-labelledby="{id}-revise-label">
					{#each scaleOf(row.standing) as value (value)}
						<button
							type="button"
							class="ui-segmented__item"
							aria-pressed={revisionScore === value}
							disabled={busy}
							onclick={() => (revisionScore = value)}>{value}</button>
					{/each}
				</div>
				<button
					type="button"
					class="ui-button ui-button--primary ui-button--sm"
					disabled={revisionScore === undefined || revisionScore === row.item.myScore || busy}
					onclick={() => commitRevision(row)}>
					{busy ? 'Committing…' : 'Commit revision'}
				</button>
			</div>
		{/if}
	</div>
{/snippet}

<!-- The waiting card is the resolved card's own markup holding skeleton fills,
     so title, track, abstract, score, comment, and action keep the geometry
     their resolved CSS gives them. -->
{#snippet cardSkeleton()}
	<div class="card__head">
		<p class="card__title sk-head">
			<span class="ui-skeleton skeleton-line" style="inline-size: min(18rem, 100%)"></span>
		</p>
	</div>
	<p class="card__track"><span class="ui-skeleton skeleton-line" style="inline-size: 7rem"></span></p>
	<div class="card__abstract">
		<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
		<span class="ui-skeleton skeleton-line" style="inline-size: 68%"></span>
	</div>
	<div class="score">
		<span class="score__value"><span class="ui-skeleton skeleton-line" style="inline-size: 1.5rem"></span></span>
		<span class="ui-skeleton skeleton-strip"></span>
	</div>
	<p class="comment"><span class="ui-skeleton skeleton-line" style="inline-size: 80%"></span></p>
	<div class="revise"><span class="ui-skeleton skeleton-action"></span></div>
{/snippet}

<!-- One block, whatever it is mounted in: the panel owns the spacing between its
     own header and its cards, so a page column and a dialog body compose it the
     same way. -->
<div class="lineup-panel">
	<div class="head" class:head--untitled={!heading}>
		{#if heading}<h2 class="head__title">{heading}</h2>{/if}
		{#if !missingAnchor}
			<div class="ui-segmented head__slices" role="group" aria-label="Comparison slice">
				{#each slices as entry (entry.key)}
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={slice === entry.key}
						onclick={() => switchSlice(entry.key)}>{entry.label}</button>
				{/each}
			</div>
			<p class="head__count">
				{#if listLoaded}
					{comparables.length} to compare against
				{:else}
					<span class="ui-skeleton skeleton-line" style="inline-size: 10rem"></span>
				{/if}
			</p>
		{/if}
	</div>

	{#if missingAnchor}
		<!-- Reached without the scope it exists to compare. Saying which piece is
		     missing, and where it comes from, is the whole content of this state. -->
		<section class="panel" aria-labelledby="lineup-anchorless">
			<h2 class="panel__title" id="lineup-anchorless">No review to line up</h2>
			<p class="panel__copy">The line-up needs a committed review to anchor on.</p>
			<a class="ui-button ui-button--secondary ui-button--sm" href="/app/review">Open Review</a>
		</section>
	{:else}
		<div class="lineup" class:lineup--modal={surface === 'modal'}>
			<!-- Narrow: the anchor's identity and score stay in view while the
			     comparables scroll past. Its full card is the first thing in the flow,
			     so this bar repeats rather than replaces it. -->
			<div class="bar" aria-hidden="true">
				{#if ready && anchor}
					<span class="bar__title">{anchor.submission.title}</span>
					<span class="bar__score">{anchor.item.myScore ?? '—'}</span>
				{:else}
					<span class="bar__title"><span class="ui-skeleton skeleton-line" style="inline-size: 60%"></span></span>
					<span class="bar__score"><span class="ui-skeleton skeleton-line" style="inline-size: 1.25rem"></span></span>
				{/if}
			</div>

			<div class="anchor">
				<section class="card card--anchor" aria-labelledby="lineup-anchor-role">
					<p class="card__role" id="lineup-anchor-role">Anchor</p>
					{#if ready && anchor}
						{@render card(anchor)}
					{:else}
						{@render cardSkeleton()}
					{/if}
				</section>
			</div>

			<section
				class="list"
				class:is-refreshing={sliceReload.visible}
				aria-busy={sliceReloading || undefined}
				aria-label="Reviews compared against the anchor">
				{#if !listLoaded}
					<ul class="list__items">
						{#each Array(3) as _, index (index)}
							<li class="card" aria-hidden="true">{@render cardSkeleton()}</li>
						{/each}
					</ul>
				{:else if comparables.length === 0}
					<div class="panel">
						{#if slice === 'track'}
							{@const Situation = situationIcon.filteredEmpty}
							<span class="panel__mark" aria-hidden="true"><Situation size={22} /></span>
							<p class="panel__title">Nothing else committed in this track</p>
							<p class="panel__copy">
								This is your only committed review in {anchor
									? (trackName(anchor.submission.trackId) ?? 'this track')
									: 'this track'}. Widen the slice to read it against everything you have scored.
							</p>
							<button
								type="button"
								class="ui-button ui-button--secondary ui-button--sm"
								onclick={() => switchSlice('all')}>All my reviews</button>
						{:else}
							{@const Situation = situationIcon.emptyRoster}
							<span class="panel__mark" aria-hidden="true"><Situation size={22} /></span>
							<p class="panel__title">No other committed reviews</p>
							<p class="panel__copy">
								A line-up compares your scoring against itself, so it needs a second committed
								review. Commit another one and this fills in.
							</p>
							<a class="ui-button ui-button--secondary ui-button--sm" href="/app/review">Open Review</a>
						{/if}
					</div>
				{:else}
					<ul class="list__items">
						{#each comparables as row (row.item.submissionId)}
							<li class="card">{@render card(row)}</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	{/if}
</div>

<style>
	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, the standing strip is the mark's own
	   height, an action is control-height. Free-standing rectangles drift; these
	   cannot. */
	.sk-head {
		line-height: var(--je-leading-tight);
	}

	.skeleton-line {
		display: inline-block;
		/* One line box exactly: the line inherits the height it stands in for. */
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	/* The standing mark's own block size, so the score row does not change
	   height when the real strip arrives. */
	.skeleton-strip {
		display: inline-block;
		inline-size: 9rem;
		max-inline-size: 100%;
		block-size: 1.375rem;
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 7.5rem;
		border-radius: var(--je-radius-control);
		vertical-align: bottom;
	}

	/* The panel is one block with its own internal rhythm, so whatever holds it
	   — a page column or a dialog body — only has to place a single child. */
	.lineup-panel {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-6);
		min-inline-size: 0;
	}

	/* Header */
	.head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-4);
	}

	/* Without a heading of its own the slice control leads, so it takes the
	   column the title would have held rather than hanging off the right edge. */
	.head--untitled {
		grid-template-columns: auto minmax(0, 1fr);
	}

	.head--untitled .head__slices {
		justify-self: start;
	}

	.head__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 600;
	}

	.head__slices {
		justify-self: end;
	}

	.head__count {
		grid-column: 1 / -1;
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Anchor beside the field it anchors. The anchor stays put while the
	   comparables scroll, because a reference you have to scroll back to is not
	   being compared against — it is being remembered. */
	.lineup {
		/* What the sticky reference sticks under: the shell's own chrome on the
		   page, nothing at all inside a dialog that scrolls its own body. */
		--lineup-sticky: var(--je-topbar-height);
		display: grid;
		gap: var(--je-space-4);
		min-inline-size: 0;
	}

	.lineup--modal {
		--lineup-sticky: 0rem;
	}

	.bar {
		position: sticky;
		/* Below the shell's own sticky chrome, never underneath it. */
		inset-block-start: var(--lineup-sticky);
		z-index: 5;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-3);
		padding: var(--je-space-2) var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.bar__title {
		min-inline-size: 0;
		overflow: hidden;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.bar__score {
		flex: 0 0 auto;
		font-size: var(--je-font-size-base);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.anchor {
		min-inline-size: 0;
	}

	.list {
		min-inline-size: 0;
	}

	/* A slice change replaces the set, not the surface: the resolved cards dim
	   until the new ones land, so the change is visible where it happens. */
	.list.is-refreshing .list__items {
		opacity: 0.55;
		pointer-events: none;
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	.list__items {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* Card */
	.card {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-2);
		min-inline-size: 0;
		padding: var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	/* The reference reads as the thing being compared against, not as one more
	   card in the list. */
	.card--anchor {
		border-color: var(--je-color-border-strong);
	}

	.card__role {
		margin: 0;
		font-size: var(--je-font-size-2xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.card__head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--je-space-2);
	}

	.card__title {
		margin: 0;
		min-inline-size: 0;
		font-size: var(--je-font-size-base);
		font-weight: 600;
		/* A single unbroken title cannot push the document sideways at 390px. */
		overflow-wrap: anywhere;
	}

	.card__track {
		margin: 0;
	}

	.card__abstract {
		min-inline-size: 0;
		font-size: var(--je-font-size-md);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	/* The number a person quotes, beside where it stands. */
	.score {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-3);
		min-inline-size: 0;
		margin-block-start: var(--je-space-1);
	}

	.score__value {
		font-size: var(--je-font-size-2xl);
		font-weight: 700;
		line-height: var(--je-leading-tight);
		font-variant-numeric: tabular-nums;
	}

	.comment {
		margin: 0;
		padding-inline-start: var(--je-space-3);
		border-inline-start: 2px solid var(--je-color-border);
		font-size: var(--je-font-size-md);
		line-height: var(--je-leading-normal);
	}

	.comment--none {
		border-inline-start-color: transparent;
		padding-inline-start: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.marks {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		margin: 0;
	}

	.revise {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-3);
		margin-block-start: var(--je-space-1);
	}

	.revise__panel {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.revise__label {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	/* Panels */
	.panel {
		display: grid;
		justify-items: center;
		align-content: center;
		gap: var(--je-space-3);
		min-block-size: 14rem;
		padding: var(--je-space-8) var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		text-align: center;
	}

	.panel__mark {
		display: grid;
		place-items: center;
		color: var(--je-color-text-subtle);
	}

	.panel__title {
		margin: 0;
		font-size: var(--je-font-size-base);
		font-weight: 600;
	}

	.panel__copy {
		margin: 0;
		max-inline-size: 52ch;
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	/* Wide enough for two columns: the anchor becomes the sticky reference beside
	   the list, and the narrow summary bar it stood in for is retired. */
	@media (min-width: 920px) {
		.lineup {
			grid-template-columns: 20rem minmax(0, 1fr);
			align-items: start;
			gap: var(--je-space-6);
		}

		.bar {
			display: none;
		}

		.anchor {
			position: sticky;
			inset-block-start: calc(var(--lineup-sticky) + var(--je-space-4));
			inline-size: 20rem;
		}
	}
</style>
