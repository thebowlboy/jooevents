<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { IconComponent } from './status-icons';

  type Tone = 'neutral' | 'action' | 'success' | 'warning' | 'danger' | 'info' | 'lavender' | 'sea';

  interface Props {
    children: Snippet;
    tone?: Tone;
    dot?: boolean;
    /** Solid act-now emphasis; styled for the success, warning, and danger tones. */
    emphasis?: boolean;
    /**
     * Leading status glyph from the shared `statusIcon` vocabulary. Recognition
     * support only: the badge's word still carries the state, so the glyph is
     * always aria-hidden. Supersedes `dot` — one fact, one marker.
     */
    icon?: IconComponent;
  }

  let { children, tone = 'neutral', dot = false, emphasis = false, icon: StatusIcon }: Props = $props();
</script>

<span class="ui-badge ui-badge--{tone}" class:ui-badge--solid={emphasis}>
  {#if StatusIcon}
    <StatusIcon class="ui-badge__icon" aria-hidden="true" />
  {:else if dot}
    <span class="ui-badge__dot" aria-hidden="true"></span>
  {/if}
  {@render children()}
</span>
