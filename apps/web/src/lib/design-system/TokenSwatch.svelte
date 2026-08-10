<script lang="ts">
  interface Props {
    name: string;
    value: string;
    foreground?: string;
  }

  let { name, value, foreground = '#2a2522' }: Props = $props();
</script>

<div class="token-swatch" style:background={value} style:color={foreground}>
  <span>{name}</span>
  <code>{value}</code>
</div>
