<script lang="ts">
	import { onMount } from 'svelte';
	import type { AgentActionBatchStatus, AgentActionBatchView, AgentActionStepStatus } from '@jooevents/contracts';
	import { Badge, Button } from '$lib/ui';
	import type { AgentActionCommandResult, AgentActionsPagePort } from '$lib/api/agent-actions-page-port';

	let { port }: { readonly port: AgentActionsPagePort } = $props();
	let batches = $state<readonly AgentActionBatchView[] | null>(null);
	let selectedId = $state('');
	let message = $state('');
	let pending = $state(false);

	const selected = $derived(batches?.find((batch) => batch.plan.batchId === selectedId) ?? batches?.[0] ?? null);
	const completed = $derived(selected?.steps.filter((step) => step.status === 'succeeded').length ?? 0);
	const activeOrdinal = $derived(selected?.steps.find((step) => !['succeeded', 'cancelled'].includes(step.status))?.ordinal ?? null);

	const batchLabel: Record<AgentActionBatchStatus, string> = {
		awaiting_approval: 'Awaiting approval', rejected: 'Rejected', queued: 'Queued', running: 'Running',
		paused: 'Paused', cancel_requested: 'Cancelling', cancelled: 'Cancelled', failed: 'Failed', succeeded: 'Completed'
	};
	const stepLabel: Record<AgentActionStepStatus, string> = {
		pending: 'Pending', running: 'Running', waiting_external: 'Waiting for provider', needs_attention: 'Needs attention',
		cancelled: 'Cancelled', succeeded: 'Completed'
	};
	function tone(status: AgentActionBatchStatus | AgentActionStepStatus): 'positive' | 'caution' | 'negative' | 'info' | 'neutral' {
		if (status === 'succeeded') return 'positive';
		if (status === 'paused' || status === 'needs_attention' || status === 'waiting_external') return 'caution';
		if (status === 'failed' || status === 'rejected' || status === 'cancel_requested') return 'negative';
		if (status === 'queued' || status === 'running') return 'info';
		return 'neutral';
	}

	function shortId(value: string) { return `${value.slice(0, 8)}…${value.slice(-4)}`; }
	function dateTime(value: string) {
		return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
	}

	async function load() {
		try {
			const next = await port.list();
			batches = next;
			if (!selectedId && next[0]) selectedId = next[0].plan.batchId;
			message = '';
		} catch (error) {
			message = error instanceof Error ? error.message : 'The action-run directory could not be loaded.';
			batches = [];
		}
	}

	function replace(updated: AgentActionBatchView) {
		batches = (batches ?? []).map((batch) => batch.plan.batchId === updated.plan.batchId ? updated : batch);
	}
	async function run(command: () => Promise<AgentActionCommandResult>) {
		if (pending) return;
		pending = true;
		message = '';
		const result = await command();
		pending = false;
		if (result.kind === 'success') replace(result.data);
		else message = result.message;
	}

	onMount(() => {
		void load();
		if (port.source.kind !== 'live') return;
		const timer = window.setInterval(async () => {
			if (!selectedId || pending) return;
			try {
				const current = await port.inspect(selectedId);
				if (current) replace(current);
			} catch { /* The visible current state remains until an explicit retry. */ }
		}, 3_000);
		return () => window.clearInterval(timer);
	});
</script>

<section class="actions" aria-labelledby="action-runs-heading">
	<header class="actions__head">
		<div>
			<h2 id="action-runs-heading">Agent action runs</h2>
			<p>Review the complete plan before it changes event state. Completed steps remain applied. Cancel stops the remaining steps.</p>
		</div>
		<Button variant="secondary" size="sm" onclick={() => void load()}>Refresh</Button>
	</header>

	{#if message}
		<p class="actions__message" role="alert">{message}</p>
	{/if}

	{#if batches === null}
		<div class="actions__loading" role="status" aria-label="Loading action runs">
			<span class="ui-skeleton actions__loading-list"></span>
			<span class="ui-skeleton actions__loading-detail"></span>
		</div>
	{:else if batches.length === 0}
		<div class="actions__empty">
			<h3>No action runs need attention</h3>
			<p>Plans submitted by an external tool or the in-app assistant will appear here before anything runs.</p>
		</div>
	{:else}
		<div class="actions__workspace">
			<nav class="actions__directory" aria-label="Action runs">
				{#each batches as batch (batch.plan.batchId)}
					<button
						type="button"
						class="run-row"
						class:run-row--selected={selected?.plan.batchId === batch.plan.batchId}
						onclick={() => (selectedId = batch.plan.batchId)}>
						<span class="run-row__top">
							<strong>{batch.plan.intent}</strong>
							<Badge value={batchLabel[batch.status]} tone={tone(batch.status)} />
						</span>
						<span class="run-row__meta">{batch.steps.filter((step) => step.status === 'succeeded').length} of {batch.steps.length} completed · {shortId(batch.plan.batchId)}</span>
					</button>
				{/each}
			</nav>

			{#if selected}
				<article class="actions__detail" aria-labelledby="selected-plan-heading">
					<header class="detail-head">
						<div>
							<p class="detail-head__eyebrow">{selected.plan.source.surface === 'external_mcp' ? 'External MCP plan' : 'Assistant plan'} · {selected.plan.source.clientKey}</p>
							<h3 id="selected-plan-heading">{selected.plan.intent}</h3>
						</div>
						<Badge value={batchLabel[selected.status]} tone={tone(selected.status)} />
					</header>

					{#if completed > 0 && selected.status !== 'succeeded'}
						<p class="partial" role="status">
							{completed} of {selected.steps.length} completed{activeOrdinal ? ` · ${selected.status === 'paused' ? 'paused' : 'stopped'} at step ${activeOrdinal}` : ''}.
							Completed steps remain applied. Cancel stops the remaining steps.
						</p>
					{/if}

					<dl class="facts">
						<div><dt>Plan</dt><dd>{shortId(selected.plan.batchId)}</dd></div>
						<div><dt>Expires</dt><dd>{dateTime(selected.plan.bounds.expiresAt)}</dd></div>
						<div><dt>Maximum actions</dt><dd>{selected.plan.bounds.maximumActions}</dd></div>
						<div><dt>Operation versions</dt><dd>{selected.plan.bounds.allowedOperationIdentities.join(', ')}</dd></div>
						{#if selected.plan.bounds.maximumSpendMinor !== undefined}
							<div><dt>Maximum spend</dt><dd>{selected.plan.bounds.maximumSpendMinor} minor units</dd></div>
						{/if}
					</dl>

					<ol class="steps">
						{#each selected.steps as step (step.id)}
							<li class="step">
								<span class="step__ordinal" aria-hidden="true">{step.ordinal}</span>
								<div class="step__body">
									<span class="step__head"><strong>{step.displayLabel}</strong><Badge value={stepLabel[step.status]} tone={tone(step.status)} /></span>
									<p>{step.operationName}@{step.operationVersion}</p>
									{#each step.consequences as consequence}<p class="step__consequence">{consequence}</p>{/each}
									{#if step.lastSafeOutcome}<p class="step__outcome">Execution paused safely. Review current event state before resuming or correcting forward.</p>{/if}
								</div>
							</li>
						{/each}
					</ol>

					<div class="actions__controls">
						{#if selected.status === 'awaiting_approval'}
							<Button loading={pending} onclick={() => void run(() => port.approve({ batchId: selected.plan.batchId, expectedVersion: selected.version, expectedPlanDigestSha256: selected.planDigestSha256 }))}>Approve and run {selected.steps.length} steps</Button>
						{:else if selected.status === 'paused'}
							<Button loading={pending} onclick={() => void run(() => port.resume({ batchId: selected.plan.batchId, expectedVersion: selected.version }))}>Resume remaining steps</Button>
						{:else if selected.status === 'queued' || selected.status === 'running'}
							<Button variant="secondary" loading={pending} onclick={() => void run(() => port.pause({ batchId: selected.plan.batchId, expectedVersion: selected.version }))}>Pause at safe boundary</Button>
						{/if}
						{#if ['awaiting_approval', 'queued', 'running', 'paused', 'cancel_requested'].includes(selected.status)}
							<Button variant="danger-quiet" loading={pending} onclick={() => void run(() => port.cancel({ batchId: selected.plan.batchId, expectedVersion: selected.version }))}>Cancel remaining steps</Button>
						{/if}
					</div>
				</article>
			{/if}
		</div>
	{/if}
</section>

<style>
	.actions { display: grid; gap: var(--je-space-5); min-inline-size: 0; }
	.actions__head { display: flex; justify-content: space-between; align-items: start; gap: var(--je-space-4); }
	.actions__head h2, .detail-head h3, .actions__empty h3 { margin: 0; }
	.actions__head p, .actions__empty p { max-inline-size: 44rem; margin: var(--je-space-2) 0 0; color: var(--je-color-text-muted); }
	.actions__message { margin: 0; padding: var(--je-space-3); border: 1px solid var(--je-color-danger); border-radius: var(--je-radius-control); background: var(--je-color-danger-soft); color: var(--je-color-text); }
	.actions__loading, .actions__workspace { display: grid; grid-template-columns: minmax(15rem, 0.72fr) minmax(0, 1.6fr); gap: var(--je-space-4); min-block-size: 32rem; }
	.actions__loading span { display: block; border-radius: var(--je-radius-surface); }
	.actions__empty { min-block-size: 20rem; display: grid; place-content: center; text-align: center; padding: var(--je-space-6); border: 1px solid var(--je-color-border); border-radius: var(--je-radius-surface); background: var(--je-color-surface); }
	.actions__directory { display: grid; align-content: start; gap: var(--je-space-2); min-inline-size: 0; }
	.run-row { display: grid; gap: var(--je-space-2); inline-size: 100%; min-block-size: 3rem; padding: var(--je-space-3); border: 1px solid var(--je-color-border); border-radius: var(--je-radius-control); background: var(--je-color-surface); color: var(--je-color-text); text-align: start; cursor: pointer; }
	.run-row:hover { border-color: var(--je-color-border-strong); }
	.run-row:focus-visible { outline: var(--je-focus-ring); outline-offset: 2px; }
	.run-row--selected { border-color: var(--je-color-action); box-shadow: inset 3px 0 0 var(--je-color-action); }
	.run-row__top, .step__head { display: flex; justify-content: space-between; align-items: start; gap: var(--je-space-2); }
	.run-row__top strong { min-inline-size: 0; overflow-wrap: anywhere; }
	.run-row__meta, .detail-head__eyebrow, .step__body > p { color: var(--je-color-text-muted); font-size: var(--je-font-size-sm); }
	.actions__detail { display: grid; align-content: start; gap: var(--je-space-5); min-inline-size: 0; padding: var(--je-space-5); border: 1px solid var(--je-color-border); border-radius: var(--je-radius-surface); background: var(--je-color-surface); }
	.detail-head { display: flex; justify-content: space-between; align-items: start; gap: var(--je-space-4); }
	.detail-head__eyebrow { margin: 0 0 var(--je-space-1); }
	.partial { margin: 0; padding: var(--je-space-3); border-inline-start: 3px solid var(--je-color-warning); background: var(--je-color-warning-soft); }
	.facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--je-space-3); margin: 0; }
	.facts div { min-inline-size: 0; }
	.facts dt { color: var(--je-color-text-muted); font-size: var(--je-font-size-sm); }
	.facts dd { margin: var(--je-space-1) 0 0; overflow-wrap: anywhere; }
	.steps { display: grid; gap: var(--je-space-3); margin: 0; padding: 0; list-style: none; }
	.step { display: grid; grid-template-columns: 2rem minmax(0, 1fr); gap: var(--je-space-3); padding-block: var(--je-space-3); border-block-start: 1px solid var(--je-color-border); }
	.step__ordinal { display: grid; place-items: center; inline-size: 2rem; block-size: 2rem; border-radius: 999px; background: var(--je-color-surface-sunken); font-weight: 700; }
	.step__body { min-inline-size: 0; }
	.step__body > p { margin: var(--je-space-1) 0 0; }
	.step__consequence { color: var(--je-color-text) !important; }
	.step__outcome { padding: var(--je-space-2); background: var(--je-color-warning-soft); }
	.actions__controls { display: flex; flex-wrap: wrap; gap: var(--je-space-2); }
	@media (max-width: 720px) {
		.actions__head, .detail-head { align-items: stretch; flex-direction: column; }
		.actions__workspace, .actions__loading { grid-template-columns: minmax(0, 1fr); min-block-size: 0; }
		.actions__directory { grid-template-columns: minmax(0, 1fr); }
		.actions__detail { padding: var(--je-space-4); }
		.facts { grid-template-columns: minmax(0, 1fr); }
		.actions__controls :global(.ui-button) { inline-size: 100%; }
	}
</style>
