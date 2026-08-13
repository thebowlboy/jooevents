/**
 * Vertical drag-to-reorder for row lists, as a pair of Svelte actions: one on
 * the scrolling container, one on each row's grab handle.
 *
 * The interaction contract:
 * - **Vertical only.** The dragged row follows the pointer on the Y axis; X is
 *   locked, so a wobbling thumb never reads as a different gesture.
 * - **The handle is the whole gesture.** Dragging starts on the handle's
 *   `pointerdown` — no long-press, no aiming at the row body — and the handle
 *   declares `touch-action: none` so the browser never turns the drag into a
 *   scroll. Page scrolling stays available everywhere else on the row.
 * - **An indicator names the destination.** While dragging, a slot line marks
 *   where the row would land; sibling rows hold still. The settle after drop
 *   is the caller's data reorder (pair the rows with `animate:flip` on the
 *   motion tokens); this module never animates layout itself.
 * - **Long lists scroll themselves.** Holding the drag near the viewport's
 *   top or bottom edge auto-scrolls, so a thumb can move a row further than
 *   one screen without letting go.
 * - **Escape and pointer loss cancel.** Nothing commits until the drop;
 *   `onMove` fires exactly once, with the row's old and new list indices.
 * - **Keys are the equal path.** Arrow Up/Down on the focused handle moves the
 *   row one step per press through the same `onMove`.
 */

export interface RowDragOptions {
	/** Selects the reorderable rows inside the container, in list order. */
	rowSelector: string;
	/** One completed move: `from` and `to` are final indices in the row list. */
	onMove: (from: number, to: number) => void;
}

export interface RowDrag {
	/** Svelte action for the list container (must be `position: relative`). */
	container: (node: HTMLElement) => { destroy(): void };
	/** Svelte action for a row's grab handle. */
	handle: (node: HTMLElement) => { destroy(): void };
	/** True while a drag is in flight — callers can quiet hover states. */
	readonly dragging: boolean;
}

/** How close to the viewport edge (px) the pointer auto-scrolls, and how fast. */
const SCROLL_EDGE = 72;
const SCROLL_MAX_STEP = 14;

export function createRowDrag(options: RowDragOptions): RowDrag {
	let containerEl: HTMLElement | null = null;
	let indicator: HTMLElement | null = null;
	let dragging = $state(false);

	interface DragState {
		handleEl: HTMLElement;
		rowEl: HTMLElement;
		pointerId: number;
		startY: number;
		/** Where the grab landed — the engage threshold measures against this. */
		grabY: number;
		/** True once the pointer has actually travelled; nothing reacts before. */
		engaged: boolean;
		lastClientY: number;
		from: number;
		to: number;
		raf: number;
	}
	let drag: DragState | null = null;

	function rows(): HTMLElement[] {
		return containerEl ? [...containerEl.querySelectorAll<HTMLElement>(options.rowSelector)] : [];
	}

	function rowOf(node: HTMLElement): HTMLElement | null {
		return node.closest<HTMLElement>(options.rowSelector);
	}

	/**
	 * The final index the drop would produce: the dragged row is imagined out
	 * of the list, and the pointer's Y picks the slot among the remaining rows.
	 */
	function targetIndex(clientY: number): number {
		if (!drag) return 0;
		const others = rows().filter((row) => row !== drag!.rowEl);
		for (let i = 0; i < others.length; i += 1) {
			const rect = others[i].getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) return i;
		}
		return others.length;
	}

	function placeIndicator(to: number): void {
		if (!drag || !containerEl || !indicator) return;
		// Landing where it already sits is a no-op; say nothing.
		if (to === drag.from) {
			indicator.style.display = 'none';
			return;
		}
		const others = rows().filter((row) => row !== drag!.rowEl);
		const containerRect = containerEl.getBoundingClientRect();
		let y: number;
		if (to < others.length) {
			y = others[to].getBoundingClientRect().top;
		} else if (others.length > 0) {
			y = others[others.length - 1].getBoundingClientRect().bottom;
		} else {
			y = containerRect.top;
		}
		indicator.style.display = 'block';
		indicator.style.top = `${y - containerRect.top}px`;
	}

	/**
	 * One frame of the drag: apply the pointer's Y offset, auto-scroll when
	 * held near a viewport edge, and re-aim the slot from live geometry (the
	 * scroll moves rows under a stationary pointer, so this cannot be
	 * event-driven alone).
	 */
	function frame(): void {
		if (!drag) return;
		// A grab is not yet a drag: until the pointer travels, nothing lifts,
		// nothing scrolls — a handle held near the viewport edge stays still.
		if (!drag.engaged && Math.abs(drag.lastClientY - drag.grabY) <= 4) {
			drag.raf = requestAnimationFrame(frame);
			return;
		}
		drag.engaged = true;
		const nearTop = drag.lastClientY < SCROLL_EDGE;
		const nearBottom = drag.lastClientY > window.innerHeight - SCROLL_EDGE;
		if (nearTop || nearBottom) {
			const edgeGap = nearTop ? drag.lastClientY : window.innerHeight - drag.lastClientY;
			const step = Math.ceil(((SCROLL_EDGE - edgeGap) / SCROLL_EDGE) * SCROLL_MAX_STEP);
			window.scrollBy(0, nearTop ? -step : step);
			// The row keeps its offset relative to the pointer, not the page.
			drag.startY -= nearTop ? -step : step;
		}
		drag.rowEl.style.transform = `translateY(${drag.lastClientY - drag.startY}px)`;
		drag.to = targetIndex(drag.lastClientY);
		placeIndicator(drag.to);
		drag.raf = requestAnimationFrame(frame);
	}

	function onPointerMove(event: PointerEvent): void {
		if (!drag || event.pointerId !== drag.pointerId) return;
		drag.lastClientY = event.clientY;
	}

	function cleanup(): void {
		if (!drag) return;
		cancelAnimationFrame(drag.raf);
		drag.rowEl.style.transform = '';
		drag.rowEl.classList.remove('ui-dragrow');
		if (indicator) indicator.style.display = 'none';
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', onPointerCancel);
		window.removeEventListener('keydown', onKeyCancel, true);
		drag = null;
		dragging = false;
	}

	function onPointerUp(event: PointerEvent): void {
		if (!drag || event.pointerId !== drag.pointerId) return;
		const { from, to } = drag;
		cleanup();
		if (to !== from) options.onMove(from, to);
	}

	function onPointerCancel(): void {
		cleanup();
	}

	function onKeyCancel(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.stopPropagation();
		cleanup();
	}

	function onPointerDown(event: PointerEvent, handleEl: HTMLElement): void {
		if (drag || event.button > 0) return;
		const rowEl = rowOf(handleEl);
		if (!rowEl || !containerEl) return;
		const from = rows().indexOf(rowEl);
		if (from === -1) return;
		event.preventDefault();
		// Capture keeps the stream on the handle where supported; the window
		// listeners below are the actual contract, so a capture refusal (some
		// synthetic pointers) costs nothing.
		try {
			handleEl.setPointerCapture(event.pointerId);
		} catch {
			// Fall through to the window listeners.
		}
		rowEl.classList.add('ui-dragrow');
		drag = {
			handleEl,
			rowEl,
			pointerId: event.pointerId,
			startY: event.clientY,
			grabY: event.clientY,
			engaged: false,
			lastClientY: event.clientY,
			from,
			to: from,
			raf: 0
		};
		dragging = true;
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerCancel);
		window.addEventListener('keydown', onKeyCancel, true);
		drag.raf = requestAnimationFrame(frame);
	}

	function onHandleKeydown(event: KeyboardEvent, handleEl: HTMLElement): void {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		const rowEl = rowOf(handleEl);
		if (!rowEl) return;
		const list = rows();
		const from = list.indexOf(rowEl);
		const to = event.key === 'ArrowUp' ? from - 1 : from + 1;
		if (from === -1 || to < 0 || to >= list.length) return;
		event.preventDefault();
		options.onMove(from, to);
	}

	return {
		container(node: HTMLElement) {
			containerEl = node;
			indicator = document.createElement('div');
			indicator.className = 'ui-drag-indicator';
			indicator.style.display = 'none';
			indicator.setAttribute('aria-hidden', 'true');
			node.appendChild(indicator);
			return {
				destroy() {
					cleanup();
					indicator?.remove();
					indicator = null;
					containerEl = null;
				}
			};
		},
		handle(node: HTMLElement) {
			const down = (event: PointerEvent) => onPointerDown(event, node);
			const key = (event: KeyboardEvent) => onHandleKeydown(event, node);
			node.addEventListener('pointerdown', down);
			node.addEventListener('keydown', key);
			return {
				destroy() {
					node.removeEventListener('pointerdown', down);
					node.removeEventListener('keydown', key);
					if (drag?.handleEl === node) cleanup();
				}
			};
		},
		get dragging() {
			return dragging;
		}
	};
}

/**
 * A motion token's duration in milliseconds, read from the live cascade so
 * reduced-motion (which zeroes the tokens) is honored automatically. For
 * `animate:flip` durations and any scripted timing that must obey rule 4.
 */
export function motionMs(token: 'fast' | 'normal' | 'slow'): number {
	if (typeof window === 'undefined') return 0;
	const raw = getComputedStyle(document.documentElement).getPropertyValue(
		`--je-duration-${token}`
	);
	const value = Number.parseFloat(raw);
	if (Number.isNaN(value)) return 0;
	return raw.trim().endsWith('ms') ? value : value * 1000;
}
