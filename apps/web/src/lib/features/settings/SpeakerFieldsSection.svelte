<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ChevronDown, ChevronUp, Lock } from 'lucide-svelte';
	import { Button, Checkbox, Field } from '$lib/ui';
	import { useWorkspaceGateway } from '$lib/api/workspace-gateway';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import type { FieldContext, FieldGroup, FieldKind, RegistryField } from '$lib/api/types';

	const { api } = useWorkspaceGateway();

	/** How each answer kind names itself, on the row chip and in the composer. */
	const kindLabels: Record<FieldKind, string> = {
		text: 'text',
		textarea: 'long text',
		email: 'email',
		url: 'link',
		phone: 'phone',
		number: 'number',
		date: 'date',
		datetime: 'date & time',
		select: 'select',
		multiselect: 'multi-select',
		checkbox: 'checkbox',
		file: 'file'
	};
	const kindOrder: FieldKind[] = [
		'text',
		'textarea',
		'email',
		'url',
		'phone',
		'number',
		'date',
		'datetime',
		'select',
		'multiselect',
		'checkbox',
		'file'
	];

	/** How a group heads its run of rows. Headings follow the rows: one appears wherever the group changes, in the user's order. */
	const groupHeadings: Record<FieldGroup, string> = {
		identity: 'Identity',
		contact: 'Contact',
		presence: 'Links & social',
		talk: 'Talk',
		logistics: 'Logistics',
		materials: 'Materials',
		other: 'General',
		consent: 'Consent'
	};

	const contexts: { key: FieldContext; label: string; where: string }[] = [
		{ key: 'apply', label: 'Apply', where: 'on the application' },
		{ key: 'onboard', label: 'Onboard', where: 'at onboarding' },
		{ key: 'profile', label: 'Profile', where: 'on the speaker profile' }
	];

	let fields = $state<RegistryField[] | null>(null);
	/** Operation id (`<fieldId>-<context>`, `move-*`, `remove-*`, `add`) currently in flight. */
	let pending = $state('');
	let refusals = $state<Record<string, string>>({});
	let message = $state('');
	/** The placement advisor's one-sentence reason, shown by the row it placed until the next action. */
	let placedId = $state('');
	let placedReason = $state('');

	let newKind = $state<FieldKind>('text');
	let newLabel = $state('');
	let newHelp = $state('');
	let newOptions = $state('');
	let newContexts = $state<Record<FieldContext, boolean>>({
		apply: true,
		onboard: false,
		profile: false
	});

	onMount(() => {
		reload();
	});

	/** Re-reads the registry; also the refresh hook a receipt's undo calls. */
	export async function reload() {
		fields = await api.fields.list();
	}

	const count = $derived(fields?.length ?? 0);

	/**
	 * The list in position order, cut into runs of consecutive same-group rows.
	 * A heading renders per run, so interleaved groups keep the user's layout —
	 * the rows are never re-sorted to make the headings tidier.
	 */
	interface Segment {
		key: string;
		group: FieldGroup;
		rows: { field: RegistryField; index: number }[];
	}
	const segments = $derived.by(() => {
		const out: Segment[] = [];
		(fields ?? []).forEach((field, index) => {
			const last = out[out.length - 1];
			if (!last || last.group !== field.group) {
				out.push({ key: `${out.length}-${field.group}`, group: field.group, rows: [] });
			}
			out[out.length - 1].rows.push({ field, index });
		});
		return out;
	});

	const optionsNeeded = $derived(newKind === 'select' || newKind === 'multiselect');
	const parsedOptions = $derived(
		newOptions
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
	);
	const chosenContexts = $derived(
		contexts.filter((context) => newContexts[context.key]).map((context) => context.key)
	);
	const addReady = $derived(
		newLabel.trim().length > 0 &&
			chosenContexts.length > 0 &&
			(!optionsNeeded || parsedOptions.length > 0)
	);

	/** Every operation opens the same way; the placement note lives until this next action. */
	function begin(opId: string) {
		pending = opId;
		message = '';
		placedId = '';
		placedReason = '';
	}

	function clearRefusal(map: Record<string, string>, id: string): Record<string, string> {
		return Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));
	}

	async function toggleContext(field: RegistryField, context: FieldContext, where: string) {
		if (pending) return;
		const before = [...field.collectAt];
		const asked = before.includes(context);
		const next = asked ? before.filter((entry) => entry !== context) : [...before, context];
		begin(`${field.id}-${context}`);
		refusals = clearRefusal(refusals, field.id);
		const outcome = await api.fields.update(field.id, { collectAt: next });
		if (outcome.ok) {
			await reload();
			const said = asked
				? `No longer asking “${field.label}” ${where}`
				: `Now asking “${field.label}” ${where}`;
			message = said;
			recordAction({
				area: 'settings',
				label: said,
				undo: async () => {
					await api.fields.update(field.id, { collectAt: before });
				}
			});
		} else {
			refusals = { ...refusals, [field.id]: outcome.reason };
			message = outcome.reason;
		}
		pending = '';
	}

	async function move(field: RegistryField, from: number, delta: -1 | 1) {
		if (pending) return;
		begin(`move-${field.id}`);
		refusals = clearRefusal(refusals, field.id);
		const outcome = await api.fields.move(field.id, from + delta);
		if (outcome.ok) {
			await reload();
			recordAction({
				area: 'settings',
				label: `Moved “${field.label}” ${delta === -1 ? 'up' : 'down'}`,
				undo: async () => {
					await api.fields.move(field.id, from);
				}
			});
			// Focus travels with the moved row. At a boundary the pressed control
			// has gone disabled, so its inverse — the only move still offered —
			// takes the focus instead.
			await tick();
			const pressed = document.getElementById(
				`field-${delta === -1 ? 'up' : 'down'}-${field.id}`
			);
			const inverse = document.getElementById(
				`field-${delta === -1 ? 'down' : 'up'}-${field.id}`
			);
			if (pressed instanceof HTMLButtonElement && !pressed.disabled) pressed.focus();
			else inverse?.focus();
		} else {
			refusals = { ...refusals, [field.id]: outcome.reason };
			message = outcome.reason;
		}
		pending = '';
	}

	async function remove(field: RegistryField, index: number) {
		if (pending) return;
		// A plain snapshot before anything happens: the compensating restore puts
		// back exactly this definition at exactly this index.
		const keep = $state.snapshot(field) as RegistryField;
		begin(`remove-${field.id}`);
		refusals = clearRefusal(refusals, field.id);
		const outcome = await api.fields.remove(field.id);
		if (outcome.ok) {
			await reload();
			recordAction({
				area: 'settings',
				label: `Removed field “${field.label}”`,
				undo: async () => {
					await api.fields.restore(keep, index);
				}
			});
		} else {
			refusals = { ...refusals, [field.id]: outcome.reason };
			message = outcome.reason;
		}
		pending = '';
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (!addReady || pending) return;
		begin('add');
		const { field, placement } = await api.fields.add({
			kind: newKind,
			label: newLabel.trim(),
			...(newHelp.trim() ? { help: newHelp.trim() } : {}),
			...(optionsNeeded ? { options: parsedOptions } : {}),
			collectAt: [...chosenContexts]
		});
		await reload();
		placedId = field.id;
		placedReason = placement.reason;
		message = `Added “${field.label}”. ${placement.reason}`;
		recordAction({
			area: 'settings',
			label: `Added field “${field.label}”`,
			undo: async () => {
				await api.fields.remove(field.id);
			}
		});
		newKind = 'text';
		newLabel = '';
		newHelp = '';
		newOptions = '';
		newContexts = { apply: true, onboard: false, profile: false };
		pending = '';
	}
</script>

<section class="panel" aria-label="Speaker fields">
	<header class="panel__head">
		<div class="panel__title">
			<h2>Speaker fields</h2>
			<!-- Rows show each result where it happened; this carries the same words to assistive tech. -->
			<p class="ui-sr-only" role="status">{message}</p>
		</div>
		<p class="panel__note">
			What you collect from applicants and confirmed speakers. Every form draws from this one
			list.
		</p>
	</header>

	{#if !fields}
		<!-- The resolved list's own row markup holding skeleton fills, so arrival
		     swaps content into place instead of reflowing the panel. -->
		<ul class="frows" aria-hidden="true">
			{#each Array(6) as _row, rowIndex (rowIndex)}
				<li class="frow">
					<div class="frow__line">
						<span class="frow__name"
							><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></span>
						<span class="frow__controls">
							<span class="ui-skeleton skeleton-cluster"></span>
							<span class="ui-skeleton skeleton-action"></span>
						</span>
					</div>
				</li>
			{/each}
		</ul>
	{:else}
		{#if count === 0}
			<p class="none">No fields yet — the first question you add starts the list.</p>
		{:else}
			<div class="fgroups">
				{#each segments as segment (segment.key)}
					<h3 class="fgroup__label" id={`fgroup-${segment.key}`}>
						{groupHeadings[segment.group]}
					</h3>
					<ul class="frows" aria-labelledby={`fgroup-${segment.key}`}>
						{#each segment.rows as row (row.field.id)}
							{@const field = row.field}
							{@const refusal = refusals[field.id] ?? ''}
							<li class="frow">
								<div class="frow__line">
									<span class="frow__name">
										<span class="frow__label">{field.label}</span>
										{#if field.locked}
											<!-- Undeletable and never leaving the application; the
											     control beside it answers with the reason if pressed. -->
											<span class="frow__lock" role="img" aria-label="Locked">
												<Lock size={12} aria-hidden="true" />
											</span>
										{/if}
										<span class="ui-badge ui-badge--neutral frow__kind"
											>{kindLabels[field.kind]}</span>
									</span>
									<span class="frow__controls">
										<span
											class="ui-segmented"
											role="group"
											aria-label={`Where “${field.label}” is asked`}>
											{#each contexts as context (context.key)}
												{@const opId = `${field.id}-${context.key}`}
												{@const required = field.required[context.key] === true}
												<button
													type="button"
													class="ui-segmented__item"
													aria-pressed={field.collectAt.includes(context.key)}
													aria-label={`Ask “${field.label}” ${context.where}`}
													aria-busy={pending === opId}
													disabled={pending !== '' && pending !== opId}
													title={required ? 'Required where asked' : undefined}
													onclick={() => toggleContext(field, context.key, context.where)}>
													{context.label}{#if required}<span
															class="frow__req"
															aria-hidden="true">*</span>{/if}
												</button>
											{/each}
										</span>
										<!-- One cluster, so a narrow viewport wraps the reorder and
										     remove controls together instead of stranding one. -->
										<span class="frow__tail">
											<span class="frow__order">
												<button
													type="button"
													class="ui-button ui-button--ghost ui-button--icon ui-button--sm"
													id={`field-up-${field.id}`}
													aria-label={`Move “${field.label}” up`}
													disabled={row.index === 0 ||
														(pending !== '' && pending !== `move-${field.id}`)}
													onclick={() => move(field, row.index, -1)}>
													<ChevronUp size={14} aria-hidden="true" />
												</button>
												<button
													type="button"
													class="ui-button ui-button--ghost ui-button--icon ui-button--sm"
													id={`field-down-${field.id}`}
													aria-label={`Move “${field.label}” down`}
													disabled={row.index === count - 1 ||
														(pending !== '' && pending !== `move-${field.id}`)}
													onclick={() => move(field, row.index, 1)}>
													<ChevronDown size={14} aria-hidden="true" />
												</button>
											</span>
											{#if field.locked}
											<!-- Removal would be refused, so the control says so instead
											     of succeeding: it stays reachable, and pressing it asks —
											     the answer that comes back is the refusal itself. -->
												<button
													type="button"
													class="ui-button ui-button--ghost ui-button--sm"
													aria-label={`Remove “${field.label}”`}
													aria-disabled="true"
													onclick={() => remove(field, row.index)}>Remove</button>
											{:else}
												<Button
													variant="ghost"
													size="sm"
													aria-label={`Remove “${field.label}”`}
													disabled={pending !== '' && pending !== `remove-${field.id}`}
													loading={pending === `remove-${field.id}`}
													onclick={() => remove(field, row.index)}>Remove</Button>
											{/if}
										</span>
									</span>
								</div>
								{#if field.kind === 'file'}
									<p class="frow__note">Uploads activate with media storage</p>
								{/if}
								{#if placedId === field.id}
									<p class="frow__placed">{placedReason}</p>
								{/if}
								{#if refusal}
									<p class="frow__refusal">{refusal}</p>
								{/if}
							</li>
						{/each}
					</ul>
				{/each}
			</div>
		{/if}

		<form class="composer" onsubmit={add} aria-label="Add a field">
			<h3 class="composer__title">Add a field</h3>
			<div class="composer__grid">
				<Field id="new-field-kind" label="Kind">
					{#snippet children({ id, describedBy })}
						<select
							class="ui-select"
							{id}
							aria-describedby={describedBy}
							disabled={pending !== ''}
							bind:value={newKind}>
							{#each kindOrder as kind (kind)}
								<option value={kind}>{kindLabels[kind]}</option>
							{/each}
						</select>
					{/snippet}
				</Field>
				<Field id="new-field-label" label="Label">
					{#snippet children({ id, describedBy })}
						<input
							class="ui-control"
							type="text"
							{id}
							aria-describedby={describedBy}
							disabled={pending !== ''}
							bind:value={newLabel} />
					{/snippet}
				</Field>
				<div class="composer__wide">
					<Field
						id="new-field-help"
						label="Help"
						optional
						description="Short guidance shown beside the question.">
						{#snippet children({ id, describedBy })}
							<input
								class="ui-control"
								type="text"
								{id}
								aria-describedby={describedBy}
								disabled={pending !== ''}
								bind:value={newHelp} />
						{/snippet}
					</Field>
				</div>
				{#if optionsNeeded}
					<div class="composer__wide">
						<Field id="new-field-options" label="Choices" description="One choice per line.">
							{#snippet children({ id, describedBy })}
								<textarea
									class="ui-textarea"
									rows="3"
									{id}
									aria-describedby={describedBy}
									disabled={pending !== ''}
									bind:value={newOptions}></textarea>
							{/snippet}
						</Field>
					</div>
				{/if}
			</div>
			<fieldset class="composer__contexts">
				<legend class="composer__legend">Ask</legend>
				<div class="composer__choices">
					<Checkbox label="At apply" bind:checked={newContexts.apply} disabled={pending !== ''} />
					<Checkbox
						label="At onboarding"
						bind:checked={newContexts.onboard}
						disabled={pending !== ''} />
					<Checkbox
						label="In profile"
						bind:checked={newContexts.profile}
						disabled={pending !== ''} />
				</div>
			</fieldset>
			<Button
				type="submit"
				variant="secondary"
				size="sm"
				disabled={!addReady || pending !== ''}
				loading={pending === 'add'}>Add field</Button>
		</form>
	{/if}
</section>

<style>
	.panel {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.panel__head {
		display: grid;
		gap: var(--je-space-2);
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

	.panel__note {
		margin: 0;
		max-inline-size: 62ch;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Skeleton fills borrow their geometry from what they stand in for: a text
	   line is one line box, the control cluster and action are control-height. */
	.skeleton-line {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.skeleton-cluster {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 13rem;
		max-inline-size: 100%;
		border-radius: var(--je-radius-control);
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 4.5rem;
		border-radius: var(--je-radius-control);
	}

	.fgroups {
		display: grid;
		gap: var(--je-space-3);
	}

	/* Quiet running heads: the grouping annotates the user's order, it never
	   competes with the rows for weight. */
	.fgroup__label {
		margin: 0;
		font-size: var(--je-font-size-2xs);
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-subtle);
	}

	.frows {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.frow {
		padding-block: var(--je-space-1);
		border-block-end: 1px solid var(--je-color-border-subtle);
	}

	.frow__line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-3);
	}

	.frow__name {
		display: inline-flex;
		flex: 1 1 12rem;
		align-items: center;
		gap: var(--je-space-2);
		min-inline-size: 0;
		font-size: var(--je-font-size-md);
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.frow__lock {
		display: inline-flex;
		color: var(--je-color-text-subtle);
	}

	.frow__controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		margin-inline-start: auto;
	}

	.frow__tail {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-2);
	}

	.frow__order {
		display: inline-flex;
		gap: 2px;
	}

	.frow__req {
		margin-inline-start: 0.1rem;
	}

	/* A standing fact about the kind, at the ink of a fact, not a warning. */
	.frow__note {
		margin: 2px 0 0;
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-subtle);
	}

	/* The advisor's reason is context for one arrival; the next action retires it. */
	.frow__placed {
		margin: 2px 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* A refused attempt is an event: it states its reason on the row it belongs
	   to and stays until the next attempt. */
	.frow__refusal {
		margin: 2px 0 0;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-danger);
	}

	.none {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.composer {
		display: grid;
		justify-items: start;
		gap: var(--je-space-3);
		max-inline-size: 52rem;
		margin-block-start: var(--je-space-4);
	}

	.composer__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.composer__grid {
		display: grid;
		grid-template-columns: 12rem minmax(0, 1fr);
		gap: var(--je-space-3);
		inline-size: 100%;
	}

	.composer__wide {
		grid-column: 1 / -1;
	}

	.composer__contexts {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		border: 0;
	}

	.composer__legend {
		padding: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 650;
		color: var(--je-color-text-muted);
	}

	.composer__choices {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2) var(--je-space-4);
	}

	@media (max-width: 920px) {
		.composer__grid {
			grid-template-columns: 1fr;
		}
	}
</style>
