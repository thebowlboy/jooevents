<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';
  import Button from './Button.svelte';
  import { PHONE_QUERY } from './breakpoints';

  interface Props {
    /**
     * The record's identity. Shown in the sheet's header, where the list is
     * no longer on screen to say which record this is — and deliberately
     * *not* repeated inline, where the open row is one line above it.
     */
    title: string;
    /**
     * Whether the detail is showing. Pages that already gate the component
     * behind `{#if expandedId === row.id}` can leave it alone: the default is
     * open, so mounting shows it and unmounting hides it.
     */
    open?: boolean;
    /**
     * Fired when the sheet is dismissed — Escape, the close control, or the
     * backdrop. The page must clear its own expanded state here, or the row
     * stays open behind a sheet nobody can see.
     */
    onclose?: () => void;
    /** Labelled facts that open the record — who it is about, at most a line
     *  or two. The record's evidence follows in `blocks`. */
    fields?: Snippet;
    /** Long-form blocks: the abstract, materials. Separated as their own group. */
    blocks?: Snippet;
    /**
     * Labelled facts that close the record: classification, provenance, and
     * state a reader consults rather than reads — after the evidence, because
     * a deliberation surface leads with what is judged, not with what is
     * filed. Same aligned label/value grammar as `fields`.
     */
    meta?: Snippet;
    /** Actions on the record as a whole. */
    actions?: Snippet;
    /** What either action costs, stated at the point of action. */
    footnote?: Snippet;
    /**
     * `auto` promotes to a full-screen sheet on phones and stays inline
     * everywhere else. `inline` and `sheet` pin one presentation, for a
     * workbench specimen or a surface with no list to return to.
     */
    presentation?: 'auto' | 'inline' | 'sheet';
  }

  let {
    title,
    open = true,
    onclose,
    fields,
    blocks,
    meta,
    actions,
    footnote,
    presentation = 'auto'
  }: Props = $props();

  let phone = $state(false);

  $effect(() => {
    const query = window.matchMedia(PHONE_QUERY);
    phone = query.matches;
    const sync = (event: MediaQueryListEvent) => {
      phone = event.matches;
    };
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  });

  const asSheet = $derived(presentation === 'sheet' || (presentation === 'auto' && phone));

  let dialog = $state<HTMLDialogElement>();
  const dialogId = $props.id();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  /**
   * Every dismissal goes through the element, never straight to the callback.
   *
   * The page's usual response to `onclose` is to stop rendering the record's
   * detail at all — so notifying first tore the `<dialog>` out of the document
   * while it was still open, and the browser had nothing left to return focus
   * to. Closing the element first lets the platform restore focus to whatever
   * opened the sheet, and the native `close` event is what tells the page.
   */
  function dismiss() {
    if (dialog?.open) dialog.close();
    else onclose?.();
  }

  /** The backdrop is the dialog's own box; header, body, and footer cover it. */
  function backdropPress(event: MouseEvent) {
    if (event.target === dialog) dismiss();
  }
</script>

{#snippet body()}
  <div class="ui-detail__content">
    {#if fields}<div class="ui-detail__fields">{@render fields()}</div>{/if}
    {#if blocks}<div class="ui-detail__blocks">{@render blocks()}</div>{/if}
    {#if meta}<div class="ui-detail__fields ui-detail__fields--meta">{@render meta()}</div>{/if}
  </div>
{/snippet}

<div class="ui-detail-host" data-presentation={asSheet ? 'sheet' : 'inline'}>
  {#if asSheet}
    <!--
      Native <dialog>, so focus containment, Escape, the top layer, and focus
      restoration on close are the browser's job. A phone gets the sheet
      because the alternative was measured and unusable: opening a row at 390px
      scrolled the table 490px sideways, and the abstract, both actions, and
      the record's own title all left the screen.
    -->
    <dialog
      bind:this={dialog}
      class="ui-dialog ui-sheet"
      aria-labelledby={`${dialogId}-title`}
      onclick={backdropPress}
      onclose={() => onclose?.()}>
      <div class="ui-dialog__header">
        <h2 class="ui-dialog__title" id={`${dialogId}-title`}>{title}</h2>
        <Button variant="ghost" size="sm" iconOnly aria-label="Close details" onclick={dismiss}>
          <X />
        </Button>
      </div>
      <div class="ui-dialog__body">
        {@render body()}
        {#if footnote}<p class="ui-detail__footnote">{@render footnote()}</p>{/if}
      </div>
      {#if actions}
        <div class="ui-dialog__footer">
          <div class="ui-detail__rail">{@render actions()}</div>
        </div>
      {/if}
    </dialog>
  {:else}
    <div class="ui-detail" class:ui-detail--stacked={!actions && !footnote}>
      {@render body()}
      {#if actions || footnote}
        <!-- The rail carries actions on the record as a whole, and the note
             saying what either costs sits with them rather than above the
             content it does not describe. -->
        <div class="ui-detail__rail">
          {#if actions}{@render actions()}{/if}
          {#if footnote}<p class="ui-detail__footnote">{@render footnote()}</p>{/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
