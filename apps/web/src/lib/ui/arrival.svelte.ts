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
 * Only one arrival is ever marked; a second call clears the first.
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
const LEAVING = 'ui-arrival--leaving';

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

		// Table structure positions pseudo-elements inconsistently across engines.
		if (['TR', 'TBODY', 'THEAD', 'TABLE', 'COL', 'COLGROUP'].includes(element.tagName)) {
			return false;
		}

		const box = element.getBoundingClientRect();
		// Nothing meaningful to draw around: collapsed, hidden, or not laid out.
		if (box.width < 4 || box.height < 4) return false;

		const style = getComputedStyle(element);
		// An inline box fragments across lines, so the ring would too.
		if (style.display === 'inline' || style.display === 'contents' || style.display === 'none') {
			return false;
		}

		// The component already uses ::after for something of its own. Unlayered
		// component CSS outranks ours, so this is either a silent no-op or a fight
		// over one pseudo — either way, stay out of it.
		const after = getComputedStyle(element, '::after').content;
		if (after && after !== 'none' && after !== 'normal') return false;

		return true;
	} catch {
		return false;
	}
}

let release: (() => void) | null = null;

/**
 * Marks `element` as the thing just navigated to. Returns a function that
 * clears the mark early; calling it twice is safe.
 */
export function markArrival(element: HTMLElement | null, options: ArrivalOptions = {}): () => void {
	release?.();
	if (!element || typeof window === 'undefined') return () => {};
	// Decoration must never be the reason a navigation misbehaves.
	if (!canHostRing(element)) return () => {};

	const minMs = options.minMs ?? ARRIVAL_MIN_MS;
	const maxMs = Math.max(options.maxMs ?? ARRIVAL_MAX_MS, minMs);

	let settled = false;
	let armed = false;
	let origin: { x: number; y: number } | null = null;
	const timers: ReturnType<typeof setTimeout>[] = [];

	// The ring is an absolutely positioned pseudo-element, so it needs a
	// positioned ancestor. Setting this in CSS would re-position anything already
	// laid out as `absolute` — a schedule card, for one — so it is applied here,
	// only when needed, and undone on release.
	const positioned = getComputedStyle(element).position !== 'static';
	if (!positioned) element.style.position = 'relative';

	element.classList.add(MARK);

	const finish = () => {
		if (settled) return;
		settled = true;
		stopListening();
		timers.forEach(clearTimeout);
		element.classList.add(LEAVING);
		// The token is 0ms under reduced motion, so this lands on the next tick
		// rather than animating.
		const fade = getComputedStyle(document.documentElement).getPropertyValue('--je-duration-slow');
		const ms = fade.trim().endsWith('ms') ? Number.parseFloat(fade) : 280;
		setTimeout(() => {
			element.classList.remove(MARK, LEAVING);
			if (!positioned) element.style.removeProperty('position');
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
}

/**
 * The whole arrival: bring the target into view, put the caret on it, and mark
 * it. Returns a function that releases the mark early.
 *
 * The scroll is motion-aware, and an element that cannot take focus is given
 * `tabindex="-1"` so the keyboard and the screen reader travel with the eye —
 * without it, a deep link moves the view but leaves the caret behind.
 */
export function revealTarget(element: HTMLElement | null, options: RevealOptions = {}): () => void {
	if (!element || typeof window === 'undefined') return () => {};
	const { mark = true, block = 'center', ...arrivalOptions } = options;

	try {
		const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		element.scrollIntoView({ block, inline: 'center', behavior: still ? 'auto' : 'smooth' });
	} catch {
		// Synthetic or detached elements still land somewhere useful.
		element.scrollIntoView?.();
	}

	try {
		if (!element.hasAttribute('tabindex') && element.tabIndex < 0) {
			element.setAttribute('tabindex', '-1');
		}
		element.focus({ preventScroll: true });
	} catch {
		/* Not focusable, and that is survivable: the view still moved. */
	}

	return mark ? markArrival(element, arrivalOptions) : () => {};
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
