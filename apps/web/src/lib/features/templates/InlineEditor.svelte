<script lang="ts">
	/**
	 * The one mini-editor behind every addressable unit of a template preview.
	 *
	 * One component, two presentations. With a fine pointer it floats beside
	 * the unit through the shared anchored/top-layer machinery — below it, or
	 * above when that is the side with room, never over it. On a coarse
	 * pointer, or a viewport too narrow to stand a panel beside anything, it
	 * docks as a bottom sheet and the unit stays visible above the controls.
	 *
	 * Editing is live-to-view: every keystroke and control change is emitted
	 * through `onchange` so the host re-renders the preview immediately, while
	 * nothing commits until Done (`oncommit`). Escape and an outside press
	 * close without applying, and the host snaps the preview back.
	 */
	import { tick } from 'svelte';
	import { ChevronDown } from 'lucide-svelte';
	import { Button, Checkbox, Radio } from '$lib/ui';
	import { ANCHOR_EDGE, lower, placeNear, raise } from '$lib/ui/anchored.svelte';
	import type { FieldContext, MergeFieldDef, RegistryField } from '$lib/api/types';
	import type { InlineEditResult, InlineUnit, RosterKnobs, ScheduleKnobs } from './inline-edit';
	import {
		SIZE_MAX,
		SIZE_MIN,
		allSizes,
		clampSize,
		filledTextStyle,
		normalizeTextStyle,
		sizeLadder
	} from './text-style';

	interface Props {
		unit: InlineUnit;
		/** The annotated element the press landed on; the floating panel anchors to it. */
		anchor: HTMLElement;
		/** The template's declared tokens, for the merge and variable pickers. */
		mergeFields?: MergeFieldDef[];
		/** The registry record behind a `field` unit. */
		field?: RegistryField | null;
		/** True while the host is committing this session's result. */
		busy?: boolean;
		/** Fired on every change of the session's working values, for live preview. */
		onchange?: (result: InlineEditResult) => void;
		oncommit: (result: InlineEditResult) => void;
		oncancel: () => void;
	}

	let {
		unit,
		anchor,
		mergeFields = [],
		field = null,
		busy = false,
		onchange,
		oncommit,
		oncancel
	}: Props = $props();

	const uid = $props.id();

	/* The same presentation split ProfilePeek established: a coarse pointer, or
	   a viewport too narrow to hold a panel beside the unit, gets the sheet.
	   Read live: a rotation changes which presentation is on screen. */
	const SHEET_QUERY = '(pointer: coarse), (max-width: 719.98px)';
	let asSheet = $state(typeof window !== 'undefined' && window.matchMedia(SHEET_QUERY).matches);
	$effect(() => {
		const query = window.matchMedia(SHEET_QUERY);
		const sync = () => (asSheet = query.matches);
		sync();
		query.addEventListener('change', sync);
		return () => query.removeEventListener('change', sync);
	});

	let panel = $state<HTMLElement>();
	let placed = $state(false);

	// The session's working copy, seeded once per unit — the host keys this
	// component by unit path, so a new unit is a new editor session.
	let textValue = $state('');
	let swapKey = $state('');
	let insertKey = $state('');
	let knobs = $state<ScheduleKnobs>({
		grouping: 'day',
		density: 'cozy',
		showRoom: true,
		showTrack: true,
		showSpeakers: true
	});
	let rosterKnobs = $state<RosterKnobs>({
		layout: 'grid',
		grouping: 'category',
		density: 'cozy',
		showHeadline: true,
		showSessions: true,
		showLinks: true
	});
	let fieldLabel = $state('');
	let fieldHelp = $state('');
	let fieldOptions = $state('');
	let fieldRequired = $state<Partial<Record<FieldContext, boolean>>>({});
	// Style tags, seeded default-filled so the current value is always shown.
	let styleSize = $state(16);
	let styleWeight = $state<'regular' | 'semibold'>('regular');
	let styleAlign = $state<'start' | 'center'>('start');

	function seedSession(from: InlineUnit, record: RegistryField | null) {
		if (from.type === 'text') {
			textValue = from.value;
			if (from.styleKind) {
				const filled = filledTextStyle(from.styleKind, from.style);
				styleSize = filled.size;
				styleWeight = filled.weight;
				styleAlign = filled.align;
			}
		} else if (from.type === 'merge') swapKey = from.key;
		else if (from.type === 'knobs') knobs = { ...from.knobs };
		else if (from.type === 'roster-knobs') rosterKnobs = { ...from.knobs };
		else if (record) {
			fieldLabel = record.label;
			fieldHelp = record.help ?? '';
			fieldOptions = (record.options ?? []).join('\n');
			fieldRequired = Object.fromEntries(
				record.collectAt.map((context) => [context, Boolean(record.required[context])])
			);
		}
	}

	// Seeded once per session on purpose: the host keys this component by unit,
	// so a fresh unit mounts a fresh editor carrying that unit's opening values.
	// svelte-ignore state_referenced_locally
	seedSession(unit, field);

	const title = $derived(
		unit.type === 'text'
			? `${unit.noun.charAt(0).toUpperCase()}${unit.noun.slice(1)}`
			: unit.type === 'merge'
				? 'Merge field'
				: unit.type === 'knobs'
					? 'Schedule layout'
					: unit.type === 'roster-knobs'
						? 'Roster layout'
						: 'Question'
	);

	const requiredLabels: Record<FieldContext, string> = {
		apply: 'Required at application',
		onboard: 'Required at onboarding',
		profile: 'Required in profile'
	};

	// -----------------------------------------------------------------------
	// The tiered size picker: recommended sizes lead, the full bounded range
	// and exact entry sit one step deeper, unbounded exists nowhere.

	const ladder = $derived(unit.type === 'text' && unit.styleKind ? sizeLadder(unit.styleKind) : null);
	const denseSizes = allSizes();
	let sizeOpen = $state(false);
	let sizeTriggerEl = $state<HTMLButtonElement>();
	let sizeListEl = $state<HTMLElement>();
	let sizePanelEl = $state<HTMLElement>();
	let sizeScrimEl = $state<HTMLElement>();

	function closeSizePicker(refocusTrigger: boolean) {
		if (!sizeOpen) return;
		sizeOpen = false;
		if (refocusTrigger) sizeTriggerEl?.focus();
	}

	// On a coarse pointer the picker overlays as a top sheet in the top layer —
	// the same shape as the timezone picker, and for the same reason: the sheet
	// scrolls, an in-flow panel reflows it, and the virtual keyboard summoned by
	// the Custom entry would cover a bottom-docked panel. The scrim goes up
	// first so the panel paints above it.
	$effect(() => {
		if (!sizeOpen || !asSheet || !sizePanelEl) return;
		raise(sizeScrimEl);
		raise(sizePanelEl);
		const size = () => {
			const viewport = window.visualViewport?.height ?? window.innerHeight;
			if (sizePanelEl) sizePanelEl.style.maxBlockSize = `${Math.max(160, viewport - 16)}px`;
		};
		size();
		window.visualViewport?.addEventListener('resize', size);
		return () => {
			window.visualViewport?.removeEventListener('resize', size);
			lower(sizePanelEl);
			lower(sizeScrimEl);
		};
	});

	function pickSize(px: number) {
		styleSize = clampSize(px);
		closeSizePicker(true);
	}

	// Opening lands focus on the current value's option (recommended tier
	// first), so arrows continue from where the unit already is.
	$effect(() => {
		if (!sizeOpen || !sizeListEl) return;
		const current = sizeListEl.querySelector<HTMLElement>('[aria-selected="true"]');
		(current ?? sizeListEl.querySelector<HTMLElement>('[role="option"]'))?.focus();
	});

	function onSizeListKeydown(event: KeyboardEvent) {
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
		const options = Array.from(sizeListEl?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
		if (options.length === 0) return;
		event.preventDefault();
		const index = options.indexOf(document.activeElement as HTMLElement);
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? options.length - 1
					: event.key === 'ArrowDown'
						? index < 0
							? 0
							: Math.min(options.length - 1, index + 1)
						: index < 0
							? options.length - 1
							: Math.max(0, index - 1);
		options[next]?.focus();
	}

	function applyCustomSize(input: HTMLInputElement) {
		const value = input.valueAsNumber;
		if (!Number.isFinite(value)) {
			input.value = String(styleSize);
			return;
		}
		styleSize = clampSize(value);
		input.value = String(styleSize);
	}

	function onCustomSizeKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter') return;
		// The editor is a form; Enter here picks the size, never submits Done.
		event.preventDefault();
		applyCustomSize(event.currentTarget as HTMLInputElement);
		closeSizePicker(true);
	}

	// -----------------------------------------------------------------------
	// Variable insertion: suggested keys as one-press chips, every declared
	// key one step deeper. Insertion at the caret is the only action here.

	const insertableVars = $derived(
		unit.type === 'text' && unit.suggestedVars !== undefined && mergeFields.length > 0
	);
	const suggestedDefs = $derived(
		unit.type === 'text'
			? (unit.suggestedVars ?? []).flatMap((key) => {
					const def = mergeFields.find((entry) => entry.key === key);
					return def ? [def] : [];
				})
			: []
	);
	let textEl = $state<HTMLInputElement | HTMLTextAreaElement>();
	let varPick = $state('');

	function insertVar(key: string) {
		const token = `{{${key}}}`;
		const el = textEl;
		if (el) {
			// Insert through the browser's own edit pipeline so the field's native
			// undo history records the press — Ctrl/Cmd+Z takes the chip back like
			// any typed text. The fired input event keeps the binding in sync.
			const start = el.selectionStart ?? textValue.length;
			const end = el.selectionEnd ?? textValue.length;
			el.focus();
			el.setSelectionRange(start, end);
			if (document.execCommand('insertText', false, token)) return;
		}
		// Fallback for engines that refuse the command: splice without undo.
		const start = el?.selectionStart ?? textValue.length;
		const end = el?.selectionEnd ?? textValue.length;
		textValue = `${textValue.slice(0, start)}${token}${textValue.slice(end)}`;
		const caret = start + token.length;
		void tick().then(() => {
			el?.focus();
			el?.setSelectionRange(caret, caret);
		});
	}

	function onVarPick() {
		if (varPick) insertVar(varPick);
		varPick = '';
	}

	// -----------------------------------------------------------------------

	function place() {
		if (!panel) return;
		if (asSheet) {
			panel.style.top = '';
			panel.style.left = '';
			placed = true;
			return;
		}
		placeNear(anchor, panel);
		// A unit can be taller than the room on either side of it — the whole
		// schedule listing is one unit — and then the shared placement leaves
		// the panel past the viewport's bottom edge. Clamp it back on screen;
		// partially overlapping a viewport-sized unit is the only option left.
		const box = panel.getBoundingClientRect();
		const over = box.bottom - (window.innerHeight - ANCHOR_EDGE);
		if (over > 0) panel.style.top = `${parseFloat(panel.style.top || '0') - over}px`;
		placed = true;
	}

	$effect(() => {
		if (!panel) return;
		raise(panel);
		place();
		return () => lower(panel);
	});

	// Focus lands on the session's first control once the panel has a position.
	$effect(() => {
		if (!panel || !placed) return;
		panel.querySelector<HTMLElement>('textarea, input, select, button')?.focus();
	});

	// A scroll anywhere between the unit and the viewport moves the anchor.
	$effect(() => {
		if (asSheet) return;
		const reposition = () => place();
		document.addEventListener('scroll', reposition, { capture: true, passive: true });
		window.addEventListener('resize', reposition);
		return () => {
			document.removeEventListener('scroll', reposition, { capture: true });
			window.removeEventListener('resize', reposition);
		};
	});

	// Live preview changes the unit's own box — a longer heading wraps taller —
	// so the anchor is watched, and the panel follows it rather than drifting.
	$effect(() => {
		if (asSheet) return;
		const observer = new ResizeObserver(() => place());
		observer.observe(anchor);
		return () => observer.disconnect();
	});

	/** The session's current values as the one result shape both emits share. */
	function sessionResult(): InlineEditResult {
		if (unit.type === 'text') {
			return {
				type: 'text',
				value: textValue,
				...(unit.styleKind
					? {
							style: normalizeTextStyle(unit.styleKind, {
								size: styleSize,
								weight: styleWeight,
								align: styleAlign
							})
						}
					: {})
			};
		}
		if (unit.type === 'merge') return { type: 'merge', swapKey, insertKey };
		if (unit.type === 'knobs') return { type: 'knobs', knobs: { ...$state.snapshot(knobs) } };
		if (unit.type === 'roster-knobs') {
			return { type: 'roster-knobs', knobs: { ...$state.snapshot(rosterKnobs) } };
		}
		const options = fieldOptions
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
		const required: Partial<Record<FieldContext, boolean>> = {};
		for (const context of field?.collectAt ?? []) {
			if (fieldRequired[context]) required[context] = true;
		}
		return {
			type: 'field',
			patch: {
				label: fieldLabel.trim() || (field?.label ?? ''),
				help: fieldHelp.trim(),
				...(field?.options ? { options } : {}),
				required
			}
		};
	}

	// Immediate to view, explicit to finalize: every change of the session's
	// working values re-renders the preview through the host. The effect reads
	// them all via sessionResult, so any keystroke or control press re-fires.
	$effect(() => {
		onchange?.(sessionResult());
	});

	function onWindowPointerdown(event: PointerEvent) {
		const target = event.target as Node;
		const element = event.target as Element | null;
		// The scrim belongs to the picker: pressing it closes the picker and
		// nothing else — the editor underneath stays open.
		if (element?.closest?.('.szp__scrim')) {
			closeSizePicker(true);
			return;
		}
		// A press outside the open size picker closes the picker; whether it
		// also closes the editor follows from where the press landed.
		if (sizeOpen && !element?.closest?.('.szp')) closeSizePicker(false);
		if (panel?.contains(target) || anchor.contains(target)) return;
		oncancel();
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.stopPropagation();
		// Layered: the first Escape closes the picker, the next the editor.
		if (sizeOpen) {
			closeSizePicker(true);
			return;
		}
		oncancel();
	}

	function apply(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		oncommit(sessionResult());
	}
</script>

<svelte:window onpointerdown={onWindowPointerdown} onkeydown={onWindowKeydown} />

<div
	class="ied"
	class:ied--sheet={asSheet}
	class:ied--placed={placed}
	role="dialog"
	aria-label={`Edit ${unit.type === 'text' ? unit.noun : title.toLowerCase()}`}
	bind:this={panel}>
	<form class="ied__form" onsubmit={apply}>
		<p class="ied__title">{title}</p>

		{#if unit.type === 'text'}
			<label class="ui-sr-only" for="{uid}-text">{title}</label>
			{#if unit.multiline}
				<textarea
					id="{uid}-text"
					class="ui-control ied__textarea"
					rows="4"
					bind:this={textEl}
					bind:value={textValue}></textarea>
			{:else}
				<input id="{uid}-text" class="ui-control" type="text" bind:this={textEl} bind:value={textValue} />
			{/if}
			{#if insertableVars}
				<!-- Insertion only: the best keys for this box are one press, the
				     whole declared set one step deeper. Management lives elsewhere. -->
				<div class="ied__stack">
					<span class="ied__legend" id="{uid}-vars">Variables</span>
					<div class="ied__vars" role="group" aria-labelledby="{uid}-vars">
						{#each suggestedDefs as def (def.key)}
							<button
								type="button"
								class="ied__chip"
								aria-label={`Insert ${def.label.toLowerCase()}`}
								onclick={() => insertVar(def.key)}>
								{def.label}
							</button>
						{/each}
						<label class="ui-sr-only" for="{uid}-vars-all">All variables</label>
						<select id="{uid}-vars-all" class="ui-select ied__vars-all" bind:value={varPick} onchange={onVarPick}>
							<option value="">All variables…</option>
							{#each mergeFields as def (def.key)}
								<option value={def.key}>{def.label} · {def.key}</option>
							{/each}
						</select>
					</div>
				</div>
			{/if}
			{#if unit.styleKind && ladder}
				<!-- Bounded style tags, never free CSS: the size is a clamped px
				     number, recommended steps first, the full range one step deeper. -->
				<div class="szp">
					<div class="ied__row">
						<span class="ied__legend" id="{uid}-style-size">Size</span>
						<button
							type="button"
							class="szp__trigger"
							bind:this={sizeTriggerEl}
							aria-label={`Size: ${styleSize} px`}
							aria-haspopup="listbox"
							aria-expanded={sizeOpen}
							onclick={() => (sizeOpen = !sizeOpen)}>
							<span class="szp__value">{styleSize} px</span>
							<span class="szp__chevron" class:szp__chevron--open={sizeOpen} aria-hidden="true">
								<ChevronDown size={14} />
							</span>
						</button>
					</div>
					{#if sizeOpen}
						{#if asSheet}
							<button
								type="button"
								class="szp__scrim"
								bind:this={sizeScrimEl}
								aria-hidden="true"
								tabindex="-1"></button>
						{/if}
						<div class="szp__panel" class:szp__panel--sheet={asSheet} bind:this={sizePanelEl}>
							<!-- Focus lives on the option buttons; the listbox itself is
							     focusable only programmatically, for completeness. -->
							<div
								class="szp__list"
								role="listbox"
								aria-label="Text size"
								tabindex="-1"
								bind:this={sizeListEl}
								onkeydown={onSizeListKeydown}>
								<div role="group" aria-label="Recommended">
									<p class="szp__tier" aria-hidden="true">Recommended</p>
									{#each ladder.recommended as px (px)}
										<button
											type="button"
											class="szp__option"
											role="option"
											aria-selected={styleSize === px}
											onclick={() => pickSize(px)}>
											<span>{px} px</span>
											{#if px === ladder.base}<span class="szp__hint">Default</span>{/if}
										</button>
									{/each}
								</div>
								<hr class="szp__rule" />
								<div role="group" aria-label="All sizes">
									<p class="szp__tier" aria-hidden="true">All sizes</p>
									<div class="szp__all">
										{#each denseSizes as px (px)}
											<button
												type="button"
												class="szp__option szp__option--dense"
												role="option"
												aria-selected={styleSize === px}
												onclick={() => pickSize(px)}>
												{px} px
											</button>
										{/each}
									</div>
								</div>
							</div>
							<div class="szp__custom">
								<label class="ied__legend" for="{uid}-size-custom">Custom</label>
								<input
									id="{uid}-size-custom"
									class="ui-control szp__input"
									type="number"
									min={SIZE_MIN}
									max={SIZE_MAX}
									step="1"
									value={styleSize}
									onchange={(event) => applyCustomSize(event.currentTarget)}
									onkeydown={onCustomSizeKeydown} />
							</div>
						</div>
					{/if}
				</div>
				<div class="ied__row">
					<span class="ied__legend" id="{uid}-style-weight">Weight</span>
					<div class="ui-segmented" role="group" aria-labelledby="{uid}-style-weight">
						<button
							type="button"
							class="ui-segmented__item"
							aria-pressed={styleWeight === 'regular'}
							onclick={() => (styleWeight = 'regular')}>Regular</button>
						<button
							type="button"
							class="ui-segmented__item"
							aria-pressed={styleWeight === 'semibold'}
							onclick={() => (styleWeight = 'semibold')}>Semibold</button>
					</div>
				</div>
				<div class="ied__row">
					<span class="ied__legend" id="{uid}-style-align">Align</span>
					<div class="ui-segmented" role="group" aria-labelledby="{uid}-style-align">
						<button
							type="button"
							class="ui-segmented__item"
							aria-pressed={styleAlign === 'start'}
							onclick={() => (styleAlign = 'start')}>Start</button>
						<button
							type="button"
							class="ui-segmented__item"
							aria-pressed={styleAlign === 'center'}
							onclick={() => (styleAlign = 'center')}>Center</button>
					</div>
				</div>
			{/if}
		{:else if unit.type === 'merge'}
			<fieldset class="ied__group">
				<legend class="ied__legend">This field</legend>
				{#each mergeFields as def (def.key)}
					<Radio name="{uid}-swap" value={def.key} bind:group={swapKey} label={def.label} description={def.sample} />
				{/each}
			</fieldset>
			<div class="ied__stack">
				<label class="ied__legend" for="{uid}-insert">Insert another field…</label>
				<select id="{uid}-insert" class="ui-select" bind:value={insertKey}>
					<option value="">Nothing extra</option>
					{#each mergeFields as def (def.key)}
						<option value={def.key}>{def.label}</option>
					{/each}
				</select>
			</div>
		{:else if unit.type === 'knobs'}
			<div class="ied__row">
				<span class="ied__legend" id="{uid}-grouping">Group by</span>
				<div class="ui-segmented" role="group" aria-labelledby="{uid}-grouping">
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={knobs.grouping === 'day'}
						onclick={() => (knobs.grouping = 'day')}>Day</button>
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={knobs.grouping === 'track'}
						onclick={() => (knobs.grouping = 'track')}>Track</button>
				</div>
			</div>
			<div class="ied__row">
				<span class="ied__legend" id="{uid}-density">Density</span>
				<div class="ui-segmented" role="group" aria-labelledby="{uid}-density">
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={knobs.density === 'cozy'}
						onclick={() => (knobs.density = 'cozy')}>Cozy</button>
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={knobs.density === 'compact'}
						onclick={() => (knobs.density = 'compact')}>Compact</button>
				</div>
			</div>
			<fieldset class="ied__group">
				<legend class="ied__legend">Show</legend>
				<Checkbox label="Rooms" bind:checked={knobs.showRoom} />
				<Checkbox label="Track chips" bind:checked={knobs.showTrack} />
				<Checkbox label="Speakers" bind:checked={knobs.showSpeakers} />
			</fieldset>
		{:else if unit.type === 'roster-knobs'}
			<div class="ied__row">
				<span class="ied__legend" id="{uid}-layout">Layout</span>
				<div class="ui-segmented" role="group" aria-labelledby="{uid}-layout">
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={rosterKnobs.layout === 'grid'}
						onclick={() => (rosterKnobs.layout = 'grid')}>Cards</button>
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={rosterKnobs.layout === 'list'}
						onclick={() => (rosterKnobs.layout = 'list')}>Rows</button>
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={rosterKnobs.layout === 'strip'}
						onclick={() => (rosterKnobs.layout = 'strip')}>Names</button>
				</div>
			</div>
			<div class="ied__row">
				<span class="ied__legend" id="{uid}-rgrouping">Group by</span>
				<div class="ui-segmented" role="group" aria-labelledby="{uid}-rgrouping">
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={rosterKnobs.grouping === 'none'}
						onclick={() => (rosterKnobs.grouping = 'none')}>One list</button>
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={rosterKnobs.grouping === 'category'}
						onclick={() => (rosterKnobs.grouping = 'category')}>Speaker group</button>
				</div>
			</div>
			<div class="ied__row">
				<span class="ied__legend" id="{uid}-rdensity">Density</span>
				<div class="ui-segmented" role="group" aria-labelledby="{uid}-rdensity">
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={rosterKnobs.density === 'cozy'}
						onclick={() => (rosterKnobs.density = 'cozy')}>Cozy</button>
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={rosterKnobs.density === 'compact'}
						onclick={() => (rosterKnobs.density = 'compact')}>Compact</button>
				</div>
			</div>
			<fieldset class="ied__group">
				<legend class="ied__legend">Show</legend>
				<Checkbox label="One-line bio" bind:checked={rosterKnobs.showHeadline} />
				<Checkbox label="Their sessions" bind:checked={rosterKnobs.showSessions} />
				<Checkbox label="Their links" bind:checked={rosterKnobs.showLinks} />
			</fieldset>
			<!-- Who is on the lineup and what order they are in is roster state,
			     shared by every presentation of it; this panel only decides how it
			     is laid out. The door says where the other half lives. -->
			<p class="ied__aside">
				Order and grouping come from <a href="/app/speakers?view=lineup">the lineup</a>.
			</p>
		{:else}
			<div class="ied__stack">
				<label class="ied__legend" for="{uid}-label">Label</label>
				<input id="{uid}-label" class="ui-control" type="text" bind:value={fieldLabel} />
			</div>
			<div class="ied__stack">
				<label class="ied__legend" for="{uid}-help">Help text</label>
				<input id="{uid}-help" class="ui-control" type="text" bind:value={fieldHelp} />
			</div>
			{#if field?.optionSource}
				<!-- Sourced options are the event vocabulary, not text to retype:
				     the definition lives in Settings, per-form exposure with the form. -->
				<p class="ied__note">
					Options come from your event's {field.optionSource} — manage them in Settings, or choose
					which ones a form offers on its Forms page.
				</p>
			{:else if field?.options}
				<div class="ied__stack">
					<label class="ied__legend" for="{uid}-options">Options — one per line</label>
					<textarea
						id="{uid}-options"
						class="ui-control ied__textarea"
						rows="4"
						bind:value={fieldOptions}></textarea>
				</div>
			{/if}
			<fieldset class="ied__group">
				<legend class="ied__legend">Required</legend>
				{#each field?.collectAt ?? [] as context (context)}
					<Checkbox label={requiredLabels[context]} bind:checked={fieldRequired[context]} />
				{/each}
			</fieldset>
			<p class="ied__note">One registry: this question changes everywhere it’s asked.</p>
		{/if}

		<div class="ied__actions">
			<Button type="submit" size="sm" loading={busy}>Done</Button>
			<Button type="button" variant="ghost" size="sm" disabled={busy} onclick={oncancel}>
				Cancel
			</Button>
		</div>
	</form>
</div>

<style>
	.ied {
		position: fixed;
		/* Placed by script; the popover UA box is neutralised rather than
		   inherited. The z-index only matters where the top layer is unavailable. */
		inset: auto;
		margin: 0;
		overflow: visible;
		z-index: 70;
		inline-size: 21rem;
		max-inline-size: calc(100vw - 1rem);
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-md);
		color: var(--je-color-text);
		text-align: start;
		/* Measured before it is seen: the first frame is laid out, not painted. */
		visibility: hidden;
	}

	.ied--placed {
		visibility: visible;
	}

	/* The sheet: docked to the bottom edge, full width, the unit visible above.
	   Long control lists scroll inside the sheet, never the document. */
	.ied--sheet {
		inset: auto 0 0 0;
		inline-size: 100%;
		max-inline-size: none;
		max-block-size: 70vh;
		overflow-y: auto;
		border-inline: 0;
		border-block-end: 0;
		border-radius: var(--je-radius-surface) var(--je-radius-surface) 0 0;
		box-shadow: var(--je-shadow-lg);
		padding: var(--je-space-4);
		padding-block-end: calc(var(--je-space-4) + env(safe-area-inset-bottom, 0px));
	}

	.ied__form {
		display: grid;
		gap: var(--je-space-3);
	}

	.ied__title {
		margin: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.ied__textarea {
		block-size: auto;
		min-block-size: 5.5rem;
		padding: var(--je-space-2) var(--je-space-3);
		resize: vertical;
	}

	.ied__group {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		border: 0;
		min-inline-size: 0;
	}

	.ied__stack {
		display: grid;
		gap: var(--je-space-1);
	}

	.ied__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-2);
	}

	.ied__legend {
		display: block;
		padding: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.ied__note {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* One quiet line naming the surface that owns the half this panel does not. */
	.ied__aside {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.ied__actions {
		display: flex;
		gap: var(--je-space-2);
	}

	/* Variables: suggested chips and the whole set share one quiet row. */
	.ied__vars {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1);
	}

	.ied__chip {
		display: inline-flex;
		align-items: center;
		padding: 0.125rem var(--je-space-2);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-round);
		background: var(--je-color-surface);
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		cursor: pointer;
		transition:
			background var(--je-duration-fast) var(--je-ease),
			border-color var(--je-duration-fast) var(--je-ease),
			color var(--je-duration-fast) var(--je-ease);
	}

	.ied__chip:hover {
		border-color: var(--je-color-border-strong);
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text);
	}

	.ied__chip:active {
		background: var(--je-color-surface-selected);
	}

	.ied__vars-all {
		inline-size: auto;
		max-inline-size: 100%;
		height: var(--je-control-height-sm);
		font-size: var(--je-font-size-xs);
	}

	/* The size picker: a compact px trigger; its panel floats over the rows
	   below beside a fine pointer and expands in flow inside the sheet. */
	.szp {
		position: relative;
		display: grid;
		gap: var(--je-space-2);
	}

	.szp__trigger {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-2);
		block-size: var(--je-control-height-sm);
		padding-inline: var(--je-space-3) var(--je-space-2);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface);
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text);
		cursor: pointer;
	}

	.szp__trigger:hover {
		border-color: var(--je-color-border-strong);
		background: var(--je-color-surface-sunken);
	}

	.szp__chevron {
		display: inline-flex;
		color: var(--je-color-text-subtle);
		transition: transform var(--je-duration-fast) var(--je-ease);
	}

	.szp__chevron--open {
		transform: rotate(180deg);
	}

	.szp__panel {
		position: absolute;
		inset-inline: 0;
		inset-block-start: calc(100% + var(--je-space-1));
		z-index: 2;
		display: grid;
		gap: var(--je-space-2);
		padding: var(--je-space-2);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-md);
	}

	/* On a coarse pointer the panel is a top sheet in the top layer: the
	   popover UA style is fit-content with auto margins, so the sheet states
	   its own edge-to-edge geometry. Top-docked because the Custom entry
	   summons the keyboard, which covers anything docked at the bottom. */
	.szp__panel--sheet {
		position: fixed;
		inset: 0.5rem 0.5rem auto;
		inline-size: auto;
		max-inline-size: none;
		margin: 0;
		overflow: auto;
	}

	.szp__scrim {
		position: fixed;
		inset: 0;
		/* Raised into the top layer, the popover UA style would shrink this to
		   fit-content; explicit auto sizing keeps it covering the viewport. */
		inline-size: auto;
		block-size: auto;
		margin: 0;
		border: 0;
		padding: 0;
		background: color-mix(in srgb, var(--je-color-text) 32%, transparent);
	}

	.szp__list {
		display: grid;
		gap: var(--je-space-1);
	}

	.szp__tier {
		margin: 0 0 var(--je-space-1);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.szp__option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-2);
		inline-size: 100%;
		padding: var(--je-space-1) var(--je-space-2);
		border: 0;
		border-radius: var(--je-radius-control);
		background: transparent;
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text);
		text-align: start;
		cursor: pointer;
	}

	.szp__option:hover {
		background: var(--je-color-surface-sunken);
	}

	.szp__option[aria-selected='true'] {
		background: var(--je-color-mark-surface);
		font-weight: 600;
	}

	.szp__option--dense {
		padding-block: 0.125rem;
	}

	.szp__hint {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.szp__rule {
		inline-size: 100%;
		margin: 0;
		border: 0;
		border-block-start: 1px solid var(--je-color-border);
	}

	/* The full range scrolls in its own strip; the panel never grows past it. */
	.szp__all {
		max-block-size: 9rem;
		overflow-y: auto;
	}

	.szp__custom {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-2);
	}

	.szp__input {
		inline-size: 6rem;
		font-variant-numeric: tabular-nums;
	}
</style>
