<script lang="ts">
  let {
    busy = false,
    label,
    quiet = false,
    onclick
  }: { busy?: boolean; label: string; quiet?: boolean; onclick: () => void } = $props();
</script>

<!-- One control, two weights (owner revision 2026-08-15). On the resting card
     it is a peer way in and carries the familiar provider treatment; on the
     confirmation state, where a link is already on its way, it steps back to
     the quiet alternative. -->
<button
  class="google-button"
  class:google-button--quiet={quiet}
  type="button"
  disabled={busy}
  aria-busy={busy}
  {onclick}>
  <span class="google-button__icon" aria-hidden="true">
    <svg viewBox="0 0 18 18" focusable="false">
      <path fill="#4285f4" d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.797 2.716v2.259h2.909c1.702-1.567 2.684-3.874 2.684-6.615Z"/>
      <path fill="#34a853" d="M9 18c2.43 0 4.468-.806 5.956-2.18l-2.909-2.259c-.806.54-1.835.859-3.047.859-2.344 0-4.328-1.585-5.037-3.714H.956v2.332A9 9 0 0 0 9 18Z"/>
      <path fill="#fbbc05" d="M3.963 10.706A5.41 5.41 0 0 1 3.682 9c0-.592.102-1.168.281-1.706V4.962H.956A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.038l3.007-2.332Z"/>
      <path fill="#ea4335" d="M9 3.58c1.321 0 2.507.454 3.441 1.346l2.581-2.581C13.464.892 11.426 0 9 0A9 9 0 0 0 .956 4.962l3.007 2.332C4.672 5.165 6.656 3.58 9 3.58Z"/>
    </svg>
  </span>
  <span>{busy ? 'Opening Google…' : label}</span>
  {#if busy}<span class="google-button__spinner" aria-hidden="true"></span>{/if}
</button>
