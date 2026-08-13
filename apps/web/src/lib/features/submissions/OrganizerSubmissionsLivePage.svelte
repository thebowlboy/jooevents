<script lang="ts">
	import { onMount } from 'svelte';
	import { Badge, CopyValue } from '$lib/ui';
	import {
		categoryTargetLabel,
		type CategoryTargetVocabularyState
	} from '$lib/api/category-targets';
	import type {
		OrganizerSubmissionAnswerView,
		OrganizerSubmissionContactView,
		OrganizerSubmissionDetailView,
		OrganizerSubmissionReadResult,
		OrganizerSubmissionsPageProps,
		OrganizerSubmissionSummaryView,
		OrganizerSubmissionTargetView
	} from '$lib/api/view-models/intake-submissions';

	/** Selected by composition. This component never chooses sample after a live failure. */
	let { port, vocabulary: vocabularyPort }: OrganizerSubmissionsPageProps = $props();

	type DetailState =
		| { readonly kind: 'loading' }
		| { readonly kind: 'success'; readonly data: OrganizerSubmissionDetailView }
		| { readonly kind: 'error'; readonly message: string };
	type ContactState =
		| { readonly kind: 'loading' }
		| { readonly kind: 'success'; readonly data: OrganizerSubmissionContactView }
		| { readonly kind: 'error'; readonly message: string };

	let rows = $state<readonly OrganizerSubmissionSummaryView[] | null>(null);
	let listError = $state<string | null>(null);
	let loadingList = $state(false);
	let expandedId = $state<string | null>(null);
	let detailById = $state<Record<string, DetailState>>({});
	let contactById = $state<Record<string, ContactState>>({});
	let vocabularyState = $state<CategoryTargetVocabularyState>({ kind: 'loading' });
	const lifecycle = new AbortController();

	function targetLabel(target: OrganizerSubmissionTargetView): string {
		// A fixed-session target is already the whole factual browser projection.
		// Its title belongs to the future canonical Session source, not vocabulary.
		if (target.kind === 'session') return target.label;
		return categoryTargetLabel(target, vocabularyState);
	}

	function readFailure(
		result: Exclude<OrganizerSubmissionReadResult<unknown>, { readonly kind: 'success' }>,
		subject: 'list' | 'detail' | 'contact'
	): string {
		if (result.kind === 'outcome' && result.outcome.class === 'access_denied') {
			return subject === 'contact'
				? 'You don’t have access to contact details for this submission.'
				: 'You don’t have access to these submissions.';
		}
		if (result.kind === 'unavailable') {
			return subject === 'contact'
				? 'Contact details aren’t available in this workspace.'
				: 'Submissions aren’t available in this build.';
		}
		if (subject === 'list') return 'Submissions couldn’t be loaded. Try again.';
		if (subject === 'detail') return 'This submission couldn’t be loaded. Try again.';
		return 'Contact details couldn’t be loaded. Try again.';
	}

	async function loadList() {
		loadingList = true;
		listError = null;
		try {
			const result = await port.list({ signal: lifecycle.signal });
			if (lifecycle.signal.aborted) return;
			if (result.kind === 'success') rows = result.data;
			else listError = readFailure(result, 'list');
		} catch {
			if (!lifecycle.signal.aborted) listError = 'Submissions couldn’t be loaded. Try again.';
		} finally {
			if (!lifecycle.signal.aborted) loadingList = false;
		}
	}

	async function loadVocabulary() {
		if (vocabularyState.kind !== 'ready') vocabularyState = { kind: 'loading' };
		try {
			const result = await vocabularyPort.read({ signal: lifecycle.signal });
			if (lifecycle.signal.aborted) return;
			vocabularyState = result.kind === 'success'
				? { kind: 'ready', snapshot: result.data }
				: { kind: 'unavailable' };
		} catch {
			if (!lifecycle.signal.aborted) vocabularyState = { kind: 'unavailable' };
		}
	}

	async function loadDetail(submissionId: string) {
		detailById = { ...detailById, [submissionId]: { kind: 'loading' } };
		try {
			const result = await port.readDetail(submissionId, { signal: lifecycle.signal });
			if (lifecycle.signal.aborted) return;
			detailById = {
				...detailById,
				[submissionId]:
					result.kind === 'success'
						? { kind: 'success', data: result.data }
						: { kind: 'error', message: readFailure(result, 'detail') }
			};
		} catch {
			if (!lifecycle.signal.aborted) {
				detailById = {
					...detailById,
					[submissionId]: {
						kind: 'error',
						message: 'This submission couldn’t be loaded. Try again.'
					}
				};
			}
		}
	}

	async function toggleDetail(submissionId: string) {
		if (expandedId === submissionId) {
			expandedId = null;
			return;
		}
		expandedId = submissionId;
		if (detailById[submissionId]?.kind !== 'success') await loadDetail(submissionId);
	}

	async function loadContact(submissionId: string) {
		if (port.contact.kind !== 'available' || contactById[submissionId]?.kind === 'loading') return;
		contactById = { ...contactById, [submissionId]: { kind: 'loading' } };
		try {
			const result = await port.contact.read(submissionId, { signal: lifecycle.signal });
			if (lifecycle.signal.aborted) return;
			contactById = {
				...contactById,
				[submissionId]:
					result.kind === 'success'
						? { kind: 'success', data: result.data }
						: { kind: 'error', message: readFailure(result, 'contact') }
			};
		} catch {
			if (!lifecycle.signal.aborted) {
				contactById = {
					...contactById,
					[submissionId]: {
						kind: 'error',
						message: 'Contact details couldn’t be loaded. Try again.'
					}
				};
			}
		}
	}

	function answerText(answer: OrganizerSubmissionAnswerView): string {
		switch (answer.type) {
			case 'text':
			case 'textarea':
			case 'url':
			case 'phone':
			case 'date':
			case 'datetime':
				return answer.value || 'No answer provided';
			case 'number':
				return String(answer.value);
			case 'select':
				return answer.choice.label;
			case 'multiselect':
				return answer.choices.length > 0
					? answer.choices.map((choice) => choice.label).join(', ')
					: 'No choices selected';
			case 'checkbox':
				return answer.checked ? 'Checked' : 'Not checked';
		}
	}

	onMount(() => {
		void loadList();
		void loadVocabulary();
		return () => lifecycle.abort();
	});
</script>

<svelte:head><title>Submissions · JooEvents</title></svelte:head>

<div class="page-head">
	<div>
		<h1>Submissions</h1>
		<p>Submitted applications, shown from the form version each person answered.</p>
	</div>
	{#if port.source.kind === 'sample'}
		<div class="source" aria-label={`Sample data: ${port.source.scenario.name}`}>
			<Badge tone="neutral">{port.source.label}</Badge>
			<span>{port.source.scenario.name}</span>
		</div>
	{/if}
</div>

{#if rows === null && !listError}
	<div class="ui-table-wrap" aria-label="Loading submissions">
		<table class="ui-table ui-table--multiline submissions-table">
			<thead>
				<tr><th>Submission</th><th>Submitted by</th><th>Target</th><th>Submitted</th><th><span class="ui-sr-only">Details</span></th></tr>
			</thead>
			<tbody>
				{#each Array(5) as _, index (index)}
					<tr aria-hidden="true">
						<td><span class="ui-table__primary"><span class="ui-skeleton skeleton-line skeleton-title"></span></span></td>
						<td><span class="ui-skeleton skeleton-line skeleton-person"></span></td>
						<td><span class="ui-skeleton skeleton-line skeleton-target"></span></td>
						<td><span class="ui-skeleton skeleton-line skeleton-date"></span></td>
						<td><span class="skeleton-action"></span></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else if listError}
	<section class="state-panel" role="alert">
		<h2>Submissions are unavailable</h2>
		<p>{listError}</p>
		<button class="ui-button ui-button--secondary" type="button" disabled={loadingList} onclick={() => void loadList()}>
			{loadingList ? 'Trying again…' : 'Try again'}
		</button>
	</section>
{:else if rows?.length === 0}
	<section class="state-panel">
		<h2>No submitted applications yet</h2>
		<p>Applications will appear here after someone completes an enabled form.</p>
	</section>
{:else if rows}
	<div class="ui-table-wrap">
		<table class="ui-table ui-table--multiline submissions-table">
			<thead>
				<tr><th>Submission</th><th>Submitted by</th><th>Target</th><th>Submitted</th><th><span class="ui-sr-only">Details</span></th></tr>
			</thead>
			<tbody>
				{#each rows as row (row.id)}
					<tr class:row-open={expandedId === row.id}>
						<td><span class="ui-table__primary"><strong>{row.title}</strong></span></td>
						<td>{row.primaryParticipantName ?? 'Name not provided'}</td>
						<td><Badge tone="neutral">{targetLabel(row.target)}</Badge></td>
						<td class="submitted-at">
							{#if port.source.kind === 'live'}
								<time datetime={row.submittedAt}>{row.submittedAtLabel}</time>
							{:else}
								{row.submittedAtLabel}
							{/if}
						</td>
						<td class="detail-control">
							<button
								class="ui-button ui-button--secondary ui-button--sm detail-button"
								type="button"
								aria-expanded={expandedId === row.id}
								aria-controls={`submission-detail-${row.id}`}
								onclick={() => void toggleDetail(row.id)}
							>
								{expandedId === row.id ? 'Hide details' : 'View details'}
							</button>
						</td>
					</tr>
					{#if expandedId === row.id}
						{@const detail = detailById[row.id]}
						<tr class="detail-row">
							<td colspan="5">
								<section id={`submission-detail-${row.id}`} class="detail" aria-label={`Details for ${row.title}`}>
									{#if !detail || detail.kind === 'loading'}
										<div class="detail-loading" aria-label="Loading submission details">
											{#each Array(4) as _, index (index)}
												<div class="answer-skeleton" aria-hidden="true">
													<span class="ui-skeleton skeleton-line skeleton-label"></span>
													<span class="ui-skeleton skeleton-line skeleton-answer"></span>
												</div>
											{/each}
										</div>
									{:else if detail.kind === 'error'}
										<div class="detail-error" role="alert">
											<p>{detail.message}</p>
											<button class="ui-button ui-button--secondary ui-button--sm" type="button" onclick={() => void loadDetail(row.id)}>Try again</button>
										</div>
									{:else}
										<div class="answers">
											{#each detail.data.answers as answer (answer.fieldId)}
												<div class="answer">
													<h3>{answer.fieldLabel}</h3>
													<p class:answer-long={answer.type === 'textarea'}>{answerText(answer)}</p>
												</div>
											{/each}
										</div>
										<aside class="contact" aria-label="Submitter contact">
											<h3>Contact</h3>
											{#if port.contact.kind === 'unavailable'}
												<p>{port.contact.reason === 'not_authorized' ? 'Contact details require additional access.' : 'Contact details aren’t enabled here.'}</p>
											{:else}
												{@const contact = contactById[row.id]}
												{#if !contact}
													<button class="ui-button ui-button--secondary ui-button--sm" type="button" onclick={() => void loadContact(row.id)}>Show contact email</button>
												{:else if contact.kind === 'loading'}
													<p aria-live="polite">Loading contact details…</p>
												{:else if contact.kind === 'error'}
													<div class="contact-error" role="alert">
														<p>{contact.message}</p>
														<button class="ui-button ui-button--secondary ui-button--sm" type="button" onclick={() => void loadContact(row.id)}>Try again</button>
													</div>
												{:else}
													<CopyValue value={contact.data.email} label="contact email address" />
												{/if}
											{/if}
										</aside>
									{/if}
								</section>
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	.page-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--je-space-6);
		margin-block-end: var(--je-space-6);
	}

	.page-head h1 {
		margin: 0;
		font-size: var(--je-font-size-2xl);
		line-height: var(--je-leading-tight);
	}

	.page-head p {
		margin: var(--je-space-1) 0 0;
		color: var(--je-color-text-muted);
	}

	.source {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		white-space: nowrap;
	}

	.submissions-table {
		min-inline-size: 52rem;
	}

	.submitted-at {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.detail-control {
		text-align: end;
	}

	.row-open > td {
		border-block-start: 2px solid var(--je-color-border-strong);
	}

	.row-open > td:first-child {
		border-inline-start: 2px solid var(--je-color-border-strong);
	}

	.row-open > td:last-child {
		border-inline-end: 2px solid var(--je-color-border-strong);
	}

	.detail-row > td {
		padding: 0;
		border-inline: 2px solid var(--je-color-border-strong);
		border-block-end: 2px solid var(--je-color-border-strong);
		background: var(--je-color-surface);
	}

	.detail {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(14rem, 1fr);
		gap: var(--je-space-8);
		padding: var(--je-space-5) var(--je-space-6) var(--je-space-6);
		white-space: normal;
	}

	.answers,
	.detail-loading {
		display: grid;
		gap: var(--je-space-5);
	}

	.answer,
	.answer-skeleton {
		display: grid;
		gap: var(--je-space-1);
	}

	.answer h3,
	.contact h3 {
		margin: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		letter-spacing: var(--je-tracking-caps);
		text-transform: uppercase;
		color: var(--je-color-text-muted);
	}

	.answer p,
	.contact p,
	.detail-error p,
	.contact-error p {
		margin: 0;
		line-height: var(--je-leading-normal);
	}

	.answer-long {
		white-space: pre-wrap;
	}

	.contact {
		align-self: start;
		display: grid;
		gap: var(--je-space-3);
		padding: var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-md);
		background: var(--je-color-surface-sunken);
	}

	.detail-error,
	.contact-error {
		display: grid;
		justify-items: start;
		gap: var(--je-space-3);
	}

	.state-panel {
		min-block-size: 14rem;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: var(--je-space-3);
		padding: var(--je-space-8);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-lg);
		background: var(--je-color-surface);
		text-align: center;
	}

	.state-panel h2,
	.state-panel p {
		margin: 0;
	}

	.state-panel p {
		max-inline-size: 42rem;
		color: var(--je-color-text-muted);
	}

	.skeleton-line {
		display: inline-block;
		block-size: 1lh;
		vertical-align: bottom;
	}

	.skeleton-title { inline-size: 18rem; }
	.skeleton-person { inline-size: 9rem; }
	.skeleton-target { inline-size: 6rem; }
	.skeleton-date { inline-size: 8rem; }
	.skeleton-label { inline-size: 7rem; }
	.skeleton-answer { inline-size: min(30rem, 100%); }

	.skeleton-action {
		display: inline-block;
		inline-size: 7rem;
		block-size: var(--je-control-height-sm);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
	}

	@media (max-width: 720px) {
		.page-head {
			align-items: stretch;
			flex-direction: column;
			gap: var(--je-space-3);
		}

		.source {
			white-space: normal;
		}

		.detail {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--je-space-6);
			padding-inline: var(--je-space-4);
		}
	}

</style>
