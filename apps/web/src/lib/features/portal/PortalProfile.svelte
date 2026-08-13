<script lang="ts">
	/**
	 * What the event knows about this person.
	 *
	 * A field they cannot change is shown as what it is — a value, with the
	 * reason it is fixed and a way to ask a human — never as an input that
	 * silently refuses to take a keystroke. Editing is a typo-fix ceremony: type,
	 * save, quiet receipt, and the receipt carries the words that were there
	 * before.
	 */
	import { Field, PENDING_MIN_VISIBLE_MS, trackPending } from '$lib/ui';
	import type { PortalProfileFieldView } from '$lib/api/portal/view-models';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { profileLockCopy, refusalCopy } from './copy';
	import { usePortalStore } from './store.svelte';
	import RefusalNote from './components/RefusalNote.svelte';

	const store = usePortalStore();

	const snapshot = $derived(store.snapshot);
	const fields = $derived(snapshot?.profile.fields ?? []);
	const waiting = trackPending(() => store.snapshot === null && !store.failed, {
		minVisibleMs: PENDING_MIN_VISIBLE_MS
	});

	let drafts = $state<Record<string, string>>({});
	let busyField = $state<string | null>(null);
	let refusals = $state<Record<string, string>>({});

	const valueOf = (field: PortalProfileFieldView) => drafts[field.id] ?? field.value;
	const isDirty = (field: PortalProfileFieldView) => valueOf(field) !== field.value;

	const inputType = (kind: PortalProfileFieldView['kind']) =>
		kind === 'email' ? 'email' : kind === 'url' ? 'url' : 'text';

	async function save(field: PortalProfileFieldView) {
		if (busyField !== null || !isDirty(field)) return;
		const previous = field.value;
		const next = valueOf(field);
		busyField = field.id;
		refusals = { ...refusals, [field.id]: '' };
		const outcome = await store.api.saveProfileField({ fieldId: field.id, value: next });
		busyField = null;
		if (!outcome.ok) {
			refusals = { ...refusals, [field.id]: refusalCopy[outcome.reason] };
			return;
		}
		drafts = Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== field.id));
		recordAction({
			label: `Saved your ${field.label.toLowerCase()}`,
			area: 'Portal',
			undo: async () => {
				await store.api.saveProfileField({ fieldId: field.id, value: previous });
				await store.reload();
			}
		});
		await store.reload();
	}

	async function requestChange(field: PortalProfileFieldView) {
		if (busyField !== null) return;
		busyField = field.id;
		refusals = { ...refusals, [field.id]: '' };
		const outcome = await store.api.requestProfileChange({ fieldId: field.id });
		busyField = null;
		if (!outcome.ok) {
			refusals = { ...refusals, [field.id]: refusalCopy[outcome.reason] };
			return;
		}
		recordAction({
			label: `Asked the organizers to change your ${field.label.toLowerCase()}`,
			area: 'Portal',
			notUndoableReason: 'They have the request. Email them if it was a mistake.'
		});
		await store.reload();
	}
</script>

<div class="profile" class:profile--reloading={store.reloading} aria-busy={store.reloading || undefined}>
	<header class="profile__head">
		<h1 class="profile__title">Your details</h1>
		<p class="profile__note">
			This is what the organizers of this event see about you. It is not shared with anyone else.
		</p>
	</header>

	{#if snapshot}
		<div class="fields">
			{#each fields as field (field.id)}
				{@const busy = busyField === field.id}
				{#if field.access.kind === 'editable'}
					<div class="fields__item">
						<Field id={`profile-${field.id}`} label={field.label}>
							{#snippet children({ id, describedBy })}
								{#if field.kind === 'long_text'}
									<textarea
										{id}
										class="ui-textarea"
										rows="4"
										aria-describedby={describedBy}
										disabled={busy}
										value={valueOf(field)}
										oninput={(event) =>
											(drafts = { ...drafts, [field.id]: event.currentTarget.value })}
									></textarea>
								{:else}
									<input
										{id}
										class="ui-control"
										type={inputType(field.kind)}
										aria-describedby={describedBy}
										disabled={busy}
										value={valueOf(field)}
										oninput={(event) =>
											(drafts = { ...drafts, [field.id]: event.currentTarget.value })} />
								{/if}
							{/snippet}
						</Field>
						<!-- The control appears when there is something to save, so it never
						     sits there disabled with nothing to explain. -->
						{#if isDirty(field)}
							<div class="fields__actions">
								<button
									type="button"
									class="ui-button ui-button--primary ui-button--sm"
									disabled={busy}
									aria-busy={busy || undefined}
									onclick={() => save(field)}>
									{busy ? 'Saving…' : 'Save'}
								</button>
								<button
									type="button"
									class="ui-button ui-button--ghost ui-button--sm"
									disabled={busy}
									onclick={() =>
										(drafts = Object.fromEntries(
											Object.entries(drafts).filter(([key]) => key !== field.id)
										))}>
									Cancel
								</button>
							</div>
						{/if}
						{#if refusals[field.id]}
							<RefusalNote message={refusals[field.id]} tone="refused" />
						{/if}
					</div>
				{:else}
					<div class="fields__item">
						<p class="fields__label">{field.label}</p>
						<p class="fields__value">{field.value}</p>
						<p class="fields__reason" id={`lock-${field.id}`}>{profileLockCopy(field.access)}</p>
						{#if field.access.changeRequested}
							<p class="fields__requested">
								You have asked the organizers to change this. They will come back to you.
							</p>
						{:else}
							<div class="fields__actions">
								<button
									type="button"
									class="ui-button ui-button--secondary ui-button--sm"
									aria-describedby={`lock-${field.id}`}
									disabled={busy}
									aria-busy={busy || undefined}
									onclick={() => requestChange(field)}>
									{busy ? 'Asking…' : 'Request a change'}
								</button>
							</div>
						{/if}
						{#if refusals[field.id]}
							<RefusalNote message={refusals[field.id]} tone="refused" />
						{/if}
					</div>
				{/if}
			{/each}
		</div>
	{:else if store.failed}
		<section class="fields__item" role="alert">
			<p class="profile__note">We could not load your details. Your access has not changed.</p>
			<button type="button" class="ui-button ui-button--primary" onclick={() => store.reload()}>
				Try again
			</button>
		</section>
	{:else if waiting.visible}
		<div class="fields" aria-hidden="true">
			{#each Array.from({ length: 3 }, (_, index) => index) as index (index)}
				<div class="fields__item">
					<p class="fields__label"><span class="ui-skeleton fields__fill fields__fill--label"></span></p>
					<p class="fields__value"><span class="ui-skeleton fields__fill"></span></p>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.profile {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-6);
		min-block-size: 28rem;
		transition: opacity var(--je-duration-normal) var(--je-ease);
	}

	.profile--reloading {
		opacity: 0.62;
	}

	.profile__head {
		display: grid;
		gap: var(--je-space-2);
	}

	.profile__title {
		margin: 0;
		font-size: var(--je-font-size-2xl);
		line-height: var(--je-leading-tight);
	}

	.profile__note {
		margin: 0;
		max-inline-size: 62ch;
		color: var(--je-color-text-muted);
		line-height: var(--je-leading-normal);
	}

	.fields {
		display: grid;
		gap: var(--je-space-5);
	}

	.fields__item {
		display: grid;
		gap: var(--je-space-2);
		max-inline-size: 34rem;
	}

	.fields__label {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.fields__value {
		margin: 0;
		white-space: pre-wrap;
		line-height: var(--je-leading-normal);
	}

	.fields__reason,
	.fields__requested {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.fields__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.fields__fill {
		display: inline-block;
		block-size: 1lh;
		inline-size: 60%;
		vertical-align: bottom;
	}

	.fields__fill--label {
		inline-size: 30%;
	}
</style>
