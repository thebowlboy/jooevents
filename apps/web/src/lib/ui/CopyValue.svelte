<script lang="ts">
  /**
   * A value that is read *and* transported: an address, a link, a reference code.
   *
   * The value itself stays ordinary selectable text. Nothing wraps it in a
   * button, nothing intercepts pointer events on it, and no click handler sits on
   * the text — so click-and-drag still selects exactly as it did before, and
   * double-click still takes the word. The shortcut is an adjacent control, never
   * a replacement for selecting by hand.
   *
   * The control keeps its space in the row at all times and stays in the tab
   * order; only its opacity changes. A control that appeared on hover would move
   * the layout under the pointer and would never be discoverable by keyboard or
   * touch, so on a coarse pointer it is simply always visible.
   *
   * Confirmation is three things, none of which can move a row:
   *
   * - the glyph cross-fades in place (two glyphs in one grid cell, opacity only);
   * - the value itself lights briefly, so the person sees *which* value went to
   *   the clipboard rather than only that something did;
   * - a "Copied" flag fades in beside it, in the **top layer**. These values sit
   *   inside clamped `overflow: hidden` cells, where an ordinary absolutely
   *   positioned pill would be cut in half; the top layer is outside every
   *   ancestor's clipping and stacking context, and costs no layout at all.
   *
   * The surface also mirrors the words to its polite live region.
   */
  import { tick } from 'svelte';
  import { Check, Copy } from 'lucide-svelte';
  import { lower, placeNear, raise } from './anchored.svelte';
  import { writeToClipboard } from './clipboard';

  interface Props {
    /** The exact text placed on the clipboard. */
    value: string;
    /** Names the thing in the control's accessible name: "Copy email address". */
    label: string;
    /** Rendered instead of the raw value when the display form differs. */
    display?: string;
    /** Lets the surface mirror the confirmation into its own live region. */
    oncopy?: (value: string) => void;
  }

  let { value, label, display, oncopy }: Props = $props();

  /** Long enough to be read, short enough not to linger as state. */
  const HELD_MS = 1600;

  let copied = $state(false);
  let failed = $state(false);
  let shown = $state(false);
  let placed = $state(false);
  let button = $state<HTMLButtonElement>();
  let flag = $state<HTMLElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function reveal() {
    shown = true;
    placed = false;
    await tick();
    raise(flag);
    placeNear(button, flag);
    placed = true;
  }

  function conceal() {
    lower(flag);
    shown = false;
    placed = false;
  }

  async function copy() {
    clearTimeout(timer);
    if (await writeToClipboard(value)) {
      copied = true;
      failed = false;
      oncopy?.(value);
      await reveal();
    } else {
      // Say so rather than showing a success the clipboard never received.
      copied = false;
      failed = true;
    }
    timer = setTimeout(() => {
      copied = false;
      failed = false;
      conceal();
    }, HELD_MS);
  }
</script>

<span class="ui-copy" class:ui-copy--copied={copied}>
  <span class="ui-copy__value">{display ?? value}</span>
  <button
    type="button"
    class="ui-copy__button"
    class:ui-copy__button--done={copied}
    class:ui-copy__button--failed={failed}
    bind:this={button}
    aria-label={copied ? `${label} copied` : failed ? `${label} could not be copied` : `Copy ${label}`}
    onclick={copy}>
    <!-- Stacked in one cell so the swap is a cross-fade, never a reflow. -->
    <span class="ui-copy__glyphs">
      <Copy class="ui-copy__glyph ui-copy__glyph--rest" aria-hidden="true" />
      <Check class="ui-copy__glyph ui-copy__glyph--done" aria-hidden="true" />
    </span>
  </button>
  {#if shown}
    <!-- One element, both jobs: the words for the eye, and a polite announcement
         for assistive technology. Naming the value keeps it useful when several
         copyable things sit in one row. -->
    <span
      class="ui-copy__flag"
      class:ui-copy__flag--placed={placed}
      bind:this={flag}
      role="status">Copied<span class="ui-sr-only">{` ${label}`}</span></span>
  {/if}
</span>
