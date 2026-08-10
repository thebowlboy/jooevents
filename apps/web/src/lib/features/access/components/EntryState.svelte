<script lang="ts">
  import { Alert, Badge, Button } from '$lib/ui';
  import { RefreshCw } from 'lucide-svelte';
  import type { AccessEntryState, BlockedState, PendingState } from '../AccessEntryController';
  import { blockedCopy, noticeCopy } from '../copy';
  import GoogleSignInButton from './GoogleSignInButton.svelte';

  let { state, onGoogle, onRetry, onCheck, onSignOut }: {
    state: AccessEntryState;
    onGoogle: () => void;
    onRetry: () => void;
    onCheck: () => void;
    onSignOut: () => void;
  } = $props();

  function pendingView(value: AccessEntryState): PendingState | undefined {
    if (value.kind === 'pending_review') return value;
    return value.kind === 'sign_out_error' && value.previous.kind === 'pending_review' ? value.previous : undefined;
  }
  function blockedView(value: AccessEntryState): BlockedState | undefined {
    if (value.kind === 'blocked') return value;
    return value.kind === 'sign_out_error' && value.previous.kind === 'blocked' ? value.previous : undefined;
  }
  let pending = $derived(pendingView(state));
  let blocked = $derived(blockedView(state));
</script>

<div class="entry-state" aria-live={state.kind === 'resolving' || state.kind === 'provisioning' ? 'polite' : 'off'}>
  {#if state.kind === 'resolving'}
    <div class="resolver" aria-label="Checking access"><span></span><span></span></div>
    {#if state.delayed}<p class="status">Checking your access…</p>{/if}
  {:else if state.kind === 'anonymous' || state.kind === 'starting_google'}
    <h1 data-entry-heading tabindex="-1">{state.kind === 'anonymous' && state.notice === 'session_ended' ? 'Sign in again' : 'Sign in'}</h1>
    {#if state.kind === 'anonymous' && state.notice && state.notice !== 'session_ended'}
      {@const notice = noticeCopy[state.notice]}
      <Alert title={notice.title} message={notice.message} tone={notice.tone} />
    {/if}
    <GoogleSignInButton busy={state.kind === 'starting_google'} onclick={onGoogle} />
    {#if state.actionError}
      {#key state.actionError}
        <div class="entry-error" role="alert">
          <strong>Couldn't open Google</strong>
          <span>Check your connection and try again.</span>
        </div>
      {/key}
    {/if}
    <p class="entry-aside">No sign-up here. Entry is for those who know.</p>
  {:else if state.kind === 'provisioning'}
    <Badge tone="info">Finishing sign-in</Badge>
    <h1 data-entry-heading tabindex="-1">Preparing your workspace</h1>
    <p>Your identity is verified. We are connecting it to your JooEvents access.</p>
    <div class="entry-progress" aria-label="Sign-in preparation in progress"><span></span></div>
    {#if state.delayed}
      <Alert title="This is taking longer than expected" message="Your access has not changed. You can safely retry the check." tone="info" />
      <Button variant="secondary" onclick={onRetry}><RefreshCw aria-hidden="true" /> Retry</Button>
    {/if}
    <p class="support">Support code: <code>{state.correlationId}</code></p>
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
    {#if state.kind === 'sign_out_error'}<Alert title="Sign-out could not finish" message="You are still signed in. Check your connection and try again." tone="danger" />{/if}
    <div class="actions"><Button onclick={onCheck} loading={pending.checking}><RefreshCw aria-hidden="true" /> {pending.checking ? 'Checking status' : 'Check status'}</Button><Button variant="secondary" onclick={onSignOut}>Sign out</Button></div>
    {#if pending.checkError}<Alert title="Couldn't check status" message="Your access has not changed. Check your connection and try again." tone="danger" />{/if}
  {:else if blocked}
    {@const copy = blockedCopy[blocked.code]}
    <h1 data-entry-heading tabindex="-1">{copy.heading}</h1>
    <p>{copy.body}</p>
    {#if state.kind === 'sign_out_error'}<Alert title="Sign-out could not finish" message="You are still signed in. Check your connection and try again." tone="danger" />{/if}
    <div class="actions"><Button variant="secondary" onclick={onSignOut}>{blocked.code === 'not_admitted' ? 'Use another Google account' : 'Sign out'}</Button><a class="help" href="/help">Get help</a></div>
    {#if state.kind === 'sign_out_error' && state.error.correlationId}<p class="support">Support code: <code>{state.error.correlationId}</code></p>{/if}
  {:else if state.kind === 'context_error'}
    <h1 data-entry-heading tabindex="-1">We couldn't check your access</h1>
    <p>Your access has not changed. Check your connection and try again.</p>
    <Button onclick={onRetry}><RefreshCw aria-hidden="true" /> Retry</Button>
    <a class="help" href="/help">Get help</a>
    {#if state.error.correlationId}<p class="support">Support code: <code>{state.error.correlationId}</code></p>{/if}
  {/if}
</div>
