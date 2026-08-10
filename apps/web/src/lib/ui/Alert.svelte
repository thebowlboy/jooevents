<script lang="ts">
  import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-svelte';

  type Tone = 'success' | 'warning' | 'danger' | 'info';

  interface Props {
    title: string;
    message: string;
    tone?: Tone;
    dismissible?: boolean;
  }

  let { title, message, tone = 'info', dismissible = false }: Props = $props();
  let visible = $state(true);
</script>

{#if visible}
  <div class="ui-alert ui-alert--{tone}" role={tone === 'danger' ? 'alert' : 'status'}>
    {#if tone === 'success'}
      <CircleCheck class="ui-alert__icon" aria-hidden="true" />
    {:else if tone === 'warning'}
      <TriangleAlert class="ui-alert__icon" aria-hidden="true" />
    {:else if tone === 'danger'}
      <CircleAlert class="ui-alert__icon" aria-hidden="true" />
    {:else}
      <Info class="ui-alert__icon" aria-hidden="true" />
    {/if}
    <div class="ui-alert__copy">
      <p class="ui-alert__title">{title}</p>
      <p class="ui-alert__message">{message}</p>
    </div>
    {#if dismissible}
      <button class="ui-button ui-button--ghost ui-button--sm ui-button--icon" type="button" aria-label="Dismiss alert" onclick={() => (visible = false)}><X /></button>
    {/if}
  </div>
{/if}
