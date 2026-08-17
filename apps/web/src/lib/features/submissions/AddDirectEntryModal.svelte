<!--
	Direct entry (04 §3, widened by 22): the organizer keys a proposal in on the
	speakers' behalf. The dialog's one consequential choice is the disposition —
	the review inbox as an ordinary undecided candidate, or accepted right away,
	the invited path. Requirements are organizer-lax (the abstract can wait);
	the exception is the email, because people are email-keyed and every
	downstream surface joins on it. One confirm, a receipt with undo — the
	ceremony of a single low-tier create, not a deployment.
-->
<script lang="ts">
	import { Button, ChoiceGroup, Field, Modal, Radio } from '$lib/ui';
	import { describePortFailure } from '$lib/api/port-failure';
	import type { SubmissionsPagePort } from '$lib/api/submissions-page-port';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import InlineVocabAdd from '$lib/features/workspace/components/InlineVocabAdd.svelte';
	import type { Format, Submission, Track } from '$lib/api/types';

	interface Props {
		port: SubmissionsPagePort;
		open?: boolean;
		tracks: Track[];
		formats: Format[];
		/**
		 * Whether the vocabulary lists have resolved at least once. Until then
		 * the selects wait visibly instead of claiming "no tracks yet" about a
		 * population that merely has not answered.
		 */
		vocabReady?: boolean;
		/** The toolbar's current filters: the lane the operator is already working in. */
		defaultTrackId?: string;
		defaultFormatId?: string;
		/** Re-reads the caller's track/format lists after an in-flow creation. */
		onvocabchanged: () => Promise<void>;
		/** The entry landed; the list behind the dialog re-reads. */
		onadded: (submission: Submission) => void;
	}

	let {
		port,
		open = $bindable(false),
		tracks,
		formats,
		vocabReady = true,
		defaultTrackId = '',
		defaultFormatId = '',
		onvocabchanged,
		onadded
	}: Props = $props();

	const uid = $props.id();

	let speakers = $state<{ name: string; email: string }[]>([{ name: '', email: '' }]);
	let title = $state('');
	let abstract = $state('');
	let trackId = $state('');
	let formatId = $state('');
	let disposition = $state<'inbox' | 'accepted'>('inbox');
	let targetSessionId = $state('');
	let collecting = $state<{ id: string; title: string }[]>([]);
	let collectingLoaded = $state(false);
	let titleError = $state('');
	let speakersError = $state('');
	let requestError = $state('');
	let vocabNote = $state('');
	let adding = $state(false);

	const offeredTracks = $derived(tracks.filter((track) => track.status === 'active'));
	const offeredFormats = $derived(formats.filter((format) => format.status === 'active'));

	function firstOffered(offered: { id: string }[], preferred: string): string {
		if (preferred && offered.some((entry) => entry.id === preferred)) return preferred;
		return offered[0]?.id ?? '';
	}

	// Each open starts a fresh entry. A memo of the last transition rather than
	// a plain `if (open)` guard: the reset reads the vocabulary lists, which an
	// in-flow creation refreshes mid-entry, and that refresh must not wipe the
	// half-typed form.
	let wasOpen = false;
	$effect(() => {
		if (open === wasOpen) return;
		wasOpen = open;
		if (!open) return;
		speakers = [{ name: '', email: '' }];
		title = '';
		abstract = '';
		trackId = firstOffered(offeredTracks, defaultTrackId);
		formatId = firstOffered(offeredFormats, defaultFormatId);
		disposition = 'inbox';
		targetSessionId = '';
		collecting = [];
		collectingLoaded = false;
		titleError = '';
		speakersError = '';
		requestError = '';
		vocabNote = '';
		void loadCollecting();
	});

	// The dialog can open before the vocabulary read lands. When the lists
	// arrive, a still-empty choice adopts its default; a choice the person (or
	// an in-flow creation) already made is never overwritten.
	$effect(() => {
		if (!open) return;
		if (trackId === '' && offeredTracks.length > 0) {
			trackId = firstOffered(offeredTracks, defaultTrackId);
		}
		if (formatId === '' && offeredFormats.length > 0) {
			formatId = firstOffered(offeredFormats, defaultFormatId);
		}
	});

	// The destination choice exists only while a session is actually collecting
	// proposals; with none, the concept does not apply and the field is absent.
	async function loadCollecting() {
		collecting = [...await port.schedule.collectingSessions()];
		collectingLoaded = true;
	}

	const emailOk = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
	const speakersOk = $derived(
		speakers.length > 0 &&
			speakers.every((speaker) => speaker.name.trim().length > 0 && emailOk(speaker.email))
	);
	const ready = $derived(title.trim().length > 0 && trackId !== '' && formatId !== '' && speakersOk);

	function edited() {
		requestError = '';
		if (title.trim()) titleError = '';
		if (speakersOk) speakersError = '';
	}

	function addSpeakerRow() {
		speakers = [...speakers, { name: '', email: '' }];
	}

	function removeSpeakerRow(index: number) {
		speakers = speakers.filter((_, i) => i !== index);
	}

	/**
	 * In-flow vocabulary creation: a real event-vocabulary entry through the
	 * same operation Settings uses, then selected here. A name an active entry
	 * already carries selects that entry instead of minting a twin — one
	 * registry, many doors. A failure keeps the row open and says so; the
	 * rethrow tells the inline row not to close.
	 */
	function matchByName(offered: { id: string; name: string }[], name: string) {
		return offered.find((entry) => entry.name.trim().toLowerCase() === name.toLowerCase());
	}

	async function addTrack(name: string) {
		const existing = matchByName(offeredTracks, name);
		if (existing) {
			trackId = existing.id;
			vocabNote = `“${existing.name}” already exists — selected.`;
			return;
		}
		try {
			const created = await port.vocab.addTrack(name);
			await onvocabchanged();
			trackId = created.id;
			vocabNote = `“${created.name}” added to the event’s tracks and selected.`;
		} catch (error) {
			requestError = 'The new track couldn’t be saved. Try again.';
			throw error;
		}
	}

	async function addFormat(name: string) {
		const existing = matchByName(offeredFormats, name);
		if (existing) {
			formatId = existing.id;
			vocabNote = `“${existing.name}” already exists — selected.`;
			return;
		}
		try {
			const created = await port.vocab.addFormat(name);
			await onvocabchanged();
			formatId = created.id;
			vocabNote = `“${created.name}” added to the event’s formats and selected.`;
		} catch (error) {
			requestError = 'The new format couldn’t be saved. Try again.';
			throw error;
		}
	}

	async function add(event?: SubmitEvent) {
		event?.preventDefault();
		titleError = title.trim() ? '' : 'Give the talk a title.';
		speakersError = speakersOk ? '' : 'Every speaker needs a name and a complete email address.';
		if (!ready || adding) return;
		adding = true;
		requestError = '';
		let created: Submission;
		try {
			created = await port.submissions.addDirectEntry({
				title: title.trim(),
				...(abstract.trim() ? { abstract: abstract.trim() } : {}),
				speakers: speakers.map((speaker) => ({
					name: speaker.name.trim(),
					email: speaker.email.trim()
				})),
				trackId,
				formatId,
				disposition,
				...(targetSessionId ? { targetSessionId } : {})
			});
		} catch (error) {
			// The port's typed refusals carry their own remedy ("open your call
			// for proposals first", "add it to the inbox, then accept it on
			// Decisions") — flattening them onto a retry line advertised a
			// permanently doomed submit as transient. The generic retry copy is
			// only the fallback for an unclassified failure.
			requestError = describePortFailure(error, 'The entry couldn’t be saved. Try again.').message;
			adding = false;
			return;
		}
		recordAction({
			area: 'submissions',
			label:
				disposition === 'accepted'
					? `Added “${created.title}” — direct entry, accepted`
					: `Added “${created.title}” — direct entry, in the inbox`,
			notUndoableReason: 'Move it to spam if this direct entry should not remain in the inbox.'
		});
		adding = false;
		open = false;
		onadded(created);
	}
</script>

<!-- "Add a submission" on the control; "direct entry" stays the provenance
     grammar the rows wear ("direct entry by Jere K.") — the button names the
     object being added, the chip names how it got here. -->
<Modal bind:open title="Add a submission">
	<form class="entry" onsubmit={add}>
		<p class="entry__copy">
			For a talk that didn’t come through the form — an invited speaker, or a proposal that
			arrived by email. The speakers own it; you’re keying it in on their behalf, and the row
			will say so.
		</p>

		<div class="entry__people" role="group" aria-labelledby="{uid}-speakers">
			<div class="ui-field__heading">
				<span class="ui-label" id="{uid}-speakers">
					Speakers <span class="ui-label__required" aria-hidden="true">*</span>
				</span>
			</div>
			{#each speakers as speaker, index (index)}
				<div class="entry__person">
					<div class="entry__slot">
						<label class="ui-label" for="{uid}-speaker-name-{index}">Name</label>
						<input
							id="{uid}-speaker-name-{index}"
							class="ui-control"
							type="text"
							disabled={adding}
							aria-describedby={speakersError ? `${uid}-speakers-error` : undefined}
							aria-invalid={speakersError && !speaker.name.trim() ? true : undefined}
							bind:value={speaker.name}
							oninput={edited} />
					</div>
					<div class="entry__slot">
						<label class="ui-label" for="{uid}-speaker-email-{index}">Email</label>
						<input
							id="{uid}-speaker-email-{index}"
							class="ui-control"
							type="email"
							disabled={adding}
							aria-describedby={speakersError ? `${uid}-speakers-error` : undefined}
							aria-invalid={speakersError && !emailOk(speaker.email) ? true : undefined}
							bind:value={speaker.email}
							oninput={edited} />
					</div>
					{#if speakers.length > 1}
						<Button variant="ghost" size="sm" disabled={adding} onclick={() => removeSpeakerRow(index)}>
							Remove
						</Button>
					{/if}
				</div>
			{/each}
			{#if speakersError}
				<p class="ui-field__message ui-field__message--error" id="{uid}-speakers-error">
					{speakersError}
				</p>
			{/if}
			<div>
				<Button variant="ghost" size="sm" disabled={adding} onclick={addSpeakerRow}>
					Add another speaker
				</Button>
			</div>
		</div>

		<Field id="{uid}-title" label="Title" required error={titleError}>
			{#snippet children({ id, describedBy, invalid })}
				<input
					class="ui-control"
					type="text"
					{id}
					aria-describedby={describedBy}
					aria-invalid={invalid}
					placeholder="e.g. Streaming Agent UIs in Production"
					disabled={adding}
					bind:value={title}
					oninput={edited} />
			{/snippet}
		</Field>

		<Field id="{uid}-abstract" label="Abstract" optional description="It can follow later.">
			{#snippet children({ id, describedBy })}
				<textarea
					class="ui-textarea"
					{id}
					aria-describedby={describedBy}
					rows="3"
					disabled={adding}
					bind:value={abstract}></textarea>
			{/snippet}
		</Field>

		<div class="entry__vocab">
			<Field id="{uid}-track" label="Track" required>
				{#snippet children({ id, describedBy })}
					<div class="entry__choice">
						<span class="ui-select-wait">
							<select
								class="ui-select"
								{id}
								aria-describedby={describedBy}
								disabled={adding || !vocabReady}
								aria-busy={!vocabReady || undefined}
								bind:value={trackId}>
								{#if vocabReady && offeredTracks.length === 0}
									<option value="">No tracks yet</option>
								{/if}
								{#each offeredTracks as track (track.id)}
									<option value={track.id}>{track.name}</option>
								{/each}
							</select>
							{#if !vocabReady}
								<span class="ui-select-wait__spinner" aria-hidden="true"><span class="ui-spinner"></span></span>
							{/if}
						</span>
						<InlineVocabAdd
							label="New track"
							placeholder="e.g. Infrastructure"
							disabled={adding || !vocabReady}
							submit={addTrack} />
					</div>
				{/snippet}
			</Field>
			<Field id="{uid}-format" label="Format" required>
				{#snippet children({ id, describedBy })}
					<div class="entry__choice">
						<span class="ui-select-wait">
							<select
								class="ui-select"
								{id}
								aria-describedby={describedBy}
								disabled={adding || !vocabReady}
								aria-busy={!vocabReady || undefined}
								bind:value={formatId}>
								{#if vocabReady && offeredFormats.length === 0}
									<option value="">No formats yet</option>
								{/if}
								{#each offeredFormats as format (format.id)}
									<option value={format.id}>{format.name}</option>
								{/each}
							</select>
							{#if !vocabReady}
								<span class="ui-select-wait__spinner" aria-hidden="true"><span class="ui-spinner"></span></span>
							{/if}
						</span>
						<InlineVocabAdd
							label="New format"
							placeholder="e.g. Lightning talk"
							disabled={adding || !vocabReady}
							submit={addFormat} />
					</div>
				{/snippet}
			</Field>
		</div>

		<ChoiceGroup legend="Where it lands">
			<Radio
				name="{uid}-disposition"
				value="inbox"
				bind:group={disposition}
				disabled={adding}
				label="Review inbox"
				description="Undecided — triaged and reviewed like any other arrival." />
			<Radio
				name="{uid}-disposition"
				value="accepted"
				bind:group={disposition}
				disabled={adding}
				label="Accepted right away"
				description="An invited talk — it joins the program immediately." />
		</ChoiceGroup>

		<!-- Last on purpose: the collecting list resolves a beat after the dialog
		     opens, and arriving below everything means nothing the person is
		     already filling in moves when it lands. -->
		{#if collectingLoaded && collecting.length > 0}
			<Field
				id="{uid}-target"
				label="Destination"
				description="A collecting session this proposal asks to join; acceptance attaches there.">
				{#snippet children({ id, describedBy })}
					<select
						class="ui-select"
						{id}
						aria-describedby={describedBy}
						disabled={adding}
						bind:value={targetSessionId}>
						<option value="">General pool</option>
						{#each collecting as session (session.id)}
							<option value={session.id}>{session.title}</option>
						{/each}
					</select>
				{/snippet}
			</Field>
		{/if}

		{#if requestError}
			<p class="entry__error" role="status">{requestError}</p>
		{/if}
	</form>

	<p class="ui-sr-only" role="status">{vocabNote}</p>

	{#snippet footer(close)}
		<Button variant="ghost" size="sm" disabled={adding} onclick={close}>Cancel</Button>
		<Button size="sm" disabled={!ready} loading={adding} onclick={() => void add()}>
			{disposition === 'accepted' ? 'Add accepted talk' : 'Add to inbox'}
		</Button>
	{/snippet}
</Modal>

<style>
	.entry {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-4);
	}

	.entry__copy {
		margin: 0;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.entry__people {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-2);
	}

	.entry__person {
		display: grid;
		grid-template-columns: 1fr 1fr auto;
		gap: var(--je-space-2);
		align-items: end;
	}

	.entry__slot {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-1);
		min-inline-size: 0;
	}

	.entry__vocab {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--je-space-3);
		align-items: start;
	}

	.entry__choice {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--je-space-1);
	}

	.entry__choice .ui-select-wait {
		align-self: stretch;
	}

	.entry__error {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-danger);
	}

	@media (max-width: 560px) {
		.entry__person {
			grid-template-columns: 1fr;
			align-items: stretch;
		}

		.entry__vocab {
			grid-template-columns: 1fr;
		}
	}
</style>
