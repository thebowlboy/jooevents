<!--
	Creating an event asks only its birth decisions — a name, its dates, and
	the timezone every schedule and deadline reads — exactly what the live
	first-run composition collects, so the real event-creation port swaps in
	without reshaping this dialog. Everything else (location, venue, tracks,
	forms) is edited where it lives once the event exists.

	Creation's receipt is the arrival: an ok outcome re-scopes the whole
	workspace to the new event and lands on its overview.
-->
<script lang="ts">
	import { Button, DatePicker, Field, Modal, TimezoneCombobox } from '$lib/ui';
	import type { OverviewCreateEventInput } from '$lib/api/overview-page-port';
	import type { MutationOutcome } from '$lib/api/types';

	let {
		open = $bindable(false),
		createEvent,
		oncreated
	}: {
		open?: boolean;
		createEvent: (input: OverviewCreateEventInput) => Promise<MutationOutcome>;
		oncreated?: () => void;
	} = $props();

	const deviceTimezone =
		typeof Intl === 'undefined' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

	let name = $state('');
	let startDate = $state('');
	let endDate = $state('');
	let timezone = $state(deviceTimezone);
	let nameError = $state('');
	let dateError = $state('');
	let requestError = $state('');
	let creating = $state(false);
	let idempotencyKey = $state('');

	// Each open starts a fresh event, not the residue of the last attempt.
	$effect(() => {
		if (!open) return;
		name = '';
		startDate = '';
		endDate = '';
		timezone = deviceTimezone;
		nameError = '';
		dateError = '';
		requestError = '';
		idempotencyKey = '';
	});

	function edited() {
		requestError = '';
		idempotencyKey = '';
		if (name.trim()) nameError = '';
		dateError =
			startDate && endDate && endDate < startDate
				? 'The end date cannot fall before the start date.'
				: '';
	}

	const ready = $derived(
		name.trim().length > 0 &&
			startDate !== '' &&
			endDate !== '' &&
			endDate >= startDate &&
			timezone.trim().length > 0
	);

	async function create(event?: SubmitEvent) {
		event?.preventDefault();
		nameError = name.trim() ? '' : 'Give the event a name.';
		dateError = !startDate || !endDate ? 'Choose both event dates.' : dateError;
		if (nameError || dateError || !ready || creating) return;
		creating = true;
		idempotencyKey ||= crypto.randomUUID();
		const outcome = await createEvent({
			name: name.trim(),
			timezone,
			startDate,
			endDate,
			idempotencyKey
		});
		if (!outcome.ok) {
			requestError = outcome.reason;
			creating = false;
			return;
		}
		// The workspace now serves the new event; arriving on its overview is
		// the receipt. The control stays busy through the handover.
		if (oncreated) oncreated();
		else location.assign('/app');
	}
</script>

<Modal bind:open title="New event">
	<form class="newevent" onsubmit={create} aria-label="New event">
		<p class="newevent__copy">
			A name, dates, and timezone are enough to start — every area opens empty and fills as you
			work. Location, venue, and the rest live in Settings once the event exists.
		</p>
		<Field id="new-event-name" label="Name" error={nameError}>
			{#snippet children({ id, describedBy, invalid })}
				<input
					class="ui-control"
					type="text"
					{id}
					aria-describedby={describedBy}
					aria-invalid={invalid}
					placeholder="e.g. AI Engineer Helsinki 2027"
					disabled={creating}
					bind:value={name}
					oninput={edited} />
			{/snippet}
		</Field>
		<div class="newevent__dates">
			<Field id="new-event-start" label="Start date">
				{#snippet children({ id, describedBy })}
					<DatePicker
						{id}
						{describedBy}
						label="start date"
						disabled={creating}
						bind:value={startDate}
						onchange={edited} />
				{/snippet}
			</Field>
			<Field id="new-event-end" label="End date" error={dateError}>
				{#snippet children({ id, describedBy, invalid })}
					<!-- No `min`: an earlier typed date must commit so the refusal can
					     say itself in place, exactly as the live first-run validates. -->
					<DatePicker
						{id}
						{describedBy}
						{invalid}
						label="end date"
						defaultFocus={startDate || 'today'}
						disabled={creating}
						bind:value={endDate}
						onchange={edited} />
				{/snippet}
			</Field>
		</div>
		<Field
			id="new-event-timezone"
			label="Timezone"
			description="Schedule times and deadlines read this. Started from this device’s timezone.">
			{#snippet children({ id, describedBy })}
				<TimezoneCombobox {id} {describedBy} disabled={creating} bind:value={timezone} />
			{/snippet}
		</Field>
		{#if requestError}
			<p class="newevent__error" role="status">{requestError}</p>
		{/if}
	</form>
	{#snippet footer(close)}
		<Button variant="ghost" size="sm" disabled={creating} onclick={close}>Cancel</Button>
		<Button size="sm" disabled={!ready} loading={creating} onclick={() => void create()}>
			Create event
		</Button>
	{/snippet}
</Modal>

<style>
	.newevent {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-4);
	}

	.newevent__copy {
		margin: 0;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.newevent__dates {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--je-space-3);
	}

	@media (max-width: 480px) {
		.newevent__dates {
			grid-template-columns: 1fr;
		}
	}

	.newevent__error {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-danger);
	}
</style>
