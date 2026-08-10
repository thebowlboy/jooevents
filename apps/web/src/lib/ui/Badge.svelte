<script lang="ts">
  import type { Snippet } from 'svelte';

  type Tone = 'neutral' | 'action' | 'success' | 'warning' | 'danger' | 'info' | 'lavender' | 'sea';

  interface Props {
    children: Snippet;
    tone?: Tone;
    dot?: boolean;
  }

  let { children, tone = 'neutral', dot = false }: Props = $props();
</script>

<span class="ui-badge ui-badge--{tone}">
  {#if dot}<span class="ui-badge__dot" aria-hidden="true"></span>{/if}
  {@render children()}
</span>
