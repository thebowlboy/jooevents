<script lang="ts">
	import { untrack } from 'svelte';
	import { Button, ChoiceGroup, Radio } from '$lib/ui';
	import type { SettingsPageProfileReviewPort } from '$lib/api/settings-page-port';

	let {
		port,
		reviewRequired,
		onchanged
	}: {
		readonly port: SettingsPageProfileReviewPort;
		readonly reviewRequired: boolean;
		readonly onchanged: (reviewRequired: boolean) => void;
	} = $props();

	let choice = $state(untrack(() => reviewRequired) ? 'review' : 'automatic');
	let saving = $state(false);
	let error = $state('');
	let announcement = $state('');
	const chosenReview = $derived(choice === 'review');
	const changed = $derived(chosenReview !== reviewRequired);

	async function save() {
		if (!changed || saving) return;
		saving = true;
		error = '';
		announcement = '';
		try {
			const outcome = await port.update(chosenReview);
			if (!outcome.ok) {
				error = outcome.reason;
				return;
			}
			onchanged(chosenReview);
			announcement = chosenReview
				? 'Speaker profile edits now wait for organizer review.'
				: 'Speaker profile edits now publish automatically.';
		} finally {
			saving = false;
		}
	}
</script>

<section class="panel" id="settings-speaker-profile-publishing" aria-labelledby="profile-publishing-title">
	<header class="panel__head">
		<h2 id="profile-publishing-title">Speaker profile publishing</h2>
	</header>

	<div class="panel__body">
		<p class="intro">Choose what happens when a speaker profile is saved for this event.</p>
		<ChoiceGroup legend="Publishing mode">
			<Radio
				name="speaker-profile-publishing"
				value="automatic"
				label="Publish edits automatically"
				description="Saved profile details can appear on the public lineup immediately. This is the default."
				disabled={saving}
				bind:group={choice} />
			<Radio
				name="speaker-profile-publishing"
				value="review"
				label="Review edits before publishing"
				description="Changed profile fields stay out of public content until an organizer approves them."
				disabled={saving}
				bind:group={choice} />
		</ChoiceGroup>

		{#if changed && !chosenReview}
			<p class="consequence">Saving this change releases current profile content without a separate review.</p>
		{/if}
		<div class="actions">
			<Button size="sm" disabled={!changed} loading={saving} onclick={save}>Save publishing mode</Button>
		</div>
		{#if error}<p class="ui-field__message ui-field__message--error" role="alert">{error}</p>{/if}
		<p class="ui-sr-only" role="status">{announcement}</p>
	</div>
</section>

<style>
	.panel {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.panel__head {
		margin-block-end: var(--je-space-4);
	}

	.panel__head h2 {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.panel__body {
		display: grid;
		gap: var(--je-space-4);
		max-inline-size: 46rem;
	}

	.intro,
	.consequence {
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.consequence {
		color: var(--je-color-text);
	}

	.actions {
		display: flex;
		justify-content: flex-start;
	}
</style>
