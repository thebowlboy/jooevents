<script lang="ts">
  import { Alert, Badge, Button, CopyValue, Field } from '$lib/ui';
  import { RefreshCw } from 'lucide-svelte';
  import type { AccessEntryState, BlockedState, EntrySurfaceState, PendingState } from '../AccessEntryController';
  import { blockedCopy, linkRequestCopy, linkRequestErrorCopy, noticeCopy } from '../copy';
  import EntryGlyph from './EntryGlyph.svelte';
  import GoogleSignInButton from './GoogleSignInButton.svelte';

  /* The link-request callbacks default to inert so a visual fixture can render
     the anonymous composition without driving a controller. */
  let {
    state,
    onGoogle,
    onRetry,
    onCheck,
    onSignOut,
    onLinkEmail = () => undefined,
    onSubmitLink = () => undefined,
    onDifferentAddress = () => undefined
  }: {
    state: AccessEntryState;
    onGoogle: () => void;
    onRetry: () => void;
    onCheck: () => void;
    onSignOut: () => void;
    onLinkEmail?: (email: string) => void;
    onSubmitLink?: () => void;
    onDifferentAddress?: () => void;
  } = $props();

  /* Starting Google keeps rendering the surface it started from, so the typed
     address or a previous failure does not vanish mid-attempt. */
  function surfaceView(value: AccessEntryState): EntrySurfaceState | undefined {
    if (value.kind === 'anonymous' || value.kind === 'link_requested') return value;
    return value.kind === 'starting_google' ? value.previous : undefined;
  }

  function pendingView(value: AccessEntryState): PendingState | undefined {
    if (value.kind === 'pending_review') return value;
    return value.kind === 'sign_out_error' && value.previous.kind === 'pending_review' ? value.previous : undefined;
  }
  function blockedView(value: AccessEntryState): BlockedState | undefined {
    if (value.kind === 'blocked') return value;
    return value.kind === 'sign_out_error' && value.previous.kind === 'blocked' ? value.previous : undefined;
  }
  function surfaceNotice(value: EntrySurfaceState | undefined) {
    return value && value.kind === 'anonymous' ? value.notice : undefined;
  }

  let surface = $derived(surfaceView(state));
  let notice = $derived(surfaceNotice(surface));
  let pending = $derived(pendingView(state));
  let blocked = $derived(blockedView(state));
  let heading = $derived(
    surface?.kind === 'link_requested'
      ? linkRequestCopy.confirmationHeading
      : notice === 'session_ended'
        ? 'Sign in again'
        : 'Sign in'
  );
</script>

<!-- Only the resolver and the resting card it becomes hold a shared footprint;
     every other state is compact and grows downward when recovery content
     appears (owner direction, 2026-08-14). -->
<div
  class="entry-state"
  class:entry-state--reserved={state.kind === 'resolving' || surface?.kind === 'anonymous'}
  aria-live={state.kind === 'resolving' || state.kind === 'provisioning' ? 'polite' : 'off'}>
  {#if state.kind === 'resolving'}
    <!-- Six fills for the six rows the resolved card has: heading, the named
         method group, its email field, the magic-link action, the provider
         control, aside. -->
    <div class="resolver" aria-label="Checking access"><span></span><span></span><span></span><span></span><span></span><span></span></div>
    {#if state.delayed}<p class="status">Checking your access…</p>{/if}
  {:else if surface}
    <h1 data-entry-heading tabindex="-1">
      {#if surface.kind === 'link_requested'}<EntryGlyph name="envelope" />{/if}{heading}
    </h1>
    {#if notice && notice !== 'session_ended'}
      {@const copy = noticeCopy[notice]}
      <Alert title={copy.title} message={copy.message} tone={copy.tone} />
    {/if}
    {#if surface.kind === 'anonymous'}
      {@const open = surface}
      <!-- The magic link stands first and equal: a titled method group, its own
           coral action, then a divider and the provider control. The method is
           named once at group level so the field can stay a plain "Email
           address". novalidate because the reviewed message and aria-invalid
           state belong to the field, not to a native browser bubble. -->
      <form class="entry-link" novalidate aria-labelledby="entry-method" onsubmit={(event) => { event.preventDefault(); onSubmitLink(); }}>
        <div class="entry-method">
          <h2 class="entry-method__title" id="entry-method"><EntryGlyph name="sparkle" />{linkRequestCopy.method}</h2>
          <p class="entry-method__help" id="entry-method-help">{linkRequestCopy.methodHelp}</p>
        </div>
        <Field id="entry-link-email" label={linkRequestCopy.label} error={open.invalid ? linkRequestCopy.invalid : undefined}>
          {#snippet children({ id, describedBy, invalid })}
            <input
              class="ui-control"
              type="email"
              inputmode="email"
              autocomplete="email"
              spellcheck="false"
              {id}
              name="email"
              aria-describedby={['entry-method-help', describedBy].filter(Boolean).join(' ')}
              aria-invalid={invalid}
              disabled={open.busy}
              value={open.email}
              oninput={(event) => onLinkEmail(event.currentTarget.value)} />
          {/snippet}
        </Field>
        <Button type="submit" size="lg" loading={open.busy}>{linkRequestCopy.submit}</Button>
      </form>
      {#if open.requestError}
        {@const copy = linkRequestErrorCopy(open.requestError.code)}
        {#key open.requestError}
          <div class="entry-error" role="alert">
            <strong>{copy.title}</strong>
            <span>{copy.body}</span>
          </div>
        {/key}
      {/if}
      <div class="entry-or"><span>{linkRequestCopy.divider}</span></div>
    {:else}
      <p>{linkRequestCopy.confirmationBody}</p>
      <p class="entry-echo">{surface.email}</p>
    {/if}
    <GoogleSignInButton busy={state.kind === 'starting_google'} onclick={onGoogle} />
    {#if surface.actionError}
      {#key surface.actionError}
        <div class="entry-error" role="alert">
          <strong>Couldn't open Google</strong>
          <span>Check your connection and try again.</span>
        </div>
      {/key}
    {/if}
    {#if surface.kind === 'anonymous'}
      <p class="entry-aside">{linkRequestCopy.aside}</p>
    {:else}
      <button type="button" class="entry-secondary" onclick={onDifferentAddress}>{linkRequestCopy.differentAddress}</button>
    {/if}
  {:else if state.kind === 'provisioning'}
    <Badge tone="info">Finishing sign-in</Badge>
    <h1 data-entry-heading tabindex="-1">Preparing your workspace</h1>
    <p>Your identity is verified. We are connecting it to your JooEvents access.</p>
    <div class="entry-progress" aria-label="Sign-in preparation in progress"><span></span></div>
    {#if state.delayed}
      <div class="entry-appear">
        <Alert title="This is taking longer than expected" message="Your access has not changed. You can safely retry the check." tone="info" />
        <Button variant="secondary" onclick={onRetry}><RefreshCw aria-hidden="true" /> Retry</Button>
      </div>
    {/if}
    <p class="support">Support code: <CopyValue value={state.correlationId} label="support code" /></p>
  {:else if pending}
    <div class="pending-intro">
      <Badge tone="warning">Awaiting approval</Badge>
      <h1 data-entry-heading tabindex="-1">Your access request is under review</h1>
      <p><strong>{pending.workspace.name}</strong> needs to approve your membership before you can see event data.</p>
    </div>
    <div class="pending-account">
      <span class="pending-account__label">Signed in as</span>
      <strong>{pending.user.displayName}</strong>
      {#if pending.user.primaryEmail}<span>{pending.user.primaryEmail}</span>{/if}
      <p>We'll email {pending.user.primaryEmail ? 'this address' : 'your signed-in address'} when your access is approved.</p>
    </div>
    {#if state.kind === 'sign_out_error'}<div class="entry-appear"><Alert title="Sign-out could not finish" message="You are still signed in. Check your connection and try again." tone="danger" /></div>{/if}
    <div class="actions"><Button onclick={onCheck} loading={pending.checking}><RefreshCw aria-hidden="true" /> {pending.checking ? 'Checking status' : 'Check status'}</Button><Button variant="secondary" onclick={onSignOut}>Sign out</Button></div>
    {#if pending.checkError}<div class="entry-appear"><Alert title="Couldn't check status" message="Your access has not changed. Check your connection and try again." tone="danger" /></div>{/if}
  {:else if blocked}
    {@const copy = blockedCopy[blocked.code]}
    <h1 data-entry-heading tabindex="-1">{copy.heading}</h1>
    <p>{copy.body}</p>
    {#if state.kind === 'sign_out_error'}<div class="entry-appear"><Alert title="Sign-out could not finish" message="You are still signed in. Check your connection and try again." tone="danger" /></div>{/if}
    <div class="actions"><Button variant="secondary" onclick={onSignOut}>{blocked.code === 'not_admitted' ? 'Use another Google account' : 'Sign out'}</Button></div>
    {#if state.kind === 'sign_out_error' && state.error.correlationId}<p class="support">Support code: <CopyValue value={state.error.correlationId} label="support code" /></p>{/if}
  {:else if state.kind === 'context_error'}
    <h1 data-entry-heading tabindex="-1">We couldn't check your access</h1>
    <p>Your access has not changed. Check your connection and try again.</p>
    <Button onclick={onRetry}><RefreshCw aria-hidden="true" /> Retry</Button>
    {#if state.error.correlationId}<p class="support">Support code: <CopyValue value={state.error.correlationId} label="support code" /></p>{/if}
  {/if}
</div>
