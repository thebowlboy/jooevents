<script lang="ts">
	import { themeStyleProperties } from '$lib/theme/theme-contract';
	import { excerpt, unitAttributes } from './inline-edit';
	import { compileTextStyle } from './text-style';
	import type { EventTheme, SurfaceField, SurfaceTemplate } from '$lib/api/types';

	interface Props {
		template: SurfaceTemplate;
		theme: EventTheme;
		eventName: string;
		/** e.g. "12–14 Oct 2026 · New York City"; empty hides the header and footer meta lines. */
		eventMeta: string;
		/**
		 * Renders prose, questions, and the submit label as addressable
		 * `data-edit` units for the template editor's click-to-edit host — a
		 * question unit opens the field registry's editor. Off by default so
		 * every other consumer of this preview stays inert.
		 */
		editable?: boolean;
		/**
		 * Whether the surface paints its own surroundings.
		 *
		 * `page` is the editor's preview: a muted backdrop standing in for the
		 * browser viewport around the published page. `bare` is what a host page
		 * gets — the page alone, because in an embed the surroundings belong to
		 * somebody else's site, and painting our own there is the one thing that
		 * makes an embed look bolted on rather than part of the page.
		 */
		frame?: 'page' | 'bare';
		/**
		 * Who is looking. `preview` is an organizer judging the artifact;
		 * `published` is a visitor on the hosted page, where calling the surface
		 * a preview would be simply untrue. It changes the accessible name that
		 * explains why the controls take no input, and nothing else — the reason
		 * they are inert is the same in both, and the page above states it.
		 */
		context?: 'preview' | 'published';
	}

	let {
		template,
		theme,
		eventName,
		eventMeta,
		editable = false,
		frame = 'page',
		context = 'preview'
	}: Props = $props();

	const submitLabel = $derived(template.submitLabel ?? 'Submit application');

	// Control ids are namespaced per component instance so two previews on one
	// page keep their label associations distinct.
	const uid = $props.id();

	// The event brand is applied as custom properties on this component's root
	// only, so every --je-* consumption inside the preview resolves to the brand
	// while the surrounding operator app keeps its own theme untouched.
	const brandStyle = $derived(
		Object.entries(themeStyleProperties(theme))
			.map(([token, value]) => `${token}: ${value}`)
			.join('; ')
	);

	const markText = $derived(theme.markText || eventName.trim().charAt(0).toUpperCase());

	const pool = $derived(template.fields ?? []);

	/** Resolves a section's fieldRefs against the pool; unknown refs are skipped. */
	function fieldsOf(refs: string[]): SurfaceField[] {
		return refs.flatMap((ref) => {
			const field = pool.find((entry) => entry.id === ref);
			return field ? [field] : [];
		});
	}

	function controlId(field: SurfaceField): string {
		return `${uid}-${field.id}`;
	}

	// The input element each single-line field kind previews as; kinds with
	// their own element (textarea, select, multiselect, checkbox) never reach
	// this map.
	const inputTypes: Partial<Record<SurfaceField['kind'], string>> = {
		text: 'text',
		email: 'email',
		url: 'url',
		phone: 'tel',
		number: 'number',
		date: 'date',
		datetime: 'datetime-local',
		file: 'file'
	};
</script>

{#snippet requiredMark(field: SurfaceField)}
	{#if field.required}<span class="form__required" aria-hidden="true">*</span><span
			class="form__vh">(required)</span
		>{/if}
{/snippet}

<div class="form" class:form--bare={frame === 'bare'} style={brandStyle}>
	<article class="form__page">
		<header class="form__brand">
			{#if markText}<span class="form__mark" aria-hidden="true">{markText}</span>{/if}
			<div class="form__brand-lines">
				<span class="form__event">{eventName}</span>
				{#if eventMeta}<span class="form__dates">{eventMeta}</span>{/if}
			</div>
		</header>

		<!-- One wrapper announces the whole preview as inert; every control is
		     additionally disabled. The controls keep their live look because the
		     artifact being previewed is an open, fillable form. In editable mode
		     a question is pressable — it opens the field's registry editor — but
		     the controls themselves still take no input. -->
		<div
			class="form__body"
			role="group"
			aria-label={editable
				? 'Preview — press a question to edit it'
				: context === 'published'
					? 'The questions this call asks — not yet accepting answers'
					: 'Preview — fields are not interactive'}>
			{#each template.blocks as block, index (index)}
				{#if block.type === 'hero'}
					<div class="form__hero">
						<p
							{...unitAttributes(editable, 'form__title', `blocks.${index}.title`, excerpt(block.title))}
							style={compileTextStyle('hero-title', block.titleStyle)}>
							{block.title}
						</p>
						{#if block.intro}
							<p
								{...unitAttributes(editable, 'form__intro', `blocks.${index}.intro`, excerpt(block.intro))}
								style={compileTextStyle('hero-intro', block.introStyle)}>
								{block.intro}
							</p>
						{/if}
					</div>
				{:else if block.type === 'form-section'}
					<section class="form__section">
						<div class="form__section-head">
							<p {...unitAttributes(editable, 'form__section-title', `blocks.${index}.title`, excerpt(block.title))}>
								{block.title}
							</p>
							{#if block.description}
								<p {...unitAttributes(editable, 'form__section-desc', `blocks.${index}.description`, excerpt(block.description))}>
									{block.description}
								</p>
							{/if}
						</div>
						{#each fieldsOf(block.fieldRefs) as field (field.id)}
							{#if field.kind === 'checkbox'}
								<div
									{...unitAttributes(
										editable,
										'form__field form__field--checkbox',
										`fields.${field.id}`,
										excerpt(field.label),
										'block'
									)}>
									<input
										class="form__checkbox"
										id={controlId(field)}
										type="checkbox"
										disabled
										aria-disabled="true"
									/>
									<div class="form__checkbox-body">
										<label class="form__label form__label--checkbox" for={controlId(field)}>
											{field.label}{@render requiredMark(field)}
										</label>
										{#if field.help}<p class="form__help">{field.help}</p>{/if}
									</div>
								</div>
							{:else}
								<div
									{...unitAttributes(
										editable,
										'form__field',
										`fields.${field.id}`,
										excerpt(field.label),
										'block'
									)}>
									<label class="form__label" for={controlId(field)}>
										{field.label}{@render requiredMark(field)}
									</label>
									{#if field.kind === 'textarea'}
										<textarea
											class="form__control form__textarea"
											id={controlId(field)}
											rows="4"
											disabled
											aria-disabled="true"
										></textarea>
									{:else if field.kind === 'select' || field.kind === 'multiselect'}
										<select
											class="form__control form__select"
											id={controlId(field)}
											multiple={field.kind === 'multiselect'}
											disabled
											aria-disabled="true"
										>
											{#if field.kind === 'select'}<option value="">Select…</option>{/if}
											{#each field.options ?? [] as option (option)}
												<option value={option}>{option}</option>
											{/each}
										</select>
									{:else}
										<input
											class="form__control"
											id={controlId(field)}
											type={inputTypes[field.kind] ?? 'text'}
											disabled
											aria-disabled="true"
										/>
									{/if}
									{#if field.help}<p class="form__help">{field.help}</p>{/if}
								</div>
							{/if}
						{/each}
					</section>
				{:else if block.type === 'note'}
					<p class="form__note" style={compileTextStyle('note', block.style)}>{block.text}</p>
				{/if}
			{/each}

			<p class="form__actions">
				{#if editable}
					<!-- The same visual as the inert button, but a disabled control
					     swallows presses — the unit renders as a span so the press
					     reaches the editor host. -->
					<span {...unitAttributes(true, 'form__submit', 'submitLabel', excerpt(submitLabel), 'block')}>
						{submitLabel}
					</span>
				{:else}
					<button type="button" class="form__submit" disabled aria-disabled="true">
						{submitLabel}
					</button>
				{/if}
			</p>
		</div>

		<footer class="form__footer">
			<p class="form__footer-event">{eventName}</p>
			{#if eventMeta}<p class="form__footer-meta">{eventMeta}</p>{/if}
		</footer>
	</article>
</div>

<style>
	/* The muted backdrop reads as a browser viewport around the published form,
	   tinted from the brand's own canvas so a wild recipe stays coherent. */
	.form {
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-8) var(--je-space-4);
	}

	/*
	 * The page carries its own type scale, in px, and deliberately does not use
	 * the `--je-font-size-*` tokens the rest of the app runs on: those scale
	 * with the operator's density preference, which an applicant's browser never
	 * sees. This preview shows the artifact, not the app around it — the same
	 * rule EmailRender established. The page ground is the brand canvas, with
	 * form sections as surface cards on it, matching the real public form.
	 */
	.form__page {
		display: grid;
		gap: var(--je-space-6);
		max-inline-size: 600px;
		margin-inline: auto;
		background: var(--je-color-canvas);
		color: var(--je-color-text);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		box-shadow: var(--je-shadow-sm);
		padding: var(--je-space-8) var(--je-space-6);
		font-family: var(--je-font-body);
		font-size: 16px;
		line-height: 1.5;
	}

	.form__brand {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		padding-block-end: var(--je-space-4);
		border-block-end: 1px solid var(--je-color-border);
	}

	.form__mark {
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

	.form__brand-lines {
		display: grid;
		gap: 2px;
		min-inline-size: 0;
	}

	.form__event {
		font-size: 0.875em;
		font-weight: 650;
	}

	.form__dates {
		font-size: 0.8125em;
		color: var(--je-color-text-muted);
	}

	.form__body {
		display: grid;
		gap: var(--je-space-5);
	}

	.form__hero {
		display: grid;
		gap: var(--je-space-2);
	}

	.form__title {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: 1.75em;
		font-weight: 700;
		line-height: var(--je-leading-tight);
		text-wrap: balance;
	}

	.form__intro {
		margin: 0;
		font-size: 1em;
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.form__section {
		display: grid;
		gap: var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-6);
	}

	.form__section-head {
		display: grid;
		gap: var(--je-space-1);
	}

	.form__section-title {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: 1.125em;
		font-weight: 700;
		line-height: var(--je-leading-snug);
	}

	.form__section-desc {
		margin: 0;
		font-size: 0.875em;
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.form__field {
		display: grid;
		gap: var(--je-space-2);
	}

	/* The annotated preview field owns the press. Disabled controls can suppress
	   their click entirely instead of allowing the delegated editor handler to
	   observe it, so editable-preview descendants remain visually present but
	   do not become pointer targets. */
	.form__field:global(.ui-editable) * {
		pointer-events: none;
	}

	.form__label {
		font-size: 0.875em;
		font-weight: 650;
		line-height: var(--je-leading-snug);
	}

	.form__required {
		color: var(--je-color-action);
		font-weight: 650;
		margin-inline-start: 0.15em;
	}

	/* Visually hidden, read by assistive tech: the asterisk alone is decoration. */
	.form__vh {
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

	/*
	 * Controls are disabled for inertness but keep the live form's appearance:
	 * the artifact being previewed is an open form, so the browser's dimmed
	 * disabled styling would misrepresent it. Opacity and colors are restored
	 * explicitly.
	 */
	.form__control {
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
		opacity: 1;
	}

	.form__textarea {
		block-size: auto;
		min-block-size: 7rem;
		padding: var(--je-space-2) var(--je-space-3);
		resize: none;
	}

	/* The unchosen select reads as a placeholder, like an untouched live form. */
	/*
	 * The same chevron the product's own selects draw, in the artifact's own
	 * scale. The native control was the odd one out: a UA arrow is painted
	 * against the border box, so `padding-inline` cannot move it and it sits
	 * hard against the edge — which is both cramped and a second visual answer
	 * to a question the design system has already answered.
	 *
	 * Geometry is `em` rather than `rem` on purpose: this page declares its own
	 * 16px base and must not inherit the operator's density scale, so the
	 * chevron has to stay proportional to the artifact rather than to the app.
	 * The values are the design system's, converted at that base.
	 */
	.form__select {
		color: var(--je-color-text-muted);
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

	/* A multi-select is an open list, not a collapsed one: it has no chevron to
	   draw and no gutter to reserve for it. */
	.form__select[multiple] {
		appearance: auto;
		padding-inline-end: var(--je-space-3);
		background-image: none;
	}

	/* A multi-select shows a few options at rest instead of one collapsed row. */
	.form__select[multiple] {
		block-size: auto;
		min-block-size: calc(var(--je-control-height) * 1.75);
		padding-block: var(--je-space-2);
	}

	.form__field--checkbox {
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--je-space-3);
		align-items: start;
	}

	.form__checkbox {
		inline-size: 1.0625rem;
		block-size: 1.0625rem;
		margin: 0;
		margin-block-start: 0.2em;
		accent-color: var(--je-color-action);
		opacity: 1;
	}

	.form__checkbox-body {
		display: grid;
		gap: var(--je-space-1);
		min-inline-size: 0;
	}

	.form__label--checkbox {
		font-size: 0.9375em;
		font-weight: 500;
		line-height: var(--je-leading-normal);
	}

	.form__help {
		margin: 0;
		font-size: 0.8125em;
		line-height: var(--je-leading-snug);
		color: var(--je-color-text-muted);
	}

	.form__note {
		margin: 0;
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-3) var(--je-space-4);
		font-size: 0.875em;
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.form__actions {
		margin: 0;
		display: flex;
	}

	/* The applicant's submit button in the action color; inert here by design,
	   so no hover/active repaint — the real form owns those states. */
	.form__submit {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		block-size: var(--je-control-height);
		padding-inline: var(--je-space-6);
		background: var(--je-color-action);
		color: var(--je-color-action-contrast);
		border: 0;
		border-radius: var(--je-radius-control);
		font-family: inherit;
		font-size: 1em;
		font-weight: 650;
		cursor: default;
		opacity: 1;
	}

	.form__footer {
		display: grid;
		gap: var(--je-space-1);
		padding-block-start: var(--je-space-4);
		border-block-start: 1px solid var(--je-color-border);
	}

	.form__footer-event {
		margin: 0;
		font-size: 0.875em;
		font-weight: 650;
	}

	.form__footer-meta {
		margin: 0;
		font-size: 0.8125em;
		color: var(--je-color-text-muted);
	}

	@media (max-width: 560px) {
		.form {
			padding: var(--je-space-4) var(--je-space-2);
		}

		.form__page {
			padding: var(--je-space-6) var(--je-space-4);
			gap: var(--je-space-5);
		}

		.form__section {
			padding: var(--je-space-4);
		}
	}

	/*
	 * Bare: the page alone. Only the preview's own surroundings come off; every
	 * decision inside is unchanged.
	 */
	.form--bare {
		background: transparent;
		border: 0;
		border-radius: 0;
		padding: 0;
	}

	.form--bare .form__page {
		max-inline-size: none;
		box-shadow: none;
	}
</style>
