<script lang="ts">
	import { Button, DatePicker, Field, TimezoneCombobox } from '$lib/ui';
	import type { CurrentEventView, EventView } from '$lib/api/view-models/event';
	import type { EventProgramPort } from '$lib/api/event-program/port';

	interface Props {
		port: EventProgramPort;
		projection: Extract<CurrentEventView, { kind: 'no_event' }>;
		oncreated?: (result: { readonly eventSetVersion: number; readonly event: EventView }) => void;
	}

	let { port, projection, oncreated }: Props = $props();
	const today = new Date();
	const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
	let name = $state('');
	let timezone = $state(
		typeof Intl === 'undefined' ? 'UTC' : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
	);
	let startDate = $state('');
	let endDate = $state('');
	let nameError = $state('');
	let dateError = $state('');
	let requestError = $state('');
	let pending = $state(false);
	let idempotencyKey = $state('');
	let nameInput = $state<HTMLInputElement>();

	function edited() {
		requestError = '';
		idempotencyKey = '';
		if (name.trim()) nameError = '';
		dateError = startDate && startDate < todayIso
			? 'The start date cannot be in the past.'
			: startDate && endDate && endDate < startDate
				? 'The end date cannot fall before the start date.'
				: '';
	}

	function reviewedError(result: Awaited<ReturnType<EventProgramPort['event']['create']>>): string {
		if (result.kind === 'unavailable') return 'Event setup is not available in this build.';
		if (result.kind === 'transport_error') {
			return result.error.retryable
				? 'We could not reach JooEvents. Try again when the connection is back.'
				: 'Event setup could not be sent. Review the fields and try again.';
		}
		if (result.kind === 'outcome') {
			return result.outcome.class === 'stale_revision'
				? 'This workspace changed while you were setting it up. Reload before trying again.'
				: 'JooEvents could not create this event from the current workspace state.';
		}
		return '';
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		nameError = name.trim() ? '' : 'Give the event a name.';
		dateError = !startDate || !endDate
			? 'Choose both event dates.'
			: startDate < todayIso
				? 'The start date cannot be in the past.'
				: endDate < startDate
				? 'The end date cannot fall before the start date.'
				: '';
		if (nameError) {
			nameInput?.focus();
			return;
		}
		if (dateError) return;

		pending = true;
		requestError = '';
		idempotencyKey ||= crypto.randomUUID();
		try {
			const result = await port.event.create({
				expectedEventSetVersion: projection.eventSetVersion,
				name,
				timezone,
				startDate,
				endDate
			}, { idempotencyKey });
			if (result.kind === 'success') {
				oncreated?.(result.data);
				return;
			}
			requestError = reviewedError(result);
		} finally {
			pending = false;
		}
	}
</script>

<section class="event-first-run" aria-labelledby="event-first-run-title">
	<header>
		<div>
			<p class="eyebrow">Event setup</p>
			<h1 id="event-first-run-title">Start with the event everyone will work from</h1>
		</div>
		{#if port.source.kind === 'sample'}
			<span class="sample-label">Sample · {port.source.label}</span>
		{/if}
	</header>
	<p class="intro">Name the event and set its dates and timezone. Rooms, tracks, forms, and schedules attach to this shared event.</p>

	<form onsubmit={submit} aria-describedby={requestError ? 'event-first-run-error' : undefined}>
		<div class="wide">
			<Field id="first-event-name" label="Event name" required error={nameError}>
				{#snippet children({ id, describedBy, invalid })}
					<input class="ui-control" type="text" {id} aria-describedby={describedBy}
						aria-invalid={invalid} disabled={pending} bind:this={nameInput} bind:value={name}
						oninput={edited} />
				{/snippet}
			</Field>
		</div>

		<Field id="first-event-timezone" label="Timezone" meta="Used for dates and deadlines.">
			{#snippet children({ id, describedBy })}
				<TimezoneCombobox {id} {describedBy} disabled={pending} bind:value={timezone} onchange={edited} />
			{/snippet}
		</Field>

		<Field id="first-event-start" label="Start date" required>
			{#snippet children({ id, describedBy })}
				<DatePicker {id} {describedBy} disabled={pending} label="event start date"
					min={todayIso} defaultFocus="today" bind:value={startDate} onchange={edited} />
			{/snippet}
		</Field>

		<Field id="first-event-end" label="End date" required error={dateError}>
			{#snippet children({ id, describedBy, invalid })}
				<DatePicker {id} {describedBy} {invalid} disabled={pending} label="event end date"
					min={startDate || undefined} defaultFocus={startDate || 'today'}
					bind:value={endDate} onchange={edited} />
			{/snippet}
		</Field>

		<div class="actions wide">
			<Button type="submit" loading={pending}>Create event</Button>
			<p id="event-first-run-error" class="request-error" role="status">{requestError}</p>
		</div>
	</form>
</section>

<style>
	.event-first-run {
		max-inline-size: 48rem;
		padding: var(--je-space-8);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-lg);
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-sm);
	}
	header { display: flex; justify-content: space-between; gap: var(--je-space-4); align-items: start; }
	h1 { margin: var(--je-space-1) 0 0; font: 700 var(--je-font-size-2xl)/var(--je-leading-tight) var(--je-font-display); }
	.eyebrow { margin: 0; color: var(--je-color-text-subtle); font-size: var(--je-font-size-xs); font-weight: 700; letter-spacing: var(--je-tracking-caps); text-transform: uppercase; }
	.sample-label { flex: none; padding: var(--je-space-1) var(--je-space-2); border-radius: var(--je-radius-round); background: var(--je-color-info-soft); color: var(--je-color-info); font-size: var(--je-font-size-xs); font-weight: 700; }
	.intro { max-inline-size: 42rem; margin: var(--je-space-3) 0 var(--je-space-6); color: var(--je-color-text-muted); }
	form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--je-space-5); }
	.wide { grid-column: 1 / -1; }
	.actions { display: flex; align-items: center; gap: var(--je-space-3); min-block-size: var(--je-control-height-lg); }
	.request-error { margin: 0; color: var(--je-color-danger); font-size: var(--je-font-size-sm); }
	@media (max-width: 40rem) {
		.event-first-run { padding: var(--je-space-5); }
		header, .actions { align-items: stretch; flex-direction: column; }
		form { grid-template-columns: 1fr; }
		.wide { grid-column: auto; }
	}
</style>
