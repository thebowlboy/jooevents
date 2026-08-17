<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { formatInstant, formatRelative } from '@jooevents/contracts';
	import { ChevronRight, Send } from 'lucide-svelte';
	import airtableMark from '$lib/assets/integrations/airtable-mark.svg';
	import type {
		AirtableAreaDirection,
		AirtableHistoryItem,
		AirtableIntegrationView,
		AirtableSelectableBase,
		IntegrationsPagePort
	} from '$lib/api/integrations-page-port';
	import { Badge, Button, CopyValue, DescribedSelect } from '$lib/ui';
	import { badgeFor } from '$lib/ui/status-tones';

	let { port, detail = false }: { readonly port: IntegrationsPagePort; readonly detail?: boolean } = $props();
	let view = $state<AirtableIntegrationView | null>(null);
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);
	let receipt = $state<string | null>(null);
	let bases = $state<readonly AirtableSelectableBase[]>([]);
	let selectedBaseId = $state('');
	let draftDirections = $state<Record<string, AirtableAreaDirection>>({});
	const viewedAt = Date.now();

	const panel = $derived(page.url.searchParams.get('panel'));
	const historyScope = $derived(page.url.searchParams.get('scope') ?? 'all');
	const filteredHistory = $derived((view?.history ?? []).filter((item) =>
		historyScope === 'all'
		|| historyScope === 'airtable' && item.kind === 'applied'
		|| historyScope === 'refused' && item.kind === 'refused'
		|| historyScope === 'connection' && (item.kind === 'connection' || item.kind === 'sharing')
	));

	async function loadBases() {
		bases = await port.listAirtableBases();
		const writable = bases.filter((base) => base.permissionLevel === 'edit' || base.permissionLevel === 'create');
		if (writable.length === 1) selectedBaseId = writable[0]!.id;
	}

	onMount(async () => {
		try {
			view = await port.readAirtable();
			draftDirections = Object.fromEntries(view.areas.map((area) => [area.key, area.direction]));
			if (view.state === 'provisioning' && view.setupStage === 'choose_base') await loadBases();
		} catch {
			error = 'Airtable connection details could not be loaded. Try again.';
		}
	});

	async function act(label: string, run: () => Promise<AirtableIntegrationView>, success?: string) {
		busy = label;
		error = null;
		receipt = null;
		try {
			view = await run();
			receipt = success ?? null;
		} catch {
			error = 'Airtable could not be updated. Nothing else changed; try again.';
		} finally {
			busy = null;
		}
	}

	const directionOptions = [
		{ value: 'not_connected', label: 'Not connected', description: 'This area is not populated or kept current.' },
		{ value: 'keep_airtable_updated', label: 'Keep Airtable updated', description: 'JooEvents values stay current in Airtable; edits there do not change the app.' },
		{ value: 'work_from_airtable', label: 'Work from Airtable', description: 'Approved fields can update JooEvents; protected changes become review requests.' }
	] satisfies readonly { value: AirtableAreaDirection; label: string; description: string }[];

	const directionLabel: Record<AirtableAreaDirection, string> = {
		not_connected: 'Not connected',
		keep_airtable_updated: 'Keep Airtable updated',
		work_from_airtable: 'Work from Airtable'
	};

	const historyKind: Record<AirtableHistoryItem['kind'], { readonly label: string; readonly tone: string }> = {
		applied: { label: 'From Airtable', tone: 'applied' },
		refused: { label: 'Restored', tone: 'refused' },
		sharing: { label: 'Sharing', tone: 'sharing' },
		connection: { label: 'Connection', tone: 'connection' }
	};

	function historyAction(item: AirtableHistoryItem) {
		const actorPrefix = item.actorLabel ? `${item.actorLabel} ` : '';
		return actorPrefix && item.summary.startsWith(actorPrefix)
			? item.summary.slice(actorPrefix.length)
			: item.summary;
	}

	function status(view: AirtableIntegrationView) {
		return {
			not_connected: { key: 'notConfigured' as const, label: 'Not connected' },
			provisioning: { key: 'syncPending' as const, label: 'Adding tables' },
			current: { key: 'syncCurrent' as const, label: 'Current' },
			pending: { key: 'syncPending' as const, label: 'Checking' },
			needs_review: { key: 'syncNeedsReview' as const, label: 'Needs review' },
			delayed: { key: 'syncDelayed' as const, label: 'Delayed' },
			catching_up: { key: 'syncPending' as const, label: 'Catching up' },
			paused: { key: 'syncPaused' as const, label: 'Paused' },
			needs_reconnect: { key: 'syncReconnect' as const, label: 'Needs reconnect' }
		}[view.state];
	}

	function directionFact(area: AirtableIntegrationView['areas'][number]) {
		if (area.direction === 'not_connected') return 'Nothing from this area appears in Airtable.';
		if (area.direction === 'keep_airtable_updated') return `${area.sharedFields} fields stay visible and current in Airtable.`;
		const parts = [
			area.editableFields > 0 ? `${area.editableFields} ${area.editableFields === 1 ? 'field' : 'fields'} can update JooEvents` : '',
			area.requestFields > 0 ? `${area.requestFields} ${area.requestFields === 1 ? 'field creates' : 'fields create'} review requests` : ''
		].filter(Boolean);
		return parts.join(' · ') || 'JooEvents keeps these values current.';
	}

	async function activate() {
		if (!view || !selectedBaseId) return;
		await act('activate', () => port.activateAirtable(selectedBaseId, view!.areas.map((area) => ({
			areaKey: area.key,
			direction: draftDirections[area.key] ?? 'not_connected'
		}))), 'JooEvents is adding the managed tables and checking every record.');
	}

	const selectedAreaCount = $derived(view?.areas.filter((area) =>
		(draftDirections[area.key] ?? area.direction) !== 'not_connected'
	).length ?? 0);
	const inboundAreaCount = $derived(view?.areas.filter((area) =>
		(draftDirections[area.key] ?? area.direction) === 'work_from_airtable'
	).length ?? 0);
	const selectedBaseWritable = $derived(bases.some((base) => base.id === selectedBaseId
		&& (base.permissionLevel === 'edit' || base.permissionLevel === 'create')));
</script>

{#if !detail}
	<section class="integrations-head">
		<p class="eyebrow">WORKING SURFACES</p>
		<h2>Keep the tools your team already works in</h2>
		<p>Connect a shared surface, or hand finished work to the platform that delivers it — without splitting the event into two versions of the truth.</p>
	</section>
	<div class="integration-list">
	<a class="integration-card" href="/app/integrations/airtable">
		<!-- Decorative beside the visible integration name. -->
		<span class="integration-card__brand" aria-hidden="true"><img src={airtableMark} alt="" width="26" height="22" /></span>
		<span class="integration-card__name"><strong>Airtable{view?.baseName ? ` · ${view.baseName}` : ''}</strong><small>A live base your Airtable team can work in. JooEvents keeps it current, and safe edits there update the app.</small></span>
		{#if view}
			<span class="integration-card__state"><Badge {...badgeFor(status(view).key)} value={status(view).label} />{#if view.attention.length > 0}<small>{view.attention.length} waiting on you →</small>{/if}</span>
		{:else}
			<span class="ui-skeleton card-status-skeleton"></span>
		{/if}
		<span class="integration-card__go" aria-hidden="true"><ChevronRight size={16} /></span>
	</a>
	<a class="integration-card integration-card--static" href="/app/integrations/accelevents">
		<!-- Decorative beside the visible integration name. -->
		<span class="integration-card__brand" aria-hidden="true"><Send size={22} /></span>
		<span class="integration-card__name"><strong>Accelevents</strong><small>When the program is ready, its locations, speakers, and sessions become files Accelevents imports. Nothing connects or syncs — you run the import.</small></span>
		<span class="integration-card__go" aria-hidden="true"><ChevronRight size={16} /></span>
	</a>
	</div>
{:else if !view}
	<section class="airtable-shell" aria-label="Loading Airtable integration">
		<span class="ui-skeleton skeleton-title"></span><span class="ui-skeleton skeleton-line"></span>
	</section>
{:else}
	<div class="airtable-detail">
	<header class="airtable-head">
		<div>
			<a class="back" href="/app/integrations">← Integrations</a>
			<p class="eyebrow">AIRTABLE</p>
			<h2>{view.state === 'not_connected' ? 'Give your Airtable team a live working surface' : 'Airtable'}</h2>
			{#if view.state === 'not_connected'}
				<p>JooEvents stays the source of truth. Teammates can keep using Airtable, while app users work here, without re-entering the same event data.</p>
			{:else if view.setupStage === 'choose_base'}
				<p>{view.accountLabel ? `Connected as ${view.accountLabel}. ` : ''}Choose the one base JooEvents may manage.</p>
			{:else}
				<p>{view.baseName}{view.accountLabel ? ` · Connected as ${view.accountLabel}` : ' · Connected Airtable account'}. A live base your Airtable team can work in while others use JooEvents; approved edits stay current both ways.</p>
			{/if}
		</div>
		<div class="head-actions">
			<Badge {...badgeFor(status(view).key)} value={status(view).label} />
			{#if view.baseUrl}<a class="ui-button ui-button--secondary ui-button--sm" href={view.baseUrl} target="_blank" rel="noreferrer">Open in Airtable</a>{/if}
		</div>
	</header>

	{#if view.state === 'not_connected'}
		<section class="card setup">
			<h3>Connect your Airtable account</h3>
			<p>You'll approve JooEvents in Airtable's own window and choose the one base it may use. Existing tables stay as they are.</p>
			<div class="setup-moments" aria-label="Connection steps">
				<span><b>1</b> Approve in Airtable</span><span><b>2</b> Choose the base</span><span><b>3</b> Choose what stays connected</span><span><b>4</b> Preview and add tables</span>
			</div>
			<p class="boundary">Review scores, private notes, and sign-in or access data never go to Airtable.</p>
			<Button loading={busy === 'connect'} disabled={busy !== null} onclick={() => act('connect', () => port.connectAirtable())}>Continue to Airtable</Button>
		</section>
	{:else if view.state === 'provisioning' && view.setupStage === 'choose_base'}
		<section class="card setup setup-config">
			<div>
				<p class="step-label">STEP 2 OF 4</p>
				<h3>Choose the base your team will work in</h3>
				<p>Only bases included in the Airtable approval appear here. JooEvents preserves unrelated tables and adds its own clearly named tables after your preview.</p>
			</div>
			{#if bases.length === 0}
				<p class="quiet">No bases are available to this connection. Reconnect and grant one editable base in Airtable.</p>
			{:else}
				<DescribedSelect
					label="Airtable base"
					value={selectedBaseId}
					options={bases.map((base) => ({
						value: base.id,
						label: base.name,
						description: base.permissionLevel === 'edit' || base.permissionLevel === 'create'
							? 'JooEvents can add and update managed tables here.'
							: 'Read-only in this connection — reconnect to use this base.'
					}))}
					disabled={busy !== null}
					onchange={(value) => selectedBaseId = value}
				/>
			{/if}
			<div class="setup-divider"></div>
			<div>
				<p class="step-label">STEP 3 OF 4</p>
				<h3>Choose how each part stays connected</h3>
				<p>Use Airtable as a live team workspace only where it helps. Protected changes still wait for review in JooEvents.</p>
			</div>
			<div class="value-list setup-directions">
				{#each view.areas as area (area.key)}
					<div class="value-row">
						<div><strong>{area.label}</strong><small>{directionFact({ ...area, direction: draftDirections[area.key] ?? area.direction })}</small></div>
						<DescribedSelect
							label={`Direction for ${area.label}`}
							value={draftDirections[area.key] ?? area.direction}
							options={directionOptions}
							disabled={busy !== null}
							onchange={(direction) => draftDirections = { ...draftDirections, [area.key]: direction }}
						/>
					</div>
				{/each}
			</div>
			<div class="setup-divider"></div>
			<div class="preview-summary">
				<div><p class="step-label">STEP 4 OF 4</p><h3>Preview and add the managed tables</h3></div>
				<dl><div><dt>Connected areas</dt><dd>{selectedAreaCount}</dd></div><div><dt>Areas teammates can work from</dt><dd>{inboundAreaCount}</dd></div><div><dt>Managed tables</dt><dd>Up to 5</dd></div></dl>
				<p class="boundary">Speaker email and phone require their own explicit sharing choice. Review scores, private notes, sign-in data, roles, and credentials are never included.</p>
				<Button loading={busy === 'activate'} disabled={busy !== null || !selectedBaseWritable || selectedAreaCount === 0} onclick={activate}>Add tables and start sync</Button>
			</div>
		</section>
	{:else}
		{#if view.state === 'delayed'}
			<section class="state-banner" role="status"><strong>Airtable is behind.</strong><span>JooEvents is still current, and the base catches up by itself.</span></section>
		{:else if view.state === 'needs_reconnect'}
			<section class="state-banner" role="status"><strong>Airtable stopped accepting the connection.</strong><span>Nothing was lost. Reconnect and both sides catch up.</span><Button variant="secondary" size="sm" loading={busy === 'connect'} disabled={busy !== null} onclick={() => act('connect', () => port.connectAirtable())}>Reconnect Airtable</Button></section>
		{:else if view.state === 'catching_up'}
			<section class="state-banner" role="status"><strong>JooEvents is re-checking every shared record.</strong><span>Edits made in Airtable wait until the check finishes.</span></section>
			{:else if view.state === 'paused'}
				<section class="state-banner" role="status"><strong>This connection is paused.</strong><span>Nothing flows either way until someone resumes it.</span><Button variant="secondary" size="sm" loading={busy === 'pause'} onclick={() => act('pause', () => port.setPaused(false), 'Airtable is resuming and will catch up safely.')}>Resume</Button></section>
			{/if}
			{#if view.state === 'provisioning' && view.setupStage === 'adding_tables'}
				<section class="state-banner" role="status"><strong>JooEvents is adding the managed tables.</strong><span>It verifies the initial records before either direction becomes active.</span></section>
			{/if}

		{#if view.attention.length > 0}
			<section class="section" id="waiting">
				<div class="section-title"><h3>Waiting on you ({view.attention.length})</h3></div>
				<div class="attention-list">
					{#each view.attention as item (item.id)}
						<a href={item.href} class="attention-row"><span>{item.title}</span><strong>{item.actionLabel} →</strong></a>
					{/each}
				</div>
			</section>
		{/if}

		<section class="section" id="shared">
			<div class="section-title"><h3>What stays connected</h3><a href="?panel=shared">{panel === 'shared' ? 'Done' : "Change what's shared"}</a></div>
			{#if panel === 'shared'}<p class="sharing-explainer">Choose whether each area is view-only in Airtable, can update approved JooEvents fields, or stays disconnected. Protected changes are restored or become review requests.</p>{/if}
			<div class="value-list">
				{#each view.areas as area (area.key)}
					<div class="value-row">
						<div><strong>{area.label}</strong>{#if area.direction === 'work_from_airtable'}<small>{directionFact(area)}</small>{/if}</div>
						{#if panel === 'shared'}
							<DescribedSelect label={`Direction for ${area.label}`} value={area.direction} options={directionOptions} disabled={busy !== null} onchange={(direction) => act(`direction-${area.key}`, () => port.setAreaDirection(area.key, direction), `${area.label} sharing changed. JooEvents is checking the affected records.`)} />
						{:else}<span>{directionLabel[area.direction]}</span>{/if}
					</div>
				{/each}
			</div>
			{#if panel === 'shared'}<p class="boundary">Review scores, private notes, and sign-in or access data never go to Airtable.</p>{/if}
		</section>

		<section class="section">
			<div class="section-title"><h3>Activity</h3></div>
			<dl class="activity-list">
				<div><dt>Last change sent to Airtable</dt><dd>{view.lastOutbound ?? 'Waiting for the first change'}</dd></div>
				<div><dt>Last change received from Airtable</dt><dd>{view.lastInbound ?? 'Waiting for the first change'}</dd></div>
				<div><dt>Last full check</dt><dd>{view.lastFullCheck ?? 'Not checked yet'}{#if view.lastFullCheckSummary}<small>{view.lastFullCheckSummary}</small>{/if}</dd></div>
			</dl>
			<Button variant="secondary" loading={busy === 'sync'} disabled={busy !== null} onclick={() => act('sync', () => port.syncNow(), 'Checking with Airtable — anything out of date lands in the next few minutes.')}>Sync now</Button>
		</section>

		<section class="section" id="history">
			<div class="section-title"><h3>History</h3><nav class="history-filters" aria-label="Filter Airtable history"><a class:active={historyScope === 'all'} href="?panel=history&scope=all">All</a><a class:active={historyScope === 'airtable'} href="?panel=history&scope=airtable">From Airtable</a><a class:active={historyScope === 'refused'} href="?panel=history&scope=refused">Refused</a><a class:active={historyScope === 'connection'} href="?panel=history&scope=connection">Connection & sharing</a></nav></div>
			<div class="history-list">
				{#each filteredHistory as item (item.id)}
					{@const kind = historyKind[item.kind]}
					{@const absoluteTime = formatInstant(item.occurredAt, 'UTC', { zone: true })}
					<article class="history-row">
						<div class="history-row__meta">
							<span class="history-kind history-kind--{kind.tone}">{kind.label}</span>
							<time class="history-time" datetime={item.occurredAt} title={absoluteTime} aria-label={`${formatRelative(item.occurredAt, viewedAt)}; ${absoluteTime}`}>{formatRelative(item.occurredAt, viewedAt)}</time>
						</div>
						<p class="history-row__summary">
							{#if item.actorLabel}<strong>{item.actorLabel}</strong>{/if}
							<span>{historyAction(item)}</span>
						</p>
						{#if item.before !== undefined && item.after !== undefined}
							<dl class="change">
								<div><dt>Before</dt><dd>“{item.before}”</dd></div>
								<div class="change__after"><dt>After</dt><dd>“{item.after}”</dd></div>
							</dl>
						{/if}
						{#if item.revertLabel}<Button variant="ghost" size="sm" loading={busy === `revert-${item.id}`} onclick={() => act(`revert-${item.id}`, () => port.revertHistory(item.id), `Changed back to “${item.before}”. Airtable updates in a moment.`)}>{item.revertLabel}</Button>{/if}
					</article>
				{:else}
					<p class="quiet">No history matches this filter.</p>
				{/each}
			</div>
		</section>

		<section class="section connection">
			<div class="section-title"><h3>Connection</h3></div>
			<div class="connection-row"><p><strong>Pause</strong><span>New changes stop flowing both ways; nothing is deleted. Resume anytime.</span></p><Button variant="secondary" loading={busy === 'pause'} disabled={busy !== null} onclick={() => act('pause', () => port.setPaused(view?.state !== 'paused'), view?.state === 'paused' ? 'Airtable is resuming.' : 'Airtable is paused. Nothing was deleted.')}>{view.state === 'paused' ? 'Resume' : 'Pause'}</Button></div>
			<div class="connection-row"><p><strong>Disconnect</strong><span>The base stays in Airtable and stops updating.</span></p><Button variant="danger-quiet" loading={busy === 'disconnect'} disabled={busy !== null} onclick={() => act('disconnect', () => port.disconnect(), 'Airtable disconnected. The base is still in Airtable.')}>Disconnect</Button></div>
			{#if view.supportCode}<div class="support"><span>Support details</span><CopyValue value={view.supportCode} label="Airtable support details" /></div>{/if}
		</section>
	{/if}

	<div class="announcements" aria-live="polite">{receipt ?? ''}</div>
	{#if receipt}<p class="ui-notice ui-notice--success" role="status">{receipt}</p>{/if}
	{#if error}<p class="ui-notice ui-notice--danger" role="alert">{error}</p>{/if}
	</div>
{/if}

<style>
	.airtable-shell{min-block-size:8rem}.integrations-head h2,.airtable-head h2,.card h3,.section h3{margin:.2rem 0}.integrations-head p,.airtable-head p,.card p,.section p{color:var(--je-color-text-muted);max-inline-size:48rem}.eyebrow{font-size:var(--je-font-size-xs);font-weight:700;letter-spacing:.08em;color:var(--je-color-text-muted)}
	.integration-card,.card,.section,.state-banner{border:1px solid var(--je-color-border);border-radius:var(--je-radius-surface);background:var(--je-color-surface)}.integration-card{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:var(--je-space-5);padding:var(--je-space-5);color:inherit;text-decoration:none}.integration-card__brand{display:grid;place-items:center;inline-size:2.75rem;block-size:2.75rem;border-radius:var(--je-radius-control);background:var(--je-color-surface-sunken)}.integration-card__brand img{display:block}.integration-card:hover{border-color:var(--je-color-border-strong)}.integration-card:hover .integration-card__go{color:var(--je-color-text)}.integration-card:focus-visible{outline:none;box-shadow:var(--je-focus-ring)}.integration-card__go{display:flex;color:var(--je-color-text-muted)}.integration-card--static{grid-template-columns:auto minmax(0,1fr) auto}.integration-card--static .integration-card__brand{color:var(--je-color-text-muted)}.integration-list{display:grid;gap:var(--je-space-3)}.integration-card small,.value-row small,.activity-list small{display:block;margin-block-start:.25rem;color:var(--je-color-text-muted)}.integration-card__state{display:grid;justify-items:end;gap:var(--je-space-2)}.card-status-skeleton{inline-size:8rem;block-size:1.5rem}
		.airtable-detail{display:grid;gap:var(--je-space-5)}.airtable-head{display:flex;justify-content:space-between;align-items:start;gap:var(--je-space-4)}.head-actions{display:flex;align-items:center;gap:var(--je-space-3);flex-wrap:wrap;justify-content:end}.back{display:inline-block;margin-block-end:var(--je-space-3)}.card,.section{padding:var(--je-space-5)}.setup{display:grid;gap:var(--je-space-4)}.setup-moments{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--je-space-3)}.setup-moments span{display:flex;gap:var(--je-space-2);align-items:center;color:var(--je-color-text-muted)}.setup-moments b{display:grid;place-items:center;flex:0 0 1.75rem;block-size:1.75rem;border-radius:999px;background:var(--je-color-surface-sunken);color:var(--je-color-text)}.boundary{font-size:var(--je-font-size-sm)}
		.setup-config{gap:var(--je-space-5)}.step-label{font-size:var(--je-font-size-xs);font-weight:700;letter-spacing:.08em;margin:0;color:var(--je-color-text-muted)}.setup-divider{border-block-start:1px solid var(--je-color-border)}.setup-directions{border:1px solid var(--je-color-border);border-radius:var(--je-radius-control);padding-inline:var(--je-space-4)}.preview-summary{display:grid;gap:var(--je-space-4)}.preview-summary dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--je-space-3);margin:0}.preview-summary dl div{padding:var(--je-space-3);border-radius:var(--je-radius-control);background:var(--je-color-surface-sunken)}.preview-summary dt{color:var(--je-color-text-muted);font-size:var(--je-font-size-sm)}.preview-summary dd{margin:.25rem 0 0;font-size:var(--je-font-size-lg);font-weight:700}
	.state-banner{display:flex;align-items:center;gap:var(--je-space-3);padding:var(--je-space-4);border-color:color-mix(in srgb,var(--je-color-warning-fill) 38%,transparent);background:linear-gradient(var(--je-color-warning-soft),var(--je-color-warning-soft)),var(--je-color-surface)}.state-banner span{color:var(--je-color-text-muted)}.state-banner :global(.ui-button){margin-inline-start:auto}.section-title{display:flex;align-items:center;justify-content:space-between;gap:var(--je-space-4);margin-block-end:var(--je-space-3)}.attention-list,.value-list,.history-list{display:grid}.attention-row,.value-row,.history-row{border-block-start:1px solid var(--je-color-border);padding-block:var(--je-space-3)}.attention-row:first-child,.value-row:first-child,.history-row:first-child{border-block-start:0}.attention-row{display:flex;justify-content:space-between;gap:var(--je-space-4);color:inherit;text-decoration:none}.attention-row strong{color:var(--je-color-link)}.value-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(14rem,20rem);align-items:center;gap:var(--je-space-4)}.value-row>span{text-align:end;color:var(--je-color-text-muted)}
	.activity-list{display:grid;margin:0 0 var(--je-space-4)}.activity-list div{display:grid;grid-template-columns:minmax(12rem,1fr) minmax(12rem,1fr);gap:var(--je-space-4);padding-block:var(--je-space-2);border-block-start:1px solid var(--je-color-border)}.activity-list div:first-child{border-block-start:0}.activity-list dt{color:var(--je-color-text-muted)}.activity-list dd{margin:0}.history-filters{display:flex;flex-wrap:wrap;gap:var(--je-space-3);font-size:var(--je-font-size-sm)}.history-filters a{color:var(--je-color-text-muted)}.history-filters a.active{color:var(--je-color-text);font-weight:700}.history-row{display:grid;gap:var(--je-space-3)}.history-row__meta{display:flex;align-items:baseline;justify-content:space-between;gap:var(--je-space-4)}.history-kind{font-size:var(--je-font-size-xs);font-weight:700;letter-spacing:.07em;text-transform:uppercase}.history-kind--applied{color:var(--je-color-info)}.history-kind--refused{color:var(--je-color-warning)}.history-kind--sharing{color:var(--je-color-success)}.history-kind--connection{color:var(--je-color-text-muted)}.history-time{color:var(--je-color-text-subtle);font-size:var(--je-font-size-sm);font-variant-numeric:tabular-nums;white-space:nowrap}.history-row__summary{display:flex;flex-wrap:wrap;gap:.28rem;margin:0;color:var(--je-color-text)}.history-row__summary strong{font-weight:700}.change{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:0;overflow:hidden;border:1px solid var(--je-color-border);border-radius:var(--je-radius-control);background:var(--je-color-surface-sunken);font-size:var(--je-font-size-sm)}.change div{padding:var(--je-space-3)}.change__after{border-inline-start:1px solid var(--je-color-border)}.change dt{color:var(--je-color-text-subtle);font-size:var(--je-font-size-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase}.change dd{margin:.2rem 0 0;color:var(--je-color-text)}.change__after dd{font-weight:700}.quiet{color:var(--je-color-text-muted)}
	.connection-row{display:flex;align-items:center;justify-content:space-between;gap:var(--je-space-5);padding-block:var(--je-space-3);border-block-start:1px solid var(--je-color-border)}.connection-row p{display:grid;gap:.2rem;margin:0}.support{display:flex;align-items:center;gap:var(--je-space-3);padding-block-start:var(--je-space-3);border-block-start:1px solid var(--je-color-border);color:var(--je-color-text-muted)}.skeleton-title,.skeleton-line{display:block}.skeleton-title{inline-size:18rem;block-size:2rem}.skeleton-line{inline-size:min(36rem,90%);block-size:1rem;margin-block-start:1rem}.announcements{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}
		@media(max-width:920px){.airtable-detail{gap:var(--je-space-4)}.airtable-head,.state-banner,.section-title,.connection-row{align-items:stretch;display:grid}.head-actions{justify-content:start}.integration-card{grid-template-columns:auto minmax(0,1fr) auto}.integration-card__state{grid-column:2;justify-items:start}.setup-moments,.preview-summary dl{grid-template-columns:1fr}.value-row,.activity-list div{grid-template-columns:1fr}.value-row>span{text-align:start}.section,.card{padding:var(--je-space-4)}.attention-row{align-items:start}.history-filters{gap:var(--je-space-2) var(--je-space-3)}.state-banner :global(.ui-button){margin-inline-start:0;inline-size:fit-content}.connection-row :global(.ui-button){min-block-size:44px;inline-size:fit-content}}
	@media(max-width:560px){.change{grid-template-columns:1fr}.change__after{border-block-start:1px solid var(--je-color-border);border-inline-start:0}}
</style>
