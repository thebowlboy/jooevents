<script lang="ts">
  import { scopeAccessibleName, type Scope } from './scopes';

  interface Props {
    /** Names the set for assistive technology: "Submission trays". */
    label: string;
    scopes: readonly Scope[];
    /** The active scope's `value`. Bindable. */
    value: string;
    onchange?: (value: string) => void;
    /**
     * The radio group's `name`. Two scope sets on one page must not share
     * one, or choosing in either clears the other; a generated id is the
     * default so they cannot collide by accident.
     */
    name?: string;
  }

  let { label, scopes, value = $bindable(), onchange, name }: Props = $props();

  const groupName = $props.id();
  const group = $derived(name ?? `scopes-${groupName}`);

  function choose(next: string) {
    if (next === value) return;
    value = next;
    onchange?.(next);
  }
</script>

<!--
  A native radio in every chip, so arrow-key movement, the single tab stop, and
  the checked state are the platform's rather than a hand-rolled roving
  tabindex. The input stays in the accessibility tree (`ui-sr-only`, not
  `hidden`); the chip around it is its visible face and carries the ring.
-->
<div class="ui-scopes" role="radiogroup" aria-label={label}>
  <div class="ui-scopes__set">
    {#each scopes as scope (scope.value)}
      {@const Glyph = scope.icon}
      <label class="ui-scopes__scope" class:ui-scopes__scope--active={value === scope.value}>
        <input
          class="ui-sr-only"
          type="radio"
          name={group}
          value={scope.value}
          checked={value === scope.value}
          aria-label={scopeAccessibleName(scope)}
          onchange={() => choose(scope.value)} />
        {#if Glyph}<Glyph class="ui-scopes__icon" aria-hidden="true" />{/if}
        <span class="ui-scopes__label ui-scopes__full" aria-hidden="true">{scope.label}</span>
        {#if scope.short}
          <span class="ui-scopes__label ui-scopes__short" aria-hidden="true">{scope.short}</span>
        {/if}
        {#if scope.count !== undefined}
          <span class="ui-scopes__count" aria-hidden="true">{scope.count}</span>
        {/if}
      </label>
    {/each}
  </div>
</div>
