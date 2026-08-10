<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  type Variant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger';
  type Size = 'sm' | 'md' | 'lg';

  type Props = Omit<HTMLButtonAttributes, 'children'> & {
    children?: Snippet;
    variant?: Variant;
    size?: Size;
    loading?: boolean;
    iconOnly?: boolean;
  };

  let {
    children,
    variant = 'primary',
    size = 'md',
    loading = false,
    iconOnly = false,
    disabled = false,
    type = 'button',
    class: className = '',
    ...rest
  }: Props = $props();

  const classes = $derived(
    `ui-button ui-button--${variant} ui-button--${size}${iconOnly ? ' ui-button--icon' : ''} ${className}`
  );
</script>

<button
  {...rest}
  {type}
  class={classes}
  disabled={disabled || loading}
  aria-busy={loading || undefined}
>
  {#if loading}<span class="ui-spinner" aria-hidden="true"></span>{/if}
  {@render children?.()}
</button>
