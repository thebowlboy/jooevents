<script lang="ts">
  import type { Component } from 'svelte';
  import '@fontsource-variable/inter';
  import '@fontsource/merriweather/400.css';
  import '@fontsource/merriweather/700.css';
  import '../app.css';

  let { children } = $props();

  // Scenario tooling belongs only to the sample composition. Conditional
  // imports also keep it out of production bundles.
  let DevScenarioSwitcher = $state<Component | null>(null);
  let DevFontSwitcher = $state<Component | null>(null);
  if (import.meta.env.DEV && import.meta.env.MODE !== 'live') {
    import('$lib/dev/DevScenarioSwitcher.svelte').then((module) => {
      DevScenarioSwitcher = module.default;
    });
    // Mounted at the root, not per-area: judging a typeface means seeing it on
    // the entry screens and the dense operator tables alike.
    import('$lib/dev/DevFontSwitcher.svelte').then((module) => {
      DevFontSwitcher = module.default;
    });
  }
</script>

{@render children()}

{#if DevScenarioSwitcher}
  <DevScenarioSwitcher />
{/if}

{#if DevFontSwitcher}
  <DevFontSwitcher />
{/if}
