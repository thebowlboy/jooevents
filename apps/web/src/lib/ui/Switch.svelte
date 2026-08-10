<script lang="ts">
  interface Props {
    label: string;
    description?: string;
    checked?: boolean;
    disabled?: boolean;
    onchange?: (checked: boolean) => void;
  }

  let {
    label,
    description,
    checked = $bindable(false),
    disabled = false,
    onchange
  }: Props = $props();
</script>

<label class:ui-choice--disabled={disabled} class="ui-switch">
  <input bind:checked {disabled} type="checkbox" role="switch" onchange={() => onchange?.(checked)} />
  <span class="ui-switch__track" aria-hidden="true"><span class="ui-switch__thumb"></span></span>
  <span class="ui-choice__copy">
    <span>{label}</span>
    {#if description}<span class="ui-choice__description">{description}</span>{/if}
  </span>
</label>
