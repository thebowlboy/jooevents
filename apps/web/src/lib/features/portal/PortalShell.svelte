<script lang="ts">
	/**
	 * The portal's persistent chrome.
	 *
	 * It belongs to the layout rather than to a page so one instance survives
	 * every move between the home surface, a submission, and the profile: the
	 * account menu never rebuilds, and the single read of the participant's world
	 * is made once here instead of once per screen.
	 *
	 * The bar carries only what no page can carry for itself — the way home and
	 * the account. The event is named by the home surface's own heading, and a
	 * detail page is placed by its back link and title, so repeating it here
	 * would spend the one persistent line on something already said.
	 *
	 * Nothing inside is at operator density. This surface is read a handful of
	 * times by someone who never asked to learn a product, so it runs at the
	 * default metrics with one column and no navigation rail — there is only ever
	 * one place to be.
	 */
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { ParticipantContext } from '@jooevents/contracts';
	import { entryDependencies } from 'jooevents-entry-deps';
	import type { SafeApiError } from '$lib/api/client';
	import { usePortalGateway } from '$lib/api/portal/gateway';
	import { Popover } from '$lib/ui';
	import wordmarkUrl from '$lib/assets/brand/jooevents-wordmark-login-256.png';
	import { accessCopy } from './copy';
	import { createPortalStore, setPortalStore } from './store.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import MakerSignature from '$lib/brand/MakerSignature.svelte';
	import { ATTRIBUTION_PLACEMENT } from '$lib/brand/attribution';

	let { children }: { children: Snippet } = $props();

	const { api, source } = usePortalGateway();
	const store = createPortalStore(api);
	setPortalStore(store);

	type Admission =
		| { kind: 'resolving' }
		| { kind: 'active'; context: Extract<ParticipantContext, { state: 'active' }> }
		| { kind: 'error'; error: SafeApiError };

	let admission = $state<Admission>({ kind: 'resolving' });
	let signingOut = $state(false);
	let signOutError = $state<SafeApiError | null>(null);
	let announcement = $state('');

	const participant = $derived(admission.kind === 'active' ? admission.context.participant : null);
	const initials = $derived(
		(participant?.displayName ?? '')
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((word) => word[0]?.toUpperCase() ?? '')
			.join('') || '·'
	);

	/**
	 * A session that is not established is not the same thing as no session: a
	 * failed check keeps the person here and says so, while a genuinely anonymous
	 * or expired one goes to the entry surface carrying where it was headed.
	 */
	async function admit() {
		const result = await entryDependencies.participant.getContext();
		if (result.kind === 'error') {
			admission = { kind: 'error', error: result.error };
			return;
		}
		if (result.data.state === 'active') {
			admission = { kind: 'active', context: result.data };
			void store.load();
			return;
		}
		const returnTo = page.url.pathname.startsWith('/portal') ? page.url.pathname : '/portal';
		await goto(`/portal/sign-in?returnTo=${encodeURIComponent(returnTo)}`, { replaceState: true });
	}

	onMount(() => {
		void admit();
	});

	async function retryAdmission() {
		admission = { kind: 'resolving' };
		await admit();
	}

	/**
	 * Signing out is server state, so nothing local moves until the server says
	 * it moved. A failure leaves the person exactly where they were, with the
	 * session they still have.
	 */
	async function signOut() {
		if (signingOut) return;
		signingOut = true;
		signOutError = null;
		announcement = accessCopy.signingOut;
		const result = await entryDependencies.participant.signOut();
		signingOut = false;
		if (result.kind === 'error') {
			signOutError = result.error;
			announcement = accessCopy.signOutFailed;
			return;
		}
		announcement = '';
		await goto('/portal/sign-in', { replaceState: true });
	}
</script>

<div class="portal">
	<header class="bar">
		<a class="bar__brand" href="/portal" aria-label="JooEvents portal home">
			<img src={wordmarkUrl} alt="JooEvents" width="108" height="19" />
		</a>
		<Popover label="Your account">
			{#snippet trigger()}
				<span class="ui-avatar bar__avatar">{initials}</span>
			{/snippet}
			{#snippet children()}
				<p class="account__name">{participant?.displayName ?? 'Signed in'}</p>
				<p class="account__email">{participant?.email ?? ''}</p>
				<a class="account__link" href="/portal/profile">Your details</a>
				{#if source.kind === 'sample'}
					<p class="account__sample">
						Sample data — {source.scenario.name}. {source.scenario.description} Nothing here belongs
						to a real event.
					</p>
				{/if}
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm account__signout"
					disabled={signingOut}
					aria-busy={signingOut || undefined}
					onclick={signOut}>
					{signingOut ? 'Signing out…' : 'Sign out'}
				</button>
				{#if signOutError}
					<p class="account__error">
						{accessCopy.signOutFailed}
						{#if signOutError.correlationId}
							<span class="account__code">Support code: {signOutError.correlationId}</span>
						{/if}
					</p>
				{/if}
			{/snippet}
		</Popover>
	</header>

	<main class="column">
		{#if admission.kind === 'error'}
			<!-- The one thing this state must not do is look like being signed out. -->
			<section class="failure" role="alert">
				<h1 class="failure__title">{accessCopy.checkFailedTitle}</h1>
				<p class="failure__copy">{accessCopy.checkFailedBody}</p>
				{#if admission.error.correlationId}
					<p class="failure__code">Support code: {admission.error.correlationId}</p>
				{/if}
				<button type="button" class="ui-button ui-button--primary" onclick={retryAdmission}>
					Try again
				</button>
			</section>
		{:else}
			{@render children()}
		{/if}
	</main>

	<!-- Text only. A speaker is here because an organizer sent them, not because
	     they came looking for the software, so the byline names the maker and
	     stops there — a follow link would be asking something of someone who is
	     mid-application. -->
	{#if ATTRIBUTION_PLACEMENT.portal}
		<div class="portal-maker"><MakerSignature /></div>
	{/if}

	<p class="ui-sr-only" role="status" aria-live="polite">{announcement}</p>
	<!-- The same receipt guarantee the operator surfaces give, placed for a
	     single column instead of beside a navigation rail. -->
	<CommitReceipt placement="column" />
</div>

<style>
	.portal {
		min-block-size: 100svh;
		display: flex;
		flex-direction: column;
		background: var(--je-color-page);
	}

	.bar {
		position: sticky;
		inset-block-start: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		min-block-size: var(--je-topbar-height);
		padding: var(--je-space-2) var(--je-space-4);
		background: var(--je-color-canvas);
		border-block-end: 1px solid var(--je-color-border);
	}

	/* The way home takes the leading edge and the remaining width, so the account
	   menu sits at the trailing edge at every viewport. */
	.bar__brand {
		display: flex;
		align-items: center;
		margin-inline-end: auto;
		border-radius: var(--je-radius-xs);
	}

	.bar__brand img {
		display: block;
	}

	/* The account menu is the bar's only control, so it takes a touch-safe target
	   where the pointer is a finger. */
	@media (pointer: coarse) {
		.bar__avatar {
			inline-size: 2.75rem;
			block-size: 2.75rem;
			font-size: var(--je-font-size-sm);
		}
	}

	.account__link {
		justify-self: start;
		color: var(--je-color-link);
		font-size: var(--je-font-size-sm);
	}

	.account__name {
		margin: 0;
		font-weight: 600;
	}

	.account__email {
		margin: 0;
		color: var(--je-color-text-muted);
		overflow-wrap: anywhere;
	}

	.account__sample {
		margin: 0;
		padding-block-start: var(--je-space-2);
		border-block-start: 1px solid var(--je-color-border-subtle);
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.account__signout {
		align-self: start;
		margin-block-start: var(--je-space-1);
	}

	.account__error {
		margin: 0;
		color: var(--je-color-danger);
		font-size: var(--je-font-size-sm);
	}

	.account__code {
		display: block;
		color: var(--je-color-text-muted);
		font-family: var(--je-font-mono);
		font-size: var(--je-font-size-xs);
	}

	.column {
		inline-size: 100%;
		max-inline-size: 52rem;
		margin-inline: auto;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: var(--je-space-8);
		padding: var(--je-space-8) var(--je-space-4) var(--je-space-12);
	}

	/* Shares the column's measure so the byline ends on the same line the content
	   does, and inherits the column's trailing space as its separation. */
	.portal-maker {
		inline-size: 100%;
		max-inline-size: 52rem;
		margin-inline: auto;
		padding: 0 var(--je-space-4) var(--je-space-8);
	}

	/* Holds the column's ordinary footprint, so an unresolved session cannot
	   collapse the page and expand it again once it resolves. */
	.failure {
		display: grid;
		justify-items: start;
		align-content: center;
		gap: var(--je-space-3);
		min-block-size: 20rem;
	}

	.failure__title {
		margin: 0;
		font-size: var(--je-font-size-xl);
	}

	.failure__copy,
	.failure__code {
		margin: 0;
		color: var(--je-color-text-muted);
	}

	.failure__code {
		font-family: var(--je-font-mono);
		font-size: var(--je-font-size-xs);
	}

	@media (max-width: 560px) {
		.column {
			padding-block-start: var(--je-space-6);
			gap: var(--je-space-6);
		}
	}
</style>
