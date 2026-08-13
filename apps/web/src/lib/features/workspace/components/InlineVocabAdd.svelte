<!--
	Creation where the choice is made: the dropdown is where a missing track or
	format is discovered, and leaving for Settings mid-entry destroys the pass.
	A quiet affordance swaps in place for a one-line name form; the caller owns
	what "submit" means (dedup against the live list, create, select), so this
	stays pure disclosure plus a name.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { Button } from '$lib/ui';

	interface Props {
		/** The action's full name, e.g. "New track…". */
		label: string;
		placeholder: string;
		disabled?: boolean;
		/**
		 * Resolves when the name has been dealt with — created or matched.
		 * A rejection keeps the row open with the name intact; the caller
		 * reports what went wrong.
		 */
		submit: (name: string) => Promise<void>;
	}

	const { label, placeholder, disabled = false, submit }: Props = $props();
	const uid = $props.id();

	let open = $state(false);
	let name = $state('');
	let busy = $state(false);
	let input = $state<HTMLInputElement>();
	let opener = $state<HTMLButtonElement>();

	async function openAdd() {
		open = true;
		await tick();
		input?.focus();
	}

	// Whichever way the row closes, the person's focus lands back on the
	// affordance that opened it rather than falling to the document body.
	async function close() {
		open = false;
		name = '';
		await tick();
		opener?.focus();
	}

	async function add() {
		const trimmed = name.trim();
		if (!trimmed || busy || disabled) return;
		busy = true;
		try {
			await submit(trimmed);
		} catch {
			// The caller reports the failure; the name stays put for a retry.
			busy = false;
			return;
		}
		busy = false;
		void close();
	}

	// Not a <form>: this row lives inside the entry dialog's own form, and a
	// nested form is invalid HTML. Enter commits the name and stays here — it
	// must never fall through as the outer form's implicit submission; Escape
	// cancels the row without also cancelling the dialog around it.
	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			if (!busy) void close();
			return;
		}
		if (event.key !== 'Enter') return;
		event.preventDefault();
		void add();
	}
</script>

{#if open}
	<div class="add">
		<label class="ui-sr-only" for={uid}>{label.replace('…', '')} name</label>
		<input
			id={uid}
			class="ui-control add__name"
			type="text"
			{placeholder}
			maxlength="64"
			{disabled}
			bind:this={input}
			bind:value={name}
			{onkeydown} />
		<Button
			size="sm"
			variant="secondary"
			disabled={disabled || !name.trim()}
			loading={busy}
			onclick={() => void add()}>
			Add
		</Button>
		<Button variant="ghost" size="sm" disabled={disabled || busy} onclick={() => void close()}>
			Cancel
		</Button>
	</div>
{:else}
	<button
		type="button"
		class="ui-button ui-button--ghost ui-button--sm"
		{disabled}
		bind:this={opener}
		onclick={() => void openAdd()}>{label}</button>
{/if}

<style>
	.add {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
	}

	.add__name {
		flex: 1;
		min-inline-size: 0;
	}
</style>
