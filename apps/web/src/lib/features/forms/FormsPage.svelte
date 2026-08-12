<script lang="ts">
	import { onMount } from 'svelte';
	import { Field, Modal, statusIcon } from '$lib/ui';
	import type { IconComponent } from '$lib/ui';
	import { useWorkspaceGateway } from '$lib/api/workspace-gateway';
	import type { FormSummary, FormTarget } from '$lib/api/types';

	const { api } = useWorkspaceGateway();

	let forms = $state<FormSummary[] | null>(null);
	let newFormOpen = $state(false);
	let intent = $state('');

	onMount(async () => {
		forms = await api.forms.list();
	});

	// Plain-language target labels: the badge says what the form collects for,
	// not which internal target it carries.
	const targetView: Record<FormTarget, { label: string; tone: string }> = {
		general: { label: 'Open CFP', tone: 'sea' },
		category: { label: 'Category pool', tone: 'lavender' },
		slot: { label: 'Specific slot', tone: 'lavender' },
		evergreen: { label: 'Evergreen', tone: 'neutral' }
	};

	const statusLabel: Record<FormSummary['status'], string> = {
		open: 'Open',
		closed: 'Closed',
		draft: 'Draft'
	};

	/* Replaces the status dot: the glyph says which of the three states this is,
	   where a coloured dot only said that there was one. */
	const statusGlyph: Record<FormSummary['status'], IconComponent> = {
		open: statusIcon.formOpen,
		closed: statusIcon.formClosed,
		draft: statusIcon.draft
	};

	const stubTitle = 'Arrives with the form builder slice';

	function countLabel(count: number, singular: string) {
		return `${count} ${count === 1 ? singular : `${singular}s`}`;
	}
</script>

<div class="head">
	<!-- The forms' outgoing look lives with the templates: this door opens the
	     shared brand tab rather than growing a second styling surface here. -->
	<a
		class="ui-button ui-button--ghost ui-button--sm"
		href="/app/templates?tab=brand"
		aria-label="Brand &amp; style — Templates">
		Brand &amp; style
	</a>
	<button
		type="button"
		class="ui-button ui-button--primary ui-button--sm head__new"
		aria-haspopup="dialog"
		onclick={() => (newFormOpen = true)}>New form</button>
</div>

<section class="list" aria-label="Forms" aria-busy={!forms}>
	{#if !forms}
		<!-- The card's own composition with skeleton fills, so the grid holds the
		     footprint the resolved cards give it. -->
		<div class="cards" aria-hidden="true">
			{#each Array(3) as _, index (index)}
				<article class="card">
					<div class="card__head">
						<p class="card__name"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></p>
						<span class="ui-skeleton skeleton-chip"></span>
					</div>
					<p class="card__status"><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></p>
					<p class="card__meta"><span class="ui-skeleton skeleton-line" style="inline-size: 12rem"></span></p>
					<div class="card__actions">
						<span class="ui-skeleton skeleton-action"></span>
						<span class="ui-skeleton skeleton-action"></span>
					</div>
				</article>
			{/each}
		</div>
	{:else if forms.length === 0}
		<div class="empty">
			<h2 class="empty__title">No forms yet</h2>
			<p class="empty__copy">
				Describe what you want to collect and the form is drafted for you, or start from a blank
				form and add the fields yourself.
			</p>
			<button
				type="button"
				class="ui-button ui-button--primary ui-button--sm"
				aria-haspopup="dialog"
				onclick={() => (newFormOpen = true)}>New form</button>
		</div>
	{:else}
		<div class="cards">
			{#each forms as form (form.id)}
				{@const target = targetView[form.target]}
				{@const Status = statusGlyph[form.status]}
				<article class="card">
					<div class="card__head">
						<h2 class="card__name">{form.name}</h2>
						<span class="ui-badge ui-badge--{target.tone}">{target.label}</span>
					</div>
					<p class="card__status">
						<span class="card__glyph card__glyph--{form.status}" aria-hidden="true"
							><Status size={14} /></span
						>
						{statusLabel[form.status]}
						{#if form.status === 'open'}
							{#if form.closesRelative}
								· <span class="card__closes">{form.closesRelative}</span>
							{:else}
								· <span class="card__rolling">no close date</span>
							{/if}
						{/if}
					</p>
					<p class="card__meta">
						Version {form.version} · {countLabel(form.submissionCount, 'submission')} · {countLabel(
							form.fieldCount,
							'field'
						)}
					</p>
					<div class="card__actions">
						<button
							type="button"
							class="ui-button ui-button--secondary ui-button--sm"
							disabled
							title={stubTitle}>Edit</button>
						<button
							type="button"
							class="ui-button ui-button--secondary ui-button--sm"
							disabled
							title={stubTitle}>Preview</button>
					</div>
				</article>
			{/each}
		</div>
	{/if}
</section>

<p class="mix">
	One event can run several forms at the same time: an open call, a pool for a category that has
	no date yet, a form for one specific slot, and an evergreen form that never closes. Each form
	carries its own target, and accepted submissions follow that target.
</p>

<Modal bind:open={newFormOpen} title="New form">
	<div class="paths">
		<div class="path">
			<Field
				id="new-form-intent"
				label="Describe what this form collects"
				description="Plain language is enough — fields, help text, and conditional rules come out of it.">
				{#snippet children({ id, describedBy })}
					<textarea
						class="ui-textarea"
						{id}
						aria-describedby={describedBy}
						rows="4"
						placeholder="Describe what you want to collect — e.g. talk submissions with a workshop equipment question"
						bind:value={intent}></textarea>
				{/snippet}
			</Field>
			<div class="path__foot">
				<button type="button" class="ui-button ui-button--primary ui-button--sm" disabled>
					Draft the form
				</button>
				<p class="path__hint">Drafting arrives with the form-builder slice</p>
			</div>
		</div>

		<div class="path">
			<p class="path__copy">
				Prefer to build it yourself? Add fields one at a time and keep full control of the wording.
			</p>
			<div class="path__foot">
				<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled>
					Start from a blank form
				</button>
				<p class="path__hint">The field-by-field builder arrives with the same slice</p>
			</div>
		</div>
	</div>

	{#snippet footer(close: () => void)}
		<button type="button" class="ui-button ui-button--secondary ui-button--sm" onclick={close}>
			Close
		</button>
	{/snippet}
</Modal>

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--je-space-2);
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
		gap: var(--je-space-4);
	}

	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, a chip is badge-height, an action
	   is control-height. Free-standing sized rectangles drift; these cannot. */
	.skeleton-line {
		display: inline-block;
		block-size: 1em;
		/* One line box exactly: the line inherits the height it stands in for. */
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	/* Centred rather than baseline-aligned: an empty fill has no text baseline,
	   and aligning its bottom edge to one would deepen the head. */
	.skeleton-chip {
		display: inline-block;
		align-self: center;
		block-size: 1.35rem;
		inline-size: 5rem;
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 4.5rem;
		border-radius: var(--je-radius-control);
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-2);
		min-block-size: 9.5rem;
		padding: var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.card__head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-2);
	}

	.card__name {
		margin: 0;
		flex: 1 1 10rem;
		min-inline-size: 0;
		font-size: var(--je-font-size-base);
		font-weight: 600;
		line-height: var(--je-leading-snug);
	}

	.card__status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1);
		margin: 0;
		font-size: var(--je-font-size-md);
	}

	/* Replaces the former status dot. A dot could only say "there is a state";
	   the glyph says which one, so the word beside it is confirmed rather than
	   decoded. Open is the only status that earns status ink — closed and draft
	   are ordinary facts, not conditions needing a response. */
	.card__glyph {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		color: var(--je-color-text-subtle);
	}

	.card__glyph--open {
		color: var(--je-color-success);
	}

	.card__closes {
		color: var(--je-color-warning);
		font-weight: 600;
	}

	.card__rolling {
		color: var(--je-color-text-muted);
	}

	.card__meta {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.card__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin-block-start: auto;
	}

	.empty {
		display: grid;
		justify-items: start;
		gap: var(--je-space-3);
		min-block-size: 9.5rem;
		align-content: center;
		padding: var(--je-space-8);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.empty__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 600;
	}

	.empty__copy {
		margin: 0;
		max-inline-size: 52ch;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.mix {
		margin: 0;
		max-inline-size: 78ch;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* Both authoring paths are visible at once: the described-intent path and
	   the blank form carry equal weight in the dialog. */
	.paths {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-6);
	}

	.path {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-2);
	}

	.path + .path {
		border-block-start: 1px solid var(--je-color-border);
		padding-block-start: var(--je-space-6);
	}

	.path__copy {
		margin: 0;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.path__foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.path__hint {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	@media (max-width: 920px) {
		.head__new {
			inline-size: 100%;
		}

		.cards {
			grid-template-columns: 1fr;
		}

		.empty {
			padding: var(--je-space-6) var(--je-space-4);
		}
	}
</style>
