<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  /**
   * `danger` is filled and belongs to the confirming press inside a dialog,
   * where destroying the thing *is* the primary action. `danger-quiet` is the
   * one to reach for out in a row of ordinary controls: danger ink and a
   * danger-toned border on a quiet base, consequential without taking the
   * region's single accent-dominant slot.
   */
  type Variant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger' | 'danger-quiet';
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
