<script lang="ts">
  type Size = 'sm' | 'md' | 'lg';

  interface Props {
    name: string;
    src?: string;
    size?: Size;
  }

  let { name, src, size = 'md' }: Props = $props();
  const initials = $derived(
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase()
  );
</script>

<span class="ui-avatar ui-avatar--{size}" title={name} aria-label={name}>
  {#if src}<img alt="" {src} />{:else}{initials}{/if}
</span>
