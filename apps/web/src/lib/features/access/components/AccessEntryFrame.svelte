<script lang="ts">
  import wordmarkUrl from '$lib/assets/brand/jooevents-wordmark-login.png';

  let { children }: { children: import('svelte').Snippet } = $props();
</script>

<div class="entry-page">
  <main class="entry-main">
    <a class="entry-brand" href="/" aria-label="JooEvents home">
      <img src={wordmarkUrl} width="512" height="94" alt="" aria-hidden="true" />
    </a>
    <p class="entry-tagline">Events for people who don't want to manage events.</p>
    <section class="entry-panel">
      <div class="entry-content">{@render children()}</div>
    </section>
  </main>
</div>
