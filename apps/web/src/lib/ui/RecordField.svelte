<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /**
     * The question this value answers. Every fact in a detail carries one:
     * the measured failure was a bare "Ingrid Halvorsen" sitting under a
     * timestamp with no term in front of it, three lines below the same name
     * on the row — a value nobody could place and nobody needed twice.
     */
    label: string;
    /**
     * Label above, value beneath, spanning the whole detail. For values that
     * are not a phrase: an abstract, an attachment list, a history.
     */
    block?: boolean;
    /** Long-form copy: gives the value a real measure and body leading. */
    prose?: boolean;
    /**
     * The record's principal evidence: content a person must read before acting,
     * not supporting prose. It stays on the neutral ink ladder and gains only
     * typographic hierarchy, so importance does not mint another role colour.
     */
    emphasis?: 'default' | 'primary';
    /**
     * A closed recognition role for scan values inside dense records.
     *
     * `person` and `time` add a quiet, consistent hue; `measure` relies on
     * weight and tabular figures. Category and state values keep using their
     * dedicated TrackChip and Badge primitives rather than entering this set.
     */
    role?: 'default' | 'person' | 'time' | 'measure';
    children: Snippet;
  }

  let {
    label,
    block = false,
    prose = false,
    emphasis = 'default',
    role = 'default',
    children
  }: Props = $props();
</script>

<div class="ui-detail__field" class:ui-detail__field--block={block || prose}>
  <span class="ui-detail__label">{label}</span>
  <div
    class="ui-detail__value ui-detail__value--{role}"
    class:ui-detail__value--prose={prose}
    class:ui-detail__value--primary={emphasis === 'primary'}>{@render children()}</div>
</div>
