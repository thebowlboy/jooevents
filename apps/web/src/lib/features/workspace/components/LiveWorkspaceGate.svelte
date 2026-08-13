<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import wordmarkUrl from '$lib/assets/brand/jooevents-wordmark-login-256.png';
	import { getAccessContext } from '$lib/api/access';
	import { loadLiveOperationManifest } from '$lib/api/composition/manifest';
	import { resolveOperatorAccess } from '$lib/api/composition/operator-entry';
	import type { LiveWorkspaceReady } from '$lib/api/composition/live-workspace';
	import type { SafeApiError } from '$lib/api/client';

	type State =
		| { readonly kind: 'loading' }
		| { readonly kind: 'redirecting' }
		| ({ readonly kind: 'ready' } & LiveWorkspaceReady)
		| { readonly kind: 'error'; readonly error: SafeApiError };

	let { children }: { readonly children?: Snippet<[LiveWorkspaceReady]> } = $props();
	let state = $state<State>({ kind: 'loading' });
	let generation = 0;
	let activeAbort: AbortController | undefined;

	async function resolve() {
		activeAbort?.abort('superseded');
		const abort = new AbortController();
		activeAbort = abort;
		const current = ++generation;
		state = { kind: 'loading' };
		try {
			const accessResult = await getAccessContext({ signal: abort.signal });
			if (abort.signal.aborted || current !== generation) return;
			const access = resolveOperatorAccess({
				result: accessResult,
				pathname: page.url.pathname,
				search: page.url.search
			});
			if (access.kind === 'transport_error') {
				state = { kind: 'error', error: access.error };
				return;
			}
			if (access.kind === 'redirect') {
				state = { kind: 'redirecting' };
				await goto(access.path, { replaceState: true, noScroll: true, keepFocus: true });
				return;
			}
			const manifest = await loadLiveOperationManifest({ signal: abort.signal });
			if (abort.signal.aborted || current !== generation) return;
			if (manifest.kind === 'transport_error') {
				state = { kind: 'error', error: manifest.error };
				return;
			}
			state = {
				kind: 'ready',
				user: access.user,
				workspace: access.workspace,
				manifest: manifest.manifest
			};
		} catch {
			if (abort.signal.aborted || current !== generation) return;
			state = { kind: 'error', error: { code: 'request_failed', retryable: true } };
		}
	}

	onMount(() => {
		void resolve();
		return () => {
			generation += 1;
			activeAbort?.abort('disposed');
		};
	});
</script>

<svelte:head>
	<title>Workspace · JooEvents</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if state.kind === 'ready' && state.manifest.operations.length > 0 && children}
	{@render children({ user: state.user, workspace: state.workspace, manifest: state.manifest })}
{:else}
	<main class="live-gate">
		<section class="live-gate__panel" aria-busy={state.kind === 'loading' || state.kind === 'redirecting'}>
			<img class="live-gate__brand" src={wordmarkUrl} alt="JooEvents" width="160" height="28" />
			{#if state.kind === 'loading' || state.kind === 'redirecting'}
			<div class="live-gate__copy" role="status">
				<span class="ui-skeleton live-gate__heading-fill" aria-hidden="true"></span>
				<span class="ui-skeleton live-gate__line-fill" aria-hidden="true"></span>
				<span class="ui-sr-only">Checking workspace access…</span>
			</div>
			{:else if state.kind === 'error'}
			<div class="live-gate__copy" role="alert">
				<h1>We couldn’t load this workspace</h1>
				<p>Check your connection and try again.</p>
				{#if state.error.correlationId}
					<p class="live-gate__support">Support code: <span>{state.error.correlationId}</span></p>
				{/if}
				<button type="button" class="ui-button ui-button--primary" onclick={() => void resolve()}>
					Try again
				</button>
			</div>
			{:else}
			<div class="live-gate__copy">
				<p class="live-gate__workspace">{state.workspace.name}</p>
				<h1>Workspace tools aren’t available here yet</h1>
				<p>
					You’re signed in as {state.user.displayName}. This workspace is connected, but this build has
					no usable event tools enabled.
				</p>
				{#if state.manifest.operations.length > 0}
					<p class="live-gate__note">Available operations are not connected to a complete workspace area.</p>
				{/if}
			</div>
			{/if}
		</section>
	</main>
{/if}

<style>
	.live-gate {
		min-block-size: 100svh;
		display: grid;
		place-items: center;
		padding: max(var(--je-space-6), env(safe-area-inset-top))
			max(var(--je-space-4), env(safe-area-inset-right))
			max(var(--je-space-6), env(safe-area-inset-bottom))
			max(var(--je-space-4), env(safe-area-inset-left));
		background: var(--je-color-page);
	}

	.live-gate__panel {
		inline-size: min(100%, 38rem);
		min-block-size: 21rem;
		display: grid;
		align-content: start;
		gap: var(--je-space-8);
		padding: clamp(var(--je-space-6), 6vw, var(--je-space-10));
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-lg);
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-sm);
	}

	.live-gate__brand {
		display: block;
		inline-size: 10rem;
		block-size: auto;
	}

	.live-gate__copy {
		display: grid;
		justify-items: start;
		gap: var(--je-space-4);
		text-align: start;
	}

	.live-gate__copy h1,
	.live-gate__copy p {
		margin: 0;
	}

	.live-gate__copy h1 {
		max-inline-size: 24ch;
		font-size: var(--je-font-size-2xl);
		line-height: var(--je-leading-tight);
	}

	.live-gate__copy > p:not(.live-gate__workspace, .live-gate__support) {
		max-inline-size: 48ch;
		color: var(--je-color-text-muted);
		line-height: var(--je-leading-normal);
	}

	.live-gate__workspace {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.live-gate__support {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.live-gate__support span {
		font-family: var(--je-font-mono);
		overflow-wrap: anywhere;
	}

	.live-gate__note {
		padding-block-start: var(--je-space-2);
		border-block-start: 1px solid var(--je-color-border-subtle);
	}

	.live-gate__heading-fill,
	.live-gate__line-fill {
		display: block;
		block-size: 1lh;
		border-radius: var(--je-radius-xs);
	}

	.live-gate__heading-fill {
		inline-size: min(22rem, 78%);
		font-size: var(--je-font-size-2xl);
	}

	.live-gate__line-fill {
		inline-size: min(28rem, 92%);
	}

	@media (max-width: 520px) {
		.live-gate {
			place-items: start stretch;
			padding-inline: 0;
			padding-block: 0;
			background: var(--je-color-surface);
		}

		.live-gate__panel {
			min-block-size: 100svh;
			border: 0;
			border-radius: 0;
			box-shadow: none;
		}
	}
</style>
