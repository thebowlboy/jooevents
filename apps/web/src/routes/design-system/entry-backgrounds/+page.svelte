<script lang="ts">
  import AccessEntryFrame from '$lib/features/access/components/AccessEntryFrame.svelte';
  import EntryState from '$lib/features/access/components/EntryState.svelte';
  import type { AccessEntryState } from '$lib/features/access/AccessEntryController';

  const anonymous: AccessEntryState = { kind: 'anonymous' };
  const noop = () => {};

  const variants = [
    { id: 'current', name: 'Current', blurb: 'Baseline: the shipped entry background (sunrise horizon).' },
    { id: 'veil', name: 'Warm veil', blurb: 'One quiet warm gradient; a faint coral-tinted light source above the brand.' },
    { id: 'horizon', name: 'Sunrise horizon', blurb: 'A soft coral dawn rising from the bottom edge beneath the panel.' },
    { id: 'aurora', name: 'Aurora wash', blurb: 'Coral, lavender, and sea soft washes blended over cream.' },
    { id: 'spotlight', name: 'Spotlight', blurb: 'A light pool behind the panel with gently darkened edges.' },
    { id: 'lattice', name: 'Dot lattice', blurb: 'A faint dot grid that fades out behind the panel.' }
  ] as const;

  let index = $state(0);
  const variant = $derived(variants[index]);

  function select(next: number) {
    index = (next + variants.length) % variants.length;
    history.replaceState(null, '', `#${variants[index].id}`);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowRight') select(index + 1);
    if (event.key === 'ArrowLeft') select(index - 1);
  }

  $effect(() => {
    const requested = variants.findIndex((entry) => `#${entry.id}` === location.hash);
    if (requested >= 0) index = requested;
  });
</script>

<svelte:head>
  <title>Entry backgrounds · Design system · JooEvents</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<svelte:window onkeydown={onKeydown} />

<div class="bgfix bgfix--{variant.id}">
  <AccessEntryFrame>
    <EntryState state={anonymous} onGoogle={noop} onRetry={noop} onCheck={noop} onSignOut={noop} />
  </AccessEntryFrame>

  <nav class="bgfix-bar" aria-label="Background variants">
    <div class="bgfix-buttons">
      {#each variants as entry, i (entry.id)}
        <button type="button" aria-pressed={i === index} onclick={() => select(i)}>{i}. {entry.name}</button>
      {/each}
    </div>
    <p>{variant.blurb} <span>&larr;/&rarr; to browse</span></p>
  </nav>
</div>

<style>
  /* Fixture-only overrides stay unlayered so they win over @layer je.features,
     including the flat mobile background rule. */

  .bgfix--veil :global(.entry-page) {
    background:
      radial-gradient(60rem 34rem at 50% 10rem, color-mix(in srgb, var(--je-color-action-soft) 48%, transparent), transparent 70%),
      linear-gradient(180deg, color-mix(in srgb, var(--je-color-action-soft) 24%, var(--je-color-canvas)), var(--je-color-page) 65%);
  }

  .bgfix--horizon :global(.entry-page) {
    background:
      radial-gradient(85rem 44rem at 50% 118%, var(--je-color-action-soft), transparent 72%),
      radial-gradient(55rem 26rem at 50% 122%, color-mix(in srgb, var(--je-color-action-soft-hover) 75%, transparent), transparent 64%),
      linear-gradient(180deg, var(--je-color-canvas), var(--je-color-page));
  }

  .bgfix--aurora :global(.entry-page) {
    background:
      radial-gradient(32rem 30rem at 12% 6%, color-mix(in srgb, var(--je-color-action-soft) 72%, transparent), transparent 72%),
      radial-gradient(34rem 30rem at 90% 16%, color-mix(in srgb, var(--je-color-accent-lavender-soft) 82%, transparent), transparent 72%),
      radial-gradient(38rem 30rem at 50% 108%, color-mix(in srgb, var(--je-color-accent-sea-soft) 75%, transparent), transparent 72%),
      var(--je-color-canvas);
  }

  .bgfix--spotlight :global(.entry-page) {
    background:
      radial-gradient(46rem 34rem at 50% 15rem, color-mix(in srgb, var(--je-color-surface) 70%, transparent), transparent 74%),
      radial-gradient(120% 130% at 50% 38%, transparent 45%, var(--je-color-surface-sunken)),
      var(--je-color-page);
  }

  .bgfix--lattice :global(.entry-page) {
    background:
      radial-gradient(52rem 38rem at 50% 12rem, var(--je-color-canvas) 18%, transparent 76%),
      radial-gradient(circle at 1px 1px, var(--je-color-border) 1px, transparent 1.6px) 0 0 / 22px 22px,
      linear-gradient(180deg, var(--je-color-canvas), var(--je-color-page));
  }

  .bgfix-bar {
    position: fixed;
    inset-inline: 0;
    bottom: 0;
    z-index: 10;
    display: grid;
    justify-items: center;
    gap: var(--je-space-2);
    padding: var(--je-space-3) var(--je-space-4) max(var(--je-space-3), env(safe-area-inset-bottom));
    background: color-mix(in srgb, var(--je-color-surface) 92%, transparent);
    border-top: 1px solid var(--je-color-border-subtle);
    backdrop-filter: blur(8px);
  }

  .bgfix-buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--je-space-2);
  }

  .bgfix-buttons button {
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--je-color-border);
    border-radius: var(--je-radius-round);
    background: var(--je-color-surface);
    color: var(--je-color-text);
    font-size: var(--je-font-size-sm);
    cursor: pointer;
  }

  .bgfix-buttons button[aria-pressed='true'] {
    border-color: var(--je-color-action);
    background: var(--je-color-action-soft);
    font-weight: 700;
  }

  .bgfix-buttons button:focus-visible {
    outline: 3px solid var(--je-color-focus);
    outline-offset: 2px;
  }

  .bgfix-bar p {
    margin: 0;
    color: var(--je-color-text-muted);
    font-size: var(--je-font-size-sm);
    text-align: center;
  }

  .bgfix-bar p span {
    color: var(--je-color-text-subtle);
  }
</style>
