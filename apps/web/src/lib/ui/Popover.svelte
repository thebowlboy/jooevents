<script lang="ts">
	/**
	 * A reason, a provenance line, or a score that varies per row, revealed in
	 * place from the mark that carries it.
	 *
	 * It is a press-and-focus disclosure, never a hover-only tooltip:
	 * hover-carried meaning never arrives on a touch device and arrives too
	 * late everywhere else. The trigger is a real button with `aria-expanded`,
	 * the panel follows it in the DOM so reading order matches, Escape closes
	 * and returns focus, and `onreveal` lets the surface mirror the same words
	 * to its polite live region.
	 *
	 * `hoverOpen` (owner call, 2026-08-15) additionally opens the panel on
	 * hover where a fine, hover-capable pointer exists — an accelerator on top
	 * of the press path, never a replacement for it, which is what keeps the
	 * hover law intact: press, tap, and keyboard open the same panel
	 * everywhere. A hover-open is provisional — it closes when the pointer
	 * leaves trigger and panel, skips `onreveal` (sweeping a column must not
	 * flood the live region), and a press while it is showing pins it open
	 * instead of toggling it shut.
	 *
	 * The panel is positioned in viewport coordinates because these marks sit
	 * inside scrolling table wrappers and schedule grids, which clip and contain
	 * absolutely positioned children.
	 */
	import { tick, type Snippet } from 'svelte';
	import { lower, placeNear, raise } from './anchored.svelte';

	interface Props {
		/**
		 * Accessible name of the control that opens the panel. It begins with the
		 * mark's own visible words, so speech input can reach it by what it says.
		 */
		label: string;
		/** Runs on open, so the surface can announce the same content politely. */
		onreveal?: () => void;
		/** The visible mark: a badge, a chip, a word. */
		trigger: Snippet;
		/**
		 * What the trigger *is*, because the affordance has to match the medium.
		 * There are three, and the ring only ever suited the first:
		 *
		 * - `mark` — already a box: a badge, a chip, a button-shaped control. It
		 *   has its own padding and fill, so a ring traces a box that is
		 *   genuinely there and reads as that box becoming interactive.
		 * - `word` — running text, with no box at all. Ringing it shrink-wraps a
		 *   pill around the glyphs with zero padding, which reads as a
		 *   mis-rendered button. Text takes a text affordance, which costs no
		 *   layout either.
		 * - `figure` — a graphic or a bare numeral: a standing plot, a score, a
		 *   scale anchor. Neither a padded box nor running text, so both of the
		 *   above are wrong — an underline is meaningless on a chart, and a ring
		 *   hugs it at zero padding exactly like the `word` case. It gets the
		 *   box the ring was assuming: a soft plate on hover, which is the tint
		 *   this design system already gives a marked thing.
		 */
		kind?: 'mark' | 'word' | 'figure';
		/**
		 * The trigger fills its container instead of shrinking to its content.
		 *
		 * For a `figure` whose content is a chart already sized by its wrapper —
		 * a standing strip spanning its column — the button has to span the same
		 * width or the plate stops short of the graphic. A bare numeral must not
		 * do this: stretched to its column it would paint a plate the width of
		 * the cell around two characters.
		 *
		 * It exists as a prop because the consumer used to do it by reaching into
		 * this component with `:global(.ui-popover__trigger)`, which also caught
		 * every other trigger inside it — including the numeral — and is what
		 * made a plate render narrower than the text it was highlighting.
		 */
		fill?: boolean;
		/** The panel body. The mark is the heading; the panel does not repeat it. */
		children: Snippet;
		/** Also open on hover, on fine hover-capable pointers only. See above. */
		hoverOpen?: boolean;
	}

	let {
		label,
		onreveal,
		trigger,
		children,
		kind = 'mark',
		fill = false,
		hoverOpen = false
	}: Props = $props();

	const uid = $props.id();

	let open = $state(false);
	let placed = $state(false);
	let root = $state<HTMLElement>();
	let panel = $state<HTMLElement>();
	let triggerButton = $state<HTMLButtonElement>();

	function place() {
		placeNear(root, panel);
		placed = true;
	}

	/** Open by hover alone — provisional, closes on leave, pinned by a press. */
	let hoverHeld = $state(false);

	async function show(announce = true) {
		open = true;
		placed = false;
		await tick();
		// The top layer takes the panel out of every ancestor's clipping and
		// stacking context, which is what a mark inside a scrolling grid needs.
		raise(panel);
		place();
		if (announce) onreveal?.();
	}

	function hide(refocus = true) {
		if (!open) return;
		open = false;
		placed = false;
		hoverHeld = false;
		if (refocus) triggerButton?.focus();
	}

	function toggle() {
		// The press outranks any hover intent still in flight: without this, a
		// pending open-timer could re-mark a just-pinned panel as hover-held
		// and let the next mouseleave close what the person deliberately kept.
		clearTimeout(hoverTimer);
		// A press on a hover-held panel is the person keeping it: it pins and
		// announces rather than snapping shut under the pointer that opened it.
		if (open && hoverHeld) {
			hoverHeld = false;
			onreveal?.();
			return;
		}
		if (open) hide();
		else void show();
	}

	// The hover accelerator. Delays are what keep a sweep across a column from
	// strobing panels open and shut: a short dwell earns the open, and a short
	// grace lets the pointer cross the gap into the panel. Timers are owned
	// handles, cleared on supersession and teardown.
	const HOVER_OPEN_MS = 150;
	const HOVER_CLOSE_MS = 200;
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => () => clearTimeout(hoverTimer));

	function finePointer(): boolean {
		return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
	}

	function onRootEnter() {
		if (!hoverOpen || !finePointer()) return;
		clearTimeout(hoverTimer);
		if (open) return;
		hoverTimer = setTimeout(() => {
			// A press may have landed while the dwell ran; what is open stays
			// exactly as the press left it.
			if (open) return;
			hoverHeld = true;
			void show(false);
		}, HOVER_OPEN_MS);
	}

	function onRootLeave() {
		if (!hoverOpen) return;
		clearTimeout(hoverTimer);
		if (!open || !hoverHeld) return;
		hoverTimer = setTimeout(() => {
			if (hoverHeld) hide(false);
		}, HOVER_CLOSE_MS);
	}

	// A scroll anywhere between the mark and the viewport moves the anchor, so
	// the listener is capturing rather than bound to one container.
	$effect(() => {
		if (!open) return;
		const reposition = () => place();
		document.addEventListener('scroll', reposition, { capture: true, passive: true });
		window.addEventListener('resize', reposition);
		return () => {
			document.removeEventListener('scroll', reposition, { capture: true });
			window.removeEventListener('resize', reposition);
		};
	});

	function onWindowPointerdown(event: PointerEvent) {
		if (open && root && !root.contains(event.target as Node)) hide(false);
	}

	function onFocusout(event: FocusEvent) {
		const next = event.relatedTarget as Node | null;
		if (open && root && next && !root.contains(next)) hide(false);
	}

	// Escape closes whatever is open, wherever focus sits inside it, and returns
	// focus to the mark that opened it.
	function onKeydown(event: KeyboardEvent) {
		if (!open || event.key !== 'Escape') return;
		event.stopPropagation();
		hide();
	}
</script>

<svelte:window onpointerdown={onWindowPointerdown} onkeydown={onKeydown} />

<!-- The hover handlers are a pointer-only accelerator on a wrapper whose real
     interactive semantics live on the button inside it; assistive tech never
     needs to reach them, so the wrapper stays a plain span. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
	class="ui-popover ui-popover--{kind}"
	class:ui-popover--fill={fill}
	bind:this={root}
	onfocusout={onFocusout}
	onmouseenter={onRootEnter}
	onmouseleave={onRootLeave}>
	<button
		type="button"
		class="ui-popover__trigger ui-popover__trigger--{kind}"
		class:ui-popover__trigger--open={open}
		class:ui-popover__trigger--fill={fill}
		aria-label={label}
		aria-expanded={open}
		aria-controls="{uid}-panel"
		bind:this={triggerButton}
		onclick={toggle}>
		{@render trigger()}
	</button>{#if open}
		<span
			class="ui-popover__panel"
			class:ui-popover__panel--placed={placed}
			id="{uid}-panel"
			bind:this={panel}>
			{@render children()}
		</span>
	{/if}
</span>

<style>
	.ui-popover {
		display: inline-flex;
		position: relative;
	}

	/* The mark keeps its own appearance; the control adds only the affordances a
	   pressable thing owes: a pointer, a hover response, and a focus ring. */
	.ui-popover__trigger {
		display: inline-flex;
		align-items: center;
		margin: 0;
		padding: 0;
		border: 0;
		border-radius: var(--je-radius-round);
		background: none;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.ui-popover__trigger--mark:hover,
	.ui-popover__trigger--mark.ui-popover__trigger--open {
		box-shadow: 0 0 0 1px var(--je-color-border-strong);
	}

	/* A word carries its own text affordance; the ring would only box it in. The
	   underline persists while the panel is open, so the trigger stays visibly
	   the source of what is on screen. */
	.ui-popover__trigger--word:hover,
	.ui-popover__trigger--word.ui-popover__trigger--open {
		text-decoration: underline;
		text-underline-offset: 0.15em;
	}

	/* An inline-flex root synthesises its baseline from flex layout instead of
	   sitting on the text baseline, so a word trigger rides visibly high in the
	   line it belongs to. The root goes back to `inline` for this kind.

	   The control is declared `inline` too, but engines coerce a `<button>` to
	   `inline-block` regardless, so the trigger stays an atomic inline box: it
	   relocates to the next line whole and never breaks across one. For a term
	   that is the wanted behaviour — a definition affordance split over two
	   lines reads as two marks — but it does mean a term must be short enough
	   to fit the narrowest column it appears in. */
	.ui-popover--word,
	.ui-popover__trigger--word {
		display: inline;
	}

	/* WebKit's UA stylesheet makes form controls unselectable, so without this a
	   drag across a sentence containing a word trigger copies the sentence with
	   a hole in it. Selecting text must keep working through it. */
	.ui-popover__trigger--word {
		-webkit-user-select: text;
		user-select: text;
	}

	/* The plate the ring was pretending was there. Padding and an exactly
	   cancelling negative margin mean the outer box is unchanged, so nothing on
	   the row moves — at rest this is pure geometry with nothing painted, and
	   hover changes only the fill. Same discipline as every other feedback in
	   the product: hold the space, change the paint. */
	.ui-popover__trigger--figure {
		padding: 2px 5px;
		margin: -2px -5px;
		border-radius: var(--je-radius-sm);
		transition: background-color var(--je-duration-fast) var(--je-ease);
	}

	.ui-popover__trigger--figure:hover,
	.ui-popover__trigger--figure.ui-popover__trigger--open {
		background: var(--je-color-surface-sunken);
	}

	/* A filled trigger spans its container, so the plate ends where the graphic
	   ends. The inline padding is dropped rather than kept: with `inline-size:
	   100%` it would eat into the width the wrapper already decided, shrinking
	   the chart it is meant to cover. */
	.ui-popover--fill,
	.ui-popover__trigger--fill {
		display: block;
		inline-size: 100%;
		min-inline-size: 0;
	}

	.ui-popover__trigger--fill {
		text-align: start;
	}

	.ui-popover__trigger--figure.ui-popover__trigger--fill {
		padding-inline: 0;
		margin-inline: 0;
	}

	.ui-popover__trigger:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.ui-popover__panel {
		position: fixed;
		/* The panel is placed by script, so the popover UA box is neutralised
		   rather than inherited; the z-index only matters where the top layer is
		   unavailable. */
		inset: auto;
		margin: 0;
		overflow: visible;
		z-index: 60;
		display: grid;
		gap: var(--je-space-1);
		inline-size: 19rem;
		max-inline-size: calc(100vw - 1rem);
		block-size: auto;
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-md);
		font-size: var(--je-font-size-sm);
		font-weight: 400;
		line-height: var(--je-leading-normal);
		color: var(--je-color-text);
		text-align: start;
		white-space: normal;
		/* Measured before it is seen: the first frame is laid out, not painted. */
		visibility: hidden;
	}

	.ui-popover__panel--placed {
		visibility: visible;
	}
</style>
