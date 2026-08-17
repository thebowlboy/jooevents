<script lang="ts">
	import { onMount } from 'svelte';
	import { formatInstant, formatInstantDate } from '@jooevents/contracts';
	import {
		ACCELEVENTS_REMOTE_FORMATS,
		computeAcceleventsPreflight,
		type AcceleventsExportPort,
		type AcceleventsExportView,
		type AcceleventsSessionType
	} from '$lib/api/accelevents-export-port';
	import { Alert, Badge, Button, Checkbox, DescribedSelect } from '$lib/ui';
	import { badgeFor } from '$lib/ui/status-tones';

	let { port }: { readonly port: AcceleventsExportPort } = $props();
	let view = $state<AcceleventsExportView | null>(null);
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);
	let receipt = $state<string | null>(null);
	let nameDrafts = $state<Record<string, { first: string; last: string }>>({});
	let roomDrafts = $state<Record<string, string>>({});
	let roomErrors = $state<Record<string, string>>({});

	function syncDrafts(next: AcceleventsExportView) {
		nameDrafts = Object.fromEntries(
			next.speakers.map((speaker) => [speaker.personId, { first: speaker.firstName, last: speaker.lastName }])
		);
		roomDrafts = Object.fromEntries(
			next.rooms.map((room) => [room.roomId, room.binding?.kind === 'remote' ? String(room.binding.locationId) : ''])
		);
	}

	onMount(async () => {
		try {
			const next = await port.read();
			syncDrafts(next);
			view = next;
		} catch {
			error = 'The export preparation could not be loaded. Try again.';
		}
	});

	async function act(label: string, run: () => Promise<AcceleventsExportView>, success?: string) {
		busy = label;
		error = null;
		receipt = null;
		try {
			const next = await run();
			syncDrafts(next);
			view = next;
			receipt = success ?? null;
		} catch {
			error = 'The export preparation could not be updated. Nothing else changed; try again.';
		} finally {
			busy = null;
		}
	}

	const sessionTypeOptions = [
		{ value: 'IN_PERSON', label: 'In person', description: 'Sessions happen at the venue.' },
		{ value: 'VIRTUAL', label: 'Virtual', description: 'Sessions happen online.' },
		{ value: 'HYBRID', label: 'Hybrid', description: 'Sessions happen at the venue and online at once.' }
	] satisfies readonly { value: AcceleventsSessionType; label: string; description: string }[];

	const remoteFormatOptions = ACCELEVENTS_REMOTE_FORMATS.map((format) => ({
		value: format.value,
		label: format.label,
		description: format.description
	}));

	const preflight = $derived(view ? computeAcceleventsPreflight(view) : null);
	const selectedRelease = $derived(
		view?.releases.find((release) => release.id === view?.selectedReleaseId) ?? null
	);

	function pageStatus(ready: boolean, hasRelease: boolean) {
		if (!hasRelease) return { key: 'notConfigured' as const, label: 'Waiting on a release' };
		if (!ready) return { key: 'actionRequired' as const, label: 'In preparation' };
		return { key: 'ready' as const, label: 'Ready to build' };
	}

	/** "America/New_York" → "New York": the place a person reads instantly. */
	function timezonePlace(timezone: string): string {
		const segment = timezone.split('/').at(-1) ?? timezone;
		return segment.replaceAll('_', ' ');
	}

	function commitName(personId: string) {
		const draft = nameDrafts[personId];
		if (!view || !draft) return;
		const current = view.speakers.find((speaker) => speaker.personId === personId);
		if (!current || (current.firstName === draft.first && current.lastName === draft.last)) return;
		act(`name-${personId}`, () => port.setSpeakerName(personId, draft.first.trim(), draft.last.trim()));
	}

	function commitRoom(roomId: string) {
		if (!view) return;
		const draft = (roomDrafts[roomId] ?? '').trim();
		const current = view.rooms.find((room) => room.roomId === roomId);
		if (!current || current.binding?.kind === 'no_location') return;
		if (draft === '') {
			roomErrors = { ...roomErrors, [roomId]: '' };
			if (current.binding !== null) act(`room-${roomId}`, () => port.bindRoom(roomId, null));
			return;
		}
		if (!/^[1-9][0-9]*$/.test(draft)) {
			roomErrors = { ...roomErrors, [roomId]: 'Accelevents location IDs are whole numbers.' };
			return;
		}
		roomErrors = { ...roomErrors, [roomId]: '' };
		const locationId = Number(draft);
		if (current.binding?.kind === 'remote' && current.binding.locationId === locationId) return;
		act(`room-${roomId}`, () => port.bindRoom(roomId, { kind: 'remote', locationId }));
	}

	function setNoLocation(roomId: string, checked: boolean) {
		roomErrors = { ...roomErrors, [roomId]: '' };
		act(`room-${roomId}`, () => port.bindRoom(roomId, checked ? { kind: 'no_location' } : null));
	}

	function generate() {
		if (!view || !preflight?.ready) return;
		const release = selectedRelease;
		act(
			'generate',
			() => port.generate(),
			`The package is ready — locations, speakers, and sessions from release ${release?.number ?? ''}.`
		);
	}
</script>

{#if !view}
	<section class="ax-shell" aria-label="Loading the Accelevents export">
		<span class="ui-skeleton skeleton-title"></span><span class="ui-skeleton skeleton-line"></span>
		{#if error}<Alert tone="danger" title="Not loaded" message={error} />{/if}
	</section>
{:else}
	{@const status = pageStatus(preflight?.ready ?? false, view.releases.length > 0)}
	<div class="ax-detail">
		<header class="ax-head">
			<div>
				<a class="back" href="/app/integrations">← Integrations</a>
				<p class="eyebrow">ACCELEVENTS</p>
				<h2>Export your program to Accelevents</h2>
				<p>
					Three CSV files — locations, speakers, and sessions — built from a program release you
					choose. JooEvents never contacts Accelevents; you download the package and run the import
					there yourself.
				</p>
			</div>
			<div class="head-actions">
				<Badge {...badgeFor(status.key)} value={status.label} />
			</div>
		</header>

		{#if view.releases.length === 0}
			<section class="card gate">
				<h3>The export starts from a published program release</h3>
				<p>
					A release is the exact program you published, frozen — so what Accelevents imports is what
					your attendees were shown, not a work in progress. Publish the schedule and this page
					fills in.
				</p>
				<p class="boundary">
					Proposals, reviews, scores, notes, and task data stay in JooEvents either way.
				</p>
				<a class="ui-button ui-button--primary" href="/app/schedule">Open Schedule</a>
			</section>
		{:else}
			<section class="section" id="release">
				<div class="section-title"><h3>The release to export</h3></div>
				<div class="release-row">
					<DescribedSelect
						label="Program release"
						value={view.selectedReleaseId ?? undefined}
						options={view.releases.map((release) => ({
							value: release.id,
							label: `Release ${release.number} · ${formatInstantDate(release.releasedAt, view?.timezone)}`,
							description: `${release.sessionCount} sessions · ${release.occurrenceCount} scheduled slots · ${release.roomCount} rooms · ${release.speakerCount} speakers`
						}))}
						disabled={busy !== null}
						onchange={(releaseId) => act('release', () => port.selectRelease(releaseId))}
					/>
					{#if selectedRelease}
						<p class="release-facts">
							{selectedRelease.sessionCount} sessions · {selectedRelease.occurrenceCount} scheduled slots
							· {selectedRelease.roomCount} rooms · {selectedRelease.speakerCount} speakers. Dates and
							times in the files use the event's timezone, {timezonePlace(view.timezone)}.
						</p>
					{/if}
				</div>
			</section>

			<section class="section" id="mapping">
				<div class="section-title"><h3>How sessions translate</h3></div>
				<p class="section-lede">
					Accelevents has a fixed set of session formats and needs to know how the event runs.
					Neither is guessed from names or rooms — you choose, and the files say exactly what you
					chose.
				</p>
				<div class="value-list">
					<div class="value-row">
						<div><strong>Session type</strong><small>One value for every exported session.</small></div>
						<DescribedSelect
							label="Session type"
							value={view.sessionType ?? undefined}
							options={sessionTypeOptions}
							disabled={busy !== null}
							onchange={(sessionType) => act('session-type', () => port.setSessionType(sessionType))}
						/>
					</div>
					{#each view.formats as format (format.formatId)}
						<div class="value-row">
							<div>
								<strong>{format.name}</strong>
								<small>{format.sessionCount} {format.sessionCount === 1 ? 'session uses' : 'sessions use'} this format in the release.</small>
							</div>
							<DescribedSelect
								label={`Accelevents format for ${format.name}`}
								value={format.remoteFormat ?? undefined}
								options={remoteFormatOptions}
								disabled={busy !== null}
								onchange={(remoteFormat) => act(`format-${format.formatId}`, () => port.mapFormat(format.formatId, remoteFormat))}
							/>
						</div>
					{/each}
				</div>
			</section>

			<section class="section" id="speakers">
				<div class="section-title"><h3>Speaker names, the way Accelevents asks for them</h3></div>
				<p class="section-lede">
					Accelevents needs a separate first and last name. Two-word names are filled in for you to
					check; every other name is yours to write — splitting a name automatically gets real names
					wrong.
				</p>
				<div class="name-grid" role="group" aria-label="Speaker export names">
					<div class="name-grid__head" aria-hidden="true">
						<span>Speaker</span><span>First name</span><span>Last name</span>
					</div>
					{#each view.speakers as speaker (speaker.personId)}
						<div class="name-grid__row">
							<div class="name-grid__who">
								<strong>{speaker.displayName}</strong>
								<small>
									{speaker.sessionCount} {speaker.sessionCount === 1 ? 'session' : 'sessions'}{#if !speaker.hasApprovedEmail}
										· no email on file{/if}
								</small>
							</div>
							<div class="cell">
								<span class="cell__label" aria-hidden="true">First name</span>
								<input
									class="ui-control"
									type="text"
									autocomplete="off"
									aria-label={`First name for ${speaker.displayName}`}
									value={nameDrafts[speaker.personId]?.first ?? ''}
									disabled={busy !== null && busy !== `name-${speaker.personId}`}
									oninput={(input) => (nameDrafts = { ...nameDrafts, [speaker.personId]: { first: input.currentTarget.value, last: nameDrafts[speaker.personId]?.last ?? '' } })}
									onchange={() => commitName(speaker.personId)}
								/>
							</div>
							<div class="cell">
								<span class="cell__label" aria-hidden="true">Last name</span>
								<input
									class="ui-control"
									type="text"
									autocomplete="off"
									aria-label={`Last name for ${speaker.displayName}`}
									value={nameDrafts[speaker.personId]?.last ?? ''}
									disabled={busy !== null && busy !== `name-${speaker.personId}`}
									oninput={(input) => (nameDrafts = { ...nameDrafts, [speaker.personId]: { first: nameDrafts[speaker.personId]?.first ?? '', last: input.currentTarget.value } })}
									onchange={() => commitName(speaker.personId)}
								/>
							</div>
						</div>
					{/each}
				</div>
			</section>

			<section class="section" id="locations">
				<div class="section-title"><h3>Rooms become Accelevents locations, in two steps</h3></div>
				<p class="section-lede">
					Accelevents assigns each location a numeric ID when it is created, and session rows need
					those IDs — so locations go over first, and the IDs come back here.
				</p>
				<div class="setup-moments" aria-label="Location steps">
					<span><b>1</b> Download locations.csv</span>
					<span><b>2</b> Import it in Accelevents</span>
					<span><b>3</b> Enter the IDs Accelevents assigned</span>
				</div>
				{#if view.locationsCsvPath}
					<a
						class="ui-button ui-button--secondary ui-button--sm locations-download"
						href={view.locationsCsvPath}
						download="locations.csv">Download locations.csv</a>
				{:else}
					<p class="quiet">locations.csv becomes available once the export operation is live.</p>
				{/if}
				<div class="room-grid" role="group" aria-label="Room location IDs">
					<div class="room-grid__head" aria-hidden="true">
						<span>Room</span><span>Accelevents location ID</span>
					</div>
					{#each view.rooms as room (room.roomId)}
						{@const noLocation = room.binding?.kind === 'no_location'}
						<div class="room-grid__row">
							<div class="room-grid__who">
								<strong>{room.name}</strong>
								<small>{room.occurrenceCount} scheduled {room.occurrenceCount === 1 ? 'slot' : 'slots'}</small>
							</div>
							<div class="room-grid__controls">
								<div class="cell">
									<span class="cell__label" aria-hidden="true">Location ID</span>
									<input
										class="ui-control"
										type="text"
										inputmode="numeric"
										autocomplete="off"
										aria-label={`Accelevents location ID for ${room.name}`}
										aria-invalid={roomErrors[room.roomId] ? true : undefined}
										value={noLocation ? '' : (roomDrafts[room.roomId] ?? '')}
										disabled={noLocation || busy !== null}
										oninput={(input) => (roomDrafts = { ...roomDrafts, [room.roomId]: input.currentTarget.value })}
										onchange={() => commitRoom(room.roomId)}
									/>
								</div>
								<Checkbox
									label="No location"
									checked={noLocation}
									disabled={busy !== null}
									onchange={(checked) => setNoLocation(room.roomId, checked)}
								/>
							</div>
							{#if roomErrors[room.roomId]}
								<p class="room-grid__error" role="alert">{roomErrors[room.roomId]}</p>
							{/if}
						</div>
					{/each}
				</div>
			</section>

			{#if view.primaries.length > 0}
				<section class="section" id="primaries">
					<div class="section-title"><h3>Primary speakers in Accelevents</h3></div>
					<p class="section-lede">
						Accelevents lets one primary speaker per session edit and moderate it there. Everyone
						exports as a secondary speaker unless you choose someone.
					</p>
					<div class="value-list">
						{#each view.primaries as row (row.occurrenceId)}
							<div class="value-row">
								<div><strong>{row.sessionTitle}</strong></div>
								<DescribedSelect
									label={`Primary speaker for ${row.sessionTitle}`}
									value={row.primaryPersonId ?? 'none'}
									options={[
										{ value: 'none', label: 'No one — all speakers stay secondary', description: 'Nobody gains edit or moderation rights in Accelevents.' },
										...row.candidates.map((candidate) => ({
											value: candidate.personId,
											label: candidate.displayName,
											description: `${candidate.roleLabel}. Becomes able to edit and moderate this session in Accelevents.`
										}))
									]}
									disabled={busy !== null}
									onchange={(personId) => act(`primary-${row.occurrenceId}`, () => port.setPrimary(row.occurrenceId, personId === 'none' ? null : personId))}
								/>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			{#if preflight}
				<section class="section" id="preflight">
					<div class="section-title"><h3>Before the files are built</h3></div>
					{#if preflight.blockers.length > 0}
						<h4>Blocking the package ({preflight.blockers.length})</h4>
						<ul class="check-list check-list--blockers">
							{#each preflight.blockers as blocker (blocker.id)}
								<li>
									<span>{blocker.summary}</span>
									{#if blocker.anchor}<a href={blocker.anchor}>{blocker.anchor.startsWith('#') ? 'Fix →' : 'Open Speakers →'}</a>{/if}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="all-clear"><Badge {...badgeFor('ready')} value="Nothing blocks the package" /></p>
					{/if}
					<h4>Left out of this package</h4>
					<ul class="check-list">
						{#each preflight.leftOut as note (note.id)}
							<li><span>{note.summary}</span></li>
						{/each}
					</ul>
					{#if preflight.contains}
						<h4>What the package contains</h4>
						<dl class="contains">
							<div><dt>Locations</dt><dd>{preflight.contains.locations}</dd></div>
							<div><dt>Speakers</dt><dd>{preflight.contains.speakers}</dd></div>
							<div><dt>Session rows</dt><dd>{preflight.contains.sessionRows}</dd></div>
						</dl>
						<p class="contains-fields">
							Each speaker row carries the speaker's {preflight.contains.personalFields.join(', ')}.
						</p>
					{/if}
					<h4>What happens in Accelevents</h4>
					<ul class="check-list">
						{#each preflight.consequences as note (note.id)}
							<li><span>{note.summary}</span></li>
						{/each}
					</ul>
				</section>

				<section class="section" id="package">
					<div class="section-title"><h3>The package</h3></div>
					<p class="section-lede">
						A ZIP holding locations.csv, speakers.csv, sessions.csv, and a short import guide naming
						the exact import order.
					</p>
					{#if view.lastGenerated}
						<p class="generated-fact">
							A package for release {view.lastGenerated.releaseNumber} was generated
							{formatInstant(view.lastGenerated.at, view.timezone)}.
						</p>
					{/if}
					{#if !preflight.ready}
						<p class="blocked-reason">
							{preflight.blockers.length}
							{preflight.blockers.length === 1 ? 'item' : 'items'} above still
							{preflight.blockers.length === 1 ? 'blocks' : 'block'} the package.
						</p>
					{/if}
					<div class="package-actions">
						<Button
							loading={busy === 'generate'}
							disabled={busy !== null || !preflight.ready}
							onclick={generate}>Build the import package</Button>
						{#if view.packagePath}
							<a class="ui-button ui-button--secondary" href={view.packagePath} download>Download the package</a>
						{:else if view.lastGenerated}
							<p class="quiet">The download link appears here once the export operation is available in this workspace.</p>
						{/if}
					</div>
					<p class="boundary">
						Proposals, reviews, scores, notes, tasks, and attendee data stay in JooEvents. The files
						leave JooEvents when you download them — handle them as speaker contact data.
					</p>
				</section>
			{/if}
		{/if}

		<div class="notice-region" role="status">
			{#if receipt}<p class="notice">{receipt}</p>{/if}
		</div>
		{#if error}<Alert tone="danger" title="Not saved" message={error} />{/if}
	</div>
{/if}

<style>
	.ax-shell {
		min-block-size: 8rem;
	}

	.skeleton-title,
	.skeleton-line {
		display: block;
	}

	.skeleton-title {
		inline-size: 18rem;
		block-size: 2rem;
	}

	.skeleton-line {
		inline-size: min(36rem, 90%);
		block-size: 1rem;
		margin-block-start: 1rem;
	}

	.ax-detail {
		display: grid;
		gap: var(--je-space-5);
	}

	.ax-head {
		display: flex;
		justify-content: space-between;
		align-items: start;
		gap: var(--je-space-4);
	}

	.ax-head h2,
	.card h3,
	.section h3 {
		margin: 0.2rem 0;
	}

	.ax-head p,
	.card p,
	.section-lede {
		color: var(--je-color-text-muted);
		max-inline-size: 48rem;
	}

	.eyebrow {
		font-size: var(--je-font-size-xs);
		font-weight: 700;
		letter-spacing: 0.08em;
		color: var(--je-color-text-muted);
	}

	.back {
		display: inline-block;
		margin-block-end: var(--je-space-3);
	}

	.head-actions {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
	}

	.card,
	.section {
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		padding: var(--je-space-5);
	}

	.gate {
		display: grid;
		gap: var(--je-space-4);
		justify-items: start;
	}

	.section-title {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-4);
		margin-block-end: var(--je-space-3);
	}

	.section h4 {
		margin: var(--je-space-5) 0 var(--je-space-2);
		font-size: var(--je-font-size-sm);
	}

	.section h4:first-of-type {
		margin-block-start: 0;
	}

	.release-row {
		display: grid;
		gap: var(--je-space-3);
		max-inline-size: 34rem;
	}

	.release-facts {
		margin: 0;
		color: var(--je-color-text-muted);
	}

	.value-list {
		display: grid;
	}

	.value-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(14rem, 20rem);
		align-items: center;
		gap: var(--je-space-4);
		border-block-start: 1px solid var(--je-color-border);
		padding-block: var(--je-space-3);
	}

	.value-row:first-child {
		border-block-start: 0;
	}

	.value-row small,
	.name-grid small,
	.room-grid small {
		display: block;
		margin-block-start: 0.25rem;
		color: var(--je-color-text-muted);
	}

	.name-grid,
	.room-grid {
		display: grid;
	}

	.name-grid__head,
	.room-grid__head {
		font-size: var(--je-font-size-xs);
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--je-color-text-muted);
		padding-block-end: var(--je-space-2);
	}

	.name-grid__head,
	.name-grid__row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(9rem, 13rem) minmax(9rem, 13rem);
		gap: var(--je-space-4);
		align-items: center;
	}

	.room-grid__head,
	.room-grid__row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem);
		gap: var(--je-space-4);
		align-items: center;
	}

	.name-grid__row,
	.room-grid__row {
		border-block-start: 1px solid var(--je-color-border);
		padding-block: var(--je-space-3);
	}

	.room-grid__controls {
		display: flex;
		align-items: center;
		gap: var(--je-space-4);
	}

	.room-grid__controls input {
		inline-size: 8rem;
	}

	.room-grid__error {
		grid-column: 1 / -1;
		margin: 0;
		color: var(--je-color-danger);
		font-size: var(--je-font-size-sm);
	}

	.setup-moments {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--je-space-3);
		margin-block-end: var(--je-space-4);
	}

	.setup-moments span {
		display: flex;
		gap: var(--je-space-2);
		align-items: center;
		color: var(--je-color-text-muted);
	}

	.setup-moments b {
		display: grid;
		place-items: center;
		flex: 0 0 1.75rem;
		block-size: 1.75rem;
		border-radius: 999px;
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text);
	}

	.locations-download {
		margin-block-end: var(--je-space-4);
	}

	.check-list {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.check-list li {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--je-space-4);
	}

	.check-list a {
		white-space: nowrap;
	}

	.cell {
		display: grid;
	}

	.cell__label {
		display: none;
	}

	.all-clear {
		margin: 0;
	}

	.contains {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--je-space-3);
		margin: 0;
	}

	.contains div {
		padding: var(--je-space-3);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
	}

	.contains dt {
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.contains dd {
		margin: 0.25rem 0 0;
		font-size: var(--je-font-size-lg);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.contains-fields {
		margin: var(--je-space-3) 0 0;
		color: var(--je-color-text-muted);
	}

	.generated-fact {
		margin: 0 0 var(--je-space-3);
	}

	.blocked-reason {
		margin: 0 0 var(--je-space-2);
		color: var(--je-color-text-muted);
	}

	.package-actions {
		display: flex;
		align-items: center;
		gap: var(--je-space-4);
		flex-wrap: wrap;
	}

	.boundary {
		margin-block-start: var(--je-space-4);
		font-size: var(--je-font-size-sm);
	}

	.quiet {
		margin: 0;
		color: var(--je-color-text-muted);
	}

	.notice {
		margin: 0;
		color: var(--je-color-success);
	}

	@media (max-width: 920px) {
		.ax-detail {
			gap: var(--je-space-4);
		}

		.ax-head,
		.section-title {
			display: grid;
			align-items: stretch;
		}

		.head-actions {
			justify-content: start;
		}

		.card,
		.section {
			padding: var(--je-space-4);
		}

		.value-row,
		.name-grid__row,
		.room-grid__row {
			grid-template-columns: 1fr;
		}

		.name-grid__head,
		.room-grid__head {
			display: none;
		}

		.cell__label {
			display: block;
			margin-block-end: 0.25rem;
			font-size: var(--je-font-size-sm);
			color: var(--je-color-text-muted);
		}

		.name-grid__row input,
		.room-grid__controls input {
			inline-size: 100%;
			min-block-size: 44px;
		}

		.room-grid__controls {
			display: grid;
			gap: var(--je-space-3);
		}

		.setup-moments {
			grid-template-columns: 1fr;
		}

		.check-list li {
			flex-direction: column;
			align-items: start;
			gap: var(--je-space-1);
		}

		.contains {
			grid-template-columns: 1fr;
		}
	}
</style>
