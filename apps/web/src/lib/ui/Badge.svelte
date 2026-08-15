<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { IconComponent } from './status-icons';
  import { statusToneClass, type StatusTone } from './status-tones';

  type PaletteTone =
    | 'neutral'
    | 'action'
    | 'success'
    | 'warning'
    | 'danger'
    | 'info'
    | 'lavender'
    | 'sea'
    /** Marking: what a surface is scoped or filtered to. Not a status. */
    | 'mark';

  /**
   * Two names reach the same paint. `StatusTone` is the vocabulary product
   * code should say — positive / negative / caution / info / neutral — because
   * it names the *meaning* and can be handed straight out of `badgeFor`. The
   * palette names stay for the accents and for marking, which are not states.
   */
  type Tone = PaletteTone | StatusTone;

  interface Props {
    /**
     * Data-driven text. A blank or whitespace-only value renders **nothing at
     * all** — an empty pill is a defect, not a state, and this is where it is
     * refused. Where the absence itself matters, the surface says so in words
     * on its quietest rung rather than drawing an empty box.
     */
    value?: string;
    children?: Snippet;
    tone?: Tone;
    dot?: boolean;
    /**
     * Solid act-now emphasis; styled for the success, warning, and danger
     * tones. This is a decision about the *region*, not about the state: at
     * most one accent-dominant element per region, and a whole column of solid
     * badges is always wrong.
     */
    emphasis?: boolean;
    /**
     * Leading status glyph from the shared `statusIcon` vocabulary. Recognition
     * support only: the badge's word still carries the state, so the glyph is
     * always aria-hidden. Supersedes `dot` — one fact, one marker.
     */
    icon?: IconComponent;
    /**
     * Allow the word to clip with an ellipsis where space is genuinely short.
     * Off by default: a badge is a background drawn around a word, so it holds
     * its content's width and lets the prose beside it absorb the pressure.
     * When on, the complete text stays in the DOM for assistive technology and
     * is mirrored into `title` for the pointer.
     */
    truncate?: boolean;
  }

  let {
    value,
    children,
    tone = 'neutral',
    dot = false,
    emphasis = false,
    icon: StatusIcon,
    truncate = false
  }: Props = $props();

  const paletteTone = $derived(
    tone in statusToneClass ? statusToneClass[tone as StatusTone] : (tone as PaletteTone)
  );

  /** Blank is not a value. `undefined` means "the caller is using `children`". */
  const text = $derived(value === undefined ? undefined : value.trim());
  const blank = $derived(text !== undefined && text.length === 0);
</script>

{#if !blank}
  <span
    class="ui-badge ui-badge--{paletteTone}"
    class:ui-badge--solid={emphasis}
    class:ui-badge--truncate={truncate}
    title={truncate && text ? text : undefined}>
    {#if StatusIcon}
      <StatusIcon class="ui-badge__icon" aria-hidden="true" />
    {:else if dot}
      <span class="ui-badge__dot" aria-hidden="true"></span>
    {/if}
    {#if text !== undefined}
      <span class="ui-badge__label">{text}</span>
    {:else}
      {@render children?.()}
    {/if}
  </span>
{/if}
