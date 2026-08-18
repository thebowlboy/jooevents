<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { themeStyleProperties } from '$lib/theme/theme-contract';
	import {
		formatInstant,
		type ServedPublicFormDto,
		type ServedPublicFormFieldDto
	} from '@jooevents/contracts';
	import type {
		PublicApplicationSession,
		PublicApplicationSessionSnapshot
	} from '$lib/api/public-application-session';
	import {
		publicApplicationControlValue,
		publicApplicationCloseView,
		publicApplicationFieldInput,
		publicApplicationFieldStates,
		publicApplicationSaveStatusView,
		publicApplicationSubmitBlockers,
		type PublicApplicationControlValue
	} from '$lib/api/view-models/public-application-form';
	import type { EventTheme } from '$lib/api/types';

	/**
	 * The live call for proposals: the same artifact the read-only surface
	 * shows, taking answers. It binds the served field DTOs — option
	 * identities intact — to one {@link PublicApplicationSession}, so the
	 * ceremony is identical wherever this renders; standalone and embedded
	 * presentation never alter validation, autosave, or submission.
	 *
	 * The draft holds only answers the contract accepts. A control may show
	 * anything while someone types; the moment its value stops being an
	 * acceptable answer it leaves the draft and the reviewed sentence for that
	 * field kind appears beside it.
	 */
	interface Props {
		form: ServedPublicFormDto;
		session: PublicApplicationSession;
		theme: EventTheme;
		eventName: string;
		/** e.g. "12–14 Oct 2026 · New York City"; empty hides the meta lines. */
		eventMeta: string;
		/**
		 * How this artifact is being shown. In `embed` presentation the
		 * success action opens the canonical participant route in a new
		 * top-level tab — sign-in never happens inside a host's frame.
		 */
		presentation?: 'page' | 'embed';
		/**
		 * Reports at most once when a submit press settles on the completed
		 * ceremony. This includes adopting a completion committed in another
		 * tab; a mount that begins already submitted never reports it.
		 */
		onSubmitted?: () => void;
	}

	let {
		form,
		session,
		theme,
		eventName,
		eventMeta,
		presentation = 'page',
		onSubmitted
	}: Props = $props();

	const uid = $props.id();

	/** The visitor's own zone, resolved once. `UTC` if the browser will not say. */
	const readerTimezone = ((): string => {
		try {
			return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
		} catch {
			return 'UTC';
		}
	})();

	// The session is this mount's own machine; its initial snapshot is a
	// deliberate one-time read, and every later change arrives via subscribe.
	// svelte-ignore state_referenced_locally
	let snapshot = $state<PublicApplicationSessionSnapshot>(session.state());
	/** What each control currently shows; the draft holds only acceptable answers. */
	let controls = $state<Record<string, PublicApplicationControlValue>>({});
	let errors = $state<Record<string, string>>({});
	/** Format refusals stay quiet until the field is left or a submit is attempted. */
	let touched = $state<Record<string, boolean>>({});
	let submitNote = $state<string | null>(null);
	/** Immediate acknowledgement across both the save flush and submit request. */
	let submitPending = $state(false);
	/** The host boundary is at-most-once even if session reconciliation repeats. */
	let completionReported = false;
	/** The confirmation panel, focused after this mount's own submit lands. */
	let doneRegion = $state<HTMLElement>();

	// Reconciliation bookkeeping outside the render graph: the server draft is
	// adopted into the controls once on first readiness and again whenever a
	// draft-changed reconcile arrives, never on every notification while the
	// person is typing.
	let hydrated = false;
	let priorRefusalKind: string | null = null;

	function hydrateControls(current: PublicApplicationSessionSnapshot): void {
		const byField = new Map(current.answers.map((answer) => [answer.fieldId, answer]));
		const next: Record<string, PublicApplicationControlValue> = {};
		for (const field of form.fields) {
			next[field.id] = publicApplicationControlValue(field, byField.get(field.id));
		}
		controls = next;
		errors = {};
	}

	onMount(() => {
		const unsubscribe = session.subscribe((next) => {
			const reconciled =
				next.refusal?.kind === 'draft_changed' && priorRefusalKind !== 'draft_changed';
			priorRefusalKind = next.refusal?.kind ?? null;
			snapshot = next;
			if (reconciled || (!hydrated && (next.phase === 'ready' || next.phase === 'submitted'))) {
				hydrated = true;
				hydrateControls(next);
			}
		});
		void session.start();
		return () => {
			unsubscribe();
			// Unsaved edits ride out an unmount through one final save.
			void session.flush();
		};
	});

	const fieldStates = $derived(publicApplicationFieldStates(form, snapshot.answers));
	const visibleFields = $derived(
		form.fields.filter((field) => fieldStates.get(field.id)?.visible ?? true)
	);
	const editable = $derived(snapshot.phase === 'ready' || snapshot.phase === 'saving');
	const controlsDisabled = $derived(!editable);
	const submitting = $derived(snapshot.phase === 'submitting');
	const submitted = $derived(snapshot.phase === 'submitted');
	const stopped = $derived(snapshot.phase === 'stopped');
	const startFailed = $derived(snapshot.phase === 'idle' && snapshot.transport !== null);
	const starting = $derived(
		snapshot.phase === 'starting' || (snapshot.phase === 'idle' && snapshot.transport === null)
	);
	const saveStatus = $derived(publicApplicationSaveStatusView(snapshot));
	const closeView = $derived(publicApplicationCloseView(form.availability));

	const refusal = $derived(snapshot.refusal);
	const terminalRefusal = $derived(stopped ? refusal : null);
	const reoffer = $derived(
		!stopped && refusal?.kind === 'target_no_longer_collecting' ? refusal : null
	);
	const inlineRefusal = $derived(
		!stopped && refusal && refusal.kind !== 'target_no_longer_collecting' ? refusal : null
	);

	const confirmationParagraphs = $derived(
		form.confirmation
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
	);
	/**
	 * The receipt line. This is the one timestamp an applicant may have to
	 * produce as proof they answered before a deadline, so it is spelled in the
	 * product's date vocabulary and it names its zone — an unlabelled clock is
	 * not evidence of anything.
	 *
	 * The zone is the visitor's, because the surface is served without the
	 * event's and inventing one would be worse than naming the one we know.
	 */
	const submittedAtLabel = $derived(
		snapshot.submission
			? formatInstant(snapshot.submission.submittedAt, readerTimezone, {
					zone: true,
					fallback: ''
				})
			: ''
	);

	const brandStyle = $derived(
		Object.entries(themeStyleProperties(theme))
			.map(([token, value]) => `${token}: ${value}`)
			.join('; ')
	);
	const markText = $derived(theme.markText || eventName.trim().charAt(0).toUpperCase());

	function controlId(field: ServedPublicFormFieldDto): string {
		return `${uid}-${field.id}`;
	}
	function errorId(field: ServedPublicFormFieldDto): string {
		return `${uid}-${field.id}-error`;
	}
	function helpId(field: ServedPublicFormFieldDto): string {
		return `${uid}-${field.id}-help`;
	}
	function textValue(fieldId: string): string {
		const raw = controls[fieldId];
		return typeof raw === 'string' ? raw : '';
	}
	function listValue(fieldId: string): readonly string[] {
		const raw = controls[fieldId];
		return Array.isArray(raw) ? raw : [];
	}
	function isRequired(field: ServedPublicFormFieldDto): boolean {
		return fieldStates.get(field.id)?.required ?? field.required;
	}
	function shownError(field: ServedPublicFormFieldDto): string | undefined {
		return touched[field.id] ? errors[field.id] : undefined;
	}
	function describedBy(field: ServedPublicFormFieldDto): string | undefined {
		const parts = [
			field.help ? helpId(field) : null,
			shownError(field) ? errorId(field) : null
		].filter(Boolean);
		return parts.length > 0 ? parts.join(' ') : undefined;
	}

	function applyInput(field: ServedPublicFormFieldDto, value: PublicApplicationControlValue): void {
		controls[field.id] = value;
		const result = publicApplicationFieldInput(field, value);
		if (result.kind === 'answer') {
			session.setAnswer(result.answer);
			delete errors[field.id];
		} else if (result.kind === 'empty') {
			session.clearAnswer(field.id);
			delete errors[field.id];
		} else {
			// The draft never carries an unacceptable answer; the text stays in
			// the control for correction.
			session.clearAnswer(field.id);
			errors[field.id] = result.message;
		}
		submitNote = null;
	}

	function markTouched(field: ServedPublicFormFieldDto): void {
		touched[field.id] = true;
	}

	function toggleChoice(
		field: Extract<ServedPublicFormFieldDto, { kind: 'multiselect' }>,
		optionId: string,
		checked: boolean
	): void {
		const current = listValue(field.id).filter((id) => id !== optionId);
		applyInput(field, checked ? [...current, optionId] : current);
	}

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!editable || submitPending) return;
		const blockers = publicApplicationSubmitBlockers(form, snapshot.answers);
		for (const blocker of blockers) {
			errors[blocker.fieldId] = errors[blocker.fieldId] ?? blocker.message;
			touched[blocker.fieldId] = true;
		}
		const blocked = form.fields.filter(
			(field) => (fieldStates.get(field.id)?.visible ?? true) && errors[field.id]
		);
		if (blocked.length > 0) {
			for (const field of blocked) touched[field.id] = true;
			submitNote =
				blocked.length === 1
					? '1 question needs attention before this can go in.'
					: `${blocked.length} questions need attention before this can go in.`;
			document.getElementById(controlId(blocked[0]!))?.focus();
			return;
		}
		submitNote = null;
		submitPending = true;
		try {
			const settled = await session.submit();
			if (settled.phase === 'submitted') {
				if (!completionReported) {
					completionReported = true;
					onSubmitted?.();
				}
				// This press settled on the completed ceremony: the transition
				// announces itself and hands focus to the receipt.
				await tick();
				doneRegion?.focus();
			} else if (settled.transport !== null) {
				submitNote = 'That didn’t go through — check your connection and try again.';
			}
		} finally {
			submitPending = false;
		}
	}

	// The input element each single-line field kind renders as; kinds with
	// their own element (textarea, select, multiselect, number, checkbox)
	// never reach this map.
	const inputTypes: Partial<Record<ServedPublicFormFieldDto['kind'], string>> = {
		text: 'text',
		email: 'email',
		url: 'url',
		phone: 'tel',
		date: 'date',
		datetime: 'datetime-local'
	};
</script>

{#snippet requiredMark(required: boolean)}
	{#if required}<span class="apply__required" aria-hidden="true">*</span><span class="apply__vh"
			>(required)</span
		>{/if}
{/snippet}

{#snippet fieldFoot(field: ServedPublicFormFieldDto)}
	{#if field.help}<p class="apply__help" id={helpId(field)}>{field.help}</p>{/if}
	{#if shownError(field)}
		<p class="apply__error" id={errorId(field)} role="status">{shownError(field)}</p>
	{/if}
{/snippet}

<div class="apply" style={brandStyle}>
	<article class="apply__page">
		<header class="apply__brand">
			{#if markText}<span class="apply__mark" aria-hidden="true">{markText}</span>{/if}
			<div class="apply__brand-lines">
				<span class="apply__event">{eventName}</span>
				{#if eventMeta}<span class="apply__dates">{eventMeta}</span>{/if}
			</div>
		</header>

		{#if submitted}
			<div class="apply__done" role="status" tabindex="-1" bind:this={doneRegion}>
				<p class="apply__done-title">Application received</p>
				{#each confirmationParagraphs as paragraph (paragraph)}
					<p class="apply__done-copy">{paragraph}</p>
				{/each}
				{#if submittedAtLabel}<p class="apply__done-meta">Submitted {submittedAtLabel}</p>{/if}
				<!-- The application-owned door to the participant portal: a
				     template can rewrite the confirmation paragraph above, never
				     this. The link carries no submission data, email, or token —
				     the entry page asks for the address itself. -->
				<div class="apply__door">
					<a
						class="apply__door-action"
						href="/portal/sign-in"
						target={presentation === 'embed' ? '_blank' : undefined}
						rel={presentation === 'embed' ? 'noopener' : undefined}>
						See your application
					</a>
					<p class="apply__door-copy">
						We’ll ask for your email and send a sign-in link. No password.
					</p>
				</div>
			</div>
		{:else}
			<form class="apply__body" aria-label={form.name} novalidate onsubmit={submit}>
				<div class="apply__hero">
					<p class="apply__title">{form.name}</p>
					{#if closeView}
						<div class="apply__close" aria-label="Application close time">
							<p class="apply__close-time">{closeView.closeLabel}</p>
							<p class="apply__close-zone">{closeView.timezoneLabel}</p>
						</div>
					{/if}
				</div>

				{#if terminalRefusal && terminalRefusal.kind !== 'target_no_longer_collecting'}
					<div class="apply__stop" role="status">
						<p class="apply__stop-title">{terminalRefusal.headline}</p>
						<p class="apply__stop-copy">{terminalRefusal.detail}</p>
					</div>
				{:else if startFailed}
					<div class="apply__stop" role="status">
						<p class="apply__stop-title">This form couldn’t load</p>
						<p class="apply__stop-copy">Check your connection and try again.</p>
						<button
							type="button"
							class="apply__retry"
							onclick={() => void session.start()}>Try again</button>
					</div>
				{/if}

				<section class="apply__section" aria-busy={starting || undefined}>
					<div class="apply__section-head">
						<p class="apply__section-title">Your proposal</p>
					</div>
					{#each visibleFields as field (field.id)}
						{#if field.kind === 'checkbox'}
							<div class="apply__field apply__field--checkbox">
								<input
									class="apply__checkbox"
									id={controlId(field)}
									type="checkbox"
									checked={controls[field.id] === true}
									disabled={controlsDisabled}
									aria-required={isRequired(field) || undefined}
									aria-invalid={shownError(field) ? 'true' : undefined}
									aria-describedby={describedBy(field)}
									onchange={(event) => applyInput(field, event.currentTarget.checked)}
									onblur={() => markTouched(field)}
								/>
								<div class="apply__checkbox-body">
									<label class="apply__label apply__label--checkbox" for={controlId(field)}>
										{field.label}{@render requiredMark(isRequired(field))}
									</label>
									{@render fieldFoot(field)}
								</div>
							</div>
						{:else if field.kind === 'multiselect'}
							{@const chosen = listValue(field.id)}
							{@const atCap = chosen.length >= field.maximumSelections}
							<fieldset
								class="apply__field apply__choices"
								aria-describedby={describedBy(field)}>
								<legend class="apply__label apply__choices-legend">
									{field.label}{@render requiredMark(isRequired(field))}
								</legend>
								<div class="apply__choice-list">
									{#each field.options as option (option.id)}
										{@const checkedHere = chosen.includes(option.id)}
										<label class="apply__choice">
											<input
												class="apply__checkbox"
												type="checkbox"
												checked={checkedHere}
												disabled={controlsDisabled || (!checkedHere && atCap)}
												onchange={(event) =>
													toggleChoice(field, option.id, event.currentTarget.checked)}
												onblur={() => markTouched(field)}
											/>
											<span class="apply__choice-label">{option.label}</span>
										</label>
									{/each}
								</div>
								{#if field.options.length > field.maximumSelections}
									<p class="apply__help">Choose up to {field.maximumSelections}.</p>
								{/if}
								{@render fieldFoot(field)}
							</fieldset>
						{:else}
							<div class="apply__field">
								<label class="apply__label" for={controlId(field)}>
									{field.label}{@render requiredMark(isRequired(field))}
								</label>
								{#if field.kind === 'textarea'}
									<textarea
										class="apply__control apply__textarea"
										id={controlId(field)}
										rows="4"
										value={textValue(field.id)}
										disabled={controlsDisabled}
										aria-required={isRequired(field) || undefined}
										aria-invalid={shownError(field) ? 'true' : undefined}
										aria-describedby={describedBy(field)}
										oninput={(event) => applyInput(field, event.currentTarget.value)}
										onblur={() => markTouched(field)}
									></textarea>
								{:else if field.kind === 'select'}
									<select
										class="apply__control apply__select"
										class:apply__select--blank={textValue(field.id) === ''}
										id={controlId(field)}
										value={textValue(field.id)}
										disabled={controlsDisabled}
										aria-required={isRequired(field) || undefined}
										aria-invalid={shownError(field) ? 'true' : undefined}
										aria-describedby={describedBy(field)}
										onchange={(event) => applyInput(field, event.currentTarget.value)}
										onblur={() => markTouched(field)}
									>
										<option value="">Select…</option>
										{#each field.options as option (option.id)}
											<option value={option.id}>{option.label}</option>
										{/each}
									</select>
								{:else if field.kind === 'number'}
									<input
										class="apply__control"
										id={controlId(field)}
										type="number"
										inputmode={field.integerOnly ? 'numeric' : 'decimal'}
										min={field.minimum ?? undefined}
										max={field.maximum ?? undefined}
										step={field.integerOnly ? 1 : 'any'}
										value={textValue(field.id)}
										disabled={controlsDisabled}
										aria-required={isRequired(field) || undefined}
										aria-invalid={shownError(field) ? 'true' : undefined}
										aria-describedby={describedBy(field)}
										oninput={(event) => applyInput(field, event.currentTarget.value)}
										onblur={() => markTouched(field)}
									/>
								{:else}
									<input
										class="apply__control"
										id={controlId(field)}
										type={inputTypes[field.kind] ?? 'text'}
										value={textValue(field.id)}
										disabled={controlsDisabled}
										aria-required={isRequired(field) || undefined}
										aria-invalid={shownError(field) ? 'true' : undefined}
										aria-describedby={describedBy(field)}
										oninput={(event) => applyInput(field, event.currentTarget.value)}
										onblur={() => markTouched(field)}
									/>
								{/if}
								{@render fieldFoot(field)}
							</div>
						{/if}
					{/each}
				</section>

				{#if reoffer}
					<div class="apply__reoffer" role="status">
						<p class="apply__reoffer-title">{reoffer.headline}</p>
						{#if reoffer.reason}<p class="apply__reoffer-reason">{reoffer.reason}</p>{/if}
						<ul class="apply__reoffer-exits">
							<li>{reoffer.exits.retarget}</li>
							<li>{reoffer.exits.spawn}</li>
						</ul>
					</div>
				{/if}
				{#if inlineRefusal}
					<div
						class="apply__note"
						class:apply__note--refused={inlineRefusal.kind !== 'draft_changed'}
						role="status">
						<p class="apply__note-title">{inlineRefusal.headline}</p>
						<p class="apply__note-copy">{inlineRefusal.detail}</p>
					</div>
				{/if}
				{#if submitNote}
					<p class="apply__note apply__note--refused" role="status">{submitNote}</p>
				{/if}

				<p class="apply__actions">
					<button
						type="submit"
						class="apply__submit"
						disabled={!editable || submitPending}
						aria-busy={submitPending || submitting || undefined}>
						{submitPending || submitting ? 'Submitting…' : 'Submit application'}
					</button>
					{#if saveStatus}
						<span
							class="apply__save"
							class:apply__save--offline={saveStatus.kind === 'offline'}
							role="status">{saveStatus.label}</span>
					{/if}
				</p>
			</form>
		{/if}

		<footer class="apply__footer">
			<p class="apply__footer-event">{eventName}</p>
			{#if eventMeta}<p class="apply__footer-meta">{eventMeta}</p>{/if}
		</footer>
	</article>
</div>

<style>
	/*
	 * The same artifact scale FormSurfaceRender established: the page carries
	 * its own 16px type base because an applicant's browser never sees the
	 * operator's density preference. The ground is the brand canvas with form
	 * sections as surface cards on it.
	 */
	.apply {
		background: transparent;
	}

	.apply__page {
		display: grid;
		gap: var(--je-space-6);
		margin-inline: auto;
		background: var(--je-color-canvas);
		color: var(--je-color-text);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-8) var(--je-space-6);
		font-family: var(--je-font-body);
		font-size: 16px;
		line-height: 1.5;
	}

	.apply__brand {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		padding-block-end: var(--je-space-4);
		border-block-end: 1px solid var(--je-color-border);
	}

	.apply__mark {
		display: grid;
		place-items: center;
		inline-size: 2.25rem;
		block-size: 2.25rem;
		flex-shrink: 0;
		background: var(--je-color-action);
		color: var(--je-color-action-contrast);
		border-radius: var(--je-radius-control);
		font-size: 0.875em;
		font-weight: 750;
		letter-spacing: 0.02em;
	}

	.apply__brand-lines {
		display: grid;
		gap: 2px;
		min-inline-size: 0;
	}

	.apply__event {
		font-size: 0.875em;
		font-weight: 650;
	}

	.apply__dates {
		font-size: 0.8125em;
		color: var(--je-color-text-muted);
	}

	.apply__body {
		display: grid;
		gap: var(--je-space-5);
	}

	.apply__hero {
		display: grid;
		gap: var(--je-space-2);
	}

	.apply__close {
		display: grid;
		gap: var(--je-space-1);
		margin-block-start: var(--je-space-3);
		padding: var(--je-space-3) var(--je-space-4);
		border-inline-start: 3px solid var(--je-color-action);
		background: var(--je-color-surface-subtle);
	}

	.apply__close p {
		margin: 0;
	}

	.apply__close-time {
		font-weight: 700;
	}

	.apply__close-zone {
		color: var(--je-color-text-muted);
		font-size: 0.875rem;
	}

	.apply__title {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: 1.75em;
		font-weight: 700;
		line-height: var(--je-leading-tight);
		text-wrap: balance;
	}

	/* A stopped ceremony's one honest panel: headline, sentence, and (for a
	   load failure) the retry. It sits above the questions, which stay
	   visible and disabled — they are still the real questions. */
	.apply__stop {
		display: grid;
		gap: var(--je-space-2);
		justify-items: start;
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-4);
	}

	.apply__stop-title {
		margin: 0;
		font-weight: 650;
	}

	.apply__stop-copy {
		margin: 0;
		font-size: 0.9375em;
		color: var(--je-color-text-muted);
	}

	.apply__retry {
		display: inline-flex;
		align-items: center;
		block-size: var(--je-control-height);
		padding-inline: var(--je-space-4);
		background: var(--je-color-action-soft);
		color: var(--je-color-text);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		font-family: inherit;
		font-size: 0.9375em;
		font-weight: 650;
		cursor: pointer;
	}

	.apply__retry:hover {
		background: var(--je-color-action-soft-hover);
	}

	.apply__retry:focus-visible {
		outline: 2px solid var(--je-color-focus);
		outline-offset: 1px;
	}

	.apply__section {
		display: grid;
		gap: var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-6);
	}

	.apply__section-head {
		display: grid;
		gap: var(--je-space-1);
	}

	.apply__section-title {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: 1.125em;
		font-weight: 700;
		line-height: var(--je-leading-snug);
	}

	.apply__field {
		display: grid;
		gap: var(--je-space-2);
	}

	.apply__label {
		font-size: 0.875em;
		font-weight: 650;
		line-height: var(--je-leading-snug);
	}

	.apply__required {
		color: var(--je-color-action);
		font-weight: 650;
		margin-inline-start: 0.15em;
	}

	/* Visually hidden, read by assistive tech: the asterisk alone is decoration. */
	.apply__vh {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}

	.apply__control {
		inline-size: 100%;
		block-size: var(--je-control-height);
		padding-inline: var(--je-space-3);
		background: var(--je-color-surface);
		color: var(--je-color-text);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		font-family: inherit;
		font-size: 1em;
		line-height: var(--je-leading-normal);
	}

	.apply__control:focus-visible {
		outline: 2px solid var(--je-color-focus);
		outline-offset: 1px;
	}

	.apply__control[aria-invalid='true'] {
		border-color: var(--je-color-danger);
	}

	/* Disabled is a real state here — before the ceremony is ready, after it
	   stops — and it must read differently from an editable control. */
	.apply__control:disabled {
		background: var(--je-color-surface-sunken);
		opacity: 1;
	}

	.apply__textarea {
		block-size: auto;
		min-block-size: 7rem;
		padding: var(--je-space-2) var(--je-space-3);
		resize: vertical;
	}

	/* The same chevron the product's selects draw, at the artifact's own
	   scale, in `em` so it stays proportional to this page's 16px base. */
	.apply__select {
		appearance: none;
		padding-inline-end: calc(var(--je-space-3) + 1.35em);
		background-image:
			linear-gradient(45deg, transparent 50%, var(--je-color-text-muted) 50%),
			linear-gradient(135deg, var(--je-color-text-muted) 50%, transparent 50%);
		background-position:
			calc(100% - var(--je-space-3) - 0.55em) 50%,
			calc(100% - var(--je-space-3) - 0.3em) 50%;
		background-repeat: no-repeat;
		background-size: 0.3em 0.3em;
	}

	/* An unchosen select reads as a placeholder, like an untouched form. */
	.apply__select--blank {
		color: var(--je-color-text-muted);
	}

	.apply__choices {
		margin: 0;
		padding: 0;
		border: 0;
		min-inline-size: 0;
	}

	.apply__choices-legend {
		padding: 0;
		/* Legends need an explicit boundary from their collection; fieldset
		   formatting does not honor a parent layout gap around the legend. */
		margin-block-end: var(--je-space-3);
	}

	.apply__choice-list {
		display: grid;
		gap: var(--je-space-2);
	}

	.apply__choice {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--je-space-3);
		align-items: start;
		min-block-size: 1.5rem;
	}

	.apply__choice-label {
		font-size: 0.9375em;
		line-height: var(--je-leading-normal);
	}

	.apply__field--checkbox {
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--je-space-3);
		align-items: start;
	}

	.apply__checkbox {
		inline-size: 1.0625rem;
		block-size: 1.0625rem;
		margin: 0;
		margin-block-start: 0.2em;
		accent-color: var(--je-color-action);
	}

	.apply__checkbox:focus-visible {
		outline: 2px solid var(--je-color-focus);
		outline-offset: 1px;
	}

	.apply__checkbox-body {
		display: grid;
		gap: var(--je-space-1);
		min-inline-size: 0;
	}

	.apply__label--checkbox {
		font-size: 0.9375em;
		font-weight: 500;
		line-height: var(--je-leading-normal);
	}

	.apply__help {
		margin: 0;
		font-size: 0.8125em;
		line-height: var(--je-leading-snug);
		color: var(--je-color-text-muted);
	}

	/* The reviewed sentence beside the field it refuses. */
	.apply__error {
		margin: 0;
		font-size: 0.8125em;
		line-height: var(--je-leading-snug);
		color: var(--je-color-danger);
	}

	/* Why something cannot be done, in place: a stated reason is muted, a
	   refused attempt is louder. Same pattern the portal's RefusalNote set. */
	.apply__note {
		margin: 0;
		display: grid;
		gap: var(--je-space-1);
		font-size: 0.875em;
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.apply__note-title {
		margin: 0;
		font-weight: 650;
		color: var(--je-color-text);
	}

	.apply__note-copy {
		margin: 0;
	}

	.apply__note--refused,
	.apply__note--refused .apply__note-title {
		color: var(--je-color-danger);
	}

	/* The recorded filled-target re-offer: headline, the per-case reason when
	   served, and the two exits. */
	.apply__reoffer {
		display: grid;
		gap: var(--je-space-2);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-4);
	}

	.apply__reoffer-title {
		margin: 0;
		font-weight: 650;
	}

	.apply__reoffer-reason {
		margin: 0;
		font-size: 0.9375em;
		color: var(--je-color-text-muted);
	}

	.apply__reoffer-exits {
		margin: 0;
		padding-inline-start: var(--je-space-5);
		display: grid;
		gap: var(--je-space-1);
		font-size: 0.9375em;
	}

	.apply__actions {
		margin: 0;
		display: flex;
		align-items: center;
		gap: var(--je-space-4);
	}

	.apply__submit,
	.apply__door-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		block-size: var(--je-control-height);
		padding-inline: var(--je-space-6);
		background: var(--je-color-action);
		color: var(--je-color-action-contrast);
		border-radius: var(--je-radius-control);
		font-family: inherit;
		font-size: 1em;
		font-weight: 650;
	}

	.apply__submit {
		border: 0;
		cursor: pointer;
	}

	.apply__submit:hover:enabled,
	.apply__door-action:hover {
		background: var(--je-color-action-hover);
	}

	.apply__submit:active:enabled,
	.apply__door-action:active {
		background: var(--je-color-action-active);
	}

	.apply__submit:focus-visible,
	.apply__door-action:focus-visible {
		outline: 2px solid var(--je-color-focus);
		outline-offset: 2px;
	}

	.apply__submit:disabled {
		opacity: 0.55;
		cursor: default;
	}

	/* In flight is not switched off: the press was taken and the label says so. */
	.apply__submit[aria-busy='true'] {
		opacity: 1;
	}

	/* The quiet autosave line; one line tall in every state so the actions
	   row never moves. */
	.apply__save {
		font-size: 0.8125em;
		line-height: var(--je-leading-snug);
		color: var(--je-color-text-muted);
		min-block-size: 1lh;
	}

	.apply__save--offline {
		color: var(--je-color-danger);
	}

	/* The confirmation panel keeps the artifact's footprint rather than
	   collapsing to a single line. */
	.apply__done {
		display: grid;
		gap: var(--je-space-3);
		align-content: start;
		min-block-size: 16rem;
		padding-block: var(--je-space-4);
	}

	.apply__done-title {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: 1.5em;
		font-weight: 700;
		line-height: var(--je-leading-tight);
	}

	.apply__done-copy {
		margin: 0;
		max-inline-size: 62ch;
		line-height: var(--je-leading-normal);
	}

	.apply__done-meta {
		margin: 0;
		font-size: 0.875em;
		color: var(--je-color-text-muted);
	}

	/* Programmatic focus lands here after submit; the panel is not a tab stop
	   a keyboard user chose, so it draws no ring of its own. */
	.apply__done:focus {
		outline: none;
	}

	/* The portal door is its own group under the receipt: the panel's own gap
	   plus this margin adds up to the group-to-group tier, so the door reads
	   as the next thing rather than another receipt line. */
	.apply__door {
		display: grid;
		gap: var(--je-space-2);
		justify-items: start;
		margin-block-start: var(--je-space-3);
	}

	/* Same control the submit button was: the action colour moves from
	   "send it" to the one thing left to do here. */
	.apply__door-action {
		text-decoration: none;
	}

	.apply__door-copy {
		margin: 0;
		font-size: 0.875em;
		line-height: var(--je-leading-snug);
		color: var(--je-color-text-muted);
	}

	.apply__footer {
		display: grid;
		gap: var(--je-space-1);
		padding-block-start: var(--je-space-4);
		border-block-start: 1px solid var(--je-color-border);
	}

	.apply__footer-event {
		margin: 0;
		font-size: 0.875em;
		font-weight: 650;
	}

	.apply__footer-meta {
		margin: 0;
		font-size: 0.8125em;
		color: var(--je-color-text-muted);
	}

	@media (max-width: 560px) {
		.apply__page {
			padding: var(--je-space-6) var(--je-space-4);
			gap: var(--je-space-5);
		}

		.apply__section {
			padding: var(--je-space-4);
		}
	}
</style>
