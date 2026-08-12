/**
 * Putting a floating element beside the thing it belongs to.
 *
 * Two components need this and they must not drift apart: the explanation
 * `Popover`, and the "Copied" flag on `CopyValue`. Both sit inside dense table
 * wrappers and schedule grids that clip and contain their children, so both need
 * the same two things — the top layer to escape that clipping, and viewport
 * arithmetic that flips rather than running off the edge.
 *
 * One placement, deliberately without options: the app has a single way of
 * standing something next to an anchor. Below and start-aligned, flipped above
 * when it does not fit, clamped to the viewport on the inline axis.
 */

/** Space between the anchor and the floating element. */
export const ANCHOR_GAP = 6;
/** Closest the floating element may come to the viewport edge. */
export const ANCHOR_EDGE = 8;

/**
 * Moves `panel` next to `anchor`, in viewport coordinates.
 *
 * Physical properties on purpose: the numbers come from `getBoundingClientRect`
 * and are compared against the viewport box, so logical properties would flip the
 * arithmetic rather than the layout.
 */
export function placeNear(anchor: HTMLElement | undefined, panel: HTMLElement | undefined): void {
  if (!anchor || !panel) return;

  // A dense-table wrapper contains paint, which makes it the containing block for
  // fixed positioning; the top layer does not. Measuring the panel at the origin
  // tells us which one we are in, so the arithmetic holds either way.
  panel.style.top = '0px';
  panel.style.left = '0px';
  const origin = panel.getBoundingClientRect();
  const box = anchor.getBoundingClientRect();

  const maxLeft = Math.max(ANCHOR_EDGE, window.innerWidth - origin.width - ANCHOR_EDGE);
  const wantLeft = Math.min(Math.max(ANCHOR_EDGE, box.left), maxLeft);

  const below = box.bottom + ANCHOR_GAP;
  const fitsBelow = below + origin.height <= window.innerHeight - ANCHOR_EDGE;
  const fitsAbove = box.top - ANCHOR_GAP - origin.height >= ANCHOR_EDGE;
  const wantTop = !fitsBelow && fitsAbove ? box.top - ANCHOR_GAP - origin.height : below;

  panel.style.top = `${wantTop - origin.top}px`;
  panel.style.left = `${wantLeft - origin.left}px`;
}

/**
 * Raises `panel` into the top layer, where no ancestor's `overflow` can clip it
 * and no stacking context can bury it. A no-op where the platform lacks the API,
 * so callers keep whatever in-flow feedback they already give.
 */
export function raise(panel: HTMLElement | undefined): void {
  if (!panel || !('showPopover' in panel)) return;
  panel.popover = 'manual';
  try {
    panel.showPopover();
  } catch {
    /* Already open. */
  }
}

/** Returns `panel` from the top layer. Safe to call when it was never raised. */
export function lower(panel: HTMLElement | undefined): void {
  if (!panel || !('hidePopover' in panel)) return;
  try {
    if (panel.matches(':popover-open')) panel.hidePopover();
  } catch {
    /* Never opened, or the selector is unsupported. */
  }
}
