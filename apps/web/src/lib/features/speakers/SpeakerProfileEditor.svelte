<script lang="ts">
	import { untrack } from 'svelte';
	import type {
		SpeakerProfileFieldKey,
		SpeakerProfileLinkDto,
		SpeakerProfileUpdateInput,
		SpeakerProfileViewDto
	} from '@jooevents/contracts';
	import type { SpeakerRecordPort } from '$lib/api/speaker-record-port';

	let {
		view,
		personName,
		port,
		onchanged
	}: {
		readonly view: SpeakerProfileViewDto;
		readonly personName: string;
		readonly port: SpeakerRecordPort;
		readonly onchanged: () => Promise<void>;
	} = $props();

	type LinkDraft = SpeakerProfileLinkDto & { readonly localId: string };
	// The parent keys this editor by profile/approval revision, so each committed
	// refresh remounts a clean draft instead of overwriting in-progress typing.
	const current = untrack(() => view.profile);
	let headline = $state(current?.headline.value ?? '');
	let biography = $state(current?.biography.value ?? '');
	let location = $state(current?.location.value ?? '');
	let links = $state<LinkDraft[]>((current?.links.value ?? []).map((link) => ({
		...link, localId: crypto.randomUUID()
	})));
	let busy = $state<'save' | SpeakerProfileFieldKey | null>(null);
	let error = $state('');
	let announcement = $state('');

	const cleanLinks = $derived(links.map(({ localId: _localId, ...link }) => link));
	const changed = $derived({
		headline: headline !== (current?.headline.value ?? ''),
		biography: biography !== (current?.biography.value ?? ''),
		location: location !== (current?.location.value ?? ''),
		links: JSON.stringify(cleanLinks) !== JSON.stringify(current?.links.value ?? [])
	});
	const dirty = $derived(
		current === null
			? headline.trim().length > 0 || biography.trim().length > 0
				|| location.trim().length > 0 || cleanLinks.length > 0
			: Object.values(changed).some(Boolean)
	);
	const approved = $derived(new Set(view.approvals.map((entry) => entry.field)));

	function addLink() {
		links = [...links, {
			localId: crypto.randomUUID(), kind: 'website', label: '', href: 'https://'
		}];
	}

	function removeLink(localId: string) {
		links = links.filter((link) => link.localId !== localId);
	}

	function patch(): SpeakerProfileUpdateInput['patch'] {
		if (current === null) return { headline, biography, location, links: cleanLinks };
		return {
			...(changed.headline ? { headline } : {}),
			...(changed.biography ? { biography } : {}),
			...(changed.location ? { location } : {}),
			...(changed.links ? { links: cleanLinks } : {})
		};
	}

	async function save() {
		if (!dirty || busy !== null) return;
		busy = 'save';
		error = '';
		announcement = '';
		try {
			const outcome = await port.profile.update({
				personId: view.personId,
				expectedProfileVersion: current?.version ?? null,
				patch: patch()
			});
			if (!outcome.ok) {
				error = outcome.reason;
				return;
			}
			announcement = `${personName}’s profile was saved.`;
			await onchanged();
		} finally {
			busy = null;
		}
	}

	function valuePresent(field: SpeakerProfileFieldKey): boolean {
		if (!current) return false;
		return field === 'links'
			? current.links.value.length > 0
			: current[field].value.trim().length > 0;
	}

	async function approve(field: SpeakerProfileFieldKey) {
		if (!current || dirty || busy !== null || !valuePresent(field) || approved.has(field)) return;
		busy = field;
		error = '';
		announcement = '';
		try {
			const outcome = await port.profile.approve({
				personId: view.personId,
				expectedProfileVersion: current.version,
				fields: [field]
			});
			if (!outcome.ok) {
				error = outcome.reason;
				return;
			}
			announcement = `${field === 'links' ? 'Links' : field[0]!.toUpperCase() + field.slice(1)} approved for this event.`;
			await onchanged();
		} finally {
			busy = null;
		}
	}

	const fieldLabel: Readonly<Record<SpeakerProfileFieldKey, string>> = {
		headline: 'Headline', biography: 'Biography', location: 'Location', links: 'Links'
	};
</script>

<div class="profile-editor">
	<div class="profile-editor__intro">
		<p>
			These details follow {personName} across this workspace. Approval is separate for each
			field and applies only to this event.
		</p>
		{#if dirty && view.approvals.length > 0}
			<p class="profile-editor__notice">
				Save before approving. A changed field loses its current approval; unchanged fields keep theirs.
			</p>
		{/if}
	</div>

	<form class="profile-editor__form" onsubmit={(event) => { event.preventDefault(); void save(); }}>
		<div class="profile-field">
			<div class="profile-field__heading">
				<label class="ui-label" for="speaker-profile-headline">Headline</label>
				{#if approved.has('headline')}
					<span class="ui-badge ui-badge--success">Approved for this event</span>
				{:else}
					<button type="button" class="ui-button ui-button--soft ui-button--sm"
						disabled={!current || dirty || busy !== null || !valuePresent('headline')}
						onclick={() => void approve('headline')}>Approve headline</button>
				{/if}
			</div>
			<input id="speaker-profile-headline" class="ui-control" type="text" maxlength="300"
				autocomplete="organization-title" bind:value={headline} disabled={busy !== null} />
		</div>

		<div class="profile-field">
			<div class="profile-field__heading">
				<label class="ui-label" for="speaker-profile-biography">Biography</label>
				{#if approved.has('biography')}
					<span class="ui-badge ui-badge--success">Approved for this event</span>
				{:else}
					<button type="button" class="ui-button ui-button--soft ui-button--sm"
						disabled={!current || dirty || busy !== null || !valuePresent('biography')}
						onclick={() => void approve('biography')}>Approve biography</button>
				{/if}
			</div>
			<textarea id="speaker-profile-biography" class="ui-control" rows="6" maxlength="8000"
				bind:value={biography} disabled={busy !== null}></textarea>
		</div>

		<div class="profile-field">
			<div class="profile-field__heading">
				<label class="ui-label" for="speaker-profile-location">Location</label>
				{#if approved.has('location')}
					<span class="ui-badge ui-badge--success">Approved for this event</span>
				{:else}
					<button type="button" class="ui-button ui-button--soft ui-button--sm"
						disabled={!current || dirty || busy !== null || !valuePresent('location')}
						onclick={() => void approve('location')}>Approve location</button>
				{/if}
			</div>
			<input id="speaker-profile-location" class="ui-control" type="text" maxlength="300"
				autocomplete="address-level2" bind:value={location} disabled={busy !== null} />
		</div>

		<fieldset class="profile-links">
			<div class="profile-field__heading">
				<legend class="ui-label">Links</legend>
				{#if approved.has('links')}
					<span class="ui-badge ui-badge--success">Approved for this event</span>
				{:else}
					<button type="button" class="ui-button ui-button--soft ui-button--sm"
						disabled={!current || dirty || busy !== null || !valuePresent('links')}
						onclick={() => void approve('links')}>Approve links</button>
				{/if}
			</div>
			{#if links.length === 0}
				<p class="profile-links__empty">No profile links have been added.</p>
			{:else}
				<div class="profile-links__rows">
					{#each links as link, index (link.localId)}
						<div class="profile-link">
							<label class="ui-sr-only" for="speaker-profile-link-kind-{link.localId}">Link {index + 1} kind</label>
							<select id="speaker-profile-link-kind-{link.localId}" class="ui-control"
								bind:value={link.kind} disabled={busy !== null}>
								<option value="website">Website</option>
								<option value="linkedin">LinkedIn</option>
								<option value="github">GitHub</option>
								<option value="x">X</option>
								<option value="other">Other</option>
							</select>
							<label class="ui-sr-only" for="speaker-profile-link-label-{link.localId}">Link {index + 1} label</label>
							<input id="speaker-profile-link-label-{link.localId}" class="ui-control" type="text"
								maxlength="120" placeholder="Label" bind:value={link.label} disabled={busy !== null} />
							<label class="ui-sr-only" for="speaker-profile-link-url-{link.localId}">Link {index + 1} address</label>
							<input id="speaker-profile-link-url-{link.localId}" class="ui-control" type="url"
								inputmode="url" maxlength="2048" placeholder="https://…" bind:value={link.href}
								disabled={busy !== null} />
							<button type="button" class="ui-button ui-button--ghost ui-button--sm"
								disabled={busy !== null} onclick={() => removeLink(link.localId)}>Remove</button>
						</div>
					{/each}
				</div>
			{/if}
			<button type="button" class="ui-button ui-button--secondary ui-button--sm profile-links__add"
				disabled={busy !== null || links.length >= 12} onclick={addLink}>Add link</button>
		</fieldset>

		<div class="profile-editor__actions">
			<button type="submit" class="ui-button ui-button--primary ui-button--sm"
				disabled={!dirty || busy !== null} aria-busy={busy === 'save'}>Save profile</button>
			{#if current}<span>Profile version {current.version}</span>{/if}
		</div>
		{#if error}<p class="ui-field__message ui-field__message--error" role="alert">{error}</p>{/if}
		<p class="ui-sr-only" role="status">{announcement}</p>
	</form>
</div>

<style>
	.profile-editor {
		display: grid;
		gap: var(--je-space-5);
	}

	.profile-editor__intro {
		display: grid;
		gap: var(--je-space-2);
		max-inline-size: 68ch;
	}

	.profile-editor__intro p,
	.profile-links__empty {
		margin: 0;
		color: var(--je-color-text-muted);
	}

	.profile-editor__notice {
		padding: var(--je-space-2) var(--je-space-3);
		border-inline-start: 2px solid var(--je-color-warning);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
		font-size: var(--je-font-size-sm);
	}

	.profile-editor__form {
		display: grid;
		gap: var(--je-space-5);
	}

	.profile-field,
	.profile-links {
		display: grid;
		gap: var(--je-space-2);
		min-inline-size: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.profile-field__heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--je-space-2) var(--je-space-4);
	}

	.profile-field__heading :global(.ui-label) {
		margin: 0;
	}

	.profile-editor textarea {
		resize: vertical;
		min-block-size: 8rem;
	}

	.profile-links__rows {
		display: grid;
		gap: var(--je-space-3);
	}

	.profile-link {
		display: grid;
		grid-template-columns: minmax(8rem, 0.7fr) minmax(10rem, 1fr) minmax(16rem, 2fr) auto;
		align-items: center;
		gap: var(--je-space-2);
	}

	.profile-links__add,
	.profile-editor__actions {
		justify-self: start;
	}

	.profile-editor__actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-3);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	@media (max-width: 47.99rem) {
		.profile-link {
			grid-template-columns: 1fr;
			padding-block-end: var(--je-space-3);
			border-block-end: 1px solid var(--je-color-border);
		}

		.profile-link > :global(.ui-button) {
			justify-self: start;
		}
	}
</style>
