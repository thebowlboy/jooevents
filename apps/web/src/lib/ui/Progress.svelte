<script lang="ts">
  interface Props {
    value: number;
    label: string;
    showValue?: boolean;
  }

  let { value, label, showValue = true }: Props = $props();
  const safeValue = $derived(Math.max(0, Math.min(100, value)));
</script>

<div class="ui-progress">
  <div class="ui-progress__header"><span>{label}</span>{#if showValue}<span>{safeValue}%</span>{/if}</div>
  <div class="ui-progress__track" role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={safeValue}>
    <div class="ui-progress__value" style:transform="scaleX({safeValue / 100})"></div>
  </div>
</div>
