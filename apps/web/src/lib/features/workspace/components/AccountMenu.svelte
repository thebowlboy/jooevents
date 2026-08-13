<!--
	The one identity mark and account affordance of the operator shell: an
	avatar trigger in the persistent top bar (reachable at every width — the
	sidebar is a modal drawer on touch), opening the account panel. Each source
	composition wires its own seam, so the sample build gets
	the modeled flows and the live build only what its backend can honor.

	Sign-out follows the confirmed discipline: the control disables and
	announces, the adapter answers, and nothing local moves until the session
	has actually ended — browser UI is not proof a server session was revoked.
	A support code renders only when it is a real correlation ID.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { Badge, Button, Field, Modal, Popover } from '$lib/ui';
	import type { AccountEmailChange, MutationOutcome } from '$lib/api/types';

	interface EmailChangeApi {
		request: (newEmail: string) => Promise<MutationOutcome>;
		resend: () => Promise<MutationOutcome>;
		cancel: () => Promise<MutationOutcome>;
	}

	interface Props {
		name: string;
		email: string;
		pendingChange?: AccountEmailChange | null;
		/**
		 * Absent while the build behind this shell has no account operations —
		 * the email row then explains instead of acting (a control acts or it
		 * explains; it never no-ops).
		 */
		emailChange?: EmailChangeApi;
		signOut: () => Promise<{ ok: boolean; correlationId?: string }>;
		/** Called after a committed change so the owner refreshes the account projection. */
		onchanged?: () => void;
	}

	let { name, email, pendingChange = null, emailChange, signOut, onchanged }: Props = $props();

	const initials = $derived(
		name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0].toUpperCase())
			.join('') || 'JE'
	);

	// ---- Sign out ---------------------------------------------------------
	let signingOut = $state(false);
	let signOutFailed = $state(false);
	let signOutCode = $state('');

	async function pressSignOut() {
		if (signingOut) return;
		signingOut = true;
		signOutFailed = false;
		const outcome = await signOut();
		if (outcome.ok) {
			// Deliberate sign-out pushes the entry route normally.
			await goto('/sign-in?notice=signed_out');
			return;
		}
		signOutCode = outcome.correlationId ?? '';
		signOutFailed = true;
		signingOut = false;
	}

	// ---- Email change ------------------------------------------------------
	let emailOpen = $state(false);
	let newEmail = $state('');
	let emailError = $state('');
	/** Operation in flight inside the dialog; every other control waits its turn. */
	let working = $state('');
	let resent = $state(false);

	// Each open starts a fresh request, not the residue of the last one.
	$effect(() => {
		if (!emailOpen) return;
		newEmail = '';
		emailError = '';
		resent = false;
	});

	async function requestChange(event?: SubmitEvent) {
		event?.preventDefault();
		if (!emailChange || working) return;
		working = 'request';
		emailError = '';
		const outcome = await emailChange.request(newEmail);
		working = '';
		if (!outcome.ok) {
			emailError = outcome.reason;
			return;
		}
		onchanged?.();
	}

	async function resendEmails() {
		if (!emailChange || working) return;
		working = 'resend';
		const outcome = await emailChange.resend();
		working = '';
		resent = outcome.ok;
	}

	async function cancelChange() {
		if (!emailChange || working) return;
		working = 'cancel';
		await emailChange.cancel();
		working = '';
		resent = false;
		onchanged?.();
	}
</script>

<Popover label="Your account">
	{#snippet trigger()}
		<span class="ui-avatar ui-avatar--sm menu__avatar" aria-hidden="true">{initials}</span>
	{/snippet}
	{#snippet children()}
		<div class="menu">
			<!-- Name and email are one tight identity group. -->
			<div class="menu__identity">
				<p class="menu__name">{name}</p>
				{#if email}
					<p class="menu__email">{email}</p>
				{/if}
				{#if pendingChange}
					<p class="menu__pendingline">
						Change to {pendingChange.newEmail} pending — both addresses must confirm.
					</p>
				{/if}
			</div>

			<div class="menu__section">
				{#if emailChange}
					<button
						type="button"
						class="ui-button ui-button--secondary ui-button--sm"
						onclick={() => (emailOpen = true)}>
						{pendingChange ? 'Review email change' : 'Change email address'}
					</button>
				{:else}
					<button
						type="button"
						class="ui-button ui-button--secondary ui-button--sm"
						aria-disabled="true"
						aria-describedby="account-email-note">
						Change email address
					</button>
					<p class="menu__note" id="account-email-note">Arrives with a later slice.</p>
				{/if}
			</div>

			<!-- One reason for the whole region; the rows stay, badged and inert. -->
			<div class="menu__section" role="group" aria-labelledby="account-security-head">
				<p class="menu__head" id="account-security-head">Sign-in &amp; security</p>
				<p class="menu__note" id="account-security-note">
					Sign-in uses Google or an emailed link. Password and two-factor sign-in arrive with a
					later slice.
				</p>
				<div class="menu__coming">
					<button
						type="button"
						class="ui-button ui-button--ghost ui-button--sm"
						aria-disabled="true"
						aria-describedby="account-security-note">
						Password
					</button>
					<Badge tone="neutral">Coming soon</Badge>
				</div>
				<div class="menu__coming">
					<button
						type="button"
						class="ui-button ui-button--ghost ui-button--sm"
						aria-disabled="true"
						aria-describedby="account-security-note">
						Two-factor (OTP)
					</button>
					<Badge tone="neutral">Coming soon</Badge>
				</div>
			</div>

			<div class="menu__section">
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm menu__signout"
					disabled={signingOut}
					aria-busy={signingOut || undefined}
					onclick={pressSignOut}>
					{signingOut ? 'Signing out…' : 'Sign out'}
				</button>
				{#if signOutFailed}
					<p class="menu__error" role="status">
						Sign-out didn’t complete — you are still signed in. Try again.
						{#if signOutCode}
							<span class="menu__code">Support code: {signOutCode}</span>
						{/if}
					</p>
				{/if}
			</div>
		</div>
	{/snippet}
</Popover>

<Modal bind:open={emailOpen} title="Change email address">
	{#if pendingChange}
		<!-- The dialog is the record of the change in flight: each mailbox's
		     confirmation state, and the standing way out. -->
		<div class="chg">
			<p class="chg__copy" role="status">
				The change to <strong>{pendingChange.newEmail}</strong> is waiting on both confirmations.
				Your current address keeps working until then.
			</p>
			<ul class="chg__rows">
				<li class="chg__row">
					<span class="chg__addr">{email}</span>
					<Badge tone={pendingChange.confirmedCurrent ? 'success' : 'info'}>
						{pendingChange.confirmedCurrent ? 'Confirmed' : 'Confirmation sent'}
					</Badge>
					<span class="chg__why">approves the change</span>
				</li>
				<li class="chg__row">
					<span class="chg__addr">{pendingChange.newEmail}</span>
					<Badge tone={pendingChange.confirmedNew ? 'success' : 'info'}>
						{pendingChange.confirmedNew ? 'Confirmed' : 'Confirmation sent'}
					</Badge>
					<span class="chg__why">proves the new address is yours</span>
				</li>
			</ul>
			{#if resent}
				<p class="chg__resent" role="status">Confirmation emails sent again.</p>
			{/if}
		</div>
	{:else}
		<form class="chg" id="account-email-form" onsubmit={requestChange}>
			<p class="chg__copy">
				Signed in as <strong>{email}</strong>. A confirmation link goes to both addresses — the
				current one approves the change, the new one proves it’s yours. Nothing changes until both
				confirm.
			</p>
			<Field id="account-new-email" label="New email address" error={emailError}>
				{#snippet children({ id, describedBy, invalid })}
					<input
						class="ui-control"
						type="email"
						{id}
						aria-describedby={describedBy}
						aria-invalid={invalid}
						disabled={working !== ''}
						bind:value={newEmail}
						oninput={() => (emailError = '')} />
				{/snippet}
			</Field>
		</form>
	{/if}
	{#snippet footer(close)}
		{#if pendingChange}
			<Button
				variant="ghost"
				size="sm"
				disabled={working !== '' && working !== 'cancel'}
				loading={working === 'cancel'}
				onclick={cancelChange}>
				Cancel change
			</Button>
			<Button
				variant="secondary"
				size="sm"
				disabled={working !== '' && working !== 'resend'}
				loading={working === 'resend'}
				onclick={resendEmails}>
				Resend emails
			</Button>
			<Button size="sm" onclick={close}>Done</Button>
		{:else}
			<Button variant="ghost" size="sm" disabled={working !== ''} onclick={close}>Cancel</Button>
			<Button
				size="sm"
				disabled={!newEmail.trim()}
				loading={working === 'request'}
				onclick={() => void requestChange()}>
				Send confirmations
			</Button>
		{/if}
	{/snippet}
</Modal>

<style>
	/* The avatar is the trigger's face; the coarse-pointer floor keeps it an
	   honest target where there is no hover to help. */
	.menu__avatar {
		pointer-events: none;
	}

	@media (pointer: coarse) {
		.menu__avatar {
			inline-size: 2.75rem;
			block-size: 2.75rem;
		}
	}

	.menu {
		display: grid;
		gap: var(--je-space-3);
	}

	.menu__identity {
		display: grid;
		gap: 2px;
	}

	.menu__name {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.menu__email {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		overflow-wrap: anywhere;
	}

	.menu__pendingline {
		margin: 2px 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		overflow-wrap: anywhere;
	}

	.menu__section {
		display: grid;
		justify-items: start;
		gap: var(--je-space-2);
		padding-block-start: var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border-subtle);
	}

	.menu__head {
		margin: 0;
		font-size: var(--je-font-size-2xs);
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-subtle);
	}

	.menu__note {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.menu__coming {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
	}

	.menu__coming [aria-disabled='true'] {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.menu__section [aria-disabled='true'] {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.menu__error {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-danger);
	}

	.menu__code {
		display: block;
		font-weight: 400;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.chg {
		display: grid;
		gap: var(--je-space-3);
	}

	.chg__copy {
		margin: 0;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.chg__rows {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.chg__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
	}

	.chg__addr {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.chg__why {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.chg__resent {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}
</style>
