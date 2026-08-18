/**
 * Arrival marking: "this is the thing you asked for".
 *
 * A scoped link promises to take someone to one record. Scrolling there keeps
 * that promise only if they can tell *which* item they landed on — and among
 * peers that look alike (a schedule grid, a queue, a matrix) the scroll alone
 * leaves them hunting. Focus is not enough on its own: it is a keyboard
 * position, and it disappears at the first click elsewhere.
 *
 * The mark is a ring in the action colour, held still. Deliberately no pulse or
 * glow: motion explains causality, and a mark that keeps re-animating keeps
 * re-asking for attention the person has already given
 * (`motion-and-transitions.md` rule 5).
 *
 * It releases on the first sign the person has taken over — a press, a key, a
 * wheel, or real pointer travel — but never before `minMs`, so a mark that
 * appears cannot strobe away before it has been seen. `maxMs` releases it for
 * someone who arrives and then sits still. The fade consumes a duration token,
 * so reduced motion removes it instantly rather than animating.
 *
 * Only one arrival is ever marked; a second call clears the first. An arrival
 * that names a *set* rather than one record — a scoped link that filters a list
 * to a tray — marks that set through `markArrivalGroup`, which is still one
 * arrival: one lifecycle, one release, every host lit and dropped together.
 *
 * **The anchor is not always the host.** A surface finds its record by some
 * element it can address — a name block, an id on a card — but the thing a
 * person recognises as "the record" is often larger than that: the whole row,
 * the whole card. Marking the addressable element instead draws a ring around a
 * name inside a cell, which answers "which name?" rather than "which one?".
 *
 * So the two roles are separate. The **anchor** is what the surface hands in:
 * it is what gets scrolled to and focused, and staying precise there is the
 * point — centring a full-width row inside a table that scrolls sideways would
 * carry the identity column off screen. The **host** is what wears the mark,
 * and it is declared in markup with `data-arrival-host` on the exact element.
 * Resolution is `closest()`, so the host may be any ancestor at any depth, and
 * an inner element that wants the mark for itself simply declares itself. With
 * no declaration anywhere the anchor is its own host — every surface that never
 * needed the distinction is unaffected.
 *
 * Three ways in, so any surface can adopt it:
 *
 * - `markArrival(el)` — mark something already on screen.
 * - `revealTarget(el)` — the whole arrival: scroll, focus, mark. This is what a
 *   surface resolving `?thing=` wants; it is deliberately here rather than in a
 *   feature so the second surface to need it does not reinvent the trio.
 * - `{@attach arrival(isTarget)}` — declarative, for a component that knows in
 *   markup whether it is the thing being asked for. Cleanup runs on unmount, so
 *   a target that disappears mid-mark takes its listeners with it.
 */

/** Held at least this long once shown, so the mark cannot flicker. */
export const ARRIVAL_MIN_MS = 1200;

/** Released after this long even if the person never acts. */
export const ARRIVAL_MAX_MS = 7000;

/** Pointer travel that counts as "they have taken over", in CSS pixels. */
const ARRIVAL_POINTER_SLOP = 24;

export interface ArrivalOptions {
	minMs?: number;
	maxMs?: number;
}

const MARK = 'ui-arrival';
const ROW = 'ui-arrival--row';
const LEAVING = 'ui-arrival--leaving';

/** Declares, in markup, which element wears the mark. See the module note. */
const HOST_ATTR = 'data-arrival-host';

/**
 * The element that should wear the mark for this anchor.
 *
 * `closest()` starts at the anchor itself, so declaring the attribute on an
 * inner element is how that element keeps the mark when an ancestor also
 * declares one.
 */
function resolveHost(anchor: HTMLElement): HTMLElement {
	try {
		return anchor.closest<HTMLElement>(`[${HOST_ATTR}]`) ?? anchor;
	} catch {
		return anchor;
	}
}

/** Cells of a row host, which is where a row's ring is actually drawn. */
function rowCells(row: HTMLElement): HTMLElement[] {
	return Array.from(row.children).filter(
		(child): child is HTMLElement =>
			child instanceof HTMLElement && (child.tagName === 'TD' || child.tagName === 'TH')
	);
}

/** Whether an element already spends its own `::after` on something. */
function ownsAfter(element: HTMLElement): boolean {
	const after = getComputedStyle(element, '::after').content;
	return Boolean(after) && after !== 'none' && after !== 'normal';
}

/**
 * Whether an element can host the ring without the result looking broken.
 *
 * The mark is decoration on top of a navigation that has already succeeded, so
 * every uncertain case fails to *nothing*: the person still gets scrolled and
 * focused, they just do not get a ring. A missing ring is a small loss; a ring
 * drawn through a neighbour, split across two lines, or clobbering a component's
 * own `::after` is a visible fault.
 */
function canHostRing(element: HTMLElement): boolean {
	try {
		if (!element.isConnected) return false;

		const box = element.getBoundingClientRect();
		// Nothing meaningful to draw around: collapsed, hidden, or not laid out.
		if (box.width < 4 || box.height < 4) return false;

		// A row is the one host whose ring is drawn on its cells rather than on
		// itself, so the ::after test has to move down with it — and a row with no
		// cells has nothing to draw on.
		if (element.tagName === 'TR') {
			const cells = rowCells(element);
			return cells.length > 0 && !cells.some(ownsAfter);
		}

		// The rest of the table box tree positions pseudo-elements inconsistently
		// across engines, and none of it is ever the thing a link points at.
		if (['TBODY', 'THEAD', 'TFOOT', 'TABLE', 'COL', 'COLGROUP'].includes(element.tagName)) {
			return false;
		}

		const style = getComputedStyle(element);
		// An inline box fragments across lines, so the ring would too.
		if (style.display === 'inline' || style.display === 'contents' || style.display === 'none') {
			return false;
		}

		// The component already uses ::after for something of its own. Unlayered
		// component CSS outranks ours, so this is either a silent no-op or a fight
		// over one pseudo — either way, stay out of it.
		if (ownsAfter(element)) return false;

		return true;
	} catch {
		return false;
	}
}

let release: (() => void) | null = null;

/**
 * Marks the host of `element` as the thing just navigated to — itself unless
 * some ancestor declares `data-arrival-host`. Returns a function that clears the
 * mark early; calling it twice is safe.
 */
export function markArrival(element: HTMLElement | null, options: ArrivalOptions = {}): () => void {
	return markArrivalGroup([element], options);
}

/** One marked host, with what has to be undone when the mark is released. */
interface MarkedHost {
	host: HTMLElement;
	mark: string;
	positioned: boolean;
}

/**
 * Marks every host in a set as the things just navigated to.
 *
 * Some scoped links name a set rather than a record: a tray chip promises "the
 * sessions that need speakers", and the crowd it lands in still cannot say
 * which ones those are. That is one arrival with several answers, so it stays
 * one lifecycle — the whole set lights together, releases together on the first
 * sign the person has taken over, and a later arrival clears all of it.
 *
 * Nulls and hosts that cannot carry the ring are skipped rather than refused:
 * a set whose members are partly off screen (another day of the grid) marks the
 * part that is there. Duplicates resolving to one host are marked once.
 */
export function markArrivalGroup(
	elements: readonly (HTMLElement | null)[],
	options: ArrivalOptions = {}
): () => void {
	release?.();
	if (typeof window === 'undefined') return () => {};

	const marked: MarkedHost[] = [];
	const seen = new Set<HTMLElement>();
	for (const element of elements) {
		if (!element) continue;
		const host = resolveHost(element);
		if (seen.has(host)) continue;
		seen.add(host);
		// Decoration must never be the reason a navigation misbehaves.
		if (!canHostRing(host)) continue;
		// A row wears the ring as a band across its own cells, so the containing
		// blocks it needs are the cells, and the stylesheet establishes them.
		const isRow = host.tagName === 'TR';
		marked.push({
			host,
			mark: isRow ? ROW : MARK,
			// The ring is an absolutely positioned pseudo-element, so it needs a
			// positioned ancestor. Setting this in CSS would re-position anything
			// already laid out as `absolute` — a schedule card, for one — so it is
			// applied here, only when needed, and undone on release.
			positioned: isRow || getComputedStyle(host).position !== 'static'
		});
	}
	if (marked.length === 0) return () => {};

	const minMs = options.minMs ?? ARRIVAL_MIN_MS;
	const maxMs = Math.max(options.maxMs ?? ARRIVAL_MAX_MS, minMs);

	let settled = false;
	let armed = false;
	let origin: { x: number; y: number } | null = null;
	const timers: ReturnType<typeof setTimeout>[] = [];

	for (const entry of marked) {
		if (!entry.positioned) entry.host.style.position = 'relative';
		entry.host.classList.add(entry.mark);
	}

	const finish = () => {
		if (settled) return;
		settled = true;
		stopListening();
		timers.forEach(clearTimeout);
		for (const entry of marked) entry.host.classList.add(LEAVING);
		// The token is 0ms under reduced motion, so this lands on the next tick
		// rather than animating.
		const fade = getComputedStyle(document.documentElement).getPropertyValue('--je-duration-slow');
		const ms = fade.trim().endsWith('ms') ? Number.parseFloat(fade) : 280;
		setTimeout(() => {
			for (const entry of marked) {
				entry.host.classList.remove(entry.mark, LEAVING);
				if (!entry.positioned) entry.host.style.removeProperty('position');
			}
		}, Number.isFinite(ms) ? ms : 280);
		if (release === finish) release = null;
	};

	const onPointerMove = (event: PointerEvent) => {
		if (!origin) {
			origin = { x: event.clientX, y: event.clientY };
			return;
		}
		const travelled = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
		if (travelled >= ARRIVAL_POINTER_SLOP) finish();
	};

	const listen = (on: boolean) => {
		const fn = on ? window.addEventListener : window.removeEventListener;
		fn('pointerdown', finish);
		fn('keydown', finish);
		fn('wheel', finish, { passive: true } as AddEventListenerOptions);
		fn('touchstart', finish, { passive: true } as AddEventListenerOptions);
		fn('pointermove', onPointerMove as EventListener);
	};

	function stopListening() {
		if (!armed) return;
		armed = false;
		listen(false);
	}

	// The hold: activity before this is the navigation itself settling, not the
	// person moving on.
	timers.push(
		setTimeout(() => {
			if (settled) return;
			armed = true;
			listen(true);
		}, minMs)
	);
	timers.push(setTimeout(finish, maxMs));

	release = finish;
	return finish;
}


export interface RevealOptions extends ArrivalOptions {
	/**
	 * Marking is for destinations that cannot answer "which one?" by themselves.
	 * Pass `false` for a named region, a single-match list, or a record's own
	 * page — see `product/07-flow-and-drill-down.md` R1.
	 */
	mark?: boolean;
	/** Where the target sits once scrolled. Centre reads as "here it is". */
	block?: ScrollLogicalPosition;
	/**
	 * Sideways placement, for a target inside something that scrolls
	 * horizontally. Defaults to centring, except for a row: a row spans its
	 * table, so centring it in a table wider than its scrollport would carry the
	 * name column — the whole reason the person followed the link — off screen.
	 */
	inline?: ScrollLogicalPosition;
}

/**
 * The whole arrival: bring the target into view, put the caret on it, and mark
 * it. Returns a function that releases the mark early.
 *
 * The element handed in is the *anchor*: what is scrolled to. The caret and the
 * mark go to its host, which is the anchor itself unless something above it
 * declares `data-arrival-host` — see the module note.
 *
 * The scroll is motion-aware, and an element that cannot take focus is given
 * `tabindex="-1"` so the keyboard and the screen reader travel with the eye —
 * without it, a deep link moves the view but leaves the caret behind. The caret
 * follows the mark rather than the anchor because they answer the same question:
 * a screen reader landing on the row reads the record, where landing on the name
 * block inside it reads a fragment, and a sighted person gets one indicator
 * instead of a focus ring drawn tight around a name inside a marked row.
 */
export function revealTarget(element: HTMLElement | null, options: RevealOptions = {}): () => void {
	if (!element || typeof window === 'undefined') return () => {};
	const {
		mark = true,
		block = 'center',
		inline = element.tagName === 'TR' ? 'nearest' : 'center',
		...arrivalOptions
	} = options;

	try {
		const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		element.scrollIntoView({ block, inline, behavior: still ? 'auto' : 'smooth' });
	} catch {
		// Synthetic or detached elements still land somewhere useful.
		element.scrollIntoView?.();
	}

	const host = resolveHost(element);
	try {
		if (!host.hasAttribute('tabindex') && host.tabIndex < 0) {
			host.setAttribute('tabindex', '-1');
		}
		host.focus({ preventScroll: true });
	} catch {
		/* Not focusable, and that is survivable: the view still moved. */
	}

	return mark ? markArrival(host, arrivalOptions) : () => {};
}

/**
 * Attachment form: `{@attach arrival(row.id === asked)}`.
 *
 * Re-runs when `active` changes, so a component states the condition once in
 * markup and never handles a DOM reference, a timer, or a listener itself.
 */
export function arrival(active: boolean, options: RevealOptions = {}) {
	return (element: Element) => {
		if (!active) return;
		const release = revealTarget(element as HTMLElement, options);
		return () => release();
	};
}
