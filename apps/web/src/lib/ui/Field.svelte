<script lang="ts">
  import type { Snippet } from 'svelte';

  export interface FieldControlContext {
    id: string;
    describedBy: string | undefined;
    invalid: boolean;
  }

  interface Props {
    id: string;
    label: string;
    description?: string;
    error?: string;
    success?: string;
    required?: boolean;
    optional?: boolean;
    meta?: string;
    children: Snippet<[FieldControlContext]>;
  }

  let {
    id,
    label,
    description,
    error,
    success,
    required = false,
    optional = false,
    meta,
    children
  }: Props = $props();

  const descriptionId = $derived(description ? `${id}-description` : undefined);
  const metaId = $derived(meta ? `${id}-meta` : undefined);
  const messageId = $derived(error || success ? `${id}-message` : undefined);
  const describedBy = $derived(
    [descriptionId, metaId, messageId].filter(Boolean).join(' ') || undefined
  );
</script>

<div class="ui-field">
  <div class="ui-field__heading">
    <label class="ui-label" for={id}>
      {label}
      {#if required}<span class="ui-label__required" aria-hidden="true"> *</span>{/if}
      {#if optional}<span class="ui-label__optional"> (optional)</span>{/if}
    </label>
    {#if meta}<span class="ui-field__meta" id={metaId}>{meta}</span>{/if}
  </div>
  {#if description}<p class="ui-field__description" id={descriptionId}>{description}</p>{/if}
  {@render children({ id, describedBy, invalid: Boolean(error) })}
  {#if error}
    <p class="ui-field__message ui-field__message--error" id={messageId}>{error}</p>
  {:else if success}
    <p class="ui-field__message ui-field__message--success" id={messageId}>{success}</p>
  {/if}
</div>
