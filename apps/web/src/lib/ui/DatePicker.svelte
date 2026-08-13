<script lang="ts">
	import { tick } from 'svelte';
	import { Calendar, ChevronLeft, ChevronRight } from 'lucide-svelte';
	import { lower, placeNear, raise } from './anchored.svelte';

	interface Props {
		/** ISO date (yyyy-mm-dd) or empty string. */
		value?: string;
		/** Inclusive ISO bounds; out-of-range days are disabled, typed values rejected. */
		min?: string;
		max?: string;
		/**
		 * Where the calendar opens when no value is set: an ISO date or 'today'.
		 * Set it per context so the first view is already the right one.
		 */
		defaultFocus?: string;
		id?: string;
		describedBy?: string;
		invalid?: boolean;
		disabled?: boolean;
		/** Accessible name for the calendar toggle; also labels the dialog. */
		label?: string;
		onchange?: (value: string) => void;
	}

	let {
		value = $bindable(''),
		min,
		max,
		defaultFocus = 'today',
		id,
		describedBy,
		invalid = false,
		disabled = false,
		label = 'date',
		onchange
	}: Props = $props();

	// Coarse pointers get the platform's own picker.
	const useNative =
		typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

	type Ymd = { y: number; m: number; d: number };

	const MONTHS = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];
	const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

	function parseIso(text: string): Ymd | null {
		const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
		if (!match) return null;
		const y = Number(match[1]);
		const m = Number(match[2]) - 1;
		const d = Number(match[3]);
		const probe = new Date(y, m, d);
		return probe.getFullYear() === y && probe.getMonth() === m && probe.getDate() === d
			? { y, m, d }
			: null;
	}

	function parseLoose(text: string): Ymd | null {
		const iso = parseIso(text);
		if (iso) return iso;
		const stamp = Date.parse(text);
		if (Number.isNaN(stamp)) return null;
		const date = new Date(stamp);
		return { y: date.getFullYear(), m: date.getMonth(), d: date.getDate() };
	}

	const toIso = ({ y, m, d }: Ymd) =>
		`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

	function todayYmd(): Ymd {
		const now = new Date();
		return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
	}

	function inRange(iso: string): boolean {
		if (min && iso < min) return false;
		if (max && iso > max) return false;
		return true;
	}

	function initialFocus(): Ymd {
		return (
			parseIso(value) ??
			(defaultFocus !== 'today' ? parseIso(defaultFocus) : null) ??
			todayYmd()
		);
	}

	let open = $state(false);
	let view = $state<'days' | 'months' | 'years'>('days');
	let placed = $state(false);
	let focusYmd = $state(initialFocus());
	let yearPageStart = $state(0);
	let text = $state(value);
	let typedInvalid = $state(false);
	let root = $state<HTMLElement>();
	let inputEl = $state<HTMLInputElement>();
	let panel = $state<HTMLElement>();

	$effect(() => {
		text = value;
		typedInvalid = false;
	});

	async function openPanel() {
		focusYmd = initialFocus();
		view = 'days';
		open = true;
		placed = false;
		await tick();
		// The top layer, not in-flow stacking: the picker sits inside dialog
		// bodies and table wrappers whose overflow would clip an absolutely
		// positioned panel. Same shared placement as every other anchored panel;
		// the three views share one fixed geometry, so one placement holds.
		raise(panel);
		placeNear(root, panel);
		placed = true;
		panel?.querySelector<HTMLButtonElement>('[data-focus-target]')?.focus();
	}

	function closePanel(refocus = true) {
		lower(panel);
		placed = false;
		open = false;
		if (refocus) inputEl?.focus();
	}

	function commit(ymd: Ymd) {
		const iso = toIso(ymd);
		if (!inRange(iso)) return;
		value = iso;
		typedInvalid = false;
		onchange?.(iso);
		closePanel();
	}

	function commitTyped() {
		if (text.trim() === '') {
			value = '';
			typedInvalid = false;
			onchange?.('');
			return;
		}
		const parsed = parseLoose(text);
		if (parsed && inRange(toIso(parsed))) {
			value = toIso(parsed);
			text = value;
			typedInvalid = false;
			onchange?.(value);
		} else {
			typedInvalid = true;
		}
	}

	function monthMatrix(y: number, m: number): (Ymd | null)[] {
		const first = new Date(y, m, 1);
		const lead = (first.getDay() + 6) % 7;
		const daysInMonth = new Date(y, m + 1, 0).getDate();
		const cells: (Ymd | null)[] = Array(lead).fill(null);
		for (let d = 1; d <= daysInMonth; d += 1) cells.push({ y, m, d });
		while (cells.length % 7 !== 0) cells.push(null);
		return cells;
	}

	function shiftMonth(delta: number) {
		const date = new Date(focusYmd.y, focusYmd.m + delta, 1);
		focusYmd = { y: date.getFullYear(), m: date.getMonth(), d: 1 };
	}

	function openYears() {
		yearPageStart = focusYmd.y - (focusYmd.y % 12);
		view = 'years';
	}

	function moveFocusDay(delta: number) {
		const date = new Date(focusYmd.y, focusYmd.m, focusYmd.d + delta);
		focusYmd = { y: date.getFullYear(), m: date.getMonth(), d: date.getDate() };
		tick().then(() => {
			panel?.querySelector<HTMLButtonElement>('[data-focus-target]')?.focus();
		});
	}

	function onGridKeydown(event: KeyboardEvent) {
		const moves: Record<string, number> = {
			ArrowLeft: -1,
			ArrowRight: 1,
			ArrowUp: -7,
			ArrowDown: 7
		};
		if (event.key in moves) {
			event.preventDefault();
			moveFocusDay(moves[event.key]);
		} else if (event.key === 'PageUp') {
			event.preventDefault();
			shiftMonth(event.shiftKey ? -12 : -1);
		} else if (event.key === 'PageDown') {
			event.preventDefault();
			shiftMonth(event.shiftKey ? 12 : 1);
		}
	}

	// A view switch replaces the focused element, firing focusout with no
	// related target; only a real focus move outside the picker closes it
	// (outside pointer clicks and Escape have their own handlers).
	function onRootFocusout(event: FocusEvent) {
		const next = event.relatedTarget as Node | null;
		if (open && root && next && !root.contains(next)) closePanel(false);
	}

	async function switchView(next: 'days' | 'months' | 'years') {
		view = next;
		await tick();
		panel?.querySelector<HTMLButtonElement>('.head__label')?.focus();
	}

	function onWindowPointerdown(event: PointerEvent) {
		if (open && root && !root.contains(event.target as Node)) closePanel(false);
	}

	const selected = $derived(parseIso(value));
	const today = todayYmd();
	const todayIso = toIso(today);
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

{#if useNative}
	<input
		class="ui-control"
		type="date"
		bind:value
		{min}
		{max}
		{id}
		{disabled}
		aria-describedby={describedBy}
		aria-invalid={invalid || undefined}
		onchange={() => onchange?.(value)} />
{:else}
	<div
		class="picker"
		bind:this={root}
		onfocusout={onRootFocusout}>
		<div class="ui-input-wrap ui-input-wrap--trailing">
			<input
				class="ui-control"
				type="text"
				inputmode="numeric"
				placeholder="YYYY-MM-DD"
				autocomplete="off"
				bind:this={inputEl}
				bind:value={text}
				{id}
				{disabled}
				aria-describedby={describedBy}
				aria-invalid={invalid || typedInvalid || undefined}
				onblur={commitTyped}
				onkeydown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						commitTyped();
					} else if (event.key === 'ArrowDown' && !open) {
						event.preventDefault();
						openPanel();
					} else if (event.key === 'Escape' && open) {
						closePanel();
					}
				}} />
			<button
				type="button"
				class="ui-input-wrap__action"
				aria-label={`Choose ${label} from calendar`}
				aria-expanded={open}
				{disabled}
				onclick={() => (open ? closePanel() : openPanel())}>
				<Calendar size={15} />
			</button>
		</div>

		{#if open}
			<div
				class="panel"
				class:panel--placed={placed}
				bind:this={panel}
				role="dialog"
				tabindex="-1"
				aria-label={`Choose ${label}`}
				onkeydown={(event) => {
					if (event.key === 'Escape') {
						event.stopPropagation();
						closePanel();
					}
				}}>
				<header class="head">
					<button
						type="button"
						class="nav"
						aria-label={view === 'years' ? 'Earlier years' : 'Previous month'}
						onclick={() => (view === 'years' ? (yearPageStart -= 12) : shiftMonth(-1))}>
						<ChevronLeft size={15} />
					</button>
					{#if view === 'days'}
						<button type="button" class="head__label" onclick={() => switchView('months')}>
							{MONTHS[focusYmd.m]}
							{focusYmd.y}
						</button>
					{:else if view === 'months'}
						<button
							type="button"
							class="head__label"
							onclick={() => {
								openYears();
								switchView('years');
							}}>{focusYmd.y}</button>
					{:else}
						<span class="head__label head__label--static">{yearPageStart}–{yearPageStart + 11}</span>
					{/if}
					<button
						type="button"
						class="nav"
						aria-label={view === 'years' ? 'Later years' : 'Next month'}
						onclick={() => (view === 'years' ? (yearPageStart += 12) : shiftMonth(1))}>
						<ChevronRight size={15} />
					</button>
				</header>

				{#if view === 'days'}
					<div class="weekdays" aria-hidden="true">
						{#each WEEKDAYS as day (day)}<span>{day}</span>{/each}
					</div>
					<div class="grid grid--days" role="group" aria-label="Days">
						{#each monthMatrix(focusYmd.y, focusYmd.m) as cell, index (index)}
							{#if cell}
								{@const iso = toIso(cell)}
								{@const isFocus = cell.d === focusYmd.d && cell.m === focusYmd.m && cell.y === focusYmd.y}
								<button
									type="button"
									class="day"
									class:day--today={iso === todayIso}
									class:day--selected={iso === value}
									aria-pressed={iso === value}
									data-focus-target={isFocus ? true : undefined}
									tabindex={isFocus ? 0 : -1}
									disabled={!inRange(iso)}
									onkeydown={onGridKeydown}
									onclick={() => commit(cell)}>{cell.d}</button>
							{:else}
								<span></span>
							{/if}
						{/each}
					</div>
					<footer class="foot">
						<button
							type="button"
							class="foot__today"
							disabled={!inRange(todayIso)}
							onclick={() => commit(today)}>Today</button>
					</footer>
				{:else if view === 'months'}
					<div class="grid grid--months">
						{#each MONTHS as month, index (month)}
							{@const monthEnd = toIso({ y: focusYmd.y, m: index, d: new Date(focusYmd.y, index + 1, 0).getDate() })}
							{@const monthStart = toIso({ y: focusYmd.y, m: index, d: 1 })}
							<button
								type="button"
								class="cell"
								class:cell--current={index === focusYmd.m && selected?.y === focusYmd.y}
								disabled={(min !== undefined && monthEnd < min) || (max !== undefined && monthStart > max)}
								onclick={() => {
									focusYmd = { y: focusYmd.y, m: index, d: 1 };
									switchView('days');
								}}>{month.slice(0, 3)}</button>
						{/each}
					</div>
				{:else}
					<div class="grid grid--months">
						{#each Array(12) as _, index (index)}
							{@const year = yearPageStart + index}
							<button
								type="button"
								class="cell"
								class:cell--current={year === focusYmd.y}
								disabled={(min !== undefined && `${year}-12-31` < min) || (max !== undefined && `${year}-01-01` > max)}
								onclick={() => {
									focusYmd = { y: year, m: focusYmd.m, d: 1 };
									switchView('months');
								}}>{year}</button>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.picker {
		position: relative;
	}

	/* One fixed compact geometry for all three views: the panel can never grow
	   with content, so the shared anchored placement holds across view switches.
	   Fixed + top layer (see openPanel), so no ancestor overflow can clip it;
	   hidden until placed so the measuring frame never paints at the origin. */
	.panel {
		position: fixed;
		inset: auto;
		z-index: 60;
		inline-size: 17.5rem;
		max-inline-size: calc(100vw - var(--je-space-8));
		margin: 0;
		padding: var(--je-space-2);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		box-shadow: var(--je-shadow-md);
		visibility: hidden;
	}

	.panel--placed {
		visibility: visible;
	}

	.head {
		display: flex;
		align-items: center;
		gap: var(--je-space-1);
		margin-block-end: var(--je-space-1);
	}

	.nav {
		display: grid;
		place-items: center;
		inline-size: 2rem;
		block-size: 2rem;
		border: 0;
		border-radius: var(--je-radius-control);
		background: transparent;
		color: var(--je-color-text-muted);
		cursor: pointer;
	}

	.nav:hover {
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text);
	}

	.head__label {
		flex: 1;
		border: 0;
		background: transparent;
		padding: var(--je-space-1);
		border-radius: var(--je-radius-control);
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-text);
		cursor: pointer;
	}

	.head__label:hover:not(.head__label--static) {
		background: var(--je-color-surface-sunken);
	}

	.head__label--static {
		cursor: default;
	}

	.weekdays {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		margin-block-end: var(--je-space-1);
	}

	.weekdays span {
		text-align: center;
		font-size: var(--je-font-size-2xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.grid--days {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
	}

	.day {
		display: grid;
		place-items: center;
		block-size: 2.25rem;
		border: 0;
		border-radius: var(--je-radius-control);
		background: transparent;
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text);
		cursor: pointer;
	}

	.day:hover:not(:disabled) {
		background: var(--je-color-surface-sunken);
	}

	.day--today {
		box-shadow: inset 0 0 0 1px var(--je-color-border-strong);
	}

	.day--selected {
		background: var(--je-color-mark-ink);
		color: var(--je-color-mark-contrast);
		font-weight: 650;
	}

	.day--selected:hover:not(:disabled) {
		background: var(--je-color-mark-ink-hover);
	}

	.day:disabled {
		color: var(--je-color-text-disabled);
		cursor: not-allowed;
	}

	.grid--months {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--je-space-1);
	}

	.cell {
		block-size: 2.5rem;
		border: 0;
		border-radius: var(--je-radius-control);
		background: transparent;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text);
		cursor: pointer;
	}

	.cell:hover:not(:disabled) {
		background: var(--je-color-surface-sunken);
	}

	.cell--current {
		box-shadow: inset 0 0 0 1px var(--je-color-mark-border);
		font-weight: 650;
	}

	.cell:disabled {
		color: var(--je-color-text-disabled);
		cursor: not-allowed;
	}

	.foot {
		display: flex;
		justify-content: center;
		margin-block-start: var(--je-space-1);
		border-block-start: 1px solid var(--je-color-border);
		padding-block-start: var(--je-space-1);
	}

	.foot__today {
		border: 0;
		background: transparent;
		padding: var(--je-space-1) var(--je-space-2);
		border-radius: var(--je-radius-control);
		font-size: var(--je-font-size-xs);
		font-weight: 650;
		color: var(--je-color-link);
		cursor: pointer;
	}

	.foot__today:hover:not(:disabled) {
		background: var(--je-color-surface-sunken);
	}

	.foot__today:disabled {
		color: var(--je-color-text-disabled);
		cursor: not-allowed;
	}
</style>
