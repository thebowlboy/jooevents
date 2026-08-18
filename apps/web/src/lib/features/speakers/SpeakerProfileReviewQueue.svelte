<script lang="ts">
	import { onMount } from 'svelte';
	import type {
		SpeakerProfileFieldKey,
		SpeakerProfileReviewQueueDto,
		SpeakerProfileReviewQueueEntryDto
	} from '@jooevents/contracts';
	import { Button, Checkbox } from '$lib/ui';
	import type { SpeakerProfileReviewPort } from '$lib/api/speakers-page-port';
	import type { SpeakerRow } from '$lib/api/types';

	let {
		port,
		speakers,
		onchanged
	}: {
		readonly port: SpeakerProfileReviewPort;
		readonly speakers: readonly SpeakerRow[];
		readonly onchanged: () => Promise<void>;
	} = $props();

	const fields: readonly SpeakerProfileFieldKey[] = Object.freeze([
		'headline', 'biography', 'location', 'links'
	]);
	const fieldLabel: Readonly<Record<SpeakerProfileFieldKey, string>> = Object.freeze({
		headline: 'headline', biography: 'biography', location: 'location', links: 'links'
	});

	let queue = $state<SpeakerProfileReviewQueueDto | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let announcement = $state('');
	let selected = $state<Record<string, boolean>>({});

	function pendingFields(view: SpeakerProfileReviewQueueEntryDto): SpeakerProfileFieldKey[] {
		const approved = new Set(view.approvedFields);
		return fields.filter((field) => view.presentFields.includes(field) && !approved.has(field));
	}

	const pending = $derived((queue?.profiles ?? []).filter((view) => pendingFields(view).length > 0));
	const selectedCount = $derived(pending.filter((view) => selected[view.personId]).length);
	const allSelected = $derived(pending.length > 0 && selectedCount === pending.length);

	function personName(personId: string): string {
		return speakers.find((row) => row.personId === personId && row.name.trim())?.name
			?? 'Unnamed speaker';
	}

	async function load() {
		loading = true;
		error = '';
		try {
			queue = await port.read();
			selected = {};
		} catch {
			error = 'The speaker profile review queue could not be loaded.';
		} finally {
			loading = false;
		}
	}

	function selectAll(value: boolean) {
		selected = Object.fromEntries(pending.map((view) => [view.personId, value]));
	}

	async function approveSelected() {
		if (saving || selectedCount === 0) return;
		saving = true;
		error = '';
		announcement = '';
		let committed = 0;
		let refusal = '';
		try {
			for (const view of pending.filter((entry) => selected[entry.personId])) {
				const outcome = await port.approve({
					personId: view.personId,
					expectedProfileVersion: view.profileVersion,
					fields: pendingFields(view)
				});
				if (!outcome.ok) {
					refusal = committed > 0
						? `${committed} profile${committed === 1 ? '' : 's'} approved before another changed. ${outcome.reason}`
						: outcome.reason;
					break;
				}
				committed += 1;
			}
			await Promise.all([load(), onchanged()]);
			if (refusal) {
				error = refusal;
			} else if (committed > 0) {
				announcement = `${committed} speaker profile${committed === 1 ? '' : 's'} approved.`;
			}
		} finally {
			saving = false;
		}
	}

	onMount(() => { void load(); });
</script>

{#if loading}
	<section class="review" aria-label="Loading speaker profile review queue">
		<h2>Profile review</h2>
		<p>Checking for profile edits…</p>
	</section>
{:else if queue?.policy.reviewRequired}
	<section class="review" aria-labelledby="profile-review-title">
		<div class="review__head">
			<div>
				<h2 id="profile-review-title">Profile review</h2>
				<p>{pending.length === 0
					? 'Every current speaker profile field has been reviewed.'
					: `${pending.length} speaker profile${pending.length === 1 ? '' : 's'} waiting for review.`}</p>
			</div>
			{#if pending.length > 0}
				<Button size="sm" disabled={selectedCount === 0} loading={saving} onclick={approveSelected}>
					Approve selected{selectedCount > 0 ? ` (${selectedCount})` : ''}
				</Button>
			{/if}
		</div>

		{#if pending.length > 0}
			<div class="review__all">
				<Checkbox
					label="Select all profiles"
					checked={allSelected}
					mixed={selectedCount > 0 && !allSelected}
					disabled={saving}
					onchange={selectAll} />
			</div>
			<ul class="review__list">
				{#each pending as view (view.personId)}
					<li>
						<Checkbox
							label={personName(view.personId)}
							description={`Waiting: ${pendingFields(view).map((field) => fieldLabel[field]).join(', ')}`}
							checked={selected[view.personId] === true}
							disabled={saving}
							onchange={(value) => (selected = { ...selected, [view.personId]: value })} />
					</li>
				{/each}
			</ul>
		{/if}
		{#if error}<p class="ui-field__message ui-field__message--error" role="alert">{error}</p>{/if}
		<p class="ui-sr-only" role="status">{announcement}</p>
	</section>
{/if}

<style>
	.review {
		display: grid;
		gap: var(--je-space-3);
		padding: var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.review__head {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: var(--je-space-4);
	}

	h2,
	p {
		margin: 0;
	}

	h2 {
		font-size: var(--je-font-size-md);
	}

	.review__head p,
	.review > p {
		margin-block-start: var(--je-space-1);
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.review__all {
		padding-block-start: var(--je-space-2);
		border-block-start: 1px solid var(--je-color-border);
	}

	.review__list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
		gap: var(--je-space-2) var(--je-space-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	@media (max-width: 640px) {
		.review__head {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
