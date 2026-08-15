<script lang="ts">
  import wordmarkUrl from '$lib/assets/brand/jooevents-wordmark-login.png';
  import MakerSignature from '$lib/brand/MakerSignature.svelte';
  import { ATTRIBUTION_PLACEMENT } from '$lib/brand/attribution';

  let {
    children,
    contentLed = false,
    waiting = false
  }: { children: import('svelte').Snippet; contentLed?: boolean; waiting?: boolean } = $props();
</script>

<div class="entry-page" class:entry-page--content={contentLed}>
  <main class="entry-main">
    <a class="entry-brand" href="/" aria-label="JooEvents home">
      <img src={wordmarkUrl} width="512" height="90" alt="" aria-hidden="true" />
    </a>
    <p class="entry-tagline">Events for people who don't want to manage events.</p>
    <section class="entry-panel">
      <!-- One wait, one indicator. It belongs to the panel rather than to any
           state inside it, so checking who you are and finishing your admission
           are one continuous motion instead of two treatments that each restart.
           It costs no layout, so it can never move the task under it. The states
           it spans still speak for themselves in the live region. -->
      {#if waiting}<div class="entry-rail" aria-hidden="true"><span></span></div>{/if}
      <div class="entry-content">{@render children()}</div>
    </section>
  </main>
  <!-- Outside main, below the task, and static across every entry state: the
       signature can never move the primary action, and no state has to make
       room for it. -->
  {#if ATTRIBUTION_PLACEMENT.entry}
    <MakerSignature links class="entry-maker" />
  {/if}
</div>
