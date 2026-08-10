<script lang="ts">
  interface Props {
    label: string;
    description?: string;
    group?: string;
    value: string;
    name: string;
    disabled?: boolean;
  }

  let {
    label,
    description,
    group = $bindable(''),
    value,
    name,
    disabled = false
  }: Props = $props();
</script>

<label class:ui-choice--disabled={disabled} class="ui-choice">
  <input bind:group {disabled} {name} {value} type="radio" />
  <span class="ui-choice__control ui-choice__control--radio" aria-hidden="true"></span>
  <span class="ui-choice__copy">
    <span>{label}</span>
    {#if description}<span class="ui-choice__description">{description}</span>{/if}
  </span>
</label>
