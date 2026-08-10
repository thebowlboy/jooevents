<script lang="ts">
  import { CalendarDays } from 'lucide-svelte';
</script>

<svelte:head><title>Workspace · JooEvents</title></svelte:head>
<main class="operator-placeholder">
  <span><CalendarDays aria-hidden="true" /></span>
  <p>JooEvents workspace</p>
  <h1>Your access is active</h1>
  <p>The operator workspace shell is ready for the next implementation slice.</p>
</main>

<style>
  .operator-placeholder { min-height: 100svh; padding: var(--je-space-8); display: grid; place-content: center; justify-items: start; gap: var(--je-space-4); background: var(--je-color-page); }
  .operator-placeholder span { display: grid; place-items: center; width: 3rem; height: 3rem; border-radius: var(--je-radius-lg); color: var(--je-color-action); background: var(--je-color-action-soft); }
  h1, p { margin: 0; } h1 { font-family: var(--je-font-display); } p { color: var(--je-color-text-muted); }
</style>
