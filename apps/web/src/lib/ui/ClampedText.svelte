<script lang="ts" module>
  let nextId = 0;
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** The text body. Clamped to `lines` until the reader expands it. */
    children: Snippet;
    /** Optional metadata rendered on the footer row, before the toggle. */
    meta?: Snippet;
    lines?: number;
    /**
     * On coarse pointers, extend the toggle's hit area over the whole component.
     * Only for surfaces with no competing click action — see the list-row rules.
     */
    expandFromSurface?: boolean;
    /** Names the toggle when several appear in one list. */
    label?: string;
    moreLabel?: string;
    lessLabel?: string;
  }

  let {
    children,
    meta,
    lines = 2,
    expandFromSurface = false,
    label,
    moreLabel = 'Show more',
    lessLabel = 'Show less'
  }: Props = $props();

  let bodyElement = $state<HTMLElement>();
  let expanded = $state(false);
  let clipped = $state(false);

  const bodyId = `ui-clamp-${(nextId += 1)}`;

  // The toggle exists only when the text is genuinely cut off, so rows that fit
  // carry no affordance at all. Measured against the rendered box, so it
  // re-decides when the container width, font, or density changes.
  $effect(() => {
    const element = bodyElement;
    if (!element) return;

    const measure = () => {
      if (expanded) return; // keep the last collapsed measurement while open
      clipped = element.scrollHeight - element.clientHeight > 1;
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });
</script>

<div
  class="ui-clamp"
  class:ui-clamp--surface={expandFromSurface && clipped}
  style:--ui-clamp-lines={lines}
>
  <div
    class="ui-clamp__body"
    class:ui-clamp__body--clipped={!expanded}
    id={bodyId}
    bind:this={bodyElement}
  >
    {@render children()}
  </div>
  {#if meta || clipped}
    <div class="ui-clamp__footer">
      {#if meta}{@render meta()}{/if}
      {#if clipped}
        <button
          type="button"
          class="ui-clamp__toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onclick={() => (expanded = !expanded)}
        >
          {expanded ? lessLabel : moreLabel}{#if label}<span class="ui-sr-only"> — {label}</span>{/if}
        </button>
      {/if}
    </div>
  {/if}
</div>
