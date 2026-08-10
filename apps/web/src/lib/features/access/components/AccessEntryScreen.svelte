<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { getAccessContext } from '$lib/api/access';
  import { signOut, startExternalSignIn } from '$lib/api/auth';
  import { AccessEntryController, type AccessEntryState } from '../AccessEntryController';
  import { parseEntryNotice } from '../copy';
  import AccessEntryFrame from './AccessEntryFrame.svelte';
  import EntryState from './EntryState.svelte';

  let state = $state<AccessEntryState>({ kind: 'resolving', delayed: false });
  let focusNextHeading = false;
  const controller = new AccessEntryController({
    getContext: getAccessContext,
    startGoogle: startExternalSignIn,
    signOut,
    navigate: (path, replace) => goto(path, { replaceState: replace, noScroll: true, keepFocus: true })
  });

  const title = $derived(state.kind === 'anonymous' || state.kind === 'starting_google'
    ? 'Sign in · JooEvents'
    : state.kind === 'provisioning' ? 'Preparing your workspace · JooEvents'
    : state.kind === 'pending_review' ? 'Access under review · JooEvents'
    : state.kind === 'blocked' || state.kind === 'sign_out_error' ? 'Workspace access unavailable · JooEvents'
    : state.kind === 'context_error' ? 'Access check problem · JooEvents'
    : 'Checking access · JooEvents');

  $effect(() => {
    controller.setRoute({
      path: page.url.pathname,
      returnTo: page.url.searchParams.get('returnTo'),
      notice: parseEntryNotice(page.url.searchParams.get('notice'))
    });
  });

  function userAction(action: () => void | Promise<void>) {
    focusNextHeading = true;
    void action();
  }

  onMount(() => {
    const unsubscribe = controller.subscribe(async (next) => {
      state = next;
      if (focusNextHeading && next.kind !== 'resolving' && next.kind !== 'starting_google') {
        focusNextHeading = false;
        await tick();
        document.querySelector<HTMLElement>('[data-entry-heading]')?.focus();
      }
    });
    const visibility = () => controller.handleVisibility(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', visibility);
    void controller.resolve();
    return () => {
      unsubscribe();
      controller.dispose();
      document.removeEventListener('visibilitychange', visibility);
    };
  });
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="description" content="Securely verify your identity and JooEvents workspace access." />
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<AccessEntryFrame>
  <EntryState
    {state}
    onGoogle={() => userAction(() => controller.startGoogle())}
    onRetry={() => userAction(() => controller.resolve())}
    onCheck={() => userAction(() => controller.checkStatus())}
    onSignOut={() => userAction(() => controller.signOut())}
  />
</AccessEntryFrame>
