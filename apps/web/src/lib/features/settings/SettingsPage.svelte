<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Button, CopyValue, DatePicker, DescribedSelect, Field, Modal, TimezoneCombobox } from '$lib/ui';
	import { useWorkspaceGateway } from '$lib/api/workspace-gateway';
	import { removalBlockReason, usageLabel, type VocabKind } from '$lib/api/vocab';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import SpeakerFieldsSection from './SpeakerFieldsSection.svelte';
	import { rolePresetDescriptions, rolePresets } from '$lib/api/types';
	import type {
		EventSettings,
		Format,
		Member,
		MemberStatus,
		MutationOutcome,
		Room,
		Track,
		VocabStatus,
		VocabUsage
	} from '$lib/api/types';

	const { api } = useWorkspaceGateway();

	/** The identity form owns every field except `dates`, which the API derives. */
	interface IdentityDraft {
		name: string;
		location: string;
		timezone: string;
		venueNote: string;
		startDate: string;
		endDate: string;
	}

	/** One list row: what it is, what points at it, and what may be done to it. */
	interface VocabEntry {
		kind: VocabKind;
		id: string;
		label: string;
		status: VocabStatus;
		usage: VocabUsage;
		/** Row detail the entry carries beyond its name, e.g. a room's capacity. */
		meta?: string;
		/** Why deletion is unavailable; empty while deletion is offered. */
		blockReason: string;
	}

	const kindNoun: Record<VocabKind, string> = { room: 'room', track: 'track', format: 'format' };

	/**
	 * Each list is headed and described in its own words. Both the waiting and
	 * the resolved panel read this, so the heading a person starts reading is
	 * the heading they keep.
	 */
	const vocabOrder: VocabKind[] = ['room', 'track', 'format'];
	const vocabGroups: Record<VocabKind, { label: string; about: string }> = {
		room: {
			label: 'Rooms',
			about: 'Where sessions happen. Capacity and equipment drive scheduling conflicts.'
		},
		track: {
			label: 'Tracks',
			about:
				'Content lanes you group talks into. Route reviewers, balance the program, color the schedule.'
		},
		format: {
			label: 'Formats',
			about: 'Session shapes and their default lengths — how long each kind of session runs.'
		}
	};

	const memberStatusBadge: Record<MemberStatus, { label: string; tone: string }> = {
		active: { label: 'Active', tone: 'success' },
		invited: { label: 'Invited', tone: 'info' },
		pending_review: { label: 'Awaiting approval', tone: 'warning' }
	};

	let loaded = $state(false);
	let settings = $state<EventSettings | null>(null);
	let fieldsSection = $state<SpeakerFieldsSection>();
	let members = $state<Member[]>([]);
	let rooms = $state<Room[]>([]);
	let tracks = $state<Track[]>([]);
	let formats = $state<Format[]>([]);
	let narrow = $state(false);

	let draft = $state<IdentityDraft>({
		name: '',
		location: '',
		timezone: '',
		venueNote: '',
		startDate: '',
		endDate: ''
	});
	let saving = $state(false);
	let savedMessage = $state('');
	let nameError = $state('');
	let endDateError = $state('');
	let nameInput = $state<HTMLInputElement>();

	let newRoomName = $state('');
	let newRoomCapacity = $state<number | null>(null);
	let newTrackName = $state('');
	let newFormatName = $state('');
	/** Entry id, or `add-*`, of the vocabulary call currently in flight. */
	let vocabPending = $state('');
	let vocabRefusals = $state<Record<string, string>>({});
	let vocabMessage = $state('');
	/** Entry id whose row menu is open; one at a time. */
	let vocabMenu = $state('');
	/** Entry id whose unavailable delete has been asked to explain itself. */
	let vocabExplained = $state('');

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

	// What the shell already knows decides which composition holds the space: a
	// workspace with no event resolves to the start panel, not to these three.
	const known = api.workspace.summarySnapshot();
	const expectEvent = known?.event != null;

	onMount(async () => {
		const [current, memberRows] = await Promise.all([
			api.settings.get(),
			api.settings.members(),
			loadVocab()
		]);
		settings = current ? { ...current } : null;
		if (current) draft = toDraft(current);
		members = memberRows.map((member) => ({ ...member }));
		loaded = true;
	});

	/** Usage travels with every entry, so the lists are re-read as a set. */
	async function loadVocab() {
		const [roomRows, trackRows, formatRows] = await Promise.all([
			api.vocab.rooms(),
			api.vocab.tracks(),
			api.vocab.formats()
		]);
		rooms = roomRows;
		tracks = trackRows;
		formats = formatRows;
	}

	// The members list is a table on wide viewports and a card list on narrow
	// ones, so the width decision is read once here rather than per row.
	$effect(() => {
		const query = window.matchMedia('(max-width: 920px)');
		const apply = () => (narrow = query.matches);
		apply();
		query.addEventListener('change', apply);
		return () => query.removeEventListener('change', apply);
	});

	function entryOf(
		kind: VocabKind,
		source: { id: string; name: string; status: VocabStatus; usage: VocabUsage },
		meta?: string
	): VocabEntry {
		return {
			kind,
			id: source.id,
			label: source.name,
			status: source.status,
			usage: source.usage,
			meta,
			blockReason: removalBlockReason(kind, source.usage, source.status) ?? ''
		};
	}

	/**
	 * Per-kind wiring for the three identical row operations. The API call and
	 * the local list update travel together so a row can be handled without the
	 * caller knowing which list it came from.
	 */
	const vocabOps: Record<
		VocabKind,
		{
			remove: (id: string) => Promise<MutationOutcome>;
			retire: (id: string) => Promise<MutationOutcome>;
			restore: (id: string) => Promise<MutationOutcome>;
			drop: (id: string) => void;
			mark: (id: string, status: VocabStatus) => void;
		}
	> = {
		room: {
			remove: (id) => api.vocab.removeRoom(id),
			retire: (id) => api.vocab.retireRoom(id),
			restore: (id) => api.vocab.restoreRoom(id),
			drop: (id) => (rooms = rooms.filter((room) => room.id !== id)),
			mark: (id, status) =>
				(rooms = rooms.map((room) => (room.id === id ? { ...room, status } : room)))
		},
		track: {
			remove: (id) => api.vocab.removeTrack(id),
			retire: (id) => api.vocab.retireTrack(id),
			restore: (id) => api.vocab.restoreTrack(id),
			drop: (id) => (tracks = tracks.filter((track) => track.id !== id)),
			mark: (id, status) =>
				(tracks = tracks.map((track) => (track.id === id ? { ...track, status } : track)))
		},
		format: {
			remove: (id) => api.vocab.removeFormat(id),
			retire: (id) => api.vocab.retireFormat(id),
			restore: (id) => api.vocab.restoreFormat(id),
			drop: (id) => (formats = formats.filter((format) => format.id !== id)),
			mark: (id, status) =>
				(formats = formats.map((format) => (format.id === id ? { ...format, status } : format)))
		}
	};

	const roomEntries: VocabEntry[] = $derived(
		rooms.map((room) => entryOf('room', room, `${room.capacity} seats`))
	);
	const trackEntries: VocabEntry[] = $derived(tracks.map((track) => entryOf('track', track)));
	const formatEntries: VocabEntry[] = $derived(formats.map((format) => entryOf('format', format)));

	const roomReady = $derived(
		newRoomName.trim().length > 0 && newRoomCapacity !== null && newRoomCapacity > 0
	);
	const trackReady = $derived(newTrackName.trim().length > 0);
	const formatReady = $derived(newFormatName.trim().length > 0);

	function toDraft(source: EventSettings): IdentityDraft {
		return {
			name: source.name,
			location: source.location,
			timezone: source.timezone,
			venueNote: source.venueNote,
			startDate: source.startDate ?? '',
			endDate: source.endDate ?? ''
		};
	}

	/** ISO dates compare directly, so an end before its start is caught here. */
	function rangeError(): string {
		if (!draft.startDate || !draft.endDate) return '';
		return draft.endDate < draft.startDate ? 'The end date cannot fall before the start date.' : '';
	}

	/** A save message describes the values as they were saved, so editing clears it. */
	function edited() {
		savedMessage = '';
		if (draft.name.trim()) nameError = '';
		endDateError = rangeError();
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!draft.name.trim()) {
			nameError = 'Give the event a name.';
			savedMessage = '';
			nameInput?.focus();
			return;
		}
		endDateError = rangeError();
		if (endDateError) {
			savedMessage = '';
			document.getElementById('event-end')?.focus();
			return;
		}
		saving = true;
		const next = await api.settings.update({
			name: draft.name.trim(),
			location: draft.location,
			timezone: draft.timezone,
			venueNote: draft.venueNote,
			startDate: draft.startDate,
			endDate: draft.endDate
		});
		saving = false;
		if (next) {
			settings = { ...next };
			draft = toDraft(next);
		}
		savedMessage = 'Saved';
	}

	function clearRefusal(map: Record<string, string>, id: string): Record<string, string> {
		return Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));
	}

	/**
	 * Pressing a control marked unavailable is the question "why not?", and it
	 * is answered without attempting anything: the row states the reason and
	 * the live region carries the same words to assistive technology.
	 */
	function explainUnavailable(entry: VocabEntry) {
		vocabExplained = entry.id;
		vocabMessage = entry.blockReason;
	}

	async function removeEntry(entry: VocabEntry) {
		if (vocabPending) return;
		vocabPending = entry.id;
		vocabMessage = '';
		vocabRefusals = clearRefusal(vocabRefusals, entry.id);
		const outcome = await vocabOps[entry.kind].remove(entry.id);
		if (outcome.ok) {
			vocabOps[entry.kind].drop(entry.id);
			recordAction({
				area: 'settings',
				label: `Deleted ${kindNoun[entry.kind]} “${entry.label}”`,
				notUndoableReason: 'Nothing referenced it, so it is gone — add it again to reuse the name.'
			});
		} else {
			// The client offered a delete the server refused: a race, a stale
			// list, or another actor. The reason pins to the row it belongs to.
			vocabRefusals = { ...vocabRefusals, [entry.id]: outcome.reason };
			vocabMessage = outcome.reason;
		}
		vocabPending = '';
	}

	async function setEntryStatus(entry: VocabEntry, status: VocabStatus) {
		if (vocabPending) return;
		vocabMenu = '';
		vocabPending = entry.id;
		vocabMessage = '';
		vocabRefusals = clearRefusal(vocabRefusals, entry.id);
		const ops = vocabOps[entry.kind];
		const outcome = await (status === 'retired' ? ops.retire(entry.id) : ops.restore(entry.id));
		if (outcome.ok) {
			ops.mark(entry.id, status);
			// The control that was pressed is replaced by its inverse, so focus
			// follows the operation to where it now lives.
			tick().then(() => {
				const next = status === 'retired' ? 'vocab-restore' : 'vocab-more';
				document.getElementById(`${next}-${entry.id}`)?.focus();
			});
			recordAction({
				area: 'settings',
				label: `${status === 'retired' ? 'Retired' : 'Restored'} ${kindNoun[entry.kind]} “${entry.label}”`,
				undo: async () => {
					await (status === 'retired' ? ops.restore(entry.id) : ops.retire(entry.id));
				}
			});
		} else {
			vocabRefusals = { ...vocabRefusals, [entry.id]: outcome.reason };
			vocabMessage = outcome.reason;
		}
		vocabPending = '';
	}

	async function addEntry(
		kind: VocabKind,
		call: () => Promise<Room | Track | Format>,
		clear: () => void
	) {
		vocabPending = `add-${kind}`;
		vocabMessage = '';
		const created = await call();
		clear();
		await loadVocab();
		recordAction({
			area: 'settings',
			label: `Added ${kindNoun[kind]} “${created.name}”`,
			undo: async () => {
				await vocabOps[kind].remove(created.id);
			}
		});
		vocabPending = '';
	}

	function addRoom(event: SubmitEvent) {
		event.preventDefault();
		if (!roomReady || vocabPending) return;
		const name = newRoomName.trim();
		const capacity = newRoomCapacity ?? 0;
		addEntry('room', () => api.vocab.addRoom(name, capacity), () => {
			newRoomName = '';
			newRoomCapacity = null;
		});
	}

	function addTrack(event: SubmitEvent) {
		event.preventDefault();
		if (!trackReady || vocabPending) return;
		const name = newTrackName.trim();
		addEntry('track', () => api.vocab.addTrack(name), () => (newTrackName = ''));
	}

	function addFormat(event: SubmitEvent) {
		event.preventDefault();
		if (!formatReady || vocabPending) return;
		const name = newFormatName.trim();
		addEntry('format', () => api.vocab.addFormat(name), () => (newFormatName = ''));
	}

	async function changeRole(member: Member, control: HTMLSelectElement) {
		const nextRole = control.value;
		if (nextRole === member.role || teamPending) return;
		teamPending = member.id;
		teamMessage = '';
		teamRefusals = clearRefusal(teamRefusals, member.id);
		const outcome = await api.settings.changeRole(member.id, nextRole);
		if (outcome.ok) {
			members = members.map((entry) =>
				entry.id === member.id ? { ...entry, role: nextRole } : entry
			);
			teamMessage = `${member.name} is now ${nextRole}`;
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
		const outcome = await api.settings.removeMember(member.id);
		if (outcome.ok) {
			members = members.filter((entry) => entry.id !== member.id);
			teamMessage = `${member.name} removed`;
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

	// A row menu is dismissible from anywhere: Escape returns focus to its own
	// trigger, a press elsewhere simply closes it.
	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !vocabMenu) return;
		const trigger = document.getElementById(`vocab-more-${vocabMenu}`);
		vocabMenu = '';
		trigger?.focus();
	}

	function onWindowPointerdown(event: PointerEvent) {
		if (!vocabMenu) return;
		const target = event.target as HTMLElement | null;
		if (!target?.closest('.entry__menu')) vocabMenu = '';
	}

	async function sendInvite() {
		const email = inviteEmail.trim();
		if (!email || !email.includes('@')) {
			inviteError = 'Enter the email address to invite, including the @.';
			inviteInput?.focus();
			return;
		}
		inviting = true;
		const member = await api.settings.invite(email, inviteRole);
		members = [...members, { ...member }];
		inviting = false;
		inviteOpen = false;
		teamMessage = `Invitation sent to ${email}`;
	}
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerdown} />

{#snippet entryList(labelId: string, items: VocabEntry[])}
	{#if items.length === 0}
		<p class="entries__none">None yet</p>
	{:else}
		<ul class="entries" aria-labelledby={labelId}>
			{#each items as item (item.id)}
				{@const refusal = vocabRefusals[item.id] ?? ''}
				<li
					class="entry"
					class:entry--menu={vocabMenu === item.id}
					class:entry--explained={vocabExplained === item.id}>
					<div class="entry__row">
						<span class="entry__text">
							<span class="entry__name">
								{item.label}
								{#if item.status === 'retired'}<span class="entry__state">retired</span>{/if}
							</span>
							<span class="entry__meta"
								>{item.meta ? `${item.meta} · ` : ''}{usageLabel(item.kind, item.usage)}</span>
						</span>
						<span class="entry__actions">
							{#if item.blockReason}
								<!-- Deletion would be refused, so it is not offered — the control
								     keeps its place and its reason instead of disappearing.
								     `aria-disabled` rather than `disabled`: the reason has to stay
								     reachable by keyboard. -->
								<button
									type="button"
									class="ui-button ui-button--secondary ui-button--sm"
									aria-label={`Delete ${item.label}`}
									aria-disabled="true"
									aria-describedby={`vocab-note-${item.id}`}
									onclick={() => explainUnavailable(item)}>Delete</button>
							{:else}
								<Button
									variant="secondary"
									size="sm"
									aria-label={`Delete ${item.label}`}
									disabled={vocabPending !== ''}
									loading={vocabPending === item.id}
									onclick={() => removeEntry(item)}>Delete</Button>
							{/if}
							{#if item.status === 'retired'}
								<Button
									id={`vocab-restore-${item.id}`}
									variant="secondary"
									size="sm"
									aria-label={`Restore ${item.label}`}
									disabled={vocabPending !== ''}
									loading={vocabPending === item.id}
									onclick={() => setEntryStatus(item, 'active')}>Restore</Button>
							{:else}
								<span
									class="entry__menu"
									onfocusout={(event) => {
										if (!event.currentTarget.contains(event.relatedTarget as Node)) vocabMenu = '';
									}}>
									<button
										type="button"
										id={`vocab-more-${item.id}`}
										class="ui-button ui-button--ghost ui-button--sm entry__more"
										aria-label={`More actions for ${item.label}`}
										aria-expanded={vocabMenu === item.id}
										aria-controls={`vocab-menu-${item.id}`}
										onclick={() => (vocabMenu = vocabMenu === item.id ? '' : item.id)}
										>More</button>
									{#if vocabMenu === item.id}
										<span class="entry__pop" id={`vocab-menu-${item.id}`}>
											<button
												type="button"
												class="ui-button ui-button--ghost ui-button--sm entry__pop-item"
												aria-label={`Retire ${item.label}`}
												onclick={() => setEntryStatus(item, 'retired')}>Retire</button>
										</span>
									{/if}
								</span>
							{/if}
						</span>
					</div>
					{#if refusal || item.blockReason}
						<!-- One slot, two arrivals: the standing explanation of an
						     unavailable delete, or the reason a refused attempt came back
						     with. A refusal is an event and stays put; the explanation is
						     context and shows with the control it belongs to. -->
						<p
							class="entry__note"
							class:entry__note--refused={refusal}
							id={`vocab-note-${item.id}`}>
							{refusal || item.blockReason}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#snippet fieldFill(labelWidth: string, descriptionWidth = '', textarea = false, metaWidth = '')}
	<div class="ui-field">
		<div class="ui-field__heading">
			<span class="ui-label"><span class="ui-skeleton skeleton-line" style="inline-size: {labelWidth}"></span></span>
			<!-- A field's meta sits on the label line; a description takes a line of
			     its own. Standing in for one with the other moves the control. -->
			{#if metaWidth}
				<span class="ui-field__meta"><span class="ui-skeleton skeleton-line" style="inline-size: {metaWidth}"></span></span>
			{/if}
		</div>
		{#if descriptionWidth}
			<p class="ui-field__description"><span class="ui-skeleton skeleton-line" style="inline-size: {descriptionWidth}"></span></p>
		{/if}
		<span class="ui-skeleton" class:skeleton-textarea={textarea} class:skeleton-control={!textarea}></span>
	</div>
{/snippet}

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
			onchange={(event) => changeRole(member, event.currentTarget)}>
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

{#if !loaded && !expectEvent}
	{#if known}
		<!-- Evidence says this workspace has no event yet, so the start panel is
		     the composition that holds the space. -->
		<section class="panel start" aria-label="Loading event setup">
			<p class="start__title sk-head"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></p>
			<p class="start__copy">
				<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
				<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
				<span class="ui-skeleton skeleton-line" style="inline-size: 55%"></span>
			</p>
			<div class="start__actions">
				<span class="ui-skeleton skeleton-action"></span>
				<span class="ui-skeleton skeleton-action"></span>
			</div>
			<p class="start__hint"><span class="ui-skeleton skeleton-line" style="inline-size: 14rem"></span></p>
		</section>
	{/if}
{:else if !loaded}
	<!-- Each placeholder is its resolved panel's own markup holding skeleton
	     fills: the settings form keeps field-and-control rhythm, the vocabulary
	     groups keep their entry rows, and the team table keeps real row height.
	     Headings and standing notes are certain, so they render as themselves. -->
	<section class="panel" aria-label="Loading event identity">
		<header class="panel__head">
			<div class="panel__title"><h2>Event identity</h2></div>
		</header>
		<div class="form" aria-hidden="true">
			<div class="form__wide">{@render fieldFill('12rem')}</div>
			{@render fieldFill('7rem')}
			{@render fieldFill('7rem', '', false, '13rem')}
			{@render fieldFill('6rem')}
			{@render fieldFill('6rem')}
			<!-- The derived sentence runs to a second line once the form is a single
			     column, and the fill follows it there. -->
			<p class="form__derived">
				<span class="ui-skeleton skeleton-line" style="inline-size: min(24rem, 100%)"></span>
				{#if narrow}<span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span>{/if}
			</p>
			<div class="form__wide">{@render fieldFill('7rem', '18rem', true)}</div>
			<div class="form__actions"><span class="ui-skeleton skeleton-action"></span></div>
		</div>
	</section>

	<section class="panel" aria-label="Loading program basics">
		<header class="panel__head">
			<div class="panel__title"><h2>Program basics</h2></div>
		</header>
		<div class="vocab">
			{#each vocabOrder as kind (kind)}
				<div class="vocab__group">
					<!-- Group names and their descriptions are certain, so they render as
					     themselves; only the entries and the add form are waiting. -->
					<h3 class="vocab__label">{vocabGroups[kind].label}</h3>
					<p class="vocab__about">{vocabGroups[kind].about}</p>
					<ul class="entries" aria-hidden="true">
						{#each Array(3) as _entry, entryIndex (entryIndex)}
							<li class="entry">
								<div class="entry__row">
									<span class="entry__text">
										<span class="entry__name"><span class="ui-skeleton skeleton-line" style="inline-size: 7rem"></span></span>
										<span class="entry__meta"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></span>
									</span>
									<span class="entry__actions"><span class="ui-skeleton skeleton-action skeleton-action--sm"></span></span>
								</div>
							</li>
						{/each}
					</ul>
					<div class="add" aria-hidden="true">
						<div class="add__fields" class:add__fields--room={kind === 'room'}>
							{@render fieldFill('6rem')}
							{#if kind === 'room'}{@render fieldFill('3rem')}{/if}
						</div>
						<span class="ui-skeleton skeleton-action"></span>
					</div>
				</div>
			{/each}
		</div>
	</section>

	<section class="panel" aria-label="Loading team">
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
{:else if !settings}
	<section class="panel start" aria-label="No event yet">
		<h2 class="start__title">No event yet</h2>
		<p class="start__copy">
			An event holds the name, dates, location, timezone, and venue note every other screen reads.
			Describe the event in your own words and the setup is drafted for you, or fill the fields in
			yourself.
		</p>
		<div class="start__actions">
			<button type="button" class="ui-button ui-button--primary ui-button--sm" disabled>
				Describe the event
			</button>
			<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled>
				Fill in the fields myself
			</button>
		</div>
		<p class="start__hint">Event creation arrives with the setup slice</p>
	</section>
{:else}
	<section class="panel" aria-label="Event identity">
		<header class="panel__head">
			<div class="panel__title"><h2>Event identity</h2></div>
		</header>
		<form class="form" onsubmit={save}>
			<div class="form__wide">
				<Field id="event-name" label="Event name" required error={nameError}>
					{#snippet children({ id, describedBy, invalid })}
						<input
							class="ui-control"
							type="text"
							{id}
							aria-describedby={describedBy}
							aria-invalid={invalid}
							bind:this={nameInput}
							bind:value={draft.name}
							oninput={edited} />
					{/snippet}
				</Field>
			</div>

			<Field id="event-location" label="Location">
				{#snippet children({ id, describedBy })}
					<input
						class="ui-control"
						type="text"
						{id}
						aria-describedby={describedBy}
						bind:value={draft.location}
						oninput={edited} />
				{/snippet}
			</Field>

			<Field id="event-timezone" label="Timezone" meta="Used for every deadline and time.">
				{#snippet children({ id, describedBy })}
					<TimezoneCombobox
						{id}
						{describedBy}
						bind:value={draft.timezone}
						onchange={edited} />
				{/snippet}
			</Field>

			<Field id="event-start" label="Start date">
				{#snippet children({ id, describedBy })}
					<DatePicker
						{id}
						{describedBy}
						label="start date"
						bind:value={draft.startDate}
						onchange={edited} />
				{/snippet}
			</Field>

			<Field id="event-end" label="End date" error={endDateError}>
				{#snippet children({ id, describedBy, invalid })}
					<DatePicker
						{id}
						{describedBy}
						{invalid}
						label="end date"
						min={draft.startDate || undefined}
						defaultFocus={draft.startDate || 'today'}
						bind:value={draft.endDate}
						onchange={edited} />
				{/snippet}
			</Field>

			<p class="form__derived">
				Public listings read <strong>{settings.dates}</strong> — rewritten from these dates when you
				save.
			</p>

			<div class="form__wide">
				<Field
					id="event-venue"
					label="Venue note"
					optional
					description="Practical detail for the team — rooms, load-in, access.">
					{#snippet children({ id, describedBy })}
						<textarea
							class="ui-textarea"
							{id}
							aria-describedby={describedBy}
							rows="3"
							bind:value={draft.venueNote}
							oninput={edited}></textarea>
					{/snippet}
				</Field>
			</div>

			<div class="form__actions">
				<Button type="submit" size="sm" loading={saving}>Save</Button>
				<p class="form__saved" role="status">{savedMessage}</p>
			</div>
		</form>
	</section>

	<section class="panel" aria-label="Program basics">
		<header class="panel__head">
			<div class="panel__title">
				<h2>Program basics</h2>
				<!-- The row itself shows the result; this carries it to assistive tech. -->
				<p class="ui-sr-only" role="status">{vocabMessage}</p>
			</div>
		</header>

		<div class="vocab">
			<div class="vocab__group">
				<h3 class="vocab__label" id="vocab-rooms">{vocabGroups.room.label}</h3>
				<p class="vocab__about">{vocabGroups.room.about}</p>
				{@render entryList('vocab-rooms', roomEntries)}
				<form class="add" onsubmit={addRoom}>
					<div class="add__fields add__fields--room">
						<Field id="new-room-name" label="Room name">
							{#snippet children({ id, describedBy })}
								<input
									class="ui-control"
									type="text"
									{id}
									aria-describedby={describedBy}
									disabled={vocabPending !== ''}
									bind:value={newRoomName} />
							{/snippet}
						</Field>
						<Field id="new-room-capacity" label="Seats">
							{#snippet children({ id, describedBy })}
								<input
									class="ui-control"
									type="number"
									min="1"
									step="1"
									{id}
									aria-describedby={describedBy}
									disabled={vocabPending !== ''}
									bind:value={newRoomCapacity} />
							{/snippet}
						</Field>
					</div>
					<Button
						type="submit"
						variant="secondary"
						size="sm"
						disabled={!roomReady || vocabPending !== ''}
						loading={vocabPending === 'add-room'}>Add room</Button>
				</form>
			</div>

			<div class="vocab__group">
				<h3 class="vocab__label" id="vocab-tracks">{vocabGroups.track.label}</h3>
				<p class="vocab__about">{vocabGroups.track.about}</p>
				{@render entryList('vocab-tracks', trackEntries)}
				<form class="add" onsubmit={addTrack}>
					<div class="add__fields">
						<Field id="new-track-name" label="Track name">
							{#snippet children({ id, describedBy })}
								<input
									class="ui-control"
									type="text"
									{id}
									aria-describedby={describedBy}
									disabled={vocabPending !== ''}
									bind:value={newTrackName} />
							{/snippet}
						</Field>
					</div>
					<Button
						type="submit"
						variant="secondary"
						size="sm"
						disabled={!trackReady || vocabPending !== ''}
						loading={vocabPending === 'add-track'}>Add track</Button>
				</form>
			</div>

			<div class="vocab__group">
				<h3 class="vocab__label" id="vocab-formats">{vocabGroups.format.label}</h3>
				<p class="vocab__about">{vocabGroups.format.about}</p>
				{@render entryList('vocab-formats', formatEntries)}
				<form class="add" onsubmit={addFormat}>
					<div class="add__fields">
						<Field id="new-format-name" label="Format name">
							{#snippet children({ id, describedBy })}
								<input
									class="ui-control"
									type="text"
									{id}
									aria-describedby={describedBy}
									disabled={vocabPending !== ''}
									bind:value={newFormatName} />
							{/snippet}
						</Field>
					</div>
					<Button
						type="submit"
						variant="secondary"
						size="sm"
						disabled={!formatReady || vocabPending !== ''}
						loading={vocabPending === 'add-format'}>Add format</Button>
				</form>
			</div>
		</div>
	</section>

	<section class="panel" aria-label="Team">
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
				{removeTarget.name} loses access to this workspace straight away — sign-in, notifications, and
				anything still assigned to them. Their past activity stays in the record, and you can invite
				them again.
			</p>
		{/if}
		{#snippet footer(close)}
			<Button variant="ghost" onclick={close}>Keep member</Button>
			<Button variant="danger" onclick={confirmRemove}>Remove member</Button>
		{/snippet}
	</Modal>

	<CommitReceipt
		onUndone={() => {
			loadVocab();
			fieldsSection?.reload();
		}} />
{/if}

<!-- Outside the loading conditional on purpose: the section owns its own
     waiting shell, so it mounts as soon as evidence says an event exists and
     is not torn down and refetched when the panels above resolve. A workspace
     without an event resolves to the start panel alone, this section included. -->
{#if loaded ? settings !== null : expectEvent}
	<SpeakerFieldsSection bind:this={fieldsSection} />
{/if}

<style>
	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, a control and an action are
	   control-height, the comment box is the textarea's own minimum, and a chip
	   is badge-height. Free-standing sized rectangles drift; these cannot. */
	/* A heading's line box without the heading element: the placeholder keeps
	   the leading its resolved heading is given. */
	.sk-head {
		line-height: var(--je-leading-tight);
	}

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

	.skeleton-textarea {
		display: block;
		block-size: 6.5rem;
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

	.form {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--je-space-4);
		max-inline-size: 52rem;
	}

	.form__wide,
	.form__derived,
	.form__actions {
		grid-column: 1 / -1;
	}

	.form__derived {
		margin: calc(var(--je-space-2) * -1) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.form__actions {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		min-block-size: var(--je-control-height-sm);
	}

	.form__saved {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-success);
	}

	.vocab {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--je-space-6);
	}

	.vocab__group {
		display: grid;
		align-content: start;
		gap: var(--je-space-3);
	}

	.vocab__label {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.vocab__about {
		margin: calc(var(--je-space-2) * -1) 0 0;
		max-inline-size: 46ch;
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.entries {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.entries__none {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* The row is its own positioning context: the menu and the reason belong to
	   it and must not move the rows underneath. */
	.entry {
		position: relative;
	}

	.entry__row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--je-space-2);
		padding-block: var(--je-space-1);
		border-block-end: 1px solid var(--je-color-border-subtle);
	}

	/* Name and usage take one line each, always: a row that sometimes fits both
	   on one line has two heights, and the waiting shell can only mirror one. */
	.entry__text {
		display: grid;
		gap: 2px;
		min-inline-size: 0;
	}

	.entry__name {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-1) var(--je-space-2);
		font-size: var(--je-font-size-md);
		font-weight: 500;
	}

	/* Retirement is a quiet fact about the entry, not a status that needs a
	   badge's weight beside a name. */
	.entry__state {
		font-size: var(--je-font-size-2xs);
		font-weight: 650;
		letter-spacing: var(--je-tracking-caps);
		text-transform: uppercase;
		color: var(--je-color-text-subtle);
	}

	/* Tabular figures are alignment machinery, not emphasis: these usage counts
	   change under the reader, and proportional digits make the sentence around
	   them jitter on refresh. The figures stay at the line's own ink — they are
	   evidence read once, not a column being compared. */
	.entry__meta {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.entry__actions {
		display: flex;
		align-items: center;
		gap: var(--je-space-1);
	}

	.entry__menu {
		position: relative;
		display: inline-flex;
	}

	/* Retire is a real but rare operation, so it lives behind the row's own
	   menu; the trigger appears when the row is hovered or holds focus, and
	   stands permanently where there is no hover. It keeps its place in the row
	   and in the tab order the whole time — a trigger that took its space only
	   when revealed would push the delete beside it sideways under the pointer. */
	.entry__more {
		opacity: 0;
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	.entry:hover .entry__more,
	.entry:focus-within .entry__more {
		opacity: 1;
	}

	/* An absolutely positioned box shrink-to-fits against its containing block,
	   and that block here is the trigger — so the menu inherited the width of the
	   word "More" and crushed the padding off any longer item inside it.
	   max-content sizes the menu to its own content instead; anchored to the row's
	   end, it grows inward, away from the viewport edge. */
	.entry__pop {
		position: absolute;
		z-index: 7;
		inset-block-start: calc(100% + var(--je-space-1));
		inset-inline-end: 0;
		display: grid;
		inline-size: max-content;
		padding: var(--je-space-1);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-md);
	}

	.entry__pop-item {
		justify-content: start;
	}

	/* The explanation an unavailable delete carries: always in the document so
	   the control can point at it, and never taking a row's space until it is
	   asked for — the count beside the name is what stands permanently. */
	.entry__note {
		position: absolute;
		margin: 0;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}

	/* With a pointer it reads beside the control on hover or focus, floating
	   over the row below rather than pushing the list around under the cursor.

	   Two rules keep it from reading as a blocked row. It is inset from the
	   leading edge, so a strip of the row underneath stays visible and the panel
	   reads as something laid over the list rather than as the list's new
	   contents. And it never takes the pointer: a positioned child keeps its
	   ancestor in `:hover`, so an explanation that accepted the cursor pinned its
	   own row open and made the row beneath genuinely unreachable. The panel
	   holds no controls, so nothing is lost by passing the pointer through — the
	   row below hovers the moment the cursor is over it, and answers for
	   itself. */
	@media (hover: hover) {
		.entry:not(.entry--menu):hover .entry__note:not(.entry__note--refused),
		.entry:not(.entry--menu):focus-within .entry__note:not(.entry__note--refused) {
			z-index: 6;
			pointer-events: none;
			inset-block-start: calc(100% - var(--je-space-1));
			inset-inline: var(--je-space-6) 0;
			inline-size: auto;
			block-size: auto;
			overflow: visible;
			clip-path: none;
			padding: var(--je-space-2) var(--je-space-3);
			border: 1px solid var(--je-color-border-strong);
			border-radius: var(--je-radius-control);
			background: var(--je-color-surface);
			box-shadow: var(--je-shadow-md);
			font-size: var(--je-font-size-sm);
			color: var(--je-color-text-muted);
		}
	}

	/* Without hover, pressing the control is how the question gets asked, and
	   the answer stays in that row until another row is asked. Standing the
	   same sentence under every used row would be a wall, not an explanation. */
	@media (hover: none) {
		.entry__more {
			opacity: 1;
		}

		.entry--explained .entry__note:not(.entry__note--refused) {
			position: static;
			inline-size: auto;
			block-size: auto;
			overflow: visible;
			clip-path: none;
			margin: var(--je-space-1) 0 0;
			font-size: var(--je-font-size-xs);
			color: var(--je-color-text-muted);
		}
	}

	/* A refused attempt is an event, not standing context: it states its reason
	   where the entry is and stays until the next attempt. */
	.entry__note--refused,
	.refusal {
		position: static;
		inline-size: auto;
		block-size: auto;
		overflow: visible;
		clip-path: none;
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-danger);
	}

	.add {
		display: grid;
		justify-items: start;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-1);
	}

	.add__fields {
		display: grid;
		gap: var(--je-space-2);
		inline-size: 100%;
	}

	.add__fields--room {
		grid-template-columns: minmax(0, 1fr) 6rem;
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

	.start {
		display: grid;
		justify-items: start;
		gap: var(--je-space-3);
		align-content: center;
		min-block-size: 16rem;
		padding: var(--je-space-8);
	}

	.start__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 600;
	}

	.start__copy {
		margin: 0;
		max-inline-size: 58ch;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.start__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.start__hint {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	@media (max-width: 920px) {
		.form {
			grid-template-columns: 1fr;
		}

		.form__derived {
			margin-block-start: calc(var(--je-space-3) * -1);
		}

		.vocab {
			grid-template-columns: 1fr;
			gap: var(--je-space-8);
		}

		.start {
			padding: var(--je-space-6) var(--je-space-4);
		}

		.start__actions {
			display: grid;
			grid-template-columns: 1fr;
			inline-size: 100%;
		}
	}
</style>
