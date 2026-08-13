<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { entryDependencies } from 'jooevents-entry-deps';
  import AccessEntryFrame from '$lib/features/access/components/AccessEntryFrame.svelte';
  import { ParticipantEntryController, type ParticipantEntryState } from '../ParticipantEntryController';
  import { parseParticipantNotice } from '../copy';
  import PortalEntryState from './PortalEntryState.svelte';

  let { mode = 'sign_in' }: { mode?: 'sign_in' | 'complete' } = $props();

  let state = $state<ParticipantEntryState>({ kind: 'resolving', delayed: false });
  let focusNext: 'heading' | 'email' | 'confirmation' | null = null;
  const controller = new ParticipantEntryController({
    ...entryDependencies.participant,
    navigate: (path, replace) => goto(path, { replaceState: replace, noScroll: true, keepFocus: true })
  });

  const title = $derived(
    state.kind === 'link_requested' ? 'Check your email · JooEvents'
    : state.kind === 'anonymous' || state.kind === 'link_request_busy' ? 'Sign in · JooEvents'
    : state.kind === 'completing' ? 'Signing you in · JooEvents'
    : state.kind === 'callback_error' ? 'Sign-in link problem · JooEvents'
    : state.kind === 'context_error' ? 'Access check problem · JooEvents'
    : 'Checking access · JooEvents'
  );

  $effect(() => {
    controller.setRoute({
      path: page.url.pathname,
      returnTo: page.url.searchParams.get('returnTo'),
      notice: parseParticipantNotice(page.url.searchParams.get('notice'))
    });
  });

  function userAction(action: () => void | Promise<void>, focus: 'heading' | 'email' | 'confirmation' = 'heading') {
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
      if (!target || next.kind === 'resolving' || next.kind === 'completing') return;
      if (target === 'email') {
        if (next.kind !== 'anonymous') return;
        focusNext = null;
        await moveFocus('#portal-entry-email');
        return;
      }
      if (target === 'confirmation') {
        if (next.kind === 'link_request_busy') return;
        focusNext = null;
        // A rejected address returns focus to the field; a refused request
        // announces itself as an alert instead of moving focus.
        if (next.kind === 'anonymous') {
          if (next.invalid) await moveFocus('#portal-entry-email');
          return;
        }
        if (next.kind === 'link_requested') await moveFocus('[data-entry-heading]');
        return;
      }
      focusNext = null;
      await moveFocus('[data-entry-heading]');
    });
    if (mode === 'complete') {
      // The proof is consumed once and never kept in the address bar, history,
      // or view state.
      const token = page.url.searchParams.get('token');
      if (token) void goto('/portal/auth/complete', { replaceState: true, noScroll: true, keepFocus: true });
      void controller.completeLink(token);
    } else {
      void controller.resolve();
    }
    return () => {
      unsubscribe();
      controller.dispose();
    };
  });
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="description" content="Sign in to your JooEvents speaker portal." />
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<AccessEntryFrame>
  <PortalEntryState
    {state}
    onEmail={(email) => controller.setEmail(email)}
    onSubmit={() => userAction(() => controller.requestLink(), 'confirmation')}
    onDifferentAddress={() => userAction(() => controller.useDifferentAddress(), 'email')}
    onBackToSignIn={() => userAction(() => controller.backToSignIn())}
    onRetry={() => userAction(() => controller.resolve())}
  />
</AccessEntryFrame>
