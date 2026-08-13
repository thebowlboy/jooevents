<script lang="ts">
  import wordmarkUrl from '$lib/assets/brand/jooevents-wordmark-login.png';
  import MakerSignature from '$lib/brand/MakerSignature.svelte';
  import { ATTRIBUTION_PLACEMENT } from '$lib/brand/attribution';

  let { children, contentLed = false }: { children: import('svelte').Snippet; contentLed?: boolean } = $props();
</script>

<div class="entry-page" class:entry-page--content={contentLed}>
  <main class="entry-main">
    <a class="entry-brand" href="/" aria-label="JooEvents home">
      <img src={wordmarkUrl} width="512" height="90" alt="" aria-hidden="true" />
    </a>
    <p class="entry-tagline">Events for people who don't want to manage events.</p>
    <section class="entry-panel">
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
