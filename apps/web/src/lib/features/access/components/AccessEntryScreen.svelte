<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto, preloadCode } from '$app/navigation';
  import { page } from '$app/state';
  import { entryDependencies } from 'jooevents-entry-deps';
  import { AccessEntryController, type AccessEntryState } from '../AccessEntryController';
  import { parseEntryNotice } from '../copy';
  import AccessEntryFrame from './AccessEntryFrame.svelte';
  import EntryState from './EntryState.svelte';

  let state = $state<AccessEntryState>({ kind: 'resolving', delayed: false, awaiting: 'identity' });
  type FocusTarget = 'heading' | 'link-email' | 'confirmation';
  let focusNext: FocusTarget | null = null;
  const controller = new AccessEntryController({
    ...entryDependencies.operator,
    navigate: (path, replace) => goto(path, { replaceState: replace, noScroll: true, keepFocus: true }),
    /* Overlap the last two waits: while admission is still committing, pull in
       the destination's route modules so its own first paint is not stacked
       behind this one. `preloadCode` rather than `preloadData` deliberately —
       it imports code and cannot issue a request, which keeps "no protected
       call before active" a property of the mechanism rather than of whichever
       load functions the operator routes happen to have today. Best effort:
       never awaited, and a rejection is the controller's to swallow. */
    warmDestination: (path) => preloadCode(path)
  });

  const title = $derived(state.kind === 'link_requested'
    ? 'Check your email · JooEvents'
    : state.kind === 'anonymous' || state.kind === 'starting_google'
    ? 'Sign in · JooEvents'
    : state.kind === 'provisioning' ? 'Preparing your workspace · JooEvents'
    : state.kind === 'pending_review' ? 'Access under review · JooEvents'
    : state.kind === 'blocked' || state.kind === 'sign_out_error' ? 'Workspace access unavailable · JooEvents'
    : state.kind === 'context_error' ? 'Access check problem · JooEvents'
    : 'Checking access · JooEvents');
  const contentLed = $derived(
    state.kind === 'pending_review' ||
    (state.kind === 'sign_out_error' && state.previous.kind === 'pending_review')
  );

  $effect(() => {
    controller.setRoute({
      path: page.url.pathname,
      returnTo: page.url.searchParams.get('returnTo'),
      notice: parseEntryNotice(page.url.searchParams.get('notice'))
    });
  });

  function userAction(action: () => void | Promise<void>, focus: FocusTarget = 'heading') {
    focusNext = focus;
    void action();
  }

  async function moveFocus(selector: string) {
    await tick();
    document.querySelector<HTMLElement>(selector)?.focus();
  }

  onMount(() => {
    const unsubscribe = controller.subscribe(async (next) => {
      state = next;
      const target = focusNext;
      if (!target || next.kind === 'resolving' || next.kind === 'starting_google') return;
      // Returning to the card puts the caret back in the field; a rejected
      // address returns focus to the field to correct; every other transition
      // speaks through its new heading. Failures announce as alerts instead.
      if (target === 'link-email') {
        if (next.kind !== 'anonymous') return;
        focusNext = null;
        await moveFocus('#entry-link-email');
        return;
      }
      if (target === 'confirmation') {
        if (next.kind === 'anonymous' && next.busy) return;
        focusNext = null;
        if (next.kind === 'anonymous') {
          if (next.invalid) await moveFocus('#entry-link-email');
          return;
        }
        if (next.kind === 'link_requested') await moveFocus('[data-entry-heading]');
        return;
      }
      focusNext = null;
      await moveFocus('[data-entry-heading]');
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

<AccessEntryFrame {contentLed} waiting={state.kind === 'resolving' || state.kind === 'provisioning'}>
  <EntryState
    {state}
    onGoogle={() => userAction(() => controller.startGoogle())}
    onRetry={() => userAction(() => controller.resolve())}
    onCheck={() => void controller.checkStatus()}
    onSignOut={() => userAction(() => controller.signOut())}
    onLinkEmail={(email) => controller.setLinkEmail(email)}
    onSubmitLink={() => userAction(() => controller.requestSignInLink(), 'confirmation')}
    onDifferentAddress={() => userAction(() => controller.useDifferentAddress(), 'link-email')}
  />
</AccessEntryFrame>
