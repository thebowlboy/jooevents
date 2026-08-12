<script lang="ts">
  import { RotateCcw } from 'lucide-svelte';
  import { PENDING_GRACE_MS, PENDING_SLOW_MS } from '$lib/ui';

  interface Variant {
    id: string;
    name: string;
    /** Where the treatment lives in the frame. */
    slot: 'edge' | 'content';
    /** What in the product's existing language this is made of. */
    distils: string;
    /** Why it might be the right permanent choice. */
    argument: string;
    /** What a person sees with motion switched off. */
    still: string;
  }

  const variants: Variant[] = [
    {
      id: 'hairline',
      name: 'Arrival hairline',
      slot: 'edge',
      distils: 'The topbar rule that already separates chrome from content.',
      argument:
        'Costs no layout and no new element: the line is already on screen, it simply lights and travels. The quietest option, and the only one that cannot move the page.',
      still: 'The rule is lit end to end while a destination is on its way.'
    },
    {
      id: 'rail',
      name: 'Intent rail',
      slot: 'edge',
      distils: 'The 3px action rail that marks the selected navigation item.',
      argument:
        'One mark carries the whole handoff: it says “chosen” in the sidebar and “on its way” at the content edge. Selection and arrival stop being two vocabularies.',
      still: 'The rail is drawn full height at reduced strength.'
    },
    {
      id: 'sweep',
      name: 'Shimmer sweep',
      slot: 'edge',
      distils: 'The skeleton shimmer, promoted from a bar to the page.',
      argument:
        'Already the app’s signal for “content is coming” — reusing it at page scale means people learn one thing, not two. Wide and faint enough to stay peripheral.',
      still: 'A faint static wash sits under the topbar.'
    },
    {
      id: 'ledger',
      name: 'Ledger rows',
      slot: 'content',
      distils: 'The hairline-separated row rhythm of activity, trays, and queues.',
      argument:
        'Reserves the shape most destinations actually resolve into, so arriving content replaces the placeholder in place rather than pushing it aside.',
      still: 'The rows hold one uniform resting opacity.'
    },
    {
      id: 'silhouette',
      name: 'Page silhouette',
      slot: 'content',
      distils: 'The overview’s own loading composition, generalised to the shell.',
      argument:
        'The most literal reading of the standard: a resolver occupying the resolved composition’s footprint. Strongest for slow waits, heaviest for fast ones.',
      still: 'The structure stays; only the shimmer stops.'
    },
    {
      id: 'fourbeat',
      name: 'Four beats',
      slot: 'content',
      distils: 'Intent → Draft → Diff → Commit, the loop the product is built on.',
      argument:
        'The only variant that means something specific to JooEvents. A wait becomes a reminder of how work moves here — at the cost of implying stages this navigation does not really have.',
      still: 'All four beats show; the first is filled.'
    },
    {
      id: 'slots',
      name: 'Slot ledger',
      slot: 'content',
      distils: 'The count chips beside navigation items and tray labels.',
      argument:
        'Expresses the promise that nothing falls through the cracks: the places are already there, the numbers are still being counted.',
      still: 'The chips rest at a single dimmed weight.'
    },
    {
      id: 'breath',
      name: 'Breath',
      slot: 'content',
      distils: 'Nothing but the type scale and the muted ink.',
      argument:
        'Says what is happening in words and moves nothing at all. The calmest option and the most honest under reduced motion, because it barely changes.',
      still: 'The sentence simply sits at full strength.'
    },
    {
      id: 'arc',
      name: 'Corner arc',
      slot: 'content',
      distils: 'The spinner, thinned and moved out of the reading path.',
      argument:
        'Status without claiming any structure — the safe answer when a destination’s shape is unknown. Familiar, but the one option that teaches nothing about this product.',
      still: 'A complete ring rests at low contrast.'
    }
  ];

  let forceStill = $state(false);
  let prefersStill = $state(false);
  let replay = $state(0);

  // One code path serves both the preview toggle and a real reduced-motion
  // preference, so the still rendering shown here cannot drift from the one
  // those visitors actually get.
  $effect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => (prefersStill = query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  });

  const still = $derived(forceStill || prefersStill);
</script>

<div class="lv" data-still={still ? 'true' : undefined}>
  <header class="lv__head">
    <p class="lv__eyebrow">Design system</p>
    <h1 class="lv__title">Waiting treatments</h1>
    <p class="lv__lede">
      Nine candidates for the one indicator the workspace will use while a destination is on
      its way. Each is shown where it would actually live, at the size it would actually be.
      Pick one; the rest come out.
    </p>

    <div class="lv__contract">
      <h2>The contract they plug into</h2>
      <p>
        Acknowledgement and resolution are separate jobs. The navigation item selects in the
        click’s own frame and never waits on data — that is the input contract. Everything
        below is the other half: reporting a wait, at the surface the work lands on, and only
        once the wait is long enough to be worth reporting.
      </p>
      <ol class="lv__tiers">
        <li>
          <strong>Under {PENDING_GRACE_MS}ms</strong>
          <span>Nothing shows. A resolver that appears and vanishes within a blink reads as a glitch.</span>
        </li>
        <li>
          <strong>{PENDING_GRACE_MS}–{PENDING_SLOW_MS}ms</strong>
          <span>One of these treatments appears. The surrounding composition stays intact.</span>
        </li>
        <li>
          <strong>Past {PENDING_SLOW_MS}ms</strong>
          <span>The wait is also announced to assistive technology, naming the destination.</span>
        </li>
      </ol>
    </div>

    <div class="lv__controls">
      <button type="button" class="ui-button ui-button--secondary ui-button--sm" onclick={() => (replay += 1)}>
        <RotateCcw size={14} aria-hidden="true" />Replay
      </button>
      <label class="lv__toggle">
        <input
          type="checkbox"
          class="ui-checkbox"
          checked={still}
          disabled={prefersStill}
          onchange={(event) => (forceStill = event.currentTarget.checked)} />
        Show the reduced-motion rendering
      </label>
      {#if still}
        <p class="lv__still-note" role="status">
          {#if prefersStill}
            This system asks for reduced motion, so the still rendering is what you see
            everywhere — not just here.
          {:else}
            Every treatment below is drawn as it appears with motion switched off. Each must
            still say “a wait is happening” without moving.
          {/if}
        </p>
      {/if}
    </div>
  </header>

  {#key replay}
    <ol class="lv__grid">
      {#each variants as variant, index (variant.id)}
        <li class="lv-card">
          <div class="lv-card__head">
            <span class="lv-card__index">{String(index + 1).padStart(2, '0')}</span>
            <h2 class="lv-card__name">{variant.name}</h2>
          </div>

          <!-- A miniature of the real shell: the treatment is judged in the place
               it will occupy, not floating on a blank card. -->
          <div class="lv-frame" data-variant={variant.id} aria-hidden="true">
            <div class="lv-frame__side">
              <span class="lv-frame__brand"></span>
              <span class="lv-frame__nav"></span>
              <span class="lv-frame__nav lv-frame__nav--active"></span>
              <span class="lv-frame__nav"></span>
              <span class="lv-frame__nav"></span>
            </div>
            <div class="lv-frame__body">
              <div class="lv-frame__top">
                <span class="lv-frame__title">Schedule</span>
                {#if variant.id === 'hairline'}
                  <span class="lv-hairline"><span></span></span>
                {:else if variant.id === 'sweep'}
                  <span class="lv-sweep"><span></span></span>
                {/if}
              </div>
              <div class="lv-frame__content">
                {#if variant.id === 'rail'}
                  <span class="lv-rail"><span></span></span>
                {/if}

                {#if variant.id === 'ledger'}
                  <div class="lv-ledger">
                    {#each [0, 1, 2, 3] as row (row)}
                      <span class="lv-ledger__row" style:--lv-step={row}></span>
                    {/each}
                  </div>
                {:else if variant.id === 'silhouette'}
                  <div class="lv-silhouette">
                    <div class="lv-silhouette__kpis">
                      {#each [0, 1, 2, 3] as kpi (kpi)}
                        <span class="ui-skeleton lv-silhouette__kpi"></span>
                      {/each}
                    </div>
                    <div class="lv-silhouette__cols">
                      <span class="ui-skeleton lv-silhouette__panel"></span>
                      <span class="ui-skeleton lv-silhouette__panel lv-silhouette__panel--aside"></span>
                    </div>
                  </div>
                {:else if variant.id === 'fourbeat'}
                  <div class="lv-beats">
                    <span class="lv-beats__track">
                      {#each ['Intent', 'Draft', 'Diff', 'Commit'] as beat, i (beat)}
                        <span class="lv-beats__beat" style:--lv-step={i}><i></i>{beat}</span>
                      {/each}
                    </span>
                  </div>
                {:else if variant.id === 'slots'}
                  <div class="lv-slots">
                    {#each ['Sessions', 'Rooms', 'Conflicts'] as slot, i (slot)}
                      <span class="lv-slots__chip" style:--lv-step={i}>
                        {slot}<i></i>
                      </span>
                    {/each}
                  </div>
                {:else if variant.id === 'breath'}
                  <p class="lv-breath">Loading Schedule…</p>
                {:else if variant.id === 'arc'}
                  <span class="lv-arc"></span>
                {/if}
              </div>
            </div>
          </div>

          <dl class="lv-card__notes">
            <div>
              <dt>Made from</dt>
              <dd>{variant.distils}</dd>
            </div>
            <div>
              <dt>The case for it</dt>
              <dd>{variant.argument}</dd>
            </div>
            <div>
              <dt>Motion off</dt>
              <dd>{variant.still}</dd>
            </div>
          </dl>
        </li>
      {/each}
    </ol>
  {/key}
</div>

<style>
  .lv {
    --lv-frame-side: 3.25rem;
    max-inline-size: var(--je-page-max);
    margin-inline: auto;
    padding: var(--je-space-8) var(--je-space-6) var(--je-space-10);
    display: flex;
    flex-direction: column;
    gap: var(--je-space-8);
  }

  .lv__head {
    display: flex;
    flex-direction: column;
    gap: var(--je-space-4);
    max-inline-size: 52rem;
  }

  .lv__eyebrow {
    margin: 0;
    font-size: var(--je-font-size-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--je-tracking-caps);
    color: var(--je-color-text-muted);
  }

  .lv__title {
    margin: 0;
    font-family: var(--je-font-display);
    font-size: var(--je-font-size-2xl);
  }

  .lv__lede {
    margin: 0;
    color: var(--je-color-text-muted);
    font-size: var(--je-font-size-md);
  }

  .lv__contract {
    padding: var(--je-space-4);
    border: 1px solid var(--je-color-border);
    border-radius: var(--je-radius-surface);
    background: var(--je-color-surface);
  }

  .lv__contract h2 {
    margin: 0 0 var(--je-space-2);
    font-size: var(--je-font-size-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--je-tracking-caps);
    color: var(--je-color-text-muted);
  }

  .lv__contract p {
    margin: 0;
    color: var(--je-color-text-muted);
    font-size: var(--je-font-size-md);
  }

  .lv__tiers {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    gap: var(--je-space-3);
    margin: var(--je-space-4) 0 0;
    padding: 0;
  }

  .lv__tiers li {
    display: grid;
    gap: var(--je-space-1);
    padding-inline-start: var(--je-space-3);
    border-inline-start: 2px solid var(--je-color-border-strong);
  }

  .lv__tiers strong {
    font-size: var(--je-font-size-sm);
    font-variant-numeric: tabular-nums;
  }

  .lv__tiers span {
    font-size: var(--je-font-size-sm);
    color: var(--je-color-text-muted);
  }

  .lv__controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--je-space-3);
  }

  .lv__toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--je-space-2);
    font-size: var(--je-font-size-sm);
  }

  .lv__still-note {
    flex-basis: 100%;
    margin: 0;
    font-size: var(--je-font-size-sm);
    color: var(--je-color-text-muted);
  }

  .lv__grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(21rem, 1fr));
    gap: var(--je-space-4);
  }

  .lv-card {
    display: flex;
    flex-direction: column;
    gap: var(--je-space-3);
    padding: var(--je-space-4);
    border: 1px solid var(--je-color-border);
    border-radius: var(--je-radius-surface);
    background: var(--je-color-surface);
  }

  .lv-card__head {
    display: flex;
    align-items: baseline;
    gap: var(--je-space-2);
  }

  .lv-card__index {
    font-size: var(--je-font-size-xs);
    font-variant-numeric: tabular-nums;
    color: var(--je-color-text-subtle);
  }

  .lv-card__name {
    margin: 0;
    font-size: var(--je-font-size-md);
    font-weight: 600;
  }

  .lv-card__notes {
    display: grid;
    gap: var(--je-space-2);
    margin: 0;
  }

  .lv-card__notes div {
    display: grid;
    gap: 0.125rem;
  }

  .lv-card__notes dt {
    font-size: var(--je-font-size-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--je-tracking-caps);
    color: var(--je-color-text-subtle);
  }

  .lv-card__notes dd {
    margin: 0;
    font-size: var(--je-font-size-sm);
    color: var(--je-color-text-muted);
  }

  /* The miniature shell */
  .lv-frame {
    display: grid;
    grid-template-columns: var(--lv-frame-side) minmax(0, 1fr);
    block-size: 11rem;
    overflow: hidden;
    border: 1px solid var(--je-color-border);
    border-radius: var(--je-radius-control);
    background: var(--je-color-page);
  }

  .lv-frame__side {
    display: flex;
    flex-direction: column;
    gap: var(--je-space-2);
    padding: var(--je-space-2) var(--je-space-1);
    background: var(--je-color-canvas);
    border-inline-end: 1px solid var(--je-color-border);
  }

  .lv-frame__brand {
    block-size: 0.5rem;
    inline-size: 70%;
    border-radius: var(--je-radius-round);
    background: var(--je-color-border-strong);
  }

  .lv-frame__nav {
    block-size: 0.375rem;
    inline-size: 85%;
    border-radius: var(--je-radius-round);
    background: var(--je-color-surface-sunken);
  }

  .lv-frame__nav--active {
    position: relative;
    background: var(--je-color-text-subtle);
  }

  .lv-frame__nav--active::before {
    content: '';
    position: absolute;
    inset-inline-start: calc(var(--je-space-1) * -1);
    inset-block: -0.125rem;
    inline-size: 2px;
    border-radius: var(--je-radius-round);
    background: var(--je-color-action);
  }

  .lv-frame__body {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
  }

  .lv-frame__top {
    position: relative;
    display: flex;
    align-items: center;
    block-size: 1.75rem;
    padding-inline: var(--je-space-3);
    background: var(--je-color-canvas);
    border-block-end: 1px solid var(--je-color-border);
  }

  .lv-frame__title {
    font-size: var(--je-font-size-2xs);
    font-weight: 600;
  }

  .lv-frame__content {
    position: relative;
    flex: 1;
    min-block-size: 0;
    padding: var(--je-space-3);
  }

  /* 01 · Arrival hairline — the existing rule, lit and travelling. */
  .lv-hairline {
    position: absolute;
    inset-inline: 0;
    inset-block-end: -1px;
    block-size: 2px;
    overflow: hidden;
  }

  .lv-hairline > span {
    display: block;
    inline-size: 45%;
    block-size: 100%;
    background: var(--je-color-action);
    animation: je-indeterminate var(--je-duration-loop) var(--je-ease) infinite alternate;
  }

  /* 02 · Intent rail — the selected-item mark, at the content edge. */
  .lv-rail {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    inline-size: 3px;
    overflow: hidden;
  }

  .lv-rail > span {
    display: block;
    inline-size: 100%;
    block-size: 40%;
    border-radius: var(--je-radius-round);
    background: var(--je-color-action);
    animation: lv-rail-travel var(--je-duration-loop) var(--je-ease) infinite alternate;
  }

  /* 03 · Shimmer sweep — the skeleton's wash, at page scale. */
  .lv-sweep {
    position: absolute;
    inset-inline: 0;
    inset-block-start: 100%;
    block-size: 2.5rem;
    overflow: hidden;
    pointer-events: none;
  }

  /* Neutral rather than tinted: at page scale a brand wash reads as a coloured
     panel, which is a state, not a wait. */
  .lv-sweep > span {
    display: block;
    inline-size: 55%;
    block-size: 100%;
    background: linear-gradient(90deg, transparent, var(--je-color-surface-sunken), transparent);
    animation: je-indeterminate var(--je-duration-loop) var(--je-ease) infinite;
  }

  /* 04 · Ledger rows — the row rhythm, reserved. */
  .lv-ledger {
    display: grid;
  }

  .lv-ledger__row {
    block-size: 0.5rem;
    margin-block: var(--je-space-2);
    border-radius: var(--je-radius-round);
    background: var(--je-color-surface-sunken);
    opacity: 0.45;
    animation: lv-settle var(--je-duration-loop) var(--je-ease) infinite alternate;
    animation-delay: calc(var(--je-duration-loop) * 0.12 * var(--lv-step));
  }

  .lv-ledger__row + .lv-ledger__row {
    border-block-start: 1px solid var(--je-color-border-subtle);
  }

  /* 05 · Page silhouette — the resolved composition's own footprint. */
  .lv-silhouette {
    display: grid;
    gap: var(--je-space-2);
  }

  .lv-silhouette__kpis {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--je-space-1);
  }

  .lv-silhouette__kpi {
    block-size: 1.5rem;
    border-radius: var(--je-radius-xs);
  }

  .lv-silhouette__cols {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    gap: var(--je-space-1);
  }

  .lv-silhouette__panel {
    block-size: 4rem;
    border-radius: var(--je-radius-xs);
  }

  /* 06 · Four beats — the product loop as the waiting language. */
  .lv-beats {
    display: grid;
    place-items: center;
    block-size: 100%;
  }

  .lv-beats__track {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--je-space-3);
  }

  .lv-beats__beat {
    display: grid;
    justify-items: center;
    gap: var(--je-space-1);
    font-size: var(--je-font-size-2xs);
    color: var(--je-color-text-subtle);
  }

  /* The emphasis travels by staggering four identical pulses rather than moving
     one element across a gap-aware grid — no layout arithmetic to get wrong. */
  .lv-beats__beat i {
    inline-size: 0.5rem;
    block-size: 0.5rem;
    border-radius: var(--je-radius-round);
    background: var(--je-color-action);
    opacity: 0.22;
    animation: lv-beat var(--je-duration-loop) var(--je-ease) infinite;
    animation-delay: calc(var(--je-duration-loop) * 0.25 * var(--lv-step));
  }

  /* 07 · Slot ledger — the places exist; the counts are still coming. */
  .lv-slots {
    display: flex;
    flex-wrap: wrap;
    gap: var(--je-space-2);
  }

  .lv-slots__chip {
    display: inline-flex;
    align-items: center;
    gap: var(--je-space-2);
    padding: 0.125rem var(--je-space-2);
    border: 1px solid var(--je-color-border);
    border-radius: var(--je-radius-round);
    font-size: var(--je-font-size-2xs);
    color: var(--je-color-text-muted);
  }

  /* The withheld numeral has to be legibly absent: too faint and the chip reads
     as an ordinary empty label rather than a count still being tallied. */
  .lv-slots__chip i {
    inline-size: 1.1rem;
    block-size: 0.5rem;
    border-radius: var(--je-radius-round);
    background: var(--je-color-border-strong);
    animation: lv-settle var(--je-duration-loop) var(--je-ease) infinite alternate;
    animation-delay: calc(var(--je-duration-loop) * 0.16 * var(--lv-step));
  }

  /* 08 · Breath — words, and nothing moving. */
  .lv-breath {
    margin: 0;
    font-size: var(--je-font-size-sm);
    color: var(--je-color-text-muted);
    animation: lv-breathe var(--je-duration-loop) var(--je-ease) infinite alternate;
  }

  /* 09 · Corner arc — status, out of the reading path. */
  .lv-arc {
    position: absolute;
    inset-block-start: var(--je-space-3);
    inset-inline-end: var(--je-space-3);
    inline-size: 1rem;
    block-size: 1rem;
    border: 1.5px solid var(--je-color-border-strong);
    border-inline-end-color: transparent;
    border-radius: var(--je-radius-round);
    animation: je-spin var(--je-duration-spin) linear infinite;
  }

  /* Reduced motion. `data-still` is set by the toggle above and by a real
     reduced-motion preference, so there is exactly one still rendering to
     maintain. Each treatment keeps its meaning without movement; none of them
     simply disappears, which would leave a wait unreported. */
  .lv[data-still='true'] .lv-hairline > span {
    inline-size: 100%;
    opacity: 0.55;
    animation: none;
  }

  .lv[data-still='true'] .lv-rail > span {
    block-size: 100%;
    opacity: 0.45;
    animation: none;
  }

  .lv[data-still='true'] .lv-sweep > span {
    inline-size: 100%;
    opacity: 0.6;
    animation: none;
  }

  .lv[data-still='true'] .lv-ledger__row,
  .lv[data-still='true'] .lv-slots__chip i {
    opacity: 0.6;
    animation: none;
  }

  .lv[data-still='true'] .lv-beats__beat i {
    animation: none;
  }

  .lv[data-still='true'] .lv-beats__beat:first-child i {
    opacity: 1;
  }

  .lv[data-still='true'] .lv-breath {
    opacity: 1;
    animation: none;
  }

  .lv[data-still='true'] .lv-arc {
    border-inline-end-color: var(--je-color-border-strong);
    opacity: 0.5;
    animation: none;
  }

  /* The skeleton primitive carries its own reduced-motion rule; the preview
     toggle has to reproduce it locally. */
  .lv[data-still='true'] :global(.ui-skeleton::after) {
    animation: none;
  }

  /* Local motion vocabulary for the candidates. Durations stay on tokens, so a
     candidate that is promoted inherits the system's timing automatically. */
  @keyframes lv-rail-travel {
    from { transform: translateY(-25%); }
    to { transform: translateY(175%); }
  }

  @keyframes lv-settle {
    from { opacity: 0.28; }
    to { opacity: 0.75; }
  }

  @keyframes lv-beat {
    0%, 55%, 100% { opacity: 0.22; }
    18% { opacity: 1; }
  }

  @keyframes lv-breathe {
    from { opacity: 0.45; }
    to { opacity: 1; }
  }

  @media (max-width: 720px) {
    .lv {
      padding: var(--je-space-6) var(--je-space-4) var(--je-space-8);
    }
  }
</style>
