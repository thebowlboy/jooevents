<script lang="ts">
	/**
	 * Naming a new template and choosing what shape it starts as.
	 *
	 * One step, not a ceremony: a name and what kind of thing it is. It lives
	 * here, beside the kind registry's other consumers, because both doors that
	 * open it — the composer's picker and the Templates library — are authoring
	 * a template, and the kind cards must read identically wherever they appear.
	 *
	 * It owns the fields and the busy/refusal state but not the chrome: each
	 * host frames it its own way (the composer swaps its modal's content, the
	 * library opens a dialog) and drives Create from its own footer through the
	 * exported `submit`. That split is what lets the composer keep Cancel
	 * meaning "return to the compose I was writing" rather than "start over".
	 */
	import { Field } from '$lib/ui';
	import { templateKinds } from '$lib/api/template-kinds';
	import type { MessageTemplate } from '$lib/api/types';

	interface Props {
		/** Mints the template. Absent hosts never render this component. */
		create: (input: { name: string; kind: string }) => Promise<MessageTemplate>;
		/** The minted template, for the host to select and open. */
		oncreated: (template: MessageTemplate) => void | Promise<void>;
		/** True while the mint is in flight; the host's footer reads it too. */
		busy?: boolean;
		/**
		 * Whether Create has anything to act on. Bound rather than asked, so the
		 * host's own footer control disables reactively — a Create that is
		 * pressable but does nothing would be a control that neither acts nor
		 * explains.
		 */
		canCreate?: boolean;
	}

	let {
		create,
		oncreated,
		busy = $bindable(false),
		canCreate = $bindable(false)
	}: Props = $props();

	let name = $state('');
	let kind = $state(templateKinds[0]!.id);
	let refusal = $state('');

	$effect(() => {
		canCreate = name.trim().length > 0;
	});

	/** Resets to a fresh sheet; a host calls this when it opens the wizard. */
	export function reset(): void {
		name = '';
		kind = templateKinds[0]!.id;
		refusal = '';
	}

	/**
	 * Mints and hands the template back. The refusal renders in place rather
	 * than closing the wizard, so a name that could not be used is still on
	 * screen to change.
	 */
	export async function submit(): Promise<void> {
		const trimmed = name.trim();
		if (!trimmed || busy) return;
		busy = true;
		refusal = '';
		try {
			await oncreated(await create({ name: trimmed, kind }));
		} catch (error) {
			refusal = error instanceof Error ? error.message : 'The template could not be created.';
		} finally {
			busy = false;
		}
	}
</script>

<div class="wizard">
	<Field id="new-template-name" label="Name" required description="What you’ll pick it by later.">
		{#snippet children({ id, describedBy, invalid })}
			<input
				class="ui-control"
				type="text"
				{id}
				aria-describedby={describedBy}
				aria-invalid={invalid}
				placeholder="Venue change"
				bind:value={name} />
		{/snippet}
	</Field>
	<fieldset class="kinds">
		<legend class="kinds__legend">What kind</legend>
		{#each templateKinds as entry (entry.id)}
			<label class="kind" class:kind--picked={kind === entry.id}>
				<input
					type="radio"
					name="new-template-kind"
					class="ui-sr-only"
					value={entry.id}
					checked={kind === entry.id}
					onchange={() => (kind = entry.id)} />
				<span class="kind__label">{entry.label}</span>
				<span class="kind__description">{entry.description}</span>
			</label>
		{/each}
	</fieldset>
	{#if refusal}<p class="wizard__error" role="alert">{refusal}</p>{/if}
</div>

<style>
	.wizard {
		display: grid;
		gap: var(--je-space-4);
		max-inline-size: 34rem;
	}

	.kinds {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		border: 0;
	}

	.kinds__legend {
		padding: 0;
		margin-block-end: var(--je-space-2);
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	/* Marking, not action: a picked card takes the mark surface every selected
	   thing in this product takes, never the action colour. */
	.kind {
		display: grid;
		gap: var(--je-space-1);
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		cursor: pointer;
	}

	.kind:hover {
		border-color: var(--je-color-border-strong);
	}

	.kind--picked {
		border-color: var(--je-color-mark-border);
		background: var(--je-color-mark-surface);
	}

	.kind:has(input:focus-visible) {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.kind__label {
		font-weight: 600;
	}

	.kind__description {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.wizard__error {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-danger);
	}
</style>
