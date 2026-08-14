<script lang="ts">
	/**
	 * Dev-only affordance for the live ceremony: opens the link the dev
	 * delivery control actually issued for this address. The dynamic import
	 * plus the module's own DEV guard keep every production bundle path inert —
	 * outside a dev build the fetch never leaves and the control reports
	 * itself unavailable.
	 */
	let { email }: { readonly email: string } = $props();

	let note = $state('');

	async function openIssuedDevLink() {
		note = '';
		const { fetchDevIssuedLink, isPortalCompletionPath } = await import(
			'$lib/api/portal/live/dev-issued-link'
		);
		const result = await fetchDevIssuedLink({ email });
		if (result.kind === 'issued' && isPortalCompletionPath(result.url)) {
			window.location.assign(result.url);
			return;
		}
		note =
			result.kind === 'none'
				? 'No live link for that address — request a new one first.'
				: 'The dev delivery control is not reachable here.';
	}
</script>

<button type="button" class="entry-secondary" data-dev-link onclick={openIssuedDevLink}>
	Open the emailed link (dev delivery)
</button>
{#if note}<p class="status" role="status">{note}</p>{/if}
