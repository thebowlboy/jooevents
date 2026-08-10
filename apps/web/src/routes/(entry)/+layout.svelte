<script lang="ts">
  import AccessEntryScreen from '$lib/features/access/components/AccessEntryScreen.svelte';
  let { children }: { children: import('svelte').Snippet } = $props();
</script>

<AccessEntryScreen />
{@render children()}
