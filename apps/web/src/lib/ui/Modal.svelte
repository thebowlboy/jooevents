<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';
  import Button from './Button.svelte';

  interface Props {
    open?: boolean;
    title: string;
    /**
     * `lg` is the inspection width: a surface people read one thing *against*
     * another needs room to hold both, and it takes the whole viewport where
     * there is no room to spare.
     */
    size?: 'md' | 'lg';
    /**
     * Whether a press outside the dialog closes it. An inspection surface is
     * left the moment you are done looking; a decision has to be answered, so
     * this is opt-in rather than the default.
     */
    dismissible?: boolean;
    children: Snippet;
    footer?: Snippet<[() => void]>;
  }

  let {
    open = $bindable(false),
    title,
    size = 'md',
    dismissible = false,
    children,
    footer
  }: Props = $props();
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

  /**
   * A press on the backdrop lands on the dialog element itself: header, body,
   * and footer cover its whole box, so nothing inside can be mistaken for it.
   */
  function backdropPress(event: MouseEvent) {
    if (dismissible && event.target === dialog) close();
  }
</script>

<dialog
  bind:this={dialog}
  class="ui-dialog"
  class:ui-dialog--lg={size === 'lg'}
  aria-labelledby={`${dialogId}-title`}
  onclick={backdropPress}
  onclose={close}
  oncancel={close}>
  <div class="ui-dialog__header">
    <h2 class="ui-dialog__title" id={`${dialogId}-title`}>{title}</h2>
    <Button variant="ghost" size="sm" iconOnly aria-label="Close dialog" onclick={close}><X /></Button>
  </div>
  <div class="ui-dialog__body">{@render children()}</div>
  {#if footer}<div class="ui-dialog__footer">{@render footer(close)}</div>{/if}
</dialog>
