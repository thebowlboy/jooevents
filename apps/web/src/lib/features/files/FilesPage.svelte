<script lang="ts">
	/**
	 * The organizer Files surface: the typed asks (file requests riding the
	 * deadline catalog), everything received against them, and the resources
	 * shared out to speakers.
	 *
	 * The loop shape is the product's one loop: a composer states its refusal
	 * in place, every commit leaves a receipt, and a detach carries its undo —
	 * blobs are refcounted, so recovery is honest.
	 */
	import { ChevronDown, ChevronRight, Search } from 'lucide-svelte';
	import { DATE_CLASS, formatDate } from '@jooevents/contracts';
	import { Badge, createSettler, Field, PENDING_MIN_VISIBLE_MS, Progress, trackPending } from '$lib/ui';
	import type { FilesPagePort } from '$lib/api/files/files-page-port';
	import type { FileLinkProvider } from '@jooevents/contracts/files';
	import {
		FILE_UPLOAD_ACCEPT,
		FILE_UPLOAD_TYPES_LABEL,
		ORGANIZER_UPLOAD_MAXIMUM_LABEL,
		type OrganizerFilesView,
		type OrganizerShareView
	} from '$lib/api/files/view-models';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { filesRefusalSentence } from './copy';
	import FilesPanel from './FilesPanel.svelte';
	import { applyParams, param } from '$lib/features/workspace/url-state.svelte';
	import { filterReceivedFiles, receivedSessionChoices } from './received-files-filter';

	let { port }: { port: FilesPagePort } = $props();

	let view = $state<OrganizerFilesView | null>(null);
	let failed = $state(false);
	let reloading = $state(false);
	let readTicket = 0;
	const receivedFileSearch = $derived(param('file') ?? '');
	const receivedSession = $derived(param('session') ?? '');
	let receivedFileDraft = $state<string | null>(null);
	const typedReceivedFile = $derived(receivedFileDraft ?? receivedFileSearch);
	const receivedSearchSettler = createSettler();
	$effect(() => () => receivedSearchSettler.cancel());
	const filteredReceived = $derived(filterReceivedFiles(view?.received ?? [], {
		file: receivedFileSearch,
		session: receivedSession
	}));
	const receivedSessions = $derived(receivedSessionChoices(view?.received ?? []));

	function queueReceivedFileSearch(value: string): void {
		receivedFileDraft = value;
		receivedSearchSettler.schedule(() => void commitReceivedFileSearch(value));
	}

	async function commitReceivedFileSearch(value: string): Promise<void> {
		await applyParams({ file: value.trim() || null });
		if (receivedFileDraft === value) receivedFileDraft = null;
	}

	const waiting = trackPending(() => view === null && !failed, {
		minVisibleMs: PENDING_MIN_VISIBLE_MS
	});

	async function read(): Promise<void> {
		const ticket = (readTicket += 1);
		try {
			const next = await port.read();
			if (ticket !== readTicket) return;
			view = next;
			failed = false;
		} catch {
			if (ticket !== readTicket) return;
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
		void read();
	});

	// ------------------------------------------------------------------
	// Ask composer (file requests, D9)
	// ------------------------------------------------------------------

	let askOpen = $state(false);
	let askEngagementId = $state('');
	let askWhat = $state('');
	let askInstructions = $state('');
	let askDeadlineId = $state('');
	let askBusy = $state(false);
	let askError = $state('');
	let requestRefusal = $state('');

	async function submitAsk(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (askBusy) return;
		const what = askWhat.trim().replace(/\s+/gu, ' ');
		if (!askEngagementId) {
			askError = 'Pick whose file this asks for.';
			return;
		}
		if (!what) {
			askError = 'Say what you are asking for.';
			return;
		}
		askError = '';
		askBusy = true;
		const instructions = askInstructions.trim().replace(/\s+/gu, ' ');
		const outcome = await port.createRequest({
			engagementId: askEngagementId,
			what,
			instructions: instructions ? instructions : null,
			deadlineId: askDeadlineId ? askDeadlineId : null
		});
		askBusy = false;
		if (!outcome.ok) {
			askError = filesRefusalSentence(outcome.reason);
			return;
		}
		recordAction({
			label: `Asked for “${what}”`,
			area: 'Files',
			notUndoableReason: 'Withdraw the request from the list if it is no longer needed.'
		});
		askOpen = false;
		askWhat = '';
		askInstructions = '';
		askDeadlineId = '';
		await reload();
	}

	let withdrawArmedId = $state<string | null>(null);
	let withdrawBusyId = $state<string | null>(null);

	async function withdraw(requestId: string, version: number, what: string): Promise<void> {
		if (withdrawArmedId !== requestId) {
			withdrawArmedId = requestId;
			return;
		}
		withdrawArmedId = null;
		withdrawBusyId = requestId;
		requestRefusal = '';
		const outcome = await port.withdrawRequest({ requestId, expectedVersion: version });
		withdrawBusyId = null;
		if (!outcome.ok) {
			requestRefusal = filesRefusalSentence(outcome.reason);
			return;
		}
		recordAction({
			label: `Withdrew the ask for “${what}”`,
			area: 'Files',
			notUndoableReason: 'Ask again if it turns out to be needed after all.'
		});
		await reload();
	}

	// ------------------------------------------------------------------
	// Share composer + share materials
	// ------------------------------------------------------------------

	let shareOpen = $state(false);
	let shareTitle = $state('');
	let shareAudience = $state('all_confirmed');
	let shareBusy = $state(false);
	let shareError = $state('');
	let shareRefusal = $state('');

	function audienceFromChoice():
		| { kind: 'all_confirmed' }
		| { kind: 'track'; trackId: string }
		| { kind: 'engagement'; engagementId: string }
		| null {
		if (shareAudience === 'all_confirmed') return { kind: 'all_confirmed' };
		if (shareAudience.startsWith('track:')) {
			return { kind: 'track', trackId: shareAudience.slice('track:'.length) };
		}
		if (shareAudience.startsWith('engagement:')) {
			return { kind: 'engagement', engagementId: shareAudience.slice('engagement:'.length) };
		}
		return null;
	}

	async function submitShare(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (shareBusy) return;
		const title = shareTitle.trim().replace(/\s+/gu, ' ');
		const audience = audienceFromChoice();
		if (!title) {
			shareError = 'Name the resource.';
			return;
		}
		if (!audience) {
			shareError = 'Pick who this is for.';
			return;
		}
		shareError = '';
		shareBusy = true;
		const outcome = await port.createShare({ title, audience });
		shareBusy = false;
		if (!outcome.ok) {
			shareError = filesRefusalSentence(outcome.reason);
			return;
		}
		recordAction({
			label: `Shared “${title}”`,
			area: 'Files',
			notUndoableReason: 'Unshare it from the list if it should not be visible.'
		});
		shareOpen = false;
		shareTitle = '';
		shareAudience = 'all_confirmed';
		await reload();
	}

	let revokeArmedId = $state<string | null>(null);
	let revokeBusyId = $state<string | null>(null);

	async function revoke(share: OrganizerShareView): Promise<void> {
		if (revokeArmedId !== share.id) {
			revokeArmedId = share.id;
			return;
		}
		revokeArmedId = null;
		revokeBusyId = share.id;
		shareRefusal = '';
		const outcome = await port.revokeShare({ shareId: share.id, expectedVersion: share.version });
		revokeBusyId = null;
		if (!outcome.ok) {
			shareRefusal = filesRefusalSentence(outcome.reason);
			return;
		}
		recordAction({
			label: `Unshared “${share.title}”`,
			area: 'Files',
			notUndoableReason: 'Share it again if speakers still need it.'
		});
		await reload();
	}

	/** Per-share add-material state: file picking and link adding. */
	let materialShareId: string | null = null;
	let shareFileInput = $state<HTMLInputElement | null>(null);
	let materialBusyShareId = $state<string | null>(null);
	let materialProgressPct = $state(0);
	let materialRefusal = $state('');
	let linkOpenShareId = $state<string | null>(null);
	let shareLinkProvider = $state<FileLinkProvider>('drive');
	let shareLinkLabel = $state('');
	let shareLinkUrl = $state('');
	let shareLinkError = $state('');

	function pickShareFile(shareId: string): void {
		if (materialBusyShareId !== null) return;
		materialShareId = shareId;
		shareFileInput?.click();
	}

	async function onShareFilePicked(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const picked = input.files?.[0];
		input.value = '';
		const shareId = materialShareId;
		if (!picked || shareId === null || materialBusyShareId !== null) return;
		materialBusyShareId = shareId;
		materialProgressPct = 0;
		materialRefusal = '';
		const outcome = await port.uploadShareFile({
			shareId,
			file: { name: picked.name, type: picked.type, size: picked.size, blob: picked },
			onProgress: (progress) => {
				materialProgressPct = progress.totalBytes === 0
					? 0
					: Math.round((progress.transferredBytes / progress.totalBytes) * 100);
			}
		});
		materialBusyShareId = null;
		if (!outcome.ok) {
			materialRefusal = filesRefusalSentence(outcome.reason);
			return;
		}
		recordAction({
			label: `Attached “${picked.name}”`,
			area: 'Files',
			notUndoableReason: 'Remove it from the resource if it is the wrong file.'
		});
		await reload();
	}

	async function submitShareLink(event: SubmitEvent, shareId: string): Promise<void> {
		event.preventDefault();
		if (materialBusyShareId !== null) return;
		const label = shareLinkLabel.trim().replace(/\s+/gu, ' ');
		const url = shareLinkUrl.trim();
		if (!label) {
			shareLinkError = 'Give the link a name speakers will recognize.';
			return;
		}
		if (!url.startsWith('https://')) {
			shareLinkError = 'The link must start with https://';
			return;
		}
		shareLinkError = '';
		materialBusyShareId = shareId;
		materialRefusal = '';
		const outcome = await port.attachShareLink({
			shareId,
			provider: shareLinkProvider,
			label,
			url
		});
		materialBusyShareId = null;
		if (!outcome.ok) {
			materialRefusal = filesRefusalSentence(outcome.reason);
			return;
		}
		recordAction({
			label: `Attached “${label}”`,
			area: 'Files',
			notUndoableReason: 'Remove it from the resource if it is the wrong link.'
		});
		linkOpenShareId = null;
		shareLinkLabel = '';
		shareLinkUrl = '';
		await reload();
	}

	// ------------------------------------------------------------------
	// Received drill-in
	// ------------------------------------------------------------------

	let expandedEngagementId = $state<string | null>(null);
</script>

{#if view}
	{@const ready = view}
	<div class="page" class:page--reloading={reloading} aria-busy={reloading || undefined}>
		<section class="section" aria-labelledby="files-requests-heading">
			<header class="section__head">
				<h2 class="section__title" id="files-requests-heading">Requested files</h2>
				<button
					type="button"
					class="ui-button ui-button--primary ui-button--sm"
					aria-expanded={askOpen}
					onclick={() => (askOpen = !askOpen)}>
					Ask for a file
				</button>
			</header>

			{#if askOpen}
				<form class="composer" onsubmit={submitAsk}>
					<div class="composer__fields">
						<Field id="ask-engagement" label="From" required>
							{#snippet children({ id, describedBy, invalid })}
								<select
									class="ui-control"
									{id}
									aria-describedby={describedBy}
									aria-invalid={invalid}
									bind:value={askEngagementId}
									disabled={askBusy}>
									<option value="">Choose a speaker…</option>
									{#each ready.engagementChoices as choice (choice.engagementId)}
										<option value={choice.engagementId}>{choice.speaker} · {choice.session}</option>
									{/each}
								</select>
							{/snippet}
						</Field>
						<Field id="ask-what" label="What" required>
							{#snippet children({ id, describedBy, invalid })}
								<input
									class="ui-control"
									type="text"
									maxlength="200"
									placeholder="Your final slide deck"
									{id}
									aria-describedby={describedBy}
									aria-invalid={invalid}
									bind:value={askWhat}
									disabled={askBusy}
								/>
							{/snippet}
						</Field>
						<Field id="ask-deadline" label="By when" optional>
							{#snippet children({ id, describedBy, invalid })}
								<select
									class="ui-control"
									{id}
									aria-describedby={describedBy}
									aria-invalid={invalid}
									bind:value={askDeadlineId}
									disabled={askBusy}>
									<option value="">No deadline</option>
									{#each ready.deadlineChoices as choice (choice.deadlineId)}
										<option value={choice.deadlineId}>{choice.label}</option>
									{/each}
								</select>
							{/snippet}
						</Field>
					</div>
					<Field id="ask-instructions" label="Instructions" optional>
						{#snippet children({ id, describedBy, invalid })}
							<input
								class="ui-control"
								type="text"
								maxlength="2000"
								placeholder="Export as PDF if you can."
								{id}
								aria-describedby={describedBy}
								aria-invalid={invalid}
								bind:value={askInstructions}
								disabled={askBusy}
							/>
						{/snippet}
					</Field>
					{#if askError}
						<p class="composer__error" role="status">{askError}</p>
					{/if}
					<div class="composer__actions">
						<button type="submit" class="ui-button ui-button--primary ui-button--sm" disabled={askBusy} aria-busy={askBusy || undefined}>
							{askBusy ? 'Asking…' : 'Send the ask'}
						</button>
					</div>
				</form>
			{/if}

			{#if view.requests.length > 0}
				<ul class="requests">
					{#each view.requests as ask (ask.id)}
						<li class="request" aria-busy={withdrawBusyId === ask.id || undefined}>
							<div class="request__main">
								<span class="request__what">{ask.what}</span>
								<span class="request__who">{ask.engagementLabel.speaker} · {ask.engagementLabel.session}</span>
							</div>
							<span class="request__state">
								{#if ask.state === 'open'}
									{#if ask.overdue}
										<Badge tone="danger" emphasis>Overdue</Badge>
									{:else}
										<Badge tone="info">Open</Badge>
									{/if}
									{#if ask.deadline}
										<span class="request__deadline {DATE_CLASS.column}">
											<span class={DATE_CLASS.label}>by</span>
											<time class={DATE_CLASS.value} datetime={ask.deadline.displayDate}
												>{formatDate(ask.deadline.displayDate)}</time
											>
										</span>
									{/if}
								{:else if ask.state === 'fulfilled'}
									<Badge tone="success">Received</Badge>
								{:else}
									<Badge tone="neutral">Withdrawn</Badge>
								{/if}
							</span>
							{#if ask.state === 'open'}
								<button
									type="button"
									class="ui-button ui-button--ghost ui-button--sm"
									class:request__withdraw--armed={withdrawArmedId === ask.id}
									disabled={withdrawBusyId !== null}
									onclick={() => withdraw(ask.id, ask.version, ask.what)}
									onblur={() => {
										if (withdrawArmedId === ask.id) withdrawArmedId = null;
									}}>
									{withdrawBusyId === ask.id
										? 'Withdrawing…'
										: withdrawArmedId === ask.id
											? 'Withdraw?'
											: 'Withdraw'}
								</button>
							{/if}
						</li>
					{/each}
				</ul>
				{#if requestRefusal}
					<p class="composer__error" role="status">{requestRefusal}</p>
				{/if}
			{:else}
				<p class="section__empty">
					Nothing asked for yet. An ask shows up in the speaker's portal and nags politely.
				</p>
			{/if}
		</section>

		<section class="section" aria-labelledby="files-received-heading">
			<header class="section__head">
				<h2 class="section__title" id="files-received-heading">Received from speakers</h2>
				{#if view.received.length > 0}
					<div class="received-filters" aria-label="Received file filters">
						<div class="ui-input-wrap ui-input-wrap--leading received-filters__file">
							<span class="ui-input-wrap__icon" aria-hidden="true"><Search size={14} /></span>
							<input
								class="ui-control"
								type="search"
								placeholder="Find a file"
								aria-label="Filter received files by name"
								value={typedReceivedFile}
								oninput={(event) => queueReceivedFileSearch(event.currentTarget.value)}
								onkeydown={(event) => {
									if (event.key !== 'Enter') return;
									event.preventDefault();
									receivedSearchSettler.flush();
								}} />
						</div>
						<select
							class="ui-select received-filters__session"
							aria-label="Filter received files by session"
							value={receivedSession}
							onchange={(event) => applyParams({ session: event.currentTarget.value || null })}>
							<option value="">All sessions</option>
							{#each receivedSessions as session (session)}
								<option value={session}>{session}</option>
							{/each}
						</select>
					</div>
				{/if}
			</header>
			{#if view.received.length > 0}
				{#if filteredReceived.length > 0}
				<ul class="groups">
					{#each filteredReceived as group (group.engagementId)}
						{@const expanded = expandedEngagementId === group.engagementId}
						<li class="group" class:group--open={expanded}>
							<button
								type="button"
								class="group__row"
								aria-expanded={expanded}
								onclick={() =>
									(expandedEngagementId = expanded ? null : group.engagementId)}>
								<span class="group__chevron" aria-hidden="true">
									{#if expanded}<ChevronDown size={16} />{:else}<ChevronRight size={16} />{/if}
								</span>
								<span class="group__speaker">{group.label.speaker}</span>
								<span class="group__session">{group.label.session}</span>
								<span class="group__count">
									{group.items.length} {group.items.length === 1 ? 'file' : 'files'}
								</span>
							</button>
							{#if expanded}
								<div class="group__panel">
									<FilesPanel
										items={group.items}
										subject={{ kind: 'engagement', engagementId: group.engagementId }}
										{port}
										onchanged={reload}
									/>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
				{:else}
					<div class="received-empty">
						<p class="section__empty">No received files match these filters.</p>
						<button type="button" class="ui-button ui-button--secondary ui-button--sm" onclick={() => applyParams({ file: null, session: null })}>
							Clear filters
						</button>
					</div>
				{/if}
			{:else}
				<p class="section__empty">Nothing received yet. Files speakers upload land here.</p>
			{/if}
		</section>

		<section class="section" aria-labelledby="files-resources-heading">
			<header class="section__head">
				<h2 class="section__title" id="files-resources-heading">Shared resources</h2>
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm"
					aria-expanded={shareOpen}
					onclick={() => (shareOpen = !shareOpen)}>
					Share a resource
				</button>
			</header>

			{#if shareOpen}
				<form class="composer" onsubmit={submitShare}>
					<div class="composer__fields">
						<Field id="share-title" label="Name" required>
							{#snippet children({ id, describedBy, invalid })}
								<input
									class="ui-control"
									type="text"
									maxlength="200"
									placeholder="Slide template"
									{id}
									aria-describedby={describedBy}
									aria-invalid={invalid}
									bind:value={shareTitle}
									disabled={shareBusy}
								/>
							{/snippet}
						</Field>
						<Field id="share-audience" label="Who sees it" required>
							{#snippet children({ id, describedBy, invalid })}
								<select
									class="ui-control"
									{id}
									aria-describedby={describedBy}
									aria-invalid={invalid}
									bind:value={shareAudience}
									disabled={shareBusy}>
									<option value="all_confirmed">All confirmed speakers</option>
									{#each ready.trackChoices as choice (choice.trackId)}
										<option value={`track:${choice.trackId}`}>Track · {choice.name}</option>
									{/each}
									{#each ready.engagementChoices as choice (choice.engagementId)}
										<option value={`engagement:${choice.engagementId}`}>
											{choice.speaker} · {choice.session}
										</option>
									{/each}
								</select>
							{/snippet}
						</Field>
					</div>
					{#if shareError}
						<p class="composer__error" role="status">{shareError}</p>
					{/if}
					<div class="composer__actions">
						<button type="submit" class="ui-button ui-button--primary ui-button--sm" disabled={shareBusy} aria-busy={shareBusy || undefined}>
							{shareBusy ? 'Sharing…' : 'Share it'}
						</button>
					</div>
				</form>
			{/if}

			<input
				bind:this={shareFileInput}
				class="page__file-input"
				type="file"
				accept={FILE_UPLOAD_ACCEPT}
				tabindex="-1"
				aria-hidden="true"
				onchange={onShareFilePicked}
			/>
			<p class="upload-constraints">
				Files: {FILE_UPLOAD_TYPES_LABEL}. Maximum {ORGANIZER_UPLOAD_MAXIMUM_LABEL} each.
			</p>

			{#if view.shares.length > 0}
				<ul class="shares">
					{#each view.shares as share (share.id)}
						<li class="share" aria-busy={revokeBusyId === share.id || materialBusyShareId === share.id || undefined}>
							<div class="share__head">
								<span class="share__title">{share.title}</span>
								<Badge tone="mark">{share.audienceLabel}</Badge>
								<span class="share__actions">
									<button
										type="button"
										class="ui-button ui-button--ghost ui-button--sm"
										disabled={materialBusyShareId !== null}
										onclick={() => pickShareFile(share.id)}>
										{materialBusyShareId === share.id ? 'Attaching…' : 'Attach file'}
									</button>
									<button
										type="button"
										class="ui-button ui-button--ghost ui-button--sm"
										aria-expanded={linkOpenShareId === share.id}
										disabled={materialBusyShareId !== null}
										onclick={() =>
											(linkOpenShareId = linkOpenShareId === share.id ? null : share.id)}>
										Attach link
									</button>
									<button
										type="button"
										class="ui-button ui-button--ghost ui-button--sm"
										class:share__revoke--armed={revokeArmedId === share.id}
										disabled={revokeBusyId !== null}
										onclick={() => revoke(share)}
										onblur={() => {
											if (revokeArmedId === share.id) revokeArmedId = null;
										}}>
										{revokeBusyId === share.id
											? 'Unsharing…'
											: revokeArmedId === share.id
												? 'Unshare?'
												: 'Unshare'}
									</button>
								</span>
							</div>
							{#if materialBusyShareId === share.id}
								<div class="share__progress">
									<Progress value={materialProgressPct} label="Uploading" />
								</div>
							{/if}
							{#if linkOpenShareId === share.id}
								<form class="composer composer--inset" onsubmit={(event) => submitShareLink(event, share.id)}>
									<div class="composer__fields">
										<label class="composer__plain-field">
											<span class="ui-label">Where it lives</span>
											<select class="ui-control" bind:value={shareLinkProvider} disabled={materialBusyShareId !== null}>
												<option value="drive">Google Drive</option>
												<option value="dropbox">Dropbox</option>
												<option value="url">Somewhere else</option>
											</select>
										</label>
										<label class="composer__plain-field">
											<span class="ui-label">What it is</span>
											<input class="ui-control" type="text" maxlength="200" bind:value={shareLinkLabel} disabled={materialBusyShareId !== null} />
										</label>
										<label class="composer__plain-field">
											<span class="ui-label">Link</span>
											<input class="ui-control" type="url" inputmode="url" placeholder="https://…" bind:value={shareLinkUrl} disabled={materialBusyShareId !== null} />
										</label>
									</div>
									{#if shareLinkError}
										<p class="composer__error" role="status">{shareLinkError}</p>
									{/if}
									<div class="composer__actions">
										<button type="submit" class="ui-button ui-button--primary ui-button--sm" disabled={materialBusyShareId !== null}>
											Add link
										</button>
									</div>
								</form>
							{/if}
							<FilesPanel
								items={share.materials}
								subject={{ kind: 'resource_share', resourceShareId: share.id }}
								{port}
								onchanged={reload}
							/>
						</li>
					{/each}
				</ul>
				{#if materialRefusal}
					<p class="composer__error" role="status">{materialRefusal}</p>
				{/if}
				{#if shareRefusal}
					<p class="composer__error" role="status">{shareRefusal}</p>
				{/if}
			{:else}
				<p class="section__empty">
					Nothing shared yet. Resources land in every matching speaker's portal.
				</p>
			{/if}
		</section>
	</div>
{:else if failed}
	<section class="page page--failed" role="alert">
		<h2 class="section__title">Files could not be loaded</h2>
		<p class="section__empty">The files workspace could not be reached. It may load on another try.</p>
		<button type="button" class="ui-button ui-button--secondary" onclick={() => { failed = false; void reload(); }}>
			Try again
		</button>
	</section>
{:else}
	<!-- The resolved page's own sections, holding shape with quiet fills. -->
	<div class="page" aria-busy="true">
		{#if waiting.visible}
			<section class="section" aria-hidden="true">
				<h2 class="section__title">Requested files</h2>
				<ul class="requests">
					<li class="request"><span class="ui-skeleton page__fill"></span></li>
					<li class="request"><span class="ui-skeleton page__fill page__fill--short"></span></li>
				</ul>
			</section>
			<section class="section" aria-hidden="true">
				<h2 class="section__title">Received from speakers</h2>
				<ul class="groups">
					<li class="group"><span class="ui-skeleton page__fill"></span></li>
				</ul>
			</section>
		{/if}
		{#if waiting.phase === 'slow'}
			<p class="ui-sr-only" role="status">Loading files.</p>
		{/if}
	</div>
{/if}

<CommitReceipt onUndone={reload} />

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-8);
		/* The column keeps its footprint through every state. */
		min-block-size: 24rem;
		transition: opacity var(--je-duration-normal) var(--je-ease);
	}

	.page--reloading {
		opacity: 0.62;
	}

	.page--failed {
		justify-content: center;
		align-items: start;
		gap: var(--je-space-3);
	}

	.page__file-input {
		display: none;
	}

	.section {
		display: grid;
		gap: var(--je-space-3);
	}

	.section__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.section__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
	}

	.section__empty {
		margin: 0;
		color: var(--je-color-text-muted);
		max-inline-size: 62ch;
	}

	.received-filters {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.received-filters__file {
		inline-size: min(18rem, 100%);
	}

	.received-filters__session {
		max-inline-size: min(20rem, 100%);
	}

	.received-empty {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-3);
	}

	.upload-constraints {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.composer {
		display: grid;
		gap: var(--je-space-3);
		padding: var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.composer--inset {
		background: var(--je-color-surface-sunken);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-3);
	}

	.composer__fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: var(--je-space-3);
		align-items: start;
	}

	.composer__plain-field {
		display: grid;
		gap: var(--je-space-1);
	}

	.composer__error {
		margin: 0;
		color: var(--je-color-danger);
		font-size: var(--je-font-size-sm);
	}

	.composer__actions {
		display: flex;
		gap: var(--je-space-2);
	}

	.requests {
		display: grid;
		gap: var(--je-space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.request {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		padding: var(--je-space-2) var(--je-space-3);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
	}

	.request__main {
		display: grid;
		gap: 2px;
		min-inline-size: 0;
	}

	.request__what {
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.request__who {
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.request__state {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		margin-inline-start: auto;
	}

	/* Figures and wrapping come from the shared date column; only the size is local. */
	.request__deadline {
		font-size: var(--je-font-size-sm);
	}

	.request__withdraw--armed,
	.share__revoke--armed {
		color: var(--je-color-danger);
	}

	.groups,
	.shares {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.group {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.group--open {
		border-color: var(--je-color-border-strong);
	}

	.group__row {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		inline-size: 100%;
		padding: var(--je-space-3);
		background: none;
		border: none;
		font: inherit;
		color: inherit;
		text-align: start;
		cursor: pointer;
		border-radius: inherit;
	}

	.group__row:hover {
		background: var(--je-color-surface-sunken);
	}

	.group__chevron {
		display: grid;
		place-items: center;
		color: var(--je-color-text-muted);
	}

	.group__speaker {
		font-weight: 600;
	}

	.group__session {
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		overflow-wrap: anywhere;
	}

	.group__count {
		margin-inline-start: auto;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.group__panel {
		padding: 0 var(--je-space-3) var(--je-space-3);
	}

	.share {
		display: grid;
		gap: var(--je-space-2);
		padding: var(--je-space-3);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.share__head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.share__title {
		font-weight: 600;
	}

	.share__actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-1);
		margin-inline-start: auto;
	}

	.share__progress {
		max-inline-size: 24rem;
	}

	.page__fill {
		display: inline-block;
		block-size: 1lh;
		inline-size: min(20rem, 85%);
	}

	.page__fill--short {
		inline-size: min(14rem, 60%);
	}

	@media (max-width: 768px) {
		.section__head,
		.received-filters {
			align-items: stretch;
		}

		.received-filters,
		.received-filters__file,
		.received-filters__session {
			inline-size: 100%;
			max-inline-size: none;
		}

		.group__row {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr) auto;
			min-block-size: 2.75rem;
		}

		.group__chevron {
			grid-row: 1 / span 2;
		}

		.group__session {
			grid-column: 2 / 4;
		}
	}
</style>
