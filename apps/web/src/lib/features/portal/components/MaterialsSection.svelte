<script lang="ts">
	/**
	 * One engagement's materials: what the organizers asked for, what you have
	 * sent, and what they shared with you.
	 *
	 * Honesty rules this section. A file states its scan state plainly ("not
	 * virus-scanned") instead of wearing a safety badge; an ask whose deadline
	 * the portal cannot date yet says so; a refusal is one reviewed sentence,
	 * never a server identifier. Uploads keep the chosen file through a
	 * failure, so "Try again" means exactly that.
	 */
	import { PENDING_MIN_VISIBLE_MS, Progress, trackPending } from '$lib/ui';
	import type { FileLinkProvider } from '@jooevents/contracts/files';
	import { usePortalFilesPort, type UploadSourceFile } from '$lib/api/files/portal-files-port';
	import type { PortalFilesRefusalReason } from '$lib/api/files/portal-files-port';
	import {
		FILE_UPLOAD_ACCEPT,
		FILE_UPLOAD_TYPES_LABEL,
		SPEAKER_UPLOAD_MAXIMUM_LABEL,
		type PortalMaterialsView,
		type PortalFileRequestView
	} from '$lib/api/files/view-models';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { materialsCopy, materialsRefusalSentence, materialsScanLabel } from '../materials-copy';
	import RefusalNote from './RefusalNote.svelte';

	let { engagementId }: { engagementId: string } = $props();

	const port = usePortalFilesPort();

	let view = $state<PortalMaterialsView | null>(null);
	let failed = $state(false);
	let reloading = $state(false);
	let request = 0;

	const waiting = trackPending(() => view === null && !failed, {
		minVisibleMs: PENDING_MIN_VISIBLE_MS
	});

	async function read(): Promise<void> {
		const ticket = (request += 1);
		try {
			const next = await port.materials(engagementId);
			if (ticket !== request) return;
			view = next;
			failed = false;
		} catch {
			if (ticket !== request) return;
			failed = view === null;
		}
	}

	async function reload(): Promise<void> {
		reloading = true;
		try {
			await read();
		} finally {
			reloading = false;
		}
	}

	$effect(() => {
		void engagementId;
		void read();
	});

	// ------------------------------------------------------------------
	// Upload
	// ------------------------------------------------------------------

	let fileInput = $state<HTMLInputElement | null>(null);
	let busy = $state<'upload' | 'link' | null>(null);
	let progressPct = $state(0);
	let refusal = $state('');
	let notice = $state('');
	/** The failed attempt, kept so "Try again" retries the same file and ask. */
	let retryable = $state<{
		readonly file: UploadSourceFile;
		readonly request: { readonly id: string; readonly version: number } | null;
	} | null>(null);
	let pickTarget: { readonly id: string; readonly version: number } | null = null;

	const RETRYABLE_REASONS: readonly PortalFilesRefusalReason[] = [
		'upload_interrupted',
		'hash_mismatch',
		'intent_expired',
		'request_unconfirmed'
	];

	function pickFor(target: PortalFileRequestView | null): void {
		if (busy !== null) return;
		pickTarget = target ? { id: target.id, version: target.version } : null;
		fileInput?.click();
	}

	async function runUpload(
		file: UploadSourceFile,
		target: { readonly id: string; readonly version: number } | null
	): Promise<void> {
		busy = 'upload';
		refusal = '';
		notice = '';
		progressPct = 0;
		const outcome = await port.upload({
			engagementId,
			file,
			...(target ? { request: target } : {}),
			onProgress: (progress) => {
				progressPct = progress.totalBytes === 0
					? 0
					: Math.round((progress.transferredBytes / progress.totalBytes) * 100);
			}
		});
		busy = null;
		if (!outcome.ok) {
			refusal = materialsRefusalSentence(outcome.reason);
			retryable = RETRYABLE_REASONS.includes(outcome.reason) ? { file, request: target } : null;
			return;
		}
		retryable = null;
		notice = outcome.data.requestFulfilled
			? materialsCopy.uploaded(file.name)
			: materialsCopy.uploadedButRequestOpen(file.name);
		recordAction({
			label: materialsCopy.uploaded(file.name),
			area: 'Portal',
			notUndoableReason: 'The organizers can see it now. Ask them if it needs removing.'
		});
		await reload();
	}

	async function onFilePicked(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const picked = input.files?.[0];
		input.value = '';
		if (!picked || busy !== null) return;
		await runUpload(
			{ name: picked.name, type: picked.type, size: picked.size, blob: picked },
			pickTarget
		);
	}

	async function retry(): Promise<void> {
		const attempt = retryable;
		if (!attempt || busy !== null) return;
		await runUpload(attempt.file, attempt.request);
	}

	// ------------------------------------------------------------------
	// Link attach
	// ------------------------------------------------------------------

	let linkOpen = $state(false);
	let linkProvider = $state<FileLinkProvider>('drive');
	let linkLabel = $state('');
	let linkUrl = $state('');
	let linkError = $state('');

	async function submitLink(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy !== null) return;
		const label = linkLabel.trim().replace(/\s+/gu, ' ');
		const url = linkUrl.trim();
		if (!label) {
			linkError = 'Give the link a name the organizers will recognize.';
			return;
		}
		if (!url.startsWith('https://')) {
			linkError = 'The link must start with https://';
			return;
		}
		linkError = '';
		busy = 'link';
		refusal = '';
		notice = '';
		// A link never settles an ask by side effect: only an upload started
		// from the ask's own button marks it done.
		const outcome = await port.attachLink({
			engagementId,
			provider: linkProvider,
			label,
			url
		});
		busy = null;
		if (!outcome.ok) {
			refusal = materialsRefusalSentence(outcome.reason);
			return;
		}
		notice = materialsCopy.linked(label);
		recordAction({
			label: materialsCopy.linked(label),
			area: 'Portal',
			notUndoableReason: 'The organizers can see it now. Ask them if it needs removing.'
		});
		linkOpen = false;
		linkLabel = '';
		linkUrl = '';
		await reload();
	}
</script>

<section class="materials" aria-label={materialsCopy.heading}>
	<h4 class="materials__title">{materialsCopy.heading}</h4>

	{#if view}
		<div class="materials__body" class:materials__body--reloading={reloading} aria-busy={reloading || undefined}>
			{#if view.openRequests.length > 0}
				<ul class="asks" aria-label="Requested files">
					{#each view.openRequests as ask (ask.id)}
						<li class="ask">
							<div class="ask__row">
								<p class="ask__what">
									{ask.what}{#if ask.hasDeadline}&nbsp;<span class="ask__deadline">— {materialsCopy.deadlineUnresolved}</span>{/if}
								</p>
								<button
									type="button"
									class="ui-button ui-button--primary ui-button--sm"
									disabled={busy !== null}
									onclick={() => pickFor(ask)}>
									{busy === 'upload' ? materialsCopy.uploadBusy : materialsCopy.uploadButton}
								</button>
							</div>
							{#if ask.instructions}
								<p class="ask__instructions">{ask.instructions}</p>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			<div class="actions">
				{#if view.openRequests.length === 0}
					<button
						type="button"
						class="ui-button ui-button--secondary ui-button--sm"
						disabled={busy !== null}
						onclick={() => pickFor(null)}>
						{busy === 'upload' ? materialsCopy.uploadBusy : materialsCopy.uploadButton}
					</button>
				{/if}
				<button
					type="button"
					class="ui-button ui-button--ghost ui-button--sm"
					aria-expanded={linkOpen}
					disabled={busy !== null}
					onclick={() => (linkOpen = !linkOpen)}>
					{materialsCopy.linkToggle}
				</button>
			</div>
			<input
				bind:this={fileInput}
				class="materials__file-input"
				type="file"
				accept={FILE_UPLOAD_ACCEPT}
				tabindex="-1"
				aria-hidden="true"
				onchange={onFilePicked}
			/>
			<p class="materials__constraints">
				Files: {FILE_UPLOAD_TYPES_LABEL}. Maximum {SPEAKER_UPLOAD_MAXIMUM_LABEL} each.
			</p>

			{#if busy === 'upload'}
				<div class="materials__progress">
					<Progress value={progressPct} label="Uploading" />
				</div>
			{/if}

			{#if refusal}
				<div class="materials__refusal">
					<RefusalNote message={refusal} tone="refused" />
					{#if retryable}
						<button
							type="button"
							class="ui-button ui-button--secondary ui-button--sm"
							disabled={busy !== null}
							onclick={retry}>
							{materialsCopy.retry}
						</button>
					{/if}
				</div>
			{:else if notice}
				<p class="materials__notice" role="status">{notice}</p>
			{/if}

			{#if linkOpen}
				<form class="link-form" onsubmit={submitLink}>
					<div class="link-form__fields">
						<label class="link-form__field">
							<span class="ui-label">Where it lives</span>
							<select class="ui-control" bind:value={linkProvider} disabled={busy !== null}>
								<option value="drive">Google Drive</option>
								<option value="dropbox">Dropbox</option>
								<option value="url">Somewhere else</option>
							</select>
						</label>
						<label class="link-form__field">
							<span class="ui-label">What it is</span>
							<input
								class="ui-control"
								type="text"
								maxlength="200"
								placeholder="Final deck (Drive)"
								bind:value={linkLabel}
								disabled={busy !== null}
							/>
						</label>
						<label class="link-form__field link-form__field--wide">
							<span class="ui-label">Link</span>
							<input
								class="ui-control"
								type="url"
								inputmode="url"
								placeholder="https://…"
								bind:value={linkUrl}
								disabled={busy !== null}
							/>
						</label>
					</div>
					<p class="link-form__reminder">{materialsCopy.linkShareReminder}</p>
					{#if linkError}
						<RefusalNote message={linkError} tone="stated" />
					{/if}
					<div class="link-form__actions">
						<button type="submit" class="ui-button ui-button--primary ui-button--sm" disabled={busy !== null}>
							{busy === 'link' ? materialsCopy.linkBusy : materialsCopy.linkSubmit}
						</button>
					</div>
				</form>
			{/if}

			{#if view.yours.length > 0}
				<div class="group">
					<h5 class="group__title">{materialsCopy.yoursHeading}</h5>
					<ul class="items">
						{#each view.yours as item (item.attachmentId)}
							<li class="item">
								{#if item.kind === 'file'}
									<span class="item__name">{item.name}</span>
									<span class="item__meta">{item.sizeLabel} · {materialsScanLabel[item.scan]}</span>
									{#if item.downloadable}
										{@const path = port.downloadPath(item.assetId)}
										{#if path}
											<a class="item__action" href={path}>{materialsCopy.download}</a>
										{/if}
									{/if}
								{:else}
									<span class="item__name">{item.label}</span>
									<span class="item__meta">{item.provider === 'drive' ? 'Google Drive' : item.provider === 'dropbox' ? 'Dropbox' : 'Link'}</span>
									<a class="item__action" href={item.url} rel="noreferrer external" target="_blank">Open</a>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if view.fromOrganizers.length > 0}
				<div class="group">
					<h5 class="group__title">{materialsCopy.fromOrganizersHeading}</h5>
					<ul class="items">
						{#each view.fromOrganizers as item (item.attachmentId)}
							<li class="item">
								{#if item.kind === 'file'}
									<span class="item__name">{item.name}</span>
									<span class="item__meta">{item.sizeLabel}</span>
									{#if item.downloadable}
										{@const path = port.downloadPath(item.assetId)}
										{#if path}
											<a class="item__action" href={path}>{materialsCopy.download}</a>
										{/if}
									{/if}
								{:else}
									<span class="item__name">{item.label}</span>
									<a class="item__action" href={item.url} rel="noreferrer external" target="_blank">Open</a>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	{:else if failed}
		<div class="materials__body">
			<p class="materials__failed" role="status">{materialsCopy.failedTitle}</p>
			<button
				type="button"
				class="ui-button ui-button--secondary ui-button--sm"
				onclick={() => {
					failed = false;
					void reload();
				}}>
				{materialsCopy.retry}
			</button>
		</div>
	{:else}
		<!-- The resolved composition's own rows, holding shape with fills. -->
		<div class="materials__body" aria-busy="true">
			{#if waiting.visible}
				<ul class="items" aria-hidden="true">
					<li class="item"><span class="ui-skeleton materials__fill"></span></li>
					<li class="item"><span class="ui-skeleton materials__fill materials__fill--short"></span></li>
				</ul>
			{/if}
			{#if waiting.phase === 'slow'}
				<p class="ui-sr-only" role="status">Loading materials.</p>
			{/if}
		</div>
	{/if}
</section>

<style>
	.materials {
		display: grid;
		gap: var(--je-space-2);
		padding-block-start: var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border);
	}

	.materials__title {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.materials__body {
		display: grid;
		gap: var(--je-space-3);
		/* Loading, failed, and resolved states share one floor so arrival never
		   collapses the engagement card under the reader. */
		min-block-size: 3.5rem;
		align-content: start;
		transition: opacity var(--je-duration-normal) var(--je-ease);
	}

	.materials__body--reloading {
		opacity: 0.62;
		pointer-events: none;
	}

	.materials__file-input {
		display: none;
	}

	.materials__constraints {
		margin: calc(var(--je-space-2) * -1) 0 0;
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.asks {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.ask {
		display: grid;
		gap: var(--je-space-1);
		padding: var(--je-space-3);
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
	}

	.ask__row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.ask__what {
		margin: 0;
		font-weight: 500;
	}

	.ask__deadline,
	.ask__instructions {
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		font-weight: 400;
	}

	.ask__instructions {
		margin: 0;
		max-inline-size: 62ch;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.materials__progress {
		max-inline-size: 24rem;
	}

	.materials__refusal {
		display: grid;
		justify-items: start;
		gap: var(--je-space-2);
	}

	.materials__notice {
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.link-form {
		display: grid;
		gap: var(--je-space-2);
		padding: var(--je-space-3);
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
	}

	.link-form__fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: var(--je-space-2);
	}

	.link-form__field {
		display: grid;
		gap: var(--je-space-1);
	}

	.link-form__field--wide {
		grid-column: 1 / -1;
	}

	.link-form__reminder {
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		max-inline-size: 62ch;
	}

	.link-form__actions {
		display: flex;
		gap: var(--je-space-2);
	}

	.group {
		display: grid;
		gap: var(--je-space-1);
	}

	.group__title {
		margin: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--je-color-text-muted);
	}

	.items {
		display: grid;
		gap: var(--je-space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.item {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.item__name {
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.item__meta {
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.item__action {
		margin-inline-start: auto;
		font-size: var(--je-font-size-sm);
		white-space: nowrap;
	}

	.materials__fill {
		display: inline-block;
		block-size: 1lh;
		inline-size: min(18rem, 90%);
	}

	.materials__fill--short {
		inline-size: min(12rem, 70%);
	}

	.materials__failed {
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}
</style>
