<script lang="ts">
	/**
	 * API keys: what may connect to this workspace from outside, with exactly
	 * the access chosen here. The creation flow leads with named use-case
	 * profiles; the granular panel beneath is the same grant as switches, so
	 * flipping any switch moves the selection to Custom rather than letting a
	 * tile claim something the switches contradict. The minted secret is shown
	 * exactly once.
	 */
	import { onMount } from 'svelte';
	import { formatInstant, formatInstantDate, formatRelative } from '@jooevents/contracts';
	import { Badge, Button, Checkbox, CopyValue, Field, Modal, Radio, Switch } from '$lib/ui';
	import type {
		ApiKeyPermissionGroup,
		ApiKeyView,
		ApiKeysPagePort
	} from '$lib/api/api-keys-page-port';
	import {
		accessSummary,
		apiKeyState,
		apiKeyStateBadge,
		grantSummary,
		groupSelection,
		matchProfileKey,
		resolveProfileIds
	} from './api-keys-view';

	let {
		apiKeys,
		narrow = false
	}: {
		/** Absent where the live credential seam is not composed. */
		readonly apiKeys?: ApiKeysPagePort;
		readonly narrow?: boolean;
	} = $props();

	const DAY_MS = 24 * 60 * 60 * 1000;
	const EXPIRY_CHOICES = [
		{ value: '30', days: 30, label: '30 days' },
		{ value: '90', days: 90, label: '90 days' },
		{ value: '180', days: 180, label: '180 days' },
		{ value: '365', days: 365, label: '1 year' },
		{ value: 'never', days: null, label: 'Never expires' }
	];

	let loaded = $state(false);
	let keys = $state<ApiKeyView[]>([]);
	let now = $state(Date.now());
	/** One element, eye and assistive tech both: results land in the row; this names them. */
	let panelMessage = $state('');
	let rowRefusals = $state<Record<string, string>>({});

	// Revoke arms in place: first press asks, second fires, blur stands down.
	let armedId = $state<string | null>(null);
	let busyId = $state<string | null>(null);

	// Creation draft.
	let createOpen = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let nameError = $state('');
	let draftName = $state('');
	/** Radio-group bound, so string-typed; only `ApiKeyProfileKey` values are written. */
	let profileChoice = $state<string>('assistant');
	let customBase = $state<string | null>(null);
	let proposes = $state(true);
	let selectedIds = $state<Record<string, boolean>>({});
	let adjustOpen = $state(false);
	let eventScope = $state<string>('all');
	let chosenEvents = $state<Record<string, boolean>>({});
	let expiryChoice = $state('90');

	// Rotation and the show-once secret.
	let rotateTarget = $state<ApiKeyView | null>(null);
	let rotateOpen = $state(false);
	let rotating = $state(false);
	let secretOpen = $state(false);
	let secretName = $state('');
	let secretValue = $state('');

	function refreshed<Value>(value: Value, _metadataVersion: number): Value {
		return value;
	}
	let metadataVersion = $state(0);
	const timezone = $derived(refreshed(apiKeys?.timezone ?? 'UTC', metadataVersion));
	const catalog = $derived<readonly ApiKeyPermissionGroup[]>(
		refreshed(apiKeys?.catalog ?? [], metadataVersion)
	);
	const activeKeys = $derived(
		keys
			.filter((key) => apiKeyState(key, now) === 'active' || apiKeyState(key, now) === 'expires_soon')
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
	);
	const retiredKeys = $derived(
		keys
			.filter((key) => apiKeyState(key, now) === 'revoked' || apiKeyState(key, now) === 'expired')
			.sort((left, right) =>
				(right.revokedAt ?? right.expiresAt ?? right.createdAt).localeCompare(
					left.revokedAt ?? left.expiresAt ?? left.createdAt
				)
			)
	);

	const selection = $derived(
		Object.entries(selectedIds)
			.filter(([, chosen]) => chosen)
			.map(([id]) => id)
	);
	const selectedSet = $derived(new Set(selection));
	const draftEventIds = $derived(
		eventScope === 'all'
			? []
			: Object.entries(chosenEvents)
					.filter(([, chosen]) => chosen)
					.map(([id]) => id)
	);
	const expiresDays = $derived(expiryChoice === 'never' ? null : Number(expiryChoice));
	const expiresOn = $derived(
		expiresDays === null
			? null
			: formatInstantDate(new Date(now + expiresDays * DAY_MS).toISOString(), timezone)
	);
	const summaryLine = $derived(
		apiKeys
			? grantSummary(
					{ proposesChanges: proposes, permissionIds: selection, eventIds: draftEventIds },
					catalog,
					apiKeys.events,
					expiresOn
				)
			: ''
	);

	onMount(async () => {
		if (!apiKeys) return;
		const rows = await apiKeys.list();
		metadataVersion += 1;
		keys = rows.map((key) => ({ ...key }));
		now = Date.now();
		loaded = true;
	});

	/**
	 * Choosing a named tile applies its grant. The convergence guard is the
	 * comparison itself: after a switch flip re-selects a matching tile, the
	 * selection already agrees and this changes nothing.
	 */
	$effect(() => {
		if (!apiKeys || profileChoice === 'custom') return;
		const profile = apiKeys.profiles.find((entry) => entry.key === profileChoice);
		if (!profile) return;
		const wanted = resolveProfileIds(profile, catalog);
		const agrees =
			profile.proposesChanges === proposes &&
			wanted.length === selection.length &&
			wanted.every((id) => selectedSet.has(id));
		if (agrees) {
			customBase = null;
			return;
		}
		proposes = profile.proposesChanges;
		selectedIds = Object.fromEntries(wanted.map((id) => [id, true]));
		customBase = null;
	});

	/** Any hand-flipped switch re-derives which tile is honest to show. */
	function drift(base: { proposesChanges: boolean; permissionIds: readonly string[] }): void {
		const match = matchProfileKey(apiKeys?.profiles ?? [], catalog, base);
		if (match === 'custom' && profileChoice !== 'custom') {
			const leaving = apiKeys?.profiles.find((entry) => entry.key === profileChoice);
			customBase = leaving?.label ?? customBase;
		}
		if (match !== 'custom') customBase = null;
		profileChoice = match;
	}

	function setPermission(id: string, chosen: boolean): void {
		selectedIds = { ...selectedIds, [id]: chosen };
		drift({
			proposesChanges: proposes,
			permissionIds: Object.entries(selectedIds)
				.filter(([, value]) => value)
				.map(([key]) => key)
		});
	}

	function setGroup(group: ApiKeyPermissionGroup, chosen: boolean): void {
		const next = { ...selectedIds };
		for (const permission of group.permissions) next[permission.id] = chosen;
		selectedIds = next;
		drift({
			proposesChanges: proposes,
			permissionIds: Object.entries(next)
				.filter(([, value]) => value)
				.map(([key]) => key)
		});
	}

	function setProposes(chosen: boolean): void {
		proposes = chosen;
		drift({ proposesChanges: chosen, permissionIds: selection });
	}

	function openCreate(): void {
		draftName = '';
		nameError = '';
		createError = '';
		profileChoice = 'assistant';
		customBase = null;
		adjustOpen = false;
		eventScope = 'all';
		chosenEvents = {};
		expiryChoice = String(apiKeys?.expiry.defaultDays ?? 90);
		const assistant = apiKeys?.profiles.find((entry) => entry.key === 'assistant');
		proposes = assistant?.proposesChanges ?? true;
		selectedIds = Object.fromEntries(
			(assistant ? resolveProfileIds(assistant, catalog) : []).map((id) => [id, true])
		);
		createOpen = true;
	}

	async function submitCreate(): Promise<void> {
		if (!apiKeys) return;
		const name = draftName.trim();
		if (name.length === 0) {
			nameError = 'Name the key so you can tell it apart later.';
			return;
		}
		creating = true;
		createError = '';
		const result = await apiKeys.create({
			name,
			proposesChanges: proposes,
			permissionIds: selection,
			eventIds: draftEventIds,
			expiresInDays: expiresDays
		});
		creating = false;
		if (result.kind === 'refused') {
			createError = result.reason;
			return;
		}
		keys = [{ ...result.key }, ...keys];
		now = Date.now();
		createOpen = false;
		secretName = result.key.name;
		secretValue = result.secret;
		secretOpen = true;
		panelMessage = `“${result.key.name}” was created. The key is shown once, in the dialog now open.`;
	}

	function askRotate(key: ApiKeyView): void {
		rotateTarget = key;
		rotateOpen = true;
	}

	async function confirmRotate(): Promise<void> {
		const target = rotateTarget;
		if (!apiKeys || !target) return;
		rotating = true;
		const result = await apiKeys.rotate(target.id);
		rotating = false;
		rotateOpen = false;
		if (result.kind === 'refused') {
			rowRefusals = { ...rowRefusals, [target.id]: result.reason };
			panelMessage = result.reason;
			return;
		}
		keys = [
			{ ...result.successor },
			...keys.map((key) => (key.id === result.predecessor.id ? { ...result.predecessor } : key))
		];
		now = Date.now();
		secretName = result.successor.name;
		secretValue = result.secret;
		secretOpen = true;
		panelMessage = `“${target.name}” was rotated. The replacement key is shown once, in the dialog now open.`;
	}

	async function revoke(key: ApiKeyView): Promise<void> {
		if (!apiKeys) return;
		if (armedId !== key.id) {
			armedId = key.id;
			return;
		}
		if (busyId !== null) return;
		armedId = null;
		busyId = key.id;
		rowRefusals = Object.fromEntries(Object.entries(rowRefusals).filter(([id]) => id !== key.id));
		const result = await apiKeys.revoke(key.id);
		busyId = null;
		if (result.kind === 'refused') {
			rowRefusals = { ...rowRefusals, [key.id]: result.reason };
			panelMessage = result.reason;
			return;
		}
		keys = keys.map((entry) => (entry.id === result.key.id ? { ...result.key } : entry));
		now = Date.now();
		panelMessage = `“${key.name}” was revoked. Anything still using it stopped working.`;
	}
</script>

{#snippet stateChip(key: ApiKeyView)}
	{@const badge = apiKeyStateBadge(apiKeyState(key, now))}
	{#if badge}
		<Badge value={badge.label} tone={badge.tone} />
	{/if}
{/snippet}

{#snippet expiresValue(key: ApiKeyView)}
	{@const state = apiKeyState(key, now)}
	<span class="expires">
		{#if key.expiresAt === null}
			<span class="expires__date">Never expires</span>
		{:else}
			<span class="expires__date">{formatInstantDate(key.expiresAt, timezone)}</span>
		{/if}
		{#if state === 'active' && key.expiresAt !== null}
			<span class="expires__distance">{formatRelative(key.expiresAt, now)}</span>
		{:else if state === 'expires_soon' && key.expiresAt !== null}
			<Badge value={`Expires ${formatRelative(key.expiresAt, now)}`} tone="caution" />
		{/if}
	</span>
{/snippet}

{#snippet lastUsedValue(key: ApiKeyView)}
	{#if key.lastUsedAt}
		<span>
			{formatRelative(key.lastUsedAt, now)}
			<span class="ui-sr-only">({formatInstant(key.lastUsedAt, timezone)})</span>
		</span>
	{:else}
		<span class="never-used">Never used</span>
	{/if}
{/snippet}

{#snippet rowControls(key: ApiKeyView)}
	<span class="row-controls">
		<Button
			variant="secondary"
			size="sm"
			aria-label={`Rotate ${key.name}`}
			disabled={busyId !== null}
			onclick={() => askRotate(key)}>Rotate</Button>
		<button
			type="button"
			class="ui-button ui-button--ghost ui-button--sm"
			class:revoke--armed={armedId === key.id}
			aria-label={`Revoke ${key.name}`}
			disabled={busyId !== null}
			onclick={() => revoke(key)}
			onblur={() => {
				if (armedId === key.id) armedId = null;
			}}>
			{busyId === key.id ? 'Revoking…' : armedId === key.id ? 'Revoke?' : 'Revoke'}
		</button>
	</span>
{/snippet}

{#if !apiKeys}
	<section class="panel" id="settings-api-keys" aria-label="API keys">
		<header class="panel__head">
			<div class="panel__title"><h2>API keys</h2></div>
		</header>
		<p class="unavailable">API keys are not part of this preview.</p>
	</section>
{:else}
	<section class="panel" id="settings-api-keys" aria-label="API keys">
		<header class="panel__head">
			<div class="panel__title">
				<h2>API keys</h2>
				<p class="ui-sr-only" role="status">{panelMessage}</p>
			</div>
			<div class="panel__action">
				<Button size="sm" disabled={!loaded} onclick={openCreate}>New API key</Button>
			</div>
			<p class="panel__note">
				A key lets an agent, a dashboard, or a script use this workspace with exactly the access
				chosen here. Reading is direct; any change a key proposes waits for a person's approval.
			</p>
		</header>

		{#if !loaded}
			{#if narrow}
				<ul class="cards" aria-hidden="true">
					{#each Array(3) as _row, rowIndex (rowIndex)}
						<li class="card">
							<div class="card__head">
								<span class="card__identity">
									<span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span>
									<span class="ui-skeleton skeleton-line" style="inline-size: 6rem"></span>
								</span>
							</div>
							<span class="ui-skeleton skeleton-line" style="inline-size: 11rem"></span>
							<div class="card__controls"><span class="ui-skeleton skeleton-action"></span></div>
						</li>
					{/each}
				</ul>
			{:else}
				<div class="ui-table-wrap" aria-hidden="true">
					<table class="ui-table keys">
						<thead>
							<tr>
								<th>Key</th>
								<th>Access</th>
								<th>Expires</th>
								<th>Last used</th>
								<th class="col-action"><span class="ui-sr-only">Actions</span></th>
							</tr>
						</thead>
						<tbody>
							{#each Array(3) as _row, rowIndex (rowIndex)}
								<tr>
									<td><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></td>
									<td><span class="ui-skeleton skeleton-line" style="inline-size: 10rem"></span></td>
									<td><span class="ui-skeleton skeleton-line" style="inline-size: 7rem"></span></td>
									<td><span class="ui-skeleton skeleton-line" style="inline-size: 5rem"></span></td>
									<td class="col-action"><span class="ui-skeleton skeleton-action"></span></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{:else if keys.length === 0}
			<p class="empty">
				No API keys yet. Create one to connect an agent, a dashboard, or a script — it can only
				ever do what you allow here, and anything it proposes still waits for your approval.
			</p>
		{:else}
			{#if retiredKeys.length > 0}
				<h3 class="group-title">Active ({activeKeys.length})</h3>
			{/if}

			{#if activeKeys.length === 0}
				<p class="empty">No active keys. Every key below was revoked or has expired.</p>
			{:else if narrow}
				<ul class="cards">
					{#each activeKeys as key (key.id)}
						<li class="card">
							<!-- The Expires fact already carries the caution badge, so the
							     head does not repeat the state. -->
							<div class="card__head">
								<span class="card__identity">
									<span class="card__name">{key.name}</span>
									<span class="card__hint">{key.tokenHint}…</span>
								</span>
							</div>
							<dl class="card__facts">
								<div class="card__fact">
									<dt>Access</dt>
									<dd>{accessSummary(key, catalog)}</dd>
								</div>
								<div class="card__fact">
									<dt>Expires</dt>
									<dd>{@render expiresValue(key)}</dd>
								</div>
								<div class="card__fact">
									<dt>Last used</dt>
									<dd>{@render lastUsedValue(key)}</dd>
								</div>
							</dl>
							<div class="card__controls">{@render rowControls(key)}</div>
							{#if rowRefusals[key.id]}
								<p class="refusal">{rowRefusals[key.id]}</p>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<div class="ui-table-wrap">
					<table class="ui-table keys">
						<thead>
							<tr>
								<th>Key</th>
								<th>Access</th>
								<th>Expires</th>
								<th>Last used</th>
								<th class="col-action"><span class="ui-sr-only">Actions</span></th>
							</tr>
						</thead>
						<tbody>
							{#each activeKeys as key (key.id)}
								<tr>
									<td>
										<span class="ui-table__primary"><strong>{key.name}</strong></span>
										<span class="ui-table__secondary key-hint">{key.tokenHint}…</span>
									</td>
									<td>{accessSummary(key, catalog)}</td>
									<td>{@render expiresValue(key)}</td>
									<td>{@render lastUsedValue(key)}</td>
									<td class="col-action">{@render rowControls(key)}</td>
								</tr>
								{#if rowRefusals[key.id]}
									<tr class="refusal-row">
										<td colspan="5"><p class="refusal">{rowRefusals[key.id]}</p></td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			{#if retiredKeys.length > 0}
				<h3 class="group-title group-title--retired">Revoked and expired ({retiredKeys.length})</h3>
				{#if narrow}
					<ul class="cards cards--retired">
						{#each retiredKeys as key (key.id)}
							<li class="card">
								<div class="card__head">
									<span class="card__identity">
										<span class="card__name">{key.name}</span>
										<span class="card__hint">{key.tokenHint}…</span>
									</span>
									{@render stateChip(key)}
								</div>
								<dl class="card__facts">
									<div class="card__fact">
										<dt>Access</dt>
										<dd>{accessSummary(key, catalog)}</dd>
									</div>
									<div class="card__fact">
										<dt>Ended</dt>
										<dd>{formatInstantDate(key.revokedAt ?? key.expiresAt, timezone)}</dd>
									</div>
								</dl>
							</li>
						{/each}
					</ul>
				{:else}
					<div class="ui-table-wrap">
						<table class="ui-table keys keys--retired">
							<thead>
								<tr>
									<th>Key</th>
									<th>Access</th>
									<th>State</th>
								</tr>
							</thead>
							<tbody>
								{#each retiredKeys as key (key.id)}
									<tr>
										<td>
											<span class="ui-table__primary">{key.name}</span>
											<span class="ui-table__secondary key-hint">{key.tokenHint}…</span>
										</td>
										<td>{accessSummary(key, catalog)}</td>
										<td>
											<span class="ended">
												{@render stateChip(key)}
												<span class="ended__date"
													>{formatInstantDate(key.revokedAt ?? key.expiresAt, timezone)}</span>
											</span>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			{/if}
		{/if}
	</section>

	<Modal bind:open={createOpen} title="New API key" size="lg">
		<div class="create">
			<Field
				id="api-key-name"
				label="Name"
				description="What this key connects — the name you'll recognize in the list."
				required
				error={nameError}>
				{#snippet children({ id, describedBy, invalid })}
					<input
						class="ui-control"
						type="text"
						{id}
						aria-describedby={describedBy}
						aria-invalid={invalid}
						maxlength="80"
						bind:value={draftName}
						oninput={() => (nameError = '')} />
				{/snippet}
			</Field>

			<fieldset class="choice-block">
				<legend class="caption">What is this key for?</legend>
				<div class="profiles">
					{#each apiKeys.profiles as profile (profile.key)}
						<Radio
							name="api-key-profile"
							value={profile.key}
							label={profile.label}
							description={profile.description}
							bind:group={profileChoice} />
					{/each}
					<Radio
						name="api-key-profile"
						value="custom"
						label="Custom"
						description={customBase
							? `Based on ${customBase}, adjusted below.`
							: 'Choose each permission yourself below.'}
						bind:group={profileChoice} />
				</div>
			</fieldset>

			<div class="capability">
				<Switch
					label="Can propose changes"
					description="The key may submit plans — bundles of changes that wait for a person's approval. Nothing a key sends changes the workspace directly."
					checked={proposes}
					onchange={setProposes} />
			</div>

			<div class="adjust">
				<div class="adjust__bar">
					<!-- Secondary, not soft: the dialog's one accent belongs to Create key. -->
					<Button
						variant="secondary"
						size="sm"
						aria-expanded={adjustOpen}
						aria-controls="api-key-permissions"
						onclick={() => (adjustOpen = !adjustOpen)}>
						{adjustOpen ? 'Hide individual permissions' : 'Adjust individual permissions'}
					</Button>
					<span class="adjust__count">{selection.length} chosen</span>
				</div>
				{#if adjustOpen}
					<div class="perm-groups" id="api-key-permissions">
						{#each catalog as group (group.key)}
							{@const chosen = groupSelection(group, selectedSet)}
							{@const chosenCount = group.permissions.filter((entry) => selectedSet.has(entry.id)).length}
							<fieldset class="perm-group">
								<div class="perm-group__head">
									<Checkbox
										label={group.label}
										checked={chosen === 'all'}
										mixed={chosen === 'some'}
										onchange={(value) => setGroup(group, value)} />
									<span class="perm-group__count">{chosenCount} of {group.permissions.length}</span>
								</div>
								<ul class="perm-group__rows">
									{#each group.permissions as permission (permission.id)}
										<li class="perm-row">
											<div class="perm-row__line">
												<div class="perm-row__control">
													<Switch
														label={permission.label}
														description={permission.description}
														checked={selectedSet.has(permission.id)}
														onchange={(value) => setPermission(permission.id, value)} />
												</div>
												{#if permission.risk !== 'routine'}
													<Badge
														value={permission.risk === 'consequential' ? 'Consequential' : 'Sensitive'}
														tone={permission.risk === 'consequential' ? 'caution' : 'neutral'} />
												{/if}
											</div>
											{#if !permission.held}
												<p class="perm-row__unheld">
													You don't hold this today, so the key won't either until you do.
												</p>
											{/if}
										</li>
									{/each}
								</ul>
							</fieldset>
						{/each}
					</div>
				{/if}
			</div>

			<fieldset class="choice-block">
				<legend class="caption">Events</legend>
				<div class="event-scope">
					<Radio
						name="api-key-events"
						value="all"
						label="All events"
						description="Every event in this workspace, current and future."
						bind:group={eventScope} />
					<Radio
						name="api-key-events"
						value="chosen"
						label="Only chosen events"
						bind:group={eventScope} />
					{#if eventScope === 'chosen'}
						<div class="event-choices">
							{#each apiKeys.events as event (event.id)}
								<Checkbox
									label={event.name}
									checked={chosenEvents[event.id] === true}
									onchange={(value) => (chosenEvents = { ...chosenEvents, [event.id]: value })} />
							{/each}
						</div>
					{/if}
				</div>
			</fieldset>

			<Field
				id="api-key-expiry"
				label="Expires"
				description="Choose a date, or let this key never expire. Rotation and revocation remain available either way.">
				{#snippet children({ id, describedBy })}
					<select class="ui-select" {id} aria-describedby={describedBy} bind:value={expiryChoice}>
						{#each EXPIRY_CHOICES as choice (choice.value)}
							<option value={choice.value}>{choice.label}</option>
						{/each}
					</select>
				{/snippet}
			</Field>

			<p class="create__summary" role="status">{summaryLine}</p>
			{#if createError}
				<p class="refusal" role="alert">{createError}</p>
			{/if}
		</div>
		{#snippet footer(close)}
			<Button variant="ghost" disabled={creating} onclick={close}>Cancel</Button>
			<Button loading={creating} onclick={submitCreate}>Create key</Button>
		{/snippet}
	</Modal>

	<Modal bind:open={rotateOpen} title="Rotate this key?">
		{#if rotateTarget}
			<p class="modal__copy">
				A replacement key is created with exactly the same access. “{rotateTarget.name}” keeps
				working for {apiKeys.expiry.rotationGraceDays} more days, then stops — switch whatever
				uses it to the replacement before then.
			</p>
		{/if}
		{#snippet footer(close)}
			<Button variant="ghost" disabled={rotating} onclick={close}>Cancel</Button>
			<Button loading={rotating} onclick={confirmRotate}>Rotate key</Button>
		{/snippet}
	</Modal>

	<Modal bind:open={secretOpen} title="Your new API key">
		<p class="modal__copy">
			“{secretName}” is ready. This is the only time JooEvents shows the key — store it somewhere
			safe. If it is lost, rotate the key and the replacement gets a new secret.
		</p>
		<div class="secret"><CopyValue value={secretValue} label="API key" /></div>
		{#snippet footer(close)}
			<Button onclick={close}>Done</Button>
		{/snippet}
	</Modal>
{/if}

<style>
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

	.panel__note {
		grid-column: 1 / -1;
		margin: 0;
		max-inline-size: 62ch;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.panel__action {
		justify-self: end;
	}

	.unavailable,
	.empty {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		max-inline-size: 58ch;
	}

	.skeleton-line {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 4.5rem;
		border-radius: var(--je-radius-control);
		vertical-align: bottom;
	}

	/* The band states the resting lifecycle fact once, so rows only badge
	   exceptions. */
	.group-title {
		margin: 0 0 var(--je-space-3);
		font-size: var(--je-font-size-xs);
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.group-title--retired {
		margin-block-start: var(--je-space-6);
	}

	/* Five short columns fit the content column; the text wraps instead of
	   scrolling sideways. */
	.keys {
		min-width: 0;
	}

	.col-action {
		inline-size: 10.5rem;
	}

	.keys--retired :global(.ui-badge) {
		vertical-align: baseline;
	}

	.key-hint {
		font-family: var(--je-font-mono);
		font-size: var(--je-font-size-xs);
	}

	.expires {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-1) var(--je-space-2);
	}

	.expires__date {
		font-variant-numeric: tabular-nums;
	}

	.expires__distance,
	.never-used {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		white-space: nowrap;
	}

	.ended {
		display: inline-flex;
		align-items: baseline;
		gap: var(--je-space-2);
	}

	.ended__date {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.row-controls {
		display: inline-flex;
		gap: var(--je-space-2);
	}

	.revoke--armed {
		color: var(--je-color-danger);
	}

	.refusal-row td {
		padding-block-end: var(--je-space-2);
	}

	.refusal {
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-danger);
	}

	.cards {
		display: grid;
		gap: var(--je-space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.card {
		display: grid;
		gap: var(--je-space-2);
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.card__head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--je-space-2);
	}

	.card__identity {
		display: grid;
		gap: var(--je-space-1);
		min-inline-size: 0;
	}

	.card__name {
		font-weight: 650;
	}

	.card__hint {
		font-family: var(--je-font-mono);
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.card__facts {
		display: grid;
		gap: var(--je-space-1);
		margin: 0;
	}

	.card__fact {
		display: grid;
		grid-template-columns: minmax(0, 6.5rem) minmax(0, 1fr);
		gap: var(--je-space-2);
		align-items: baseline;
	}

	.card__fact dt {
		font-size: var(--je-font-size-2xs);
		font-weight: 700;
		letter-spacing: var(--je-tracking-caps);
		text-transform: uppercase;
		color: var(--je-color-text-subtle);
	}

	.card__fact dd {
		margin: 0;
		font-size: var(--je-font-size-sm);
	}

	.card__controls {
		display: flex;
		justify-content: end;
	}

	/* Creation flow. Sibling steps share one gap; the summary is the section's
	   own closing line. */
	.create {
		display: grid;
		gap: var(--je-space-5);
	}

	.choice-block {
		margin: 0;
		padding: 0;
		border: 0;
		display: grid;
		gap: var(--je-space-2);
	}

	.caption {
		padding: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.profiles,
	.event-scope {
		display: grid;
		gap: var(--je-space-2);
	}

	.event-choices {
		display: grid;
		gap: var(--je-space-1);
		margin-inline-start: var(--je-space-6);
	}

	.adjust {
		display: grid;
		gap: var(--je-space-3);
	}

	.adjust__bar {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
	}

	.adjust__count {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* Supporting inset: the granular panel is detail under the thing in hand. */
	.perm-groups {
		display: grid;
		gap: var(--je-space-4);
		padding: var(--je-space-3);
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.perm-group {
		margin: 0;
		padding: 0;
		border: 0;
		display: grid;
		gap: var(--je-space-2);
	}

	.perm-group__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--je-space-2);
	}

	.perm-group__count {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.perm-group__rows {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
		margin-inline-start: var(--je-space-6);
	}

	.perm-row__line {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content;
		gap: var(--je-space-2);
		align-items: start;
	}

	.perm-row__control {
		min-inline-size: 0;
	}

	.perm-row__unheld {
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.create__summary {
		margin: 0;
		padding: var(--je-space-2) var(--je-space-3);
		background: var(--je-color-surface-sunken);
		border-radius: var(--je-radius-control);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text);
	}

	.modal__copy {
		margin: 0 0 var(--je-space-4);
		font-size: var(--je-font-size-md);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	/* The one place the secret ever renders: mono, wrapping, copyable. */
	.secret {
		padding: var(--je-space-3);
		background: var(--je-color-code-surface);
		color: var(--je-color-code-text);
		border-radius: var(--je-radius-control);
		font-family: var(--je-font-mono);
		font-size: var(--je-font-size-sm);
		overflow-wrap: anywhere;
	}

	/* Cosmetic only: ink readable on the dark code surface, and full rest
	   visibility — in the show-once dialog copying is the primary task, so the
	   control stands instead of waiting for a hover to reveal it. */
	.secret :global(.ui-copy__button) {
		color: var(--je-color-code-text);
		opacity: 1;
	}

	@media (max-width: 40rem) {
		.perm-row__line {
			grid-template-columns: minmax(0, 1fr);
		}

		.perm-group__rows {
			margin-inline-start: var(--je-space-3);
		}
	}
</style>
