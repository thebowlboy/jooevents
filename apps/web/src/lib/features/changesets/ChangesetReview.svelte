<script lang="ts">
	import { Alert, Badge, Button, CopyValue } from '$lib/ui';
	import type {
		ChangesetCommitView,
		ChangesetDiffView,
		ChangesetReviewEffectInput,
		ChangesetReviewResult
	} from '$lib/api/changesets/port';
	import type { ChangesetRevisionSelector } from '@jooevents/contracts';
	import {
		changesetOutcomeCopy,
		changesetTransportCopy,
		changesetUnavailableCopy,
		type ChangesetReviewFailureCopy
	} from './copy';
	import type {
		ChangesetReviewEffectAction,
		ChangesetReviewProps
	} from './types';

	let {
		port,
		selector,
		title = 'Review changes',
		idempotencyKeyFactory,
		operationDetail,
		onCommitted
	}: ChangesetReviewProps = $props();

	const uid = $props.id();
	let diff = $state<ChangesetDiffView | null>(null);
	let commit = $state<ChangesetCommitView | null>(null);
	let busy = $state<'diff' | ChangesetReviewEffectAction | null>(null);
	let failure = $state<ChangesetReviewFailureCopy | null>(null);
	let confirmation = $state<string | null>(null);
	let controller: AbortController | null = null;
	let requestEpoch = 0;
	const effectKeys = new Map<string, string>();

	const stage = $derived(
		commit || diff?.status.value === 'committed'
			? 3
			: diff?.status.value === 'proposed'
				? 2
				: diff
					? 1
					: 0
	);

	function selectorSnapshot(value: ChangesetRevisionSelector): ChangesetRevisionSelector {
		return {
			changesetId: value.changesetId,
			revisionId: value.revisionId,
			revisionDigest: value.revisionDigest
		};
	}

	function setFailure<Data>(result: Exclude<ChangesetReviewResult<Data>, { readonly kind: 'success' }>) {
		confirmation = null;
		failure = result.kind === 'outcome'
			? changesetOutcomeCopy(result.outcome, result.correlationId)
			: result.kind === 'transport_error'
				? changesetTransportCopy(result.error)
				: changesetUnavailableCopy(result.operation);
	}

	function newController(): { readonly controller: AbortController; readonly epoch: number } {
		controller?.abort();
		controller = new AbortController();
		return { controller, epoch: ++requestEpoch };
	}

	async function loadDiff(selected: ChangesetRevisionSelector) {
		const request = newController();
		busy = 'diff';
		failure = null;
		confirmation = null;
		try {
			const result = await port.readDiff(selected, { signal: request.controller.signal });
			if (request.epoch !== requestEpoch || request.controller.signal.aborted) return;
			if (result.kind === 'success') diff = result.data;
			else setFailure(result);
		} catch {
			if (!request.controller.signal.aborted) {
				failure = changesetTransportCopy({ code: 'network_unavailable', retryable: true });
			}
		} finally {
			if (request.epoch === requestEpoch) busy = null;
		}
	}

	function effectInput(review: ChangesetDiffView): ChangesetReviewEffectInput {
		return { ...review.selector, expectedHeadVersion: review.headVersion };
	}

	function effectKey(action: ChangesetReviewEffectAction, request: ChangesetReviewEffectInput): string {
		const slot = [
			action,
			request.changesetId,
			request.revisionId,
			request.revisionDigest,
			request.expectedHeadVersion
		].join(':');
		const existing = effectKeys.get(slot);
		if (existing) return existing;
		const created = idempotencyKeyFactory?.({ action, request })
			?? `changeset-review-${action}-${crypto.randomUUID()}`;
		effectKeys.set(slot, created);
		return created;
	}

	async function propose() {
		if (!diff || diff.status.value !== 'draft' || busy) return;
		const requestBody = effectInput(diff);
		const request = newController();
		busy = 'propose';
		failure = null;
		confirmation = null;
		try {
			const result = await port.propose(
				requestBody,
				effectKey('propose', requestBody),
				{ signal: request.controller.signal }
			);
			if (request.epoch !== requestEpoch || request.controller.signal.aborted) return;
			if (result.kind === 'success') {
				diff = result.data;
				confirmation = 'The exact revision is now proposed and ready for its permitted next step.';
			} else setFailure(result);
		} catch {
			if (!request.controller.signal.aborted) {
				failure = changesetTransportCopy({ code: 'network_unavailable', retryable: true });
			}
		} finally {
			if (request.epoch === requestEpoch) busy = null;
		}
	}

	async function commitChanges() {
		if (!diff || diff.status.value !== 'proposed'
			|| diff.approval.requirement !== 'none' || busy) return;
		const requestBody = effectInput(diff);
		const request = newController();
		busy = 'commit';
		failure = null;
		confirmation = null;
		try {
			const result = await port.commit(
				requestBody,
				effectKey('commit', requestBody),
				{ signal: request.controller.signal }
			);
			if (request.epoch !== requestEpoch || request.controller.signal.aborted) return;
			if (result.kind === 'success') {
				commit = result.data;
				confirmation = 'Changes committed.';
				onCommitted?.({
					commit: result.data,
					...(result.receipt ? { receipt: result.receipt } : {}),
					...(result.correlationId ? { correlationId: result.correlationId } : {})
				});
			} else setFailure(result);
		} catch {
			if (!request.controller.signal.aborted) {
				failure = changesetTransportCopy({ code: 'network_unavailable', retryable: true });
			}
		} finally {
			if (request.epoch === requestEpoch) busy = null;
		}
	}

	function refresh() {
		void loadDiff(selectorSnapshot(selector));
	}

	$effect(() => {
		port;
		const selected = selectorSnapshot(selector);
		selected.changesetId;
		selected.revisionId;
		selected.revisionDigest;
		diff = null;
		commit = null;
		failure = null;
		confirmation = null;
		effectKeys.clear();
		void loadDiff(selected);
		return () => {
			controller?.abort();
			requestEpoch += 1;
		};
	});
</script>

<section class="review" aria-labelledby="{uid}-title" aria-busy={busy !== null}>
	<header class="review__header">
		<div class="review__heading">
			<h2 id="{uid}-title">{title}</h2>
			<p>Revision {diff?.revisionNumber ?? '—'} · {diff?.operationCount ?? '—'} {diff?.operationCount === 1 ? 'change' : 'changes'}</p>
		</div>
		{#if diff}
			<Badge tone={diff.status.tone}>{diff.status.label}</Badge>
		{:else}
			<span class="ui-skeleton status-skeleton" aria-hidden="true"></span>
		{/if}
	</header>

	<ol class="stages" aria-label="Changeset progress">
		{#each ['Draft', 'Diff', 'Proposed', 'Committed'] as label, index}
			<li class:stages__step--complete={stage > index} class:stages__step--current={stage === index} aria-current={stage === index ? 'step' : undefined}>
				<span aria-hidden="true">{index + 1}</span>{label}
			</li>
		{/each}
	</ol>

	{#if busy === 'diff' && !diff}
		<div class="diff diff--loading" aria-label="Loading changeset diff">
			<div class="diff__summary">
				<span class="ui-skeleton line line--wide" aria-hidden="true"></span>
				<span class="ui-skeleton line line--short" aria-hidden="true"></span>
			</div>
			<div class="group-skeleton">
				<span class="ui-skeleton line line--medium" aria-hidden="true"></span>
				<span class="ui-skeleton code-skeleton" aria-hidden="true"></span>
			</div>
		</div>
	{:else if diff}
		<div class="diff">
			<header class="diff__summary">
				<div>
					<h3>Exact revision diff</h3>
					<p>{diff.approval.label}. Dependency groups apply together.</p>
				</div>
				<Badge tone={diff.risk.tone}>{diff.risk.label}</Badge>
			</header>

			<div class="groups">
				{#each diff.groups as group (group.key)}
					<section class="group" aria-labelledby="{uid}-group-{group.key}">
						<header class="group__header">
							<div>
								<h4 id="{uid}-group-{group.key}">{group.label}</h4>
								<p>{group.operations.length} {group.operations.length === 1 ? 'operation' : 'operations'} · applied together</p>
							</div>
							<Badge tone={group.risk.tone}>{group.risk.label}</Badge>
						</header>

						{#if group.consequenceLabels.length > 0}
							<div class="consequences">
								<span>Consequences</span>
								<ul>
									{#each group.consequenceLabels as consequence}
										<li>{consequence}</li>
									{/each}
								</ul>
							</div>
						{/if}

						<div class="operations">
							{#each group.operations as operation (operation.key)}
								<details open={diff.operationCount === 1}>
									<summary>
										<span>{operation.kindLabel}</span>
										<span class="operation-version">v{operation.version}</span>
									</summary>
									{#if operationDetail}
										<div class="operation-detail">{@render operationDetail(operation)}</div>
										<details class="structured-detail">
											<summary>Structured details</summary>
											<pre aria-label={`Safe structured diff for ${operation.kindLabel}`}><code>{operation.safeDiffText}</code></pre>
										</details>
									{:else}
										<pre aria-label={`Safe structured diff for ${operation.kindLabel}`}><code>{operation.safeDiffText}</code></pre>
									{/if}
								</details>
							{/each}
						</div>
					</section>
				{/each}
			</div>
		</div>
	{/if}

	{#if failure}
		<div class="feedback">
			<Alert title={failure.title} message={failure.message} tone="danger" />
			{#if failure.correlationId}
				<p class="support-code">Support code <CopyValue value={failure.correlationId} label="support code" /></p>
			{/if}
		</div>
	{:else if confirmation}
		<p class="confirmation" role="status">{confirmation}</p>
	{/if}

	<footer class="actions">
		{#if !diff}
			<Button onclick={refresh} loading={busy === 'diff'}>Retry review</Button>
		{:else if diff.status.value === 'draft'}
			<Button onclick={propose} loading={busy === 'propose'} disabled={busy !== null}>Propose for review</Button>
		{:else if diff.status.value === 'proposed'}
			<Button
				onclick={commitChanges}
				loading={busy === 'commit'}
				disabled={busy !== null || diff.approval.requirement !== 'none'}
				aria-describedby={diff.approval.requirement !== 'none' ? `${uid}-approval-note` : undefined}
			>Commit changes</Button>
			{#if diff.approval.requirement !== 'none'}
				<p id="{uid}-approval-note">A separate authorized person must approve this exact revision. Approval is not available on this surface.</p>
			{/if}
		{:else if diff.status.value === 'committed' || commit}
			<p class="terminal">This exact revision has been committed.</p>
		{:else}
			<p class="terminal">This draft was discarded. No effective state was changed here.</p>
		{/if}
		{#if diff && failure}
			<Button variant="secondary" onclick={refresh} loading={busy === 'diff'} disabled={busy !== null}>Reload diff</Button>
		{/if}
	</footer>
</section>

<style>
	.review {
		display: grid;
		gap: var(--je-space-4);
		min-block-size: 24rem;
		padding: var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-xs);
		color: var(--je-color-text);
	}

	.review__header,
	.diff__summary,
	.group__header,
	.actions {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--je-space-3);
	}

	.review__heading h2,
	.diff__summary h3,
	.group__header h4 {
		margin: 0;
		font-family: var(--je-font-body);
		line-height: var(--je-leading-tight);
	}

	.review__heading h2 { font-size: var(--je-font-size-lg); }
	.diff__summary h3 { font-size: var(--je-font-size-md); }
	.group__header h4 { font-size: var(--je-font-size-base); }

	.review__heading p,
	.diff__summary p,
	.group__header p,
	.actions p,
	.terminal {
		margin: var(--je-space-1) 0 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.status-skeleton {
		inline-size: 5rem;
		block-size: 1.5rem;
		border-radius: var(--je-radius-round);
	}

	.stages {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.stages li {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-inline-size: 0;
		padding-block: var(--je-space-2);
		border-block-end: 2px solid var(--je-color-border);
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.stages li span {
		display: inline-grid;
		place-items: center;
		inline-size: 1.25rem;
		block-size: 1.25rem;
		flex: 0 0 auto;
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-round);
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
	}

	.stages__step--complete,
	.stages__step--current {
		border-color: var(--je-color-mark-border) !important;
		color: var(--je-color-text) !important;
	}

	.stages__step--complete span,
	.stages__step--current span {
		border-color: var(--je-color-mark-border) !important;
		background: var(--je-color-mark-surface);
		color: var(--je-color-mark-ink);
	}

	.diff,
	.diff--loading {
		display: grid;
		gap: var(--je-space-4);
		min-block-size: 14rem;
	}

	.groups,
	.operations,
	.group-skeleton {
		display: grid;
		gap: var(--je-space-3);
	}

	.group {
		display: grid;
		gap: var(--je-space-3);
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-page);
	}

	.consequences {
		display: grid;
		gap: var(--je-space-2);
	}

	.consequences > span {
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		letter-spacing: var(--je-tracking-caps);
		text-transform: uppercase;
	}

	.consequences ul {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.consequences li {
		padding: var(--je-space-1) var(--je-space-2);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-round);
		background: var(--je-color-surface);
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-xs);
	}

	details {
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface);
	}

	summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-3);
		min-block-size: var(--je-control-height-sm);
		padding: var(--je-space-2) var(--je-space-3);
		cursor: pointer;
		font-weight: 600;
	}

	summary:hover { background: var(--je-color-action-soft); }
	summary:focus-visible { outline: none; box-shadow: var(--je-focus-ring); }

	.operation-version {
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
		font-weight: 400;
	}

	pre {
		max-block-size: 22rem;
		margin: 0;
		padding: var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border);
		border-end-start-radius: var(--je-radius-control);
		border-end-end-radius: var(--je-radius-control);
		background: var(--je-color-code-surface);
		color: var(--je-color-code-text);
		font-family: var(--je-font-mono);
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-normal);
		white-space: pre-wrap;
		overflow: auto;
		overflow-wrap: anywhere;
	}

	.operation-detail {
		padding: var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border);
	}

	.structured-detail {
		border: 0;
		border-block-start: 1px solid var(--je-color-border-subtle);
		border-radius: 0;
		background: var(--je-color-surface-sunken);
	}

	.structured-detail > summary {
		min-block-size: var(--je-control-height-sm);
		font-size: var(--je-font-size-sm);
		font-weight: 500;
	}

	.feedback {
		display: grid;
		gap: var(--je-space-2);
	}

	.support-code,
	.confirmation {
		margin: 0;
		font-size: var(--je-font-size-sm);
	}

	.support-code { color: var(--je-color-text-muted); }
	.confirmation { color: var(--je-color-success); }

	.actions {
		align-items: center;
		justify-content: flex-start;
		flex-wrap: wrap;
		padding-block-start: var(--je-space-2);
		border-block-start: 1px solid var(--je-color-border-subtle);
	}

	.actions p {
		max-inline-size: 38rem;
		margin: 0;
	}

	.line { block-size: 1lh; }
	.line--wide { inline-size: min(28rem, 75%); }
	.line--medium { inline-size: min(18rem, 55%); }
	.line--short { inline-size: min(12rem, 35%); }
	.code-skeleton { min-block-size: 8rem; border-radius: var(--je-radius-control); }

	@media (max-width: 620px) {
		.review { padding: var(--je-space-3); }
		.stages { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.review__header,
		.diff__summary,
		.group__header,
		.actions { align-items: stretch; flex-direction: column; }
		.actions :global(.ui-button) { inline-size: 100%; }
	}
</style>
