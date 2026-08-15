/**
 * The two widths this system changes shape at, named once.
 *
 * Both are stated in `rem` so they move with the reader's own text size: a
 * person at 200% zoom hits the narrow arrangement at twice the CSS width,
 * which is the point — the arrangement is about how much *text* fits, not how
 * many device pixels there are.
 */

/**
 * A phone. Below this a record's detail promotes from an inline expansion to a
 * full-screen sheet, because a labelled two-column detail inside a 390px
 * column is unreadable. It matches the width at which `tokens.css` promotes
 * control metrics to the touch row, so the two never disagree about what a
 * phone is.
 */
export const PHONE_QUERY = '(max-width: 47.9375rem)';

/**
 * The width a dense table needs before its columns are worth keeping, mirrored
 * from `--je-table-columns-min`.
 *
 * The table's own transformation does **not** use this as a media query: it
 * asks a container query about the wrapper's real width, so a table narrowed
 * by the sidebar re-composes at the same moment a phone's does. This constant
 * exists for code that has to reason about the same threshold in JavaScript —
 * tests, mostly — and any use of it as a *viewport* query is a mistake.
 */
export const TABLE_COLUMNS_MIN_REM = 52;
