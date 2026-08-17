<script lang="ts">
  import { Alert, Button, CopyValue, Field } from '$lib/ui';
  import { RefreshCw } from 'lucide-svelte';
  import EntryGlyph from '$lib/features/access/components/EntryGlyph.svelte';
  import PortalDevIssuedLink from './PortalDevIssuedLink.svelte';
  import type { ParticipantEntryState } from '../ParticipantEntryController';
  import {
    participantEntryCopy,
    participantLinkFailureCopy,
    participantNoticeCopy,
    participantRequestErrorCopy
  } from '../copy';

  let { state, onEmail, onSubmit, onDifferentAddress, onBackToSignIn, onRetry }: {
    state: ParticipantEntryState;
    onEmail: (email: string) => void;
    onSubmit: () => void;
    onDifferentAddress: () => void;
    onBackToSignIn: () => void;
    onRetry: () => void;
  } = $props();

  /* The address stays on screen while the request is in flight: same field,
     same position, only its busy state changes. */
  function formView(value: ParticipantEntryState) {
    if (value.kind === 'anonymous') return { ...value, busy: false };
    return value.kind === 'link_request_busy'
      ? { kind: 'anonymous' as const, email: value.email, invalid: false, busy: true }
      : undefined;
  }

  let form = $derived(formView(state));
  const showDevLink = import.meta.env.DEV && import.meta.env.MODE !== 'live';
  /* A live-dev build has a real ceremony and a dev-only delivery control: the
     affordance opens the actually issued link (its own component keeps every
     production bundle path inert). */
  const showLiveDevLink = import.meta.env.DEV && import.meta.env.MODE === 'live';
</script>

<div class="entry-state" aria-live={state.kind === 'resolving' || state.kind === 'completing' ? 'polite' : 'off'}>
  {#if state.kind === 'resolving' || state.kind === 'completing'}
    <!-- Four fills for the four rows this lane resolves to: heading, the named
         method group, its email field, the action. A delayed sentence replaces
         the heading fill instead of becoming a fifth row. -->
    <div class="resolver resolver--portal" aria-label="Checking access">
      {#if state.delayed}
        <p class="resolver__status status">
          {state.kind === 'completing' ? 'Signing you in…' : 'Checking your access…'}
        </p>
      {:else}
        <span></span>
      {/if}
      <span></span><span></span><span></span>
    </div>
  {:else if form}
    {@const open = form}
    <h1 data-entry-heading tabindex="-1">{participantEntryCopy.heading}</h1>
    {#if state.kind === 'anonymous' && state.notice}
      {@const notice = participantNoticeCopy[state.notice]}
      <Alert title={notice.title} message={notice.message} tone={notice.tone} />
    {/if}
    <!-- The same titled method group the operator lane uses, with this lane's
         own warm helper. novalidate: the reviewed message and aria-invalid
         state belong to the field, not to a native browser bubble. -->
    <form class="entry-link" novalidate aria-labelledby="portal-method" onsubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div class="entry-method">
        <h2 class="entry-method__title" id="portal-method"><EntryGlyph name="sparkle" />{participantEntryCopy.method}</h2>
        <p class="entry-method__help" id="portal-method-help">{participantEntryCopy.intro}</p>
      </div>
      <Field id="portal-entry-email" label={participantEntryCopy.label} error={open.invalid ? participantEntryCopy.invalid : undefined}>
        {#snippet children({ id, describedBy, invalid })}
          <input
            class="ui-control"
            type="email"
            inputmode="email"
            autocomplete="email"
            spellcheck="false"
            {id}
            name="email"
            aria-describedby={['portal-method-help', describedBy].filter(Boolean).join(' ')}
            aria-invalid={invalid}
            disabled={open.busy}
            value={open.email}
            oninput={(event) => onEmail(event.currentTarget.value)} />
        {/snippet}
      </Field>
      <Button type="submit" size="lg" loading={open.busy}>{participantEntryCopy.submit}</Button>
    </form>
    {#if state.kind === 'anonymous' && state.requestError}
      {@const copy = participantRequestErrorCopy(state.requestError.code)}
      {#key state.requestError}
        <div class="entry-error" role="alert">
          <strong>{copy.title}</strong>
          <span>{copy.body}</span>
        </div>
      {/key}
    {/if}
  {:else if state.kind === 'link_requested'}
    <h1 data-entry-heading tabindex="-1"><EntryGlyph name="envelope" />{participantEntryCopy.confirmationHeading}</h1>
    <p>{participantEntryCopy.confirmationBody}</p>
    <p class="entry-echo">{state.email}</p>
    <button type="button" class="entry-secondary" onclick={onDifferentAddress}>{participantEntryCopy.differentAddress}</button>
    {#if showDevLink}
      <a class="entry-secondary" href="/portal/auth/complete?token=sample" data-dev-link>Open the emailed link (sample data)</a>
    {/if}
    {#if showLiveDevLink}
      <PortalDevIssuedLink email={state.email} />
    {/if}
  {:else if state.kind === 'callback_error'}
    {@const copy = participantLinkFailureCopy[state.outcome]}
    <h1 data-entry-heading tabindex="-1">{copy.heading}</h1>
    <p>{copy.body}</p>
    <Button size="lg" onclick={onBackToSignIn}>{participantEntryCopy.backToSignIn}</Button>
  {:else if state.kind === 'context_error'}
    <h1 data-entry-heading tabindex="-1">We couldn't check your access</h1>
    <p>Your access has not changed. Check your connection and try again.</p>
    <Button size="lg" onclick={onRetry}><RefreshCw aria-hidden="true" /> Retry</Button>
    {#if state.error.correlationId}<p class="support">Support code: <CopyValue value={state.error.correlationId} label="support code" /></p>{/if}
  {/if}
</div>
