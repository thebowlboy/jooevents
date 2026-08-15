<script lang="ts">
	/**
	 * The event's own facts: what every other screen reads for a name, a place,
	 * a timezone, and the dates public listings quote. The waiting shell is this
	 * panel's own markup holding skeleton fills, so the two cannot drift apart.
	 */
	import { untrack } from 'svelte';
	import { Button, DatePicker, Field, TimezoneCombobox } from '$lib/ui';
	import type { SettingsPagePort } from '$lib/api/settings-page-port';
	import type { EventSettings } from '$lib/api/types';

	let {
		port,
		event = null,
		narrow = false,
		loading = false
	}: {
		readonly port: SettingsPagePort;
		/** The resolved event; absent only while this panel is its own shell. */
		readonly event?: EventSettings | null;
		readonly narrow?: boolean;
		readonly loading?: boolean;
	} = $props();

	/** The identity form owns every field except `dates`, which the API derives. */
	interface IdentityDraft {
		name: string;
		location: string;
		timezone: string;
		venueNote: string;
		startDate: string;
		endDate: string;
	}

	function toDraft(source: EventSettings): IdentityDraft {
		return {
			name: source.name,
			location: source.location,
			timezone: source.timezone,
			venueNote: source.venueNote,
			startDate: source.startDate ?? '',
			endDate: source.endDate ?? ''
		};
	}

	// Seeded at construction, deliberately once: the page renders this panel as
	// its waiting shell or with the resolved event and never turns one instance
	// into the other, so a later read would only overwrite what is being typed.
	const seed = untrack(() => event);
	let draft = $state<IdentityDraft>(
		seed
			? toDraft(seed)
			: { name: '', location: '', timezone: '', venueNote: '', startDate: '', endDate: '' }
	);
	let dates = $state(seed?.dates ?? '');
	let saving = $state(false);
	let savedMessage = $state('');
	let nameError = $state('');
	let endDateError = $state('');
	let nameInput = $state<HTMLInputElement>();

	/** ISO dates compare directly, so an end before its start is caught here. */
	function rangeError(): string {
		if (!draft.startDate || !draft.endDate) return '';
		return draft.endDate < draft.startDate ? 'The end date cannot fall before the start date.' : '';
	}

	/** A save message describes the values as they were saved, so editing clears it. */
	function edited() {
		savedMessage = '';
		if (draft.name.trim()) nameError = '';
		endDateError = rangeError();
	}

	async function save(submitEvent: SubmitEvent) {
		submitEvent.preventDefault();
		if (!draft.name.trim()) {
			nameError = 'Give the event a name.';
			savedMessage = '';
			nameInput?.focus();
			return;
		}
		endDateError = rangeError();
		if (endDateError) {
			savedMessage = '';
			document.getElementById('event-end')?.focus();
			return;
		}
		saving = true;
		const next = await port.event.update({
			name: draft.name.trim(),
			location: draft.location,
			timezone: draft.timezone,
			venueNote: draft.venueNote,
			startDate: draft.startDate,
			endDate: draft.endDate
		});
		saving = false;
		if (next) {
			draft = toDraft(next);
			dates = next.dates;
		}
		savedMessage = 'Saved';
	}
</script>

{#snippet fieldFill(labelWidth: string, descriptionWidth = '', textarea = false, metaWidth = '')}
	<div class="ui-field">
		<div class="ui-field__heading">
			<span class="ui-label"><span class="ui-skeleton skeleton-line" style="inline-size: {labelWidth}"></span></span>
			<!-- A field's meta sits on the label line; a description takes a line of
			     its own. Standing in for one with the other moves the control. -->
			{#if metaWidth}
				<span class="ui-field__meta"><span class="ui-skeleton skeleton-line" style="inline-size: {metaWidth}"></span></span>
			{/if}
		</div>
		{#if descriptionWidth}
			<p class="ui-field__description"><span class="ui-skeleton skeleton-line" style="inline-size: {descriptionWidth}"></span></p>
		{/if}
		<span class="ui-skeleton" class:skeleton-textarea={textarea} class:skeleton-control={!textarea}></span>
	</div>
{/snippet}

{#if loading}
	<section class="panel" id="settings-event-identity" aria-label="Loading event identity">
		<header class="panel__head">
			<div class="panel__title"><h2>Event identity</h2></div>
		</header>
		<div class="form" aria-hidden="true">
			<div class="form__wide">{@render fieldFill('12rem')}</div>
			{@render fieldFill('7rem')}
			{@render fieldFill('7rem', '', false, '13rem')}
			{@render fieldFill('6rem')}
			{@render fieldFill('6rem')}
			<!-- The derived sentence runs to a second line once the form is a single
			     column, and the fill follows it there. -->
			<p class="form__derived">
				<span class="ui-skeleton skeleton-line" style="inline-size: min(24rem, 100%)"></span>
				{#if narrow}<span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span>{/if}
			</p>
			<div class="form__wide">{@render fieldFill('7rem', '18rem', true)}</div>
			<div class="form__actions"><span class="ui-skeleton skeleton-action"></span></div>
		</div>
	</section>
{:else}
	<section class="panel" id="settings-event-identity" aria-label="Event identity">
		<header class="panel__head">
			<div class="panel__title"><h2>Event identity</h2></div>
		</header>
		<form class="form" onsubmit={save}>
			<div class="form__wide">
				<Field id="event-name" label="Event name" required error={nameError}>
					{#snippet children({ id, describedBy, invalid })}
						<input
							class="ui-control"
							type="text"
							{id}
							aria-describedby={describedBy}
							aria-invalid={invalid}
							bind:this={nameInput}
							bind:value={draft.name}
							oninput={edited} />
					{/snippet}
				</Field>
			</div>

			<Field id="event-location" label="Location">
				{#snippet children({ id, describedBy })}
					<input
						class="ui-control"
						type="text"
						{id}
						aria-describedby={describedBy}
						bind:value={draft.location}
						oninput={edited} />
				{/snippet}
			</Field>

			<Field id="event-timezone" label="Timezone" meta="Used for every deadline and time.">
				{#snippet children({ id, describedBy })}
					<TimezoneCombobox
						{id}
						{describedBy}
						bind:value={draft.timezone}
						onchange={edited} />
				{/snippet}
			</Field>

			<Field id="event-start" label="Start date">
				{#snippet children({ id, describedBy })}
					<DatePicker
						{id}
						{describedBy}
						label="start date"
						bind:value={draft.startDate}
						onchange={edited} />
				{/snippet}
			</Field>

			<Field id="event-end" label="End date" error={endDateError}>
				{#snippet children({ id, describedBy, invalid })}
					<DatePicker
						{id}
						{describedBy}
						{invalid}
						label="end date"
						min={draft.startDate || undefined}
						defaultFocus={draft.startDate || 'today'}
						bind:value={draft.endDate}
						onchange={edited} />
				{/snippet}
			</Field>

			<p class="form__derived">
				Public listings read <strong>{dates}</strong> — rewritten from these dates when you
				save.
			</p>

			<div class="form__wide">
				<Field
					id="event-venue"
					label="Venue note"
					optional
					description="Practical detail for the team — rooms, load-in, access.">
					{#snippet children({ id, describedBy })}
						<textarea
							class="ui-textarea"
							{id}
							aria-describedby={describedBy}
							rows="3"
							bind:value={draft.venueNote}
							oninput={edited}></textarea>
					{/snippet}
				</Field>
			</div>

			<div class="form__actions">
				<Button type="submit" size="sm" loading={saving}>Save</Button>
				<p class="form__saved" role="status">{savedMessage}</p>
			</div>
		</form>
	</section>
{/if}

<style>
	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, a control and an action are
	   control-height. Free-standing sized rectangles drift; these cannot. */
	.skeleton-line {
		display: inline-block;
		block-size: 1em;
		/* One line box exactly: the line inherits the height it stands in for. */
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.skeleton-control {
		display: block;
		block-size: var(--je-control-height);
		border-radius: var(--je-radius-control);
	}

	.skeleton-textarea {
		display: block;
		block-size: 6.5rem;
		border-radius: var(--je-radius-control);
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 6.5rem;
		border-radius: var(--je-radius-control);
		/* Sits on the line bottom: an empty fill has no baseline of its own, and
		   the descender space under one would deepen the row it stands in. */
		vertical-align: bottom;
	}

	.panel {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.panel__head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: var(--je-space-2) var(--je-space-4);
		margin-block-end: var(--je-space-4);
	}

	.panel__title {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.panel__head h2 {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.form {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--je-space-4);
		max-inline-size: 52rem;
	}

	.form__wide,
	.form__derived,
	.form__actions {
		grid-column: 1 / -1;
	}

	.form__derived {
		margin: calc(var(--je-space-2) * -1) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.form__actions {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		min-block-size: var(--je-control-height-sm);
	}

	.form__saved {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-success);
	}

	@media (max-width: 920px) {
		.form {
			grid-template-columns: 1fr;
		}

		.form__derived {
			margin-block-start: calc(var(--je-space-3) * -1);
		}
	}
</style>
