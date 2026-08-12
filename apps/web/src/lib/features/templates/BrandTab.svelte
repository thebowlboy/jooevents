<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Field } from '$lib/ui';
	import { useWorkspaceGateway } from '$lib/api/workspace-gateway';
	import { contrastRatio, contrastText } from '$lib/theme/theme-contract';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import type { EventTheme, MessageTemplate } from '$lib/api/types';
	import { brandPresets, matchPreset, themesEqual, type BrandPreset } from './brand-presets';
	import EmailRender from './EmailRender.svelte';

	const { api } = useWorkspaceGateway();

	interface Props {
		/** Called after the brand is stored, so the surrounding page can refresh the copy it renders previews with. */
		onSaved?: () => void;
	}
	let { onSaved }: Props = $props();

	/** The color choices a recipe exposes, in the order a brand is judged. */
	const colorFields = [
		{ key: 'canvas', label: 'Canvas' },
		{ key: 'surface', label: 'Surface' },
		{ key: 'text', label: 'Text' },
		{ key: 'action', label: 'Action' }
	] as const;
	type ColorKey = (typeof colorFields)[number]['key'];

	const hexPattern = /^#[0-9a-f]{6}$/;

	let loaded = $state(false);
	let saved = $state<EventTheme | null>(null);
	let draft = $state<EventTheme | null>(null);
	let previewTemplate = $state<MessageTemplate | null>(null);
	let eventName = $state('Your event');
	let eventMeta = $state('');
	let saving = $state(false);

	onMount(async () => {
		const [theme, templates, summary] = await Promise.all([
			api.theme.get(),
			api.templates.list(),
			api.workspace.summary()
		]);
		saved = { ...theme };
		draft = { ...theme };
		previewTemplate =
			templates.messages.find((template) => template.key === 'decision-accepted') ??
			templates.messages[0] ??
			null;
		if (summary.event) {
			eventName = summary.event.name;
			eventMeta = `${summary.event.dates} · ${summary.event.location}`;
		}
		loaded = true;
	});

	const dirty = $derived(saved !== null && draft !== null && !themesEqual(draft, saved));
	const activePreset = $derived(draft ? matchPreset(draft) : null);
	/** The CTA carries white text unless white fails AA; the readout says which. */
	const whiteRatio = $derived(draft ? contrastRatio(draft.action, '#ffffff') : 0);
	const actionText = $derived(draft ? contrastText(draft.action) : '#ffffff');

	function applyPreset(preset: BrandPreset) {
		if (!draft) return;
		draft = { ...preset.recipe, markText: draft.markText };
	}

	/** A hex field applies only complete values; partial typing changes nothing. */
	function applyHex(key: ColorKey, raw: string) {
		if (!draft) return;
		const value = raw.trim().toLowerCase();
		const hex = value.startsWith('#') ? value : `#${value}`;
		if (hexPattern.test(hex)) draft[key] = hex;
	}

	/** Leaving a hex field with an incomplete value snaps it back to the brand. */
	function settleHex(key: ColorKey, input: HTMLInputElement) {
		if (draft) input.value = draft[key];
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!draft || !saved || saving || !dirty) return;
		const prior = { ...saved };
		saving = true;
		await api.theme.set({ ...draft });
		// Re-read so local state carries the stored, normalized brand.
		const stored = await api.theme.get();
		saved = { ...stored };
		draft = { ...stored };
		saving = false;
		recordAction({
			area: 'templates',
			label: `Saved the event brand “${stored.name}”`,
			undo: async () => {
				await api.theme.set(prior);
				const restored = await api.theme.get();
				saved = { ...restored };
				draft = { ...restored };
			}
		});
		onSaved?.();
	}
</script>

{#snippet fieldFill(labelWidth: string)}
	<div class="ui-field">
		<div class="ui-field__heading">
			<span class="ui-label"
				><span class="ui-skeleton sk-line" style="inline-size: {labelWidth}"></span></span>
		</div>
		<span class="ui-skeleton sk-control"></span>
	</div>
{/snippet}

{#if !loaded}
	<!-- The resolved composition holding skeleton fills: the controls column keeps
	     field-and-control rhythm and the preview column reserves the card's room,
	     so arrival replaces content without moving the page. -->
	<section class="panel" aria-label="Loading event brand">
		<header class="panel__head">
			<div class="panel__title"><h2>Event brand</h2></div>
		</header>
		<div class="brand" aria-hidden="true">
			<div class="controls">
				<div class="presets">
					{#each ['warm', 'harbor', 'plum'] as key (key)}
						<span class="ui-skeleton sk-preset"></span>
					{/each}
				</div>
				<div class="colors">
					{#each colorFields as field (field.key)}
						{@render fieldFill('4rem')}
					{/each}
				</div>
				<span class="ui-skeleton sk-line" style="inline-size: 9rem"></span>
				<span class="ui-skeleton sk-control"></span>
				<span class="ui-skeleton sk-line" style="inline-size: 9rem"></span>
				<span class="ui-skeleton sk-control"></span>
				{@render fieldFill('6rem')}
				<div class="controls__actions"><span class="ui-skeleton sk-action"></span></div>
			</div>
			<div class="preview">
				<span class="ui-skeleton sk-preview"></span>
				<p class="preview__caption">Every template and public surface follows the brand.</p>
			</div>
		</div>
	</section>
{:else if draft}
	<section class="panel" aria-label="Event brand">
		<header class="panel__head">
			<div class="panel__title"><h2>Event brand</h2></div>
		</header>
		<div class="brand">
			<form class="controls" onsubmit={save}>
				<div class="presets" role="group" aria-label="Start from a preset">
					{#each brandPresets as preset (preset.key)}
						<button
							type="button"
							class="preset"
							class:preset--active={activePreset === preset.key}
							aria-pressed={activePreset === preset.key}
							onclick={() => applyPreset(preset)}>
							<span class="preset__swatches" aria-hidden="true">
								<span style:background={preset.recipe.canvas}></span>
								<span style:background={preset.recipe.action}></span>
							</span>
							{preset.name}
						</button>
					{/each}
				</div>

				<div class="colors">
					{#each colorFields as field (field.key)}
						<Field id={`brand-${field.key}`} label={field.label}>
							{#snippet children({ id, describedBy })}
								<span class="color">
									<input
										class="color__swatch"
										type="color"
										value={draft?.[field.key]}
										aria-label={`${field.label} color picker`}
										oninput={(event) => applyHex(field.key, event.currentTarget.value)} />
									<input
										class="ui-control color__hex"
										type="text"
										{id}
										aria-describedby={describedBy}
										spellcheck="false"
										autocomplete="off"
										value={draft?.[field.key]}
										oninput={(event) => applyHex(field.key, event.currentTarget.value)}
										onblur={(event) => settleHex(field.key, event.currentTarget)} />
								</span>
							{/snippet}
						</Field>
					{/each}
				</div>

				<!-- What the action color can carry, judged live: below 4.5:1 the
				     brand stops trusting white and the preview shows dark text. -->
				<div class="contrast">
					<span class="contrast__swatch" style:background={draft.action} style:color={actionText}
						>Aa</span>
					<span class="contrast__copy">
						<strong>{whiteRatio.toFixed(2)}:1</strong> action on white
						{#if whiteRatio < 4.5}
							<span class="contrast__warn"
								>Below AA — buttons switch to dark text on this action color.</span>
						{/if}
					</span>
				</div>

				<label class="range">
					<span class="range__head"><span>Corner radius</span><output>{draft.radius}px</output></span>
					<input class="ui-range" type="range" min="2" max="20" step="1" bind:value={draft.radius} />
				</label>

				<label class="range">
					<span class="range__head"
						><span>Control height</span><output>{draft.controlHeight}px</output></span>
					<input
						class="ui-range"
						type="range"
						min="30"
						max="48"
						step="1"
						bind:value={draft.controlHeight} />
				</label>

				<Field
					id="brand-mark"
					label="Mark text"
					description="2–3 characters shown in the square mark.">
					{#snippet children({ id, describedBy })}
						<input
							class="ui-control controls__mark"
							type="text"
							{id}
							aria-describedby={describedBy}
							maxlength="3"
							autocomplete="off"
							value={draft?.markText ?? ''}
							oninput={(event) => {
								if (draft) draft.markText = event.currentTarget.value;
							}} />
					{/snippet}
				</Field>

				<!-- The commit for the whole panel, so it is not a small button. It
				     had `size="sm"`, which made the one consequential control on the
				     tab shorter than the preset chips above it and gave its label no
				     room; and it sat in a flex row beside a full sentence inside a
				     336px column, so the hint squeezed it the moment there was
				     anything to save. The hint belongs under it, not beside it. -->
				<div class="controls__actions">
					<Button type="submit" disabled={!dirty} loading={saving}>Save brand</Button>
					<p class="controls__hint" aria-hidden={!dirty}>
						{#if dirty}Not applied yet — the preview is already showing it.{/if}
					</p>
				</div>
			</form>

			<div class="preview">
				{#if previewTemplate}
					<EmailRender template={previewTemplate} theme={draft} {eventName} {eventMeta} />
				{:else}
					<p class="preview__none">No templates to preview yet.</p>
				{/if}
				<p class="preview__caption">Every template and public surface follows the brand.</p>
			</div>
		</div>
	</section>
{/if}

<style>
	/* Skeleton fills borrow their geometry from what they stand in for. */
	.sk-line {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.sk-control {
		display: block;
		block-size: var(--je-control-height);
		border-radius: var(--je-radius-control);
	}

	.sk-preset {
		display: block;
		block-size: var(--je-control-height);
		border-radius: var(--je-radius-control);
	}

	.sk-action {
		display: inline-block;
		block-size: var(--je-control-height);
		inline-size: 7.5rem;
		border-radius: var(--je-radius-control);
		vertical-align: bottom;
	}

	.sk-preview {
		display: block;
		min-block-size: 38rem;
		border-radius: var(--je-radius-surface);
	}

	.panel {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.panel__head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: var(--je-space-2) var(--je-space-4);
		margin-block-end: var(--je-space-4);
	}

	.panel__title {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.panel__head h2 {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.brand {
		display: grid;
		grid-template-columns: minmax(0, 21rem) minmax(0, 1fr);
		gap: var(--je-space-6);
		align-items: start;
	}

	.controls {
		display: grid;
		gap: var(--je-space-4);
	}

	.presets {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--je-space-2);
	}

	.preset {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--je-space-2);
		block-size: var(--je-control-height);
		padding-inline: var(--je-space-2);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface);
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		cursor: pointer;
	}

	.preset:hover {
		border-color: var(--je-color-border-strong);
		color: var(--je-color-text);
	}

	.preset--active {
		border-color: var(--je-color-action);
		background: var(--je-color-surface-selected);
		color: var(--je-color-text);
	}

	.preset:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.preset__swatches {
		display: flex;
		overflow: hidden;
		flex-shrink: 0;
		inline-size: 1.5rem;
		block-size: 1rem;
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-xs);
	}

	.preset__swatches span {
		flex: 1;
	}

	.colors {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--je-space-3);
	}

	.color {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
	}

	/* The swatch is the same control as the hex field, in picker form: control
	   height, control radius, hairline border. */
	.color__swatch {
		inline-size: var(--je-control-height);
		block-size: var(--je-control-height);
		flex-shrink: 0;
		padding: 2px;
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface);
		cursor: pointer;
	}

	.color__swatch:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.color__hex {
		min-inline-size: 0;
		font-family: var(--je-font-mono);
		font-size: var(--je-font-size-sm);
	}

	.contrast {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
	}

	.contrast__swatch {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		inline-size: 2.1rem;
		block-size: 1.55rem;
		border-radius: var(--je-radius-xs);
		font-size: var(--je-font-size-sm);
		font-weight: 750;
	}

	.contrast__copy {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.contrast__copy strong {
		color: var(--je-color-text);
		font-variant-numeric: tabular-nums;
	}

	.contrast__warn {
		display: block;
		margin-block-start: 2px;
		font-weight: 650;
		color: var(--je-color-warning);
	}

	.range {
		display: grid;
		gap: var(--je-space-1);
	}

	.range__head {
		display: flex;
		justify-content: space-between;
		font-size: var(--je-font-size-xs);
		font-weight: 650;
		color: var(--je-color-text-muted);
	}

	.range__head output {
		color: var(--je-color-text);
		font-variant-numeric: tabular-nums;
	}

	.controls__mark {
		max-inline-size: 6rem;
		text-transform: uppercase;
	}

	/* Stacked, start-aligned. The hint keeps its line whether or not there is
	   anything to say, so the commit does not hop down the column the first time
	   a field is touched. */
	.controls__actions {
		display: grid;
		justify-items: start;
		gap: var(--je-space-2);
	}

	.controls__hint {
		margin: 0;
		min-block-size: 1lh;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.preview {
		display: grid;
		gap: var(--je-space-2);
		min-inline-size: 0;
	}

	.preview__caption {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		text-align: center;
	}

	/* An empty preview keeps the card's room so the tab never collapses. */
	.preview__none {
		display: grid;
		place-items: center;
		min-block-size: 38rem;
		margin: 0;
		border: 1px dashed var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	@media (max-width: 920px) {
		.brand {
			grid-template-columns: 1fr;
		}

		.sk-preview,
		.preview__none {
			min-block-size: 24rem;
		}
	}
</style>
