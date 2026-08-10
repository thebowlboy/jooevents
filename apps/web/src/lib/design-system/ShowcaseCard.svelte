<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    description?: string;
    eyebrow?: string;
    full?: boolean;
    flush?: boolean;
    children: Snippet;
    actions?: Snippet;
  }

  let {
    title,
    description,
    eyebrow,
    full = false,
    flush = false,
    children,
    actions
  }: Props = $props();
</script>

<article class:showcase-card--full={full} class:showcase-card--flush={flush} class="showcase-card">
  <header class="showcase-card__header">
    <div>
      {#if eyebrow}<p class="showcase-card__eyebrow">{eyebrow}</p>{/if}
      <h3>{title}</h3>
      {#if description}<p>{description}</p>{/if}
    </div>
    {#if actions}<div class="showcase-card__actions">{@render actions()}</div>{/if}
  </header>
  <div class="showcase-card__body">{@render children()}</div>
</article>
