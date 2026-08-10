<script lang="ts">
  import { Check, Minus } from 'lucide-svelte';

  interface Props {
    label: string;
    description?: string;
    checked?: boolean;
    mixed?: boolean;
    disabled?: boolean;
    name?: string;
    value?: string;
    onchange?: (checked: boolean) => void;
  }

  let {
    label,
    description,
    checked = $bindable(false),
    mixed = false,
    disabled = false,
    name,
    value,
    onchange
  }: Props = $props();

  let input: HTMLInputElement;

  $effect(() => {
    if (input) input.indeterminate = mixed;
  });

  function handleChange() {
    onchange?.(checked);
  }
</script>

<label class:ui-choice--disabled={disabled} class="ui-choice">
  <input bind:this={input} bind:checked {disabled} {name} {value} type="checkbox" onchange={handleChange} />
  <span class="ui-choice__control" aria-hidden="true">
    {#if mixed}<Minus />{:else}<Check />{/if}
  </span>
  <span class="ui-choice__copy">
    <span>{label}</span>
    {#if description}<span class="ui-choice__description">{description}</span>{/if}
  </span>
</label>
