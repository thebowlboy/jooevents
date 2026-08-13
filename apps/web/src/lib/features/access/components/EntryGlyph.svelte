<script lang="ts">
  /**
   * The two entry glyphs: a sparkle that titles the magic-link method group and
   * an envelope that sits beside "Check your email".
   *
   * They name a method and a moment rather than a status, so they stay local to
   * entry instead of joining the product's status vocabulary. Both are static,
   * take their colour from the text they accompany, and render `aria-hidden` —
   * the words beside them always carry the meaning.
   */
  let { name }: { name: 'sparkle' | 'envelope' } = $props();
</script>

<svg
  class="entry-glyph"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false">
  {#if name === 'sparkle'}
    <path d="M10.5 4.5 Q11.5 11.5 18 12.5 Q11.5 13.5 10.5 20 Q9.5 13.5 3 12.5 Q9.5 11.5 10.5 4.5 Z" />
    <path d="M18.6 3.4 Q18.9 5.5 21 5.8 Q18.9 6.1 18.6 8.2 Q18.3 6.1 16.2 5.8 Q18.3 5.5 18.6 3.4 Z" />
  {:else}
    <rect x="2.75" y="5.25" width="18.5" height="13.5" rx="2.5" />
    <path d="M3.75 7.75 10.7 13.1 a2.1 2.1 0 0 0 2.6 0 l6.95 -5.35" />
  {/if}
</svg>
