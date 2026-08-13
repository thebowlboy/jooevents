<script lang="ts">
	/**
	 * Inviting reviewers is the ordinary member invitation with the Speaker
	 * Reviewer preset — one system, no parallel invite. Several addresses go in
	 * at once and every line reports its own outcome, so one bad address never
	 * hides what happened to the rest. The copy stays honest about state: an
	 * invitation is recorded and reserved here; nothing claims an email went out.
	 */
	import { tick } from 'svelte';
	import { Badge, Button, Field, Modal } from '$lib/ui';
	import { rolePresetDescriptions } from '$lib/api/types';
	import type { Format, ReviewerInviteLine, ScopeRef, SessionItem, Track } from '$lib/api/types';
	import type { ReviewersPagePort } from '$lib/api/reviewers-page-port';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import ScopePicker from './ScopePicker.svelte';
	import { scopeKey } from './scope-display';

	let {
		port,
		open = $bindable(false),
		tracks,
		formats,
		sessions,
		oninvited
	}: {
		port: ReviewersPagePort;
		open?: boolean;
		tracks: Track[];
		formats: Format[];
		sessions: SessionItem[];
		/** At least one invitation was recorded; the roster behind is stale. */
		oninvited: (added: number) => void;
	} = $props();

	const api = $derived(port);

	let emailsText = $state('');
	let error = $state('');
	let scopeOpen = $state(false);
	let scope = $state<ScopeRef[]>([]);
	let submitting = $state(false);
	let outcomes = $state<ReviewerInviteLine[] | null>(null);
	let emailsInput = $state<HTMLTextAreaElement>();
	let linesElement = $state<HTMLDivElement>();

	// A fresh opening is a fresh invitation, not a continuation of the last one.
	$effect(() => {
		if (!open) return;
		emailsText = '';
		error = '';
		scopeOpen = false;
		scope = [];
		outcomes = null;
	});

	function toggleRef(ref: ScopeRef) {
		const key = scopeKey(ref);
		scope = scope.some((entry) => scopeKey(entry) === key)
			? scope.filter((entry) => scopeKey(entry) !== key)
			: [...scope, ref];
	}

	/** Addresses as written, split on newlines/commas/spaces, first copy kept. */
	function parseAddresses(): string[] {
		const seen = new Set<string>();
		const addresses: string[] = [];
		for (const raw of emailsText.split(/[\s,;]+/)) {
			const address = raw.trim();
			if (!address) continue;
			const key = address.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			addresses.push(address);
		}
		return addresses;
	}

	const recordedCount = $derived(outcomes?.filter((line) => line.ok).length ?? 0);
	const failedCount = $derived((outcomes?.length ?? 0) - recordedCount);

	async function submit() {
		const addresses = parseAddresses();
		if (addresses.length === 0) {
			error = 'Enter at least one email address — one per line, or separated by commas.';
			emailsInput?.focus();
			return;
		}
		submitting = true;
		try {
			const lines = await api.reviewers.invite(
				addresses.map((email) => ({ email })),
				scope
			);
			outcomes = lines;
			const added = lines.filter((line) => line.ok).length;
			// Only the addresses that need another pass stay in the entry box.
			emailsText = lines
				.filter((line) => !line.ok)
				.map((line) => line.email)
				.join('\n');
			if (added > 0) {
				recordAction({
					label:
						added === 1
							? `Recorded a reviewer invitation for ${lines.find((line) => line.ok)?.email}`
							: `Recorded ${added} reviewer invitations`,
					area: 'Reviewers',
					notUndoableReason: 'Withdraw one by removing the reviewer from the roster.'
				});
				oninvited(added);
			}
			// The outcomes lead the dialog; a body scrolled down to the picker
			// would otherwise hide the one thing the press produced.
			await tick();
			linesElement?.scrollIntoView({ block: 'nearest' });
		} finally {
			submitting = false;
		}
	}
</script>

<Modal bind:open title="Invite reviewers">
	<p class="copy">
		Each address gets review access reserved as an invited workspace member. The person stays
		Invited until they sign in — recording the invitation does not email anyone.
	</p>
	<div class="fields">
		{#if outcomes}
			<!-- After a submit, the outcomes are the content: they lead, above the
			     entry box that now holds only the addresses needing another pass. -->
			<div class="lines" bind:this={linesElement}>
				<p class="lines__summary" role="status">
					{recordedCount} recorded{failedCount > 0 ? `, ${failedCount} not recorded` : ''}.
				</p>
				<ul class="lines__list">
					{#each outcomes as line (line.email)}
						<li class="line">
							<span class="line__email">{line.email}</span>
							{#if line.ok}
								<Badge tone="info">Recorded</Badge>
							{:else}
								<span class="line__reason">{line.reason}</span>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
		<Field
			id="invite-reviewer-emails"
			label="Email addresses"
			description="Several at once is fine — one per line, or separated by commas."
			required
			{error}>
			{#snippet children({ id, describedBy, invalid })}
				<textarea
					class="ui-control emails"
					rows="3"
					{id}
					aria-describedby={describedBy}
					aria-invalid={invalid}
					bind:this={emailsInput}
					bind:value={emailsText}
					oninput={() => (error = '')}></textarea>
			{/snippet}
		</Field>

		<div class="role">
			<span class="role__label">Role</span>
			<p class="role__name">Speaker Reviewer</p>
			<p class="role__about">{rolePresetDescriptions['Speaker Reviewer']}</p>
		</div>

		<div class="scope">
			{#if scopeOpen}
				<span class="role__label">Initial scope</span>
				<p class="scope__hint">
					A submission is in scope when it matches any selection. Leave everything unselected to
					keep the default.
				</p>
				<ScopePicker {tracks} {formats} {sessions} selected={scope} ontoggle={toggleRef} />
			{:else}
				<button type="button" class="scope__openbtn" onclick={() => (scopeOpen = true)}>
					Add an initial scope (optional)
				</button>
				<p class="scope__hint">Without one, each reviewer reviews everything — the default.</p>
			{/if}
		</div>

	</div>
	{#snippet footer(close)}
		<Button variant="ghost" disabled={submitting} onclick={close}>
			{recordedCount > 0 ? 'Done' : 'Cancel'}
		</Button>
		<Button
			loading={submitting}
			disabled={outcomes !== null && emailsText.trim() === ''}
			onclick={submit}>
			Record invitations
		</Button>
	{/snippet}
</Modal>

<style>
	.copy {
		margin: 0 0 var(--je-space-4);
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.fields {
		display: grid;
		gap: var(--je-space-4);
	}

	.emails {
		min-block-size: calc(var(--je-control-height) * 1.8);
		block-size: auto;
		padding-block: var(--je-space-2);
		resize: vertical;
	}

	.role {
		display: grid;
		gap: var(--je-space-1);
	}

	.role__label {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		color: var(--je-color-text);
	}

	.role__name {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.role__about {
		margin: 0;
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.scope {
		display: grid;
		gap: var(--je-space-2);
	}

	/* An in-place disclosure, not a navigation: dotted-and-ink, never coral. */
	.scope__openbtn {
		justify-self: start;
		padding: 0;
		border: 0;
		background: none;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		text-decoration: underline dotted;
		text-underline-offset: 0.18em;
		cursor: pointer;
	}

	.scope__openbtn:hover {
		color: var(--je-color-text);
		text-decoration-style: solid;
	}

	.scope__hint {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.lines {
		display: grid;
		gap: var(--je-space-2);
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
	}

	.lines__summary {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.lines__list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: var(--je-space-1);
	}

	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-2);
		font-size: var(--je-font-size-sm);
	}

	.line__email {
		overflow-wrap: anywhere;
	}

	.line__reason {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-danger);
	}
</style>
