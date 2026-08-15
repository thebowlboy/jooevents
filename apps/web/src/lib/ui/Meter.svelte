<script lang="ts">
  /**
   * A ratio against a limit, drawn as one bar in the learned status colours.
   *
   * It exists because two surfaces were drawing the same bar with different
   * answers: the Overview's pipeline lanes filled a coral wash for "fine" —
   * the action hue, which §Color forbids reading as a status and which sits 7°
   * from the danger family — while nothing else in the product drew a meter at
   * all. One definition of green/amber/red means an operator learns the bar
   * once.
   *
   * **The fill answers the state, not the fraction.** A stage at 97% whose
   * deadline is tomorrow is amber; a stage at 20% with three weeks left is
   * green. That asymmetry is the whole point of colouring a bar — the length
   * already carries the fraction, so spending hue on it again says nothing.
   *
   * **The bar is never the only carrier.** Callers render the digits beside it
   * (`valueText` is what assistive technology hears in place of a bare
   * percentage) and a state word wherever the state is not otherwise obvious.
   * The track is a lighter step of the fill's own ramp rather than a neutral
   * grey, so the state reads across the whole bar instead of only across the
   * filled part — which is what makes a nearly-empty amber bar legible.
   */
  import { statusToneClass, type StatusTone } from './status-tones';

  interface Props {
    /** Percentage, 0–100. Clamped, so a bad ratio cannot overflow the track. */
    value: number;
    /** What is being measured. Never rendered — the surface says it visibly. */
    label: string;
    /**
     * The state's loudness in the closed vocabulary. `neutral` is for a bar
     * that measures inventory rather than health, where a status colour would
     * claim something the number does not.
     */
    tone?: StatusTone;
    /**
     * The absolute a sighted reader compares — `583 of 600`. Announced instead
     * of the percentage, because "97%" answers a different question from "17
     * still open".
     */
    valueText?: string;
  }

  let { value, label, tone = 'neutral', valueText }: Props = $props();

  const safe = $derived(Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)));
</script>

<span
  class="ui-meter ui-meter--{statusToneClass[tone]}"
  role="progressbar"
  aria-label={label}
  aria-valuemin="0"
  aria-valuemax="100"
  aria-valuenow={safe}
  aria-valuetext={valueText}>
  <span class="ui-meter__fill" style:inline-size="{safe}%"></span>
</span>
