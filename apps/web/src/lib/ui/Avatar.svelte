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

<!-- No `title`: a hover tooltip never reaches a touch device and arrives too late
     everywhere else, so the mark carries its name to assistive technology and the
     composition around it carries the name people read. -->
<span class="ui-avatar ui-avatar--{size}" aria-label={name}>
  {#if src}<img alt="" {src} />{:else}{initials}{/if}
</span>
