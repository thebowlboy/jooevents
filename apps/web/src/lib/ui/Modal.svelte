<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';
  import Button from './Button.svelte';

  interface Props {
    open?: boolean;
    title: string;
    children: Snippet;
    footer?: Snippet<[() => void]>;
  }

  let { open = $bindable(false), title, children, footer }: Props = $props();
  let dialog: HTMLDialogElement;
  const dialogId = $props.id();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  function close() {
    open = false;
  }
</script>

<dialog bind:this={dialog} class="ui-dialog" aria-labelledby={`${dialogId}-title`} onclose={close} oncancel={close}>
  <div class="ui-dialog__header">
    <h2 class="ui-dialog__title" id={`${dialogId}-title`}>{title}</h2>
    <Button variant="ghost" size="sm" iconOnly aria-label="Close dialog" onclick={close}><X /></Button>
  </div>
  <div class="ui-dialog__body">{@render children()}</div>
  {#if footer}<div class="ui-dialog__footer">{@render footer(close)}</div>{/if}
</dialog>
