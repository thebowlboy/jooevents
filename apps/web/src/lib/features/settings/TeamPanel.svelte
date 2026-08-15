<script lang="ts">
	/**
	 * Who holds the workspace, and at what role. A role change applies at once; an
	 * invitation only reserves the role until the person is admitted.
	 */
	import { onMount } from 'svelte';
	import { Button, CopyValue, DescribedSelect, Field, Modal } from '$lib/ui';
	import type { SettingsPagePort } from '$lib/api/settings-page-port';
	import { rolePresetDescriptions, rolePresets } from '$lib/api/types';
	import type { Member, MemberStatus } from '$lib/api/types';

	let {
		port,
		narrow = false,
		loading = false
	}: {
		readonly port: SettingsPagePort;
		readonly narrow?: boolean;
		readonly loading?: boolean;
	} = $props();

	const memberStatusBadge: Record<MemberStatus, { label: string; tone: string }> = {
		active: { label: 'Active', tone: 'success' },
		invited: { label: 'Invited', tone: 'info' },
		pending_review: { label: 'Awaiting approval', tone: 'warning' }
	};

	let members = $state<Member[]>([]);
	/** Member id of the team call currently in flight. */
	let teamPending = $state('');
	let teamRefusals = $state<Record<string, string>>({});
	let teamMessage = $state('');
	let inviteOpen = $state(false);
	let inviteEmail = $state('');
	let inviteRole = $state<(typeof rolePresets)[number]>('Viewer');
	let inviteError = $state('');
	let inviting = $state(false);
	let inviteInput = $state<HTMLInputElement>();
	let removeTarget = $state<Member | null>(null);
	let removeOpen = $state(false);

	onMount(async () => {
		if (loading) return;
		const memberRows = await port.team.members();
		if (memberRows.kind === 'success') {
			members = memberRows.members.map((member) => ({ ...member }));
		} else {
			teamMessage = memberRows.reason;
		}
	});

	function clearRefusal(map: Record<string, string>, id: string): Record<string, string> {
		return Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));
	}

	async function changeRole(member: Member, control: HTMLSelectElement) {
		const nextRole = control.value;
		if (nextRole === member.role || teamPending) return;
		teamPending = member.id;
		teamMessage = '';
		teamRefusals = clearRefusal(teamRefusals, member.id);
		const outcome = await port.team.changeRole(member.id, nextRole);
		if (outcome.ok) {
			members = outcome.members
				? outcome.members.map((entry) => ({ ...entry }))
				: members.map((entry) => entry.id === member.id ? { ...entry, role: nextRole } : entry);
			teamMessage = outcome.message;
		} else {
			// The refused change never happened, so the control returns to the role
			// the person still holds.
			control.value = member.role;
			teamRefusals = { ...teamRefusals, [member.id]: outcome.reason };
			teamMessage = outcome.reason;
		}
		teamPending = '';
	}

	function askRemove(member: Member) {
		removeTarget = member;
		removeOpen = true;
	}

	async function confirmRemove() {
		const member = removeTarget;
		if (!member) return;
		removeOpen = false;
		teamPending = member.id;
		teamMessage = '';
		teamRefusals = clearRefusal(teamRefusals, member.id);
		const outcome = await port.team.removeMember(member.id);
		if (outcome.ok) {
			members = outcome.members
				? outcome.members.map((entry) => ({ ...entry }))
				: members.filter((entry) => entry.id !== (outcome.removedId ?? member.id));
			teamMessage = outcome.message;
		} else {
			teamRefusals = { ...teamRefusals, [member.id]: outcome.reason };
			teamMessage = outcome.reason;
		}
		teamPending = '';
	}

	function openInvite() {
		inviteEmail = '';
		inviteRole = 'Viewer';
		inviteError = '';
		inviteOpen = true;
	}

	async function sendInvite() {
		const email = inviteEmail.trim();
		if (!email || !email.includes('@')) {
			inviteError = 'Enter the email address to invite, including the @.';
			inviteInput?.focus();
			return;
		}
		inviting = true;
		const outcome = await port.team.invite(email, inviteRole);
		inviting = false;
		if (outcome.ok) {
			members = outcome.members
				? outcome.members.map((entry) => ({ ...entry }))
				: outcome.member ? [...members, { ...outcome.member }] : members;
			inviteOpen = false;
			teamMessage = outcome.message;
		} else {
			inviteError = outcome.reason;
			teamMessage = outcome.reason;
			inviteInput?.focus();
		}
	}
</script>

{#snippet roleControl(member: Member)}
	<!-- Every role control locks while one change is in flight; only the control
	     that was actually changed shows the wait. -->
	<span class="ui-select-wait">
		<select
			class="ui-select role"
			aria-label={`Role for ${member.name}`}
			value={member.role}
			disabled={teamPending !== ''}
			aria-busy={teamPending === member.id}
			onchange={(changeEvent) => changeRole(member, changeEvent.currentTarget)}>
			{#each rolePresets as preset (preset)}
				<option value={preset}>{preset}</option>
			{/each}
		</select>
		{#if teamPending === member.id}
			<span class="ui-select-wait__spinner" aria-hidden="true"><span class="ui-spinner"></span></span>
		{/if}
	</span>
{/snippet}

{#snippet statusChip(member: Member)}
	{@const badge = memberStatusBadge[member.status ?? 'active']}
	<span class="ui-badge ui-badge--{badge.tone}">{badge.label}</span>
{/snippet}

{#snippet removeControl(member: Member)}
	<Button
		variant="secondary"
		size="sm"
		aria-label={`Remove ${member.name}`}
		disabled={teamPending !== ''}
		loading={teamPending === member.id}
		onclick={() => askRemove(member)}>Remove</Button>
{/snippet}

{#if loading}
	<section class="panel" id="settings-team" aria-label="Loading team">
		<header class="panel__head">
			<div class="panel__title"><h2>Team</h2></div>
			<div class="panel__action"><span class="ui-skeleton skeleton-action"></span></div>
			<p class="panel__note">
				A role change applies immediately. An invitation reserves its role until the person signs in
				and is approved.
			</p>
		</header>
		{#if narrow}
			<ul class="cards" aria-hidden="true">
				{#each Array(5) as _member, memberIndex (memberIndex)}
					<li class="card">
						<div class="card__head">
							<span class="card__identity">
								<span class="card__name"><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></span>
								<span class="card__email"><span class="ui-skeleton skeleton-line" style="inline-size: 11rem"></span></span>
							</span>
							<span class="ui-skeleton skeleton-chip"></span>
						</div>
						<div class="card__controls">
							<span class="card__role">
								<span class="card__caption">Role</span>
								<span class="ui-skeleton skeleton-control"></span>
							</span>
							<span class="ui-skeleton skeleton-action skeleton-action--sm"></span>
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<div class="ui-table-wrap" aria-hidden="true">
				<table class="ui-table members">
					<thead>
						<tr>
							<th>Name</th>
							<th>Email</th>
							<th class="col-role">Role</th>
							<th>Status</th>
							<th class="col-action"><span class="ui-sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each Array(5) as _member, memberIndex (memberIndex)}
							<tr>
								<td><span class="ui-table__primary"><strong><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></strong></span></td>
								<td class="col-email"><span class="ui-skeleton skeleton-line" style="inline-size: 11rem"></span></td>
								<td class="col-role"><span class="ui-skeleton skeleton-control"></span></td>
								<td><span class="ui-skeleton skeleton-chip"></span></td>
								<td class="col-action"><span class="ui-skeleton skeleton-action skeleton-action--sm"></span></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{:else}
	<section class="panel" id="settings-team" aria-label="Team">
		<header class="panel__head">
			<div class="panel__title">
				<h2>Team</h2>
				<!-- The row itself shows the result; this carries it to assistive tech. -->
				<p class="ui-sr-only" role="status">{teamMessage}</p>
			</div>
			<div class="panel__action">
				<Button size="sm" disabled={teamPending !== ''} onclick={openInvite}>Invite member</Button>
			</div>
			<p class="panel__note">
				A role change applies immediately. An invitation reserves its role until the person signs in
				and is approved.
			</p>
		</header>

		{#if narrow}
			<ul class="cards">
				{#each members as member (member.id)}
					<li class="card">
						<div class="card__head">
							<span class="card__identity">
								<span class="card__name">{member.name}</span>
								<span class="card__email"><CopyValue value={member.email} label="email address" /></span>
							</span>
							{@render statusChip(member)}
						</div>
						<div class="card__controls">
							<span class="card__role">
								<span class="card__caption">Role</span>
								{@render roleControl(member)}
							</span>
							{@render removeControl(member)}
						</div>
						{#if teamRefusals[member.id]}
							<p class="refusal">{teamRefusals[member.id]}</p>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<div class="ui-table-wrap">
				<table class="ui-table members">
					<thead>
						<tr>
							<th>Name</th>
							<th>Email</th>
							<th class="col-role">Role</th>
							<th>Status</th>
							<th class="col-action"><span class="ui-sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each members as member (member.id)}
							<tr>
								<td><span class="ui-table__primary"><strong>{member.name}</strong></span></td>
								<td class="col-email"><CopyValue value={member.email} label="email address" /></td>
								<td class="col-role">{@render roleControl(member)}</td>
								<td>{@render statusChip(member)}</td>
								<td class="col-action">{@render removeControl(member)}</td>
							</tr>
							{#if teamRefusals[member.id]}
								<tr class="refusal-row">
									<td colspan="5"><p class="refusal">{teamRefusals[member.id]}</p></td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<Modal bind:open={inviteOpen} title="Invite a member">
		<p class="modal__copy">
			The invitation reserves this role now. The person stays Invited until they sign in and their
			access is approved — only then does the role take effect.
		</p>
		<div class="modal__fields">
			<Field id="invite-email" label="Email address" required error={inviteError}>
				{#snippet children({ id, describedBy, invalid })}
					<input
						class="ui-control"
						type="email"
						{id}
						aria-describedby={describedBy}
						aria-invalid={invalid}
						bind:this={inviteInput}
						bind:value={inviteEmail}
						oninput={() => (inviteError = '')} />
				{/snippet}
			</Field>
			<Field
				id="invite-role"
				label="Role"
				meta="Changeable later"
				description={rolePresetDescriptions[inviteRole]}>
				{#snippet children({ id, describedBy })}
					<DescribedSelect
						{id}
						{describedBy}
						label="Roles"
						bind:value={inviteRole}
						options={rolePresets.map((preset) => ({
							value: preset,
							label: preset,
							description: rolePresetDescriptions[preset]
						}))} />
				{/snippet}
			</Field>
		</div>
		{#snippet footer(close)}
			<Button variant="ghost" disabled={inviting} onclick={close}>Cancel</Button>
			<Button loading={inviting} onclick={sendInvite}>Send invitation</Button>
		{/snippet}
	</Modal>

	<Modal bind:open={removeOpen} title="Remove this member?">
		{#if removeTarget}
			<p class="modal__copy">
				{removeTarget.name} loses workspace access when this change commits. Existing sessions are
				revoked separately and may remain active briefly. Their past activity stays in the record,
				and you can invite them again.
			</p>
		{/if}
		{#snippet footer(close)}
			<Button variant="ghost" onclick={close}>Keep member</Button>
			<Button variant="danger" onclick={confirmRemove}>Remove member</Button>
		{/snippet}
	</Modal>
{/if}

<style>
	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, a control and an action are
	   control-height, and a chip is badge-height. */
	.skeleton-line {
		display: inline-block;
		block-size: 1em;
		/* One line box exactly: the line inherits the height it stands in for. */
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.skeleton-control {
		display: block;
		block-size: var(--je-control-height);
		border-radius: var(--je-radius-control);
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 6.5rem;
		border-radius: var(--je-radius-control);
		/* Sits on the line bottom: an empty fill has no baseline of its own, and
		   the descender space under one would deepen the row it stands in. */
		vertical-align: bottom;
	}

	.skeleton-action--sm {
		inline-size: 4.5rem;
	}

	.skeleton-chip {
		display: inline-block;
		align-self: center;
		block-size: 1.35rem;
		inline-size: 4rem;
	}

	.panel {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.panel__head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: var(--je-space-2) var(--je-space-4);
		margin-block-end: var(--je-space-4);
	}

	.panel__title {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.panel__head h2 {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.panel__note {
		grid-column: 1 / -1;
		margin: 0;
		max-inline-size: 62ch;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.panel__action {
		justify-self: end;
	}

	.col-role {
		inline-size: 10.5rem;
	}

	.col-email {
		overflow-wrap: anywhere;
	}

	.col-action {
		inline-size: 6rem;
	}

	/* Four short columns plus two controls fit the desktop content column, so the
	   table wraps its text instead of scrolling sideways. */
	.members {
		min-width: 0;
	}

	.role {
		font-size: var(--je-font-size-sm);
	}

	.refusal-row td {
		padding-block-end: var(--je-space-2);
	}

	/* A refused attempt is an event, not standing context: it states its reason
	   where the member is and stays until the next attempt. */
	.refusal {
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-danger);
	}

	.cards {
		display: grid;
		gap: var(--je-space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.card {
		display: grid;
		gap: var(--je-space-2);
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.card__head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--je-space-2);
	}

	.card__identity {
		display: grid;
		gap: var(--je-space-1);
		min-inline-size: 0;
	}

	.card__name {
		font-weight: 650;
	}

	.card__email {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		overflow-wrap: anywhere;
	}

	.card__controls {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: end;
		gap: var(--je-space-2);
	}

	.card__role {
		display: grid;
		gap: var(--je-space-1);
		min-inline-size: 0;
	}

	.card__caption {
		font-size: var(--je-font-size-xs);
		font-weight: 650;
		color: var(--je-color-text-muted);
	}

	.modal__copy {
		margin: 0 0 var(--je-space-4);
		font-size: var(--je-font-size-md);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.modal__fields {
		display: grid;
		gap: var(--je-space-4);
	}
</style>
