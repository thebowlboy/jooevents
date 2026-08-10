<script lang="ts">
  import { Check, Clipboard, Palette, RotateCcw, X } from 'lucide-svelte';
  import { Badge, Button, Field } from '$lib/ui';
  import {
    contrastRatio,
    contrastText,
    defaultThemeRecipe,
    serializeThemeCss,
    themeStyleProperties,
    type Density,
    type ThemePreset,
    type ThemeRecipe
  } from '$lib/theme/theme-contract';

  interface Props {
    open?: boolean;
    density?: Density;
  }

  let { open = $bindable(false), density = $bindable('compact') }: Props = $props();
  let preset = $state<ThemePreset>('warm');
  let recipe = $state<ThemeRecipe>({ ...defaultThemeRecipe });
  let copied = $state(false);

  const themeCss = $derived(serializeThemeCss(recipe));
  const actionText = $derived(contrastText(recipe.action));
  const actionContrastValue = $derived(contrastRatio(recipe.action, actionText));
  const actionContrast = $derived(actionContrastValue.toFixed(2));
  const bodyContrastValue = $derived(contrastRatio(recipe.surface, recipe.text));
  const bodyContrast = $derived(bodyContrastValue.toFixed(2));

  $effect(() => {
    const root = document.documentElement;
    root.dataset.density = density;
  });

  $effect(() => {
    const root = document.documentElement;
    const customProperties = themeStyleProperties(recipe);

    for (const token of Object.keys(customProperties)) root.style.removeProperty(token);

    root.dataset.theme = preset;
    if (preset === 'custom') {
      for (const [token, value] of Object.entries(customProperties)) root.style.setProperty(token, value);
    }
  });

  function choosePreset(next: ThemePreset) {
    preset = next;
  }

  function markCustom() {
    preset = 'custom';
  }

  function reset() {
    recipe = { ...defaultThemeRecipe };
    preset = 'warm';
    density = 'compact';
  }

  async function copyTheme() {
    await navigator.clipboard.writeText(themeCss);
    copied = true;
    window.setTimeout(() => (copied = false), 1800);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) open = false;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <button class="theme-studio__backdrop" type="button" aria-label="Close theme studio" onclick={() => (open = false)}></button>
  <div class="theme-studio" role="dialog" aria-label="Theme studio" aria-modal="true">
    <header class="theme-studio__header">
      <span class="theme-studio__mark"><Palette /></span>
      <div>
        <p class="theme-studio__eyebrow">Live token editor</p>
        <h2>Theme studio</h2>
      </div>
      <Button variant="ghost" size="sm" iconOnly aria-label="Close theme studio" onclick={() => (open = false)}><X /></Button>
    </header>

    <div class="theme-studio__body">
      <section class="theme-studio__section">
        <div class="theme-studio__section-heading">
          <div>
            <h3>Starting layer</h3>
            <p>Presets change tokens, never component anatomy.</p>
          </div>
        </div>
        <div class="theme-studio__presets" role="group" aria-label="Theme preset">
          {#each [
            { id: 'warm', name: 'Warm', colors: ['#faf8f5', '#b05a4f'] },
            { id: 'harbor', name: 'Harbor', colors: ['#f4f8f8', '#3d7377'] },
            { id: 'plum', name: 'Plum', colors: ['#f8f6fb', '#695b8e'] }
          ] as item}
            <button
              type="button"
              class:theme-studio__preset--active={preset === item.id}
              class="theme-studio__preset"
              aria-pressed={preset === item.id}
              onclick={() => choosePreset(item.id as ThemePreset)}
            >
              <span class="theme-studio__swatch-pair">
                {#each item.colors as color}<span style:background={color}></span>{/each}
              </span>
              <span>{item.name}</span>
              {#if preset === item.id}<Check />{/if}
            </button>
          {/each}
        </div>
      </section>

      <section class="theme-studio__section">
        <div class="theme-studio__section-heading">
          <div>
            <h3>Density</h3>
            <p>Content density is independent from brand styling.</p>
          </div>
        </div>
        <div class="ui-segmented theme-studio__density" role="group" aria-label="Interface density">
          {#each ['compact', 'default', 'comfortable'] as option}
            <button
              class="ui-segmented__item"
              type="button"
              aria-pressed={density === option}
              onclick={() => (density = option as Density)}
            >{option}</button>
          {/each}
        </div>
      </section>

      <section class="theme-studio__section">
        <div class="theme-studio__section-heading">
          <div>
            <h3>Custom recipe</h3>
            <p>Only stable semantic choices are exposed.</p>
          </div>
          {#if preset === 'custom'}<span class="theme-studio__live">Live</span>{/if}
        </div>

        <Field id="theme-name" label="Layer name">
          {#snippet children({ id, describedBy })}
            <input class="ui-control" {id} aria-describedby={describedBy} bind:value={recipe.name} oninput={markCustom} />
          {/snippet}
        </Field>

        <div class="theme-studio__colors">
          {#each [
            { key: 'action', label: 'Action' },
            { key: 'canvas', label: 'Canvas' },
            { key: 'surface', label: 'Surface' },
            { key: 'text', label: 'Text' }
          ] as color}
            <label class="theme-studio__color">
              <span>{color.label}</span>
              <span class="theme-studio__color-control">
                <input
                  type="color"
                  value={recipe[color.key as keyof ThemeRecipe] as string}
                  oninput={(event) => {
                    recipe[color.key as 'action' | 'canvas' | 'surface' | 'text'] = event.currentTarget.value;
                    markCustom();
                  }}
                />
                <code>{recipe[color.key as keyof ThemeRecipe]}</code>
              </span>
            </label>
          {/each}
        </div>

        <div class="theme-studio__metrics">
          <div class="theme-studio__metric">
            <span>Body contrast</span>
            <Badge tone={bodyContrastValue >= 4.5 ? 'success' : 'danger'}>{bodyContrastValue >= 4.5 ? 'AA' : 'Check'}</Badge>
            <strong>{bodyContrast}:1</strong>
          </div>
          <div class="theme-studio__metric">
            <span>Action contrast</span>
            <span class="theme-studio__contrast-preview" style:background={recipe.action} style:color={actionText}>Aa</span>
            <strong>{actionContrast}:1</strong>
          </div>
        </div>

        <label class="theme-studio__range">
          <span><strong>Control radius</strong><output>{recipe.radius}px</output></span>
          <input class="ui-range" type="range" min="2" max="20" step="1" bind:value={recipe.radius} oninput={markCustom} />
        </label>

        <label class="theme-studio__range">
          <span><strong>Control height</strong><output>{recipe.controlHeight}px</output></span>
          <input class="ui-range" type="range" min="30" max="48" step="1" bind:value={recipe.controlHeight} oninput={markCustom} />
        </label>
      </section>

      <section class="theme-studio__section">
        <div class="theme-studio__section-heading">
          <div>
            <h3>Agent-ready output</h3>
            <p>Load this after the base styles. The final cascade layer wins.</p>
          </div>
        </div>
        <pre class="ui-code theme-studio__code">{themeCss}</pre>
      </section>
    </div>

    <footer class="theme-studio__footer">
      <Button variant="ghost" size="sm" onclick={reset}><RotateCcw /> Reset</Button>
      <Button size="sm" onclick={copyTheme}>
        {#if copied}<Check /> Copied{:else}<Clipboard /> Copy CSS{/if}
      </Button>
    </footer>
  </div>
{/if}

<style>
  @layer je.workbench {
  .theme-studio__backdrop {
    position: fixed;
    z-index: 800;
    inset: 0;
    border: 0;
    background: var(--je-color-scrim);
    backdrop-filter: blur(1px);
  }

  .theme-studio {
    position: fixed;
    z-index: 810;
    top: 0;
    right: 0;
    bottom: 0;
    display: grid;
    width: min(27rem, calc(100vw - 1rem));
    max-width: 100%;
    min-width: 0;
    grid-template-rows: auto minmax(0, 1fr) auto;
    overflow: hidden;
    border-left: 1px solid var(--je-color-border);
    background: var(--je-color-surface);
    box-shadow: var(--je-shadow-lg);
    animation: studio-in var(--je-duration-slow) var(--je-ease-out);
  }

  .theme-studio__header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0.75rem;
    align-items: center;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--je-color-border);
  }

  .theme-studio__mark {
    display: grid;
    width: 2rem;
    height: 2rem;
    place-items: center;
    border-radius: var(--je-radius-control);
    background: var(--je-color-action-soft);
    color: var(--je-color-link);
  }

  .theme-studio__mark :global(svg) {
    width: 1rem;
  }

  .theme-studio__eyebrow {
    margin: 0;
    color: var(--je-color-text-subtle);
    font-size: var(--je-font-size-2xs);
    font-weight: 750;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h2,
  h3 {
    margin: 0;
  }

  h2 {
    font-size: var(--je-font-size-base);
  }

  h3 {
    font-size: var(--je-font-size-sm);
  }

  .theme-studio__body {
    min-width: 0;
    overflow-y: auto;
  }

  .theme-studio__section {
    display: grid;
    min-width: 0;
    gap: 0.85rem;
    padding: 1rem;
    border-bottom: 1px solid var(--je-color-border);
  }

  .theme-studio__section-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .theme-studio__section-heading p {
    margin: 0.16rem 0 0;
    color: var(--je-color-text-muted);
    font-size: var(--je-font-size-xs);
  }

  .theme-studio__presets {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.4rem;
  }

  .theme-studio__preset {
    position: relative;
    display: grid;
    gap: 0.35rem;
    justify-items: start;
    padding: 0.55rem;
    border: 1px solid var(--je-color-border);
    border-radius: var(--je-radius-control);
    background: var(--je-color-surface);
    color: var(--je-color-text-muted);
    font-size: var(--je-font-size-xs);
    font-weight: 650;
    cursor: pointer;
  }

  .theme-studio__preset:hover,
  .theme-studio__preset--active {
    border-color: var(--je-color-action);
  }

  .theme-studio__preset > :global(svg) {
    position: absolute;
    top: 0.35rem;
    right: 0.35rem;
    width: 0.8rem;
    color: var(--je-color-action);
  }

  .theme-studio__swatch-pair {
    display: flex;
    overflow: hidden;
    width: 100%;
    height: 1.35rem;
    border: 1px solid var(--je-color-border-subtle);
    border-radius: var(--je-radius-xs);
  }

  .theme-studio__swatch-pair span {
    flex: 1;
  }

  .theme-studio__density {
    width: 100%;
  }

  .theme-studio__density :global(.ui-segmented__item) {
    flex: 1;
    padding-inline: 0.25rem;
  }

  .theme-studio__colors {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }

  .theme-studio__color {
    display: grid;
    gap: 0.3rem;
    color: var(--je-color-text-muted);
    font-size: var(--je-font-size-xs);
    font-weight: 650;
  }

  .theme-studio__color-control {
    display: flex;
    height: var(--je-control-height);
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem 0.5rem 0.2rem 0.25rem;
    border: 1px solid var(--je-color-border-strong);
    border-radius: var(--je-radius-control);
    background: var(--je-color-surface);
  }

  .theme-studio__color-control input {
    width: 1.8rem;
    height: 1.45rem;
    padding: 0;
    overflow: hidden;
    border: 0;
    border-radius: var(--je-radius-xs);
    background: transparent;
    cursor: pointer;
  }

  .theme-studio__color-control code {
    color: var(--je-color-text-muted);
    font-size: var(--je-font-size-2xs);
  }

  .theme-studio__metrics {
    display: grid;
    gap: 0.45rem;
  }

  .theme-studio__metric {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 0.55rem;
    color: var(--je-color-text-muted);
    font-size: var(--je-font-size-xs);
  }

  .theme-studio__contrast-preview {
    display: grid;
    width: 2.1rem;
    height: 1.55rem;
    place-items: center;
    border-radius: var(--je-radius-xs);
    font-weight: 750;
  }

  .theme-studio__metric strong {
    color: var(--je-color-text);
    font-variant-numeric: tabular-nums;
  }

  .theme-studio__range {
    display: grid;
    gap: 0.35rem;
  }

  .theme-studio__range > span {
    display: flex;
    justify-content: space-between;
    color: var(--je-color-text-muted);
    font-size: var(--je-font-size-xs);
  }

  .theme-studio__range strong {
    color: var(--je-color-text);
  }

  .theme-studio__live {
    padding: 0.15rem 0.4rem;
    border-radius: var(--je-radius-round);
    background: var(--je-color-success-soft);
    color: var(--je-color-success);
    font-size: var(--je-font-size-2xs);
    font-weight: 750;
    text-transform: uppercase;
  }

  .theme-studio__code {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    max-height: 12rem;
    overflow: auto;
    font-size: var(--je-font-size-2xs);
  }

  .theme-studio__footer {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--je-color-border);
    background: var(--je-color-page);
  }

  @keyframes studio-in {
    from { opacity: 0; transform: translateX(1.5rem); }
    to { opacity: 1; transform: translateX(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .theme-studio { animation: none; }
  }
  }
</style>
