<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import PublicSurfacePage from 'jooevents-public-surface-page';
	import { createEmbedChildChannel, type EmbedChildChannel } from '$lib/features/embeds/embed-document';
	import type { SurfaceKind } from '$lib/api/types';

	/**
	 * `/embed/apply`, `/embed/schedule`, `/embed/speakers` — the same published
	 * surface the hosted page serves, presented for somebody else's page: the
	 * document sizes to its content instead of a viewport, and when the loader
	 * identified this frame it speaks the versioned child protocol (ready,
	 * measured height, and the completion notice) to exactly the host origin
	 * the loader named. Framing itself is governed by the response's
	 * `frame-ancestors` policy, which the server derives from the surface's own
	 * allowlist.
	 */
	const ROUTES: Record<string, SurfaceKind> = {
		apply: 'application-form',
		schedule: 'schedule',
		speakers: 'speaker-roster'
	};

	const kind = $derived(ROUTES[page.params.kind ?? '']);

	let body = $state<HTMLElement | null>(null);
	/** The loader-identified frame protocol; stays null for a direct open. */
	let channel = $state<EmbedChildChannel | null>(null);

	onMount(() => {
		const query = page.url.searchParams;
		const opened = createEmbedChildChannel({
			embedId: query.get('embed'),
			hostOrigin: query.get('host'),
			frame: window
		});
		if (!opened.active) return;
		channel = opened;

		let reported = -1;
		const measure = () => {
			const height = Math.ceil(
				Math.max(body?.scrollHeight ?? 0, document.documentElement.scrollHeight)
			);
			if (height !== reported) {
				reported = height;
				opened.reportHeight(height);
			}
		};
		opened.announceReady();
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(document.documentElement);
		if (body) observer.observe(body);
		const stopListening = opened.listen((message) => {
			// Constrained display context only; the surface keeps the event's own
			// brand, and the hint is recorded as data for the document.
			document.documentElement.setAttribute(
				'data-host-color-scheme',
				message.colorScheme ?? 'unset'
			);
		});
		return () => {
			observer.disconnect();
			stopListening();
			channel = null;
		};
	});
</script>

<!-- An embed document is never a search result: it exists to be framed. -->
<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
	{#if !kind}
		<title>Page not found</title>
	{/if}
</svelte:head>

{#if kind}
	<div class="embed-doc" bind:this={body}>
		<!-- The completion boundary of this presentation: a submit press that
		     settles on the completed ceremony is reported at most once to the
		     identified host as the envelope-only protocol notice. That includes
		     adopting a completion from another tab; a mount that arrives already
		     completed reports nothing. The success action opens the participant
		     route top-level rather than signing in inside the host's frame. -->
		<PublicSurfacePage
			{kind}
			presentation="embed"
			onSubmitted={() => channel?.reportSubmissionComplete()} />
	</div>
{:else}
	<div class="embed-doc embed-doc--missing" bind:this={body}>
		<p>This embed doesn’t exist.</p>
	</div>
{/if}

<style>
	/* The content is the box: inside somebody else's page the document must
	   take its natural height, so the hosted page's viewport-height floor is
	   lifted for this presentation of the same surface. */
	.embed-doc :global(.public) {
		min-block-size: 0;
	}

	.embed-doc :global(.public__body) {
		padding-block: var(--je-space-4) var(--je-space-5);
	}

	.embed-doc--missing {
		display: grid;
		place-items: center;
		min-block-size: 8rem;
		color: var(--je-color-text-muted);
	}

	.embed-doc--missing p {
		margin: 0;
	}
</style>
