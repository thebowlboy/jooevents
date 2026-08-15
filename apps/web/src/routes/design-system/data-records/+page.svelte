<script lang="ts">
	import { ChevronDown } from 'lucide-svelte';
	import {
		Badge,
		Button,
		RecordDetail,
		RecordField,
		ScopeFilter,
		TrackChip,
		badgeFor,
		recordTable,
		statusToneClass,
		submissionTrayIcon,
		trackAccentPalette,
		type Scope,
		type StatusTone
	} from '$lib/ui';

	// Judged at internal-operations density, because these primitives were
	// built for dense operator tables and a roomy specimen page would flatter
	// every one of them.
	$effect(() => {
		const previous = document.documentElement.dataset.density;
		document.documentElement.dataset.density = 'compact';
		return () => {
			if (previous === undefined) delete document.documentElement.dataset.density;
			else document.documentElement.dataset.density = previous;
		};
	});

	const trackOrder = [
		'organizer-craft',
		'agent-systems',
		'platform-reliability',
		'research',
		'community',
		'security',
		'data',
		'design'
	];

	const trackNames: Record<string, string> = {
		'organizer-craft': 'Organizer Craft',
		'agent-systems': 'Agent Systems',
		'platform-reliability': 'Platform & Reliability',
		research: 'Research',
		community: 'Community',
		security: 'Security & Trust',
		data: 'Data Engineering',
		design: 'Design'
	};

	interface Row {
		id: string;
		title: string;
		speaker: string;
		trackId: string | null;
		format: string;
		signals: string;
		reviews: string;
		reviewCount: number;
		decision: 'accepted' | 'waitlisted' | 'declined' | null;
		notified: boolean;
		abstract: string;
	}

	const rows: Row[] = [
		{
			id: 'sub-1',
			title: 'Running a call for papers without losing your weekends',
			speaker: 'Ingrid Halvorsen',
			trackId: 'organizer-craft',
			format: 'Talk · 30 min',
			signals: 'Returning speaker',
			reviews: '4.8',
			reviewCount: 3,
			decision: 'accepted',
			notified: false,
			abstract:
				'Two years of running a 900-submission call with a volunteer committee of five. What we automated, what we deliberately refused to automate, and the three review patterns that turned a fortnight of triage into an afternoon: staged deadlines, expectation setting before the form opens, and a discard tray nobody is afraid of.'
		},
		{
			id: 'sub-2',
			title: 'Agent handoffs that do not lose the thread',
			speaker: 'Tomás Řehák',
			trackId: 'agent-systems',
			format: 'Talk · 30 min',
			signals: 'Agent-drafted',
			reviews: '4.1',
			reviewCount: 4,
			decision: 'waitlisted',
			notified: true,
			abstract:
				'A working account of passing state between agents without a shared database: typed changesets, a diff surface a human can actually read, and what happened the three times we let a model write straight to effective state.'
		},
		{
			id: 'sub-3',
			title: 'Backpressure for the rest of us',
			speaker: 'Mei-Ling Chen',
			trackId: 'platform-reliability',
			format: 'Workshop · 90 min',
			signals: 'Needs reviewer',
			reviews: 'No reviews yet',
			reviewCount: 0,
			decision: null,
			notified: false,
			abstract:
				'Queues fill. This is a hands-on session on what to do about it when your budget is one engineer and your traffic is spiky: shedding, buffering, and the difference between a system that degrades and one that falls over.'
		},
		{
			id: 'sub-4',
			// Deliberately trackless: the row that shipped nine blank capsules.
			title: 'What a schedule owes the people in it',
			speaker: 'Priya Ramanathan',
			trackId: null,
			format: 'Talk · 20 min',
			signals: 'Late arrival',
			reviews: '3.2',
			reviewCount: 2,
			decision: 'declined',
			notified: true,
			abstract:
				'Accessibility, prayer rooms, quiet spaces, and the ten minutes between sessions that nobody schedules. A speaker-side account of what a published schedule promises and how often it keeps that promise.'
		}
	];

	const decisionKey = {
		accepted: 'accepted',
		waitlisted: 'waitlisted',
		declined: 'declined'
	} as const;

	let openRow = $state<string | null>(null);
	let sheetOpen = $state(false);

	const trays: Scope[] = [
		{ value: 'inbox', label: 'Inbox', count: 9, icon: submissionTrayIcon.inbox },
		{ value: 'set-aside', label: 'Set aside', short: 'Aside', count: 3, icon: submissionTrayIcon['set-aside'] },
		{ value: 'late', label: 'Late', count: 1, icon: submissionTrayIcon.late },
		{ value: 'discarded', label: 'Spam', short: 'Spam', count: 4, icon: submissionTrayIcon.discarded }
	];

	let tray = $state('inbox');
	let narrowTray = $state('set-aside');

	const tones: { tone: StatusTone; word: string; state: Parameters<typeof badgeFor>[0] }[] = [
		{ tone: 'positive', word: 'Accepted', state: 'accepted' },
		{ tone: 'negative', word: 'Declined', state: 'declined' },
		{ tone: 'caution', word: 'Waitlisted', state: 'waitlisted' },
		{ tone: 'info', word: 'Invited', state: 'invited' },
		{ tone: 'neutral', word: 'Decision needed', state: 'notStarted' }
	];

	/** A value the surface genuinely does not have. It must render nothing. */
	const missingTrack = '';
</script>

<svelte:head>
	<title>Data records · JooEvents design system</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="page">
	<header class="page__head">
		<p class="eyebrow">Design system</p>
		<h1>Data records</h1>
		<p class="lede">
			The foundation every data surface inherits: a badge that cannot render empty, a category
			palette that can tell eight tracks apart, a table that stops scrolling sideways on a phone,
			a scope set that keeps every member reachable, one detail in two presentations, and a
			destructive action that does not claim the region's primary slot.
		</p>
	</header>

	<!-- ─────────────────────────────────────────────────────────────────── -->
	<section id="badges" class="section">
		<h2>Badge integrity</h2>
		<p class="note">
			A badge is a background drawn around a word. With no word it is decoration that reads as a
			value the surface failed to load, so <code>Badge</code> renders nothing at all; with too
			little room it holds its content's width and lets the prose beside it give way.
		</p>

		<div class="specimens">
			<figure class="specimen">
				<figcaption>Blank renders nothing</figcaption>
				<div class="line" data-testid="blank-badge-line">
					<span>Priya Ramanathan</span>
					<Badge value={missingTrack} tone="lavender" />
					<span class="muted">· Talk · 20 min</span>
				</div>
				<p class="caption">
					No pill, no doubled separator, no 16px hole in the line. Where the absence itself
					matters the surface says so in words on its quietest rung — never as an empty box.
				</p>
			</figure>

			<figure class="specimen">
				<figcaption>Too narrow to fit (180px)</figcaption>
				<div class="cramped">
					<span class="cramped__text">A submission title long enough to fight for the line</span>
					<Badge {...badgeFor('waitlisted')} value="Waitlisted" />
				</div>
				<p class="caption">
					The badge holds its width; the title truncates. The word can never paint outside its
					own background.
				</p>
			</figure>

			<figure class="specimen">
				<figcaption>Truncating, where space is genuinely short</figcaption>
				<div class="cramped">
					<Badge tone="mark" value="Platform &amp; Reliability — chair review" truncate />
				</div>
				<p class="caption">
					Opt-in per instance, with a floor. The full value stays in the DOM for assistive
					technology and in <code>title</code> for the pointer.
				</p>
			</figure>

			<figure class="specimen">
				<figcaption>The net under the raw class</figcaption>
				<div class="line" data-testid="raw-empty">
					<span>Priya Ramanathan</span>
					<!-- Deliberately the un-migrated call site: a raw class fed a value
					     the surface does not have. The primitive is the fix; this rule
					     is what stops the defect shipping from the places it has not
					     reached yet. -->
					<span class="ui-badge ui-badge--neutral">{missingTrack}</span>
					<span class="ui-track">{missingTrack}</span>
					<span class="muted">· Talk · 20 min</span>
				</div>
				<p class="caption">
					<code>.ui-badge:empty</code> and <code>.ui-track:empty</code> take no space. A net,
					not a substitute: a page that renders its own empty box is still a page to migrate.
				</p>
			</figure>
		</div>
	</section>

	<!-- ─────────────────────────────────────────────────────────────────── -->
	<section id="tones" class="section">
		<h2>Status tones</h2>
		<p class="note">
			Five words, applied wherever a state appears. Tone belongs to the state; emphasis belongs to
			the region, which is why <code>badgeFor</code> hands back a tone and a glyph and never a
			loudness.
		</p>

		<div class="tones">
			{#each tones as entry (entry.tone)}
				<div class="tone">
					<Badge {...badgeFor(entry.state)} value={entry.word} />
					<span class="tone__name">{entry.tone}</span>
					<span class="tone__family muted">.ui-badge--{statusToneClass[entry.tone]}</span>
				</div>
			{/each}
		</div>

		<p class="note">
			The same fact at two loudnesses is how a reader mis-ranks it. Result not sent is
			<em>caution</em> on every surface; whether one instance is promoted to a solid emphasis
			badge is a decision about that region's single accent-dominant slot, and a column of them
			is always wrong.
		</p>
		<div class="line">
			<Badge {...badgeFor('unnotified')} value="Result not sent" />
			<span class="muted">— soft, in a column</span>
			<Badge {...badgeFor('unnotified')} value="Result not sent" emphasis />
			<span class="muted">— solid, at most once per region</span>
		</div>
	</section>

	<!-- ─────────────────────────────────────────────────────────────────── -->
	<section id="tracks" class="section">
		<h2>Track accents</h2>
		<p class="note">
			A category is not a state, so it takes a different silhouette: a squared corner, no status
			glyph, one weight lighter. Colour is then free to do the only job it has here — tell this
			track from the next one. All eight fills sit at the same lightness, so no track looks more
			important than its neighbours.
		</p>

		<div class="tracks">
			{#each trackOrder as id (id)}
				<TrackChip name={trackNames[id]} {id} order={trackOrder} />
			{/each}
		</div>

		<p class="caption">
			{trackAccentPalette.length} accents, every ink at 5.7:1 or better on its own fill, on
			surface, and on page. Theme-independent on purpose: an event theme cannot re-derive a
			category palette out of its own action colour.
		</p>

		<div class="line">
			<span class="muted">A submission with no track:</span>
			<TrackChip name={missingTrack} id="none" />
			<span class="muted">— nothing at all.</span>
		</div>
	</section>

	<!-- ─────────────────────────────────────────────────────────────────── -->
	<section id="scopes" class="section">
		<h2>Scope filter</h2>
		<p class="note">
			A closed set of mutually exclusive populations. Every member stays visible and reachable at
			390px: the set rearranges into two even columns rather than wrapping, an odd member takes
			the full width, and narrow space may take letters but never the word — the full name stays
			the accessible name.
		</p>

		<figure class="specimen">
			<figcaption>Room for one row</figcaption>
			<ScopeFilter label="Submission trays" scopes={trays} bind:value={tray} />
		</figure>

		<figure class="specimen">
			<figcaption>360px — two columns, touch-row targets, abbreviated faces</figcaption>
			<div class="narrow" data-testid="narrow-scopes">
				<ScopeFilter label="Submission trays, narrow" scopes={trays} bind:value={narrowTray} />
			</div>
		</figure>
	</section>

	<!-- ─────────────────────────────────────────────────────────────────── -->
	<section id="records" class="section">
		<h2>The phone record</h2>
		<p class="note">
			Below the width its columns need, a row re-composes: a rail for the row's own control, a
			primary line, labelled scan-key lines, and one trailing affordance. The trigger is a
			container query on the wrapper, so a table narrowed by the sidebar re-composes at the same
			moment a phone's does — and every <code>.ui-table</code> in the product inherits it without
			a page change.
		</p>

		<figure class="specimen">
			<figcaption>Columns — the wrapper has room</figcaption>
			<div class="ui-table-wrap">
				<table class="ui-table ui-table--multiline" {@attach recordTable()}>
					<thead>
						<tr>
							<th class="ui-pick-cell">
								<label class="ui-pick"
									><input type="checkbox" aria-label="Select all shown" /></label>
							</th>
							<th>Submission</th>
							<th>Signals</th>
							<th class="ui-table__number">Reviews</th>
							<th>Decision</th>
							<th><span class="ui-sr-only">Details</span></th>
						</tr>
					</thead>
					<tbody>
						{#each rows as row (row.id)}
							<tr>
								<td class="ui-pick-cell">
									<label class="ui-pick"
										><input type="checkbox" aria-label={`Select “${row.title}”`} /></label>
								</td>
								<td class="ui-cell--lead">
									<span class="ui-table__primary title-line">
										<strong>{row.title}</strong>
										<TrackChip name={row.trackId ? trackNames[row.trackId] : ''} id={row.trackId ?? ''} order={trackOrder} />
									</span>
									<span class="ui-table__secondary">{row.speaker} · {row.format}</span>
								</td>
								<td>{row.signals}</td>
								<td class="ui-table__number">{row.reviews}</td>
								<td class="ui-cell--state">
									{#if row.decision}
										<Badge {...badgeFor(decisionKey[row.decision])} value={row.decision === 'accepted' ? 'Accepted' : row.decision === 'waitlisted' ? 'Waitlisted' : 'Declined'} />
									{:else}
										<Badge {...badgeFor('notStarted')} value="Decision needed" />
									{/if}
								</td>
								<td class="ui-cell--trail">
									<Button
										variant="ghost"
										size="sm"
										iconOnly
										aria-expanded={openRow === row.id}
										aria-label={`Details for “${row.title}”`}
										onclick={() => (openRow = openRow === row.id ? null : row.id)}>
										<ChevronDown />
									</Button>
								</td>
							</tr>
							{#if openRow === row.id}
								<tr class="ui-table__detail">
									<td colspan="6">
										<RecordDetail
											title={row.title}
											presentation="inline"
											onclose={() => (openRow = null)}>
											<!-- Evidence-first: the byline opens, the judged material follows,
											     and the classification ledger closes the record in `meta`. -->
											{#snippet fields()}
											<RecordField label="Speaker" role="person">{row.speaker}</RecordField>
											{/snippet}
											{#snippet blocks()}
											<RecordField label="Abstract" prose emphasis="primary">{row.abstract}</RecordField>
												<RecordField label="Materials" block>
													<span class="muted">No materials attached to this submission.</span>
												</RecordField>
											{/snippet}
											{#snippet meta()}
												<RecordField label="Track">
													{#if row.trackId}
												<TrackChip name={trackNames[row.trackId]} id={row.trackId} order={trackOrder} />
													{:else}
														<span class="muted">No track</span>
													{/if}
											</RecordField>
											<RecordField label="Format">{row.format}</RecordField>
											<RecordField label="Received" role="time">4 weeks ago</RecordField>
											<RecordField label="Reviews" role="measure">
													{row.reviewCount > 0 ? `${row.reviews} average of ${row.reviewCount} reviews` : 'No reviews yet'}
												</RecordField>
											{/snippet}
											{#snippet actions()}
												<Button variant="secondary" size="sm">Set aside</Button>
												<Button variant="danger-quiet" size="sm">Mark as spam</Button>
											{/snippet}
											{#snippet footnote()}
												Neither is sent to the submitter and both can be undone.
											{/snippet}
										</RecordDetail>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		</figure>

		<figure class="specimen">
			<figcaption>360px — the same table as records</figcaption>
			<div class="narrow" data-testid="record-specimen">
				<div class="ui-table-wrap">
					<table class="ui-table ui-table--multiline" {@attach recordTable()}>
						<thead>
							<tr>
								<th class="ui-pick-cell">
									<label class="ui-pick"
										><input type="checkbox" aria-label="Select all shown records" /></label>
								</th>
								<th>Submission</th>
								<th>Signals</th>
								<th class="ui-table__number">Reviews</th>
								<th>Decision</th>
								<th><span class="ui-sr-only">Details</span></th>
							</tr>
						</thead>
						<tbody>
							{#each rows as row (row.id)}
								<tr>
									<td class="ui-pick-cell">
										<label class="ui-pick"
											><input type="checkbox" aria-label={`Select record “${row.title}”`} /></label>
									</td>
									<td class="ui-cell--lead">
										<span class="ui-table__primary">
											<strong>{row.title}</strong>
										</span>
										<span class="ui-table__secondary">{row.speaker}</span>
									</td>
									<td>{row.signals}</td>
									<td class="ui-table__number ui-cell--detail">{row.reviews}</td>
									<td class="ui-cell--state">
										{#if row.decision}
											<Badge {...badgeFor(decisionKey[row.decision])} value={row.decision === 'accepted' ? 'Accepted' : row.decision === 'waitlisted' ? 'Waitlisted' : 'Declined'} />
										{:else}
											<Badge {...badgeFor('notStarted')} value="Decision needed" />
										{/if}
									</td>
									<td class="ui-cell--trail">
										<Button
											variant="ghost"
											size="sm"
											iconOnly
											aria-label={`Record details for “${row.title}”`}>
											<ChevronDown />
										</Button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
			<p class="caption">
				<code>Reviews</code> carries <code>.ui-cell--detail</code>: it does not earn phone real
				estate and is rendered in the detail instead. That class is only legitimate when the
				value is genuinely there — hiding a fact outright is the off-screen defect in a
				different costume.
			</p>
		</figure>

		<figure class="specimen">
			<figcaption>Genuinely tabular: columns kept, scrolling declared</figcaption>
			<div class="narrow">
				<!-- A grid whose meaning *is* the alignment keeps its columns and owes
				     a visible affordance and a keyboard-reachable scroll region. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<!-- The tabindex is the point: a scroll container that cannot be
				     focused cannot be scrolled by keyboard at all, and a region with
				     content out of view is exactly the case WCAG 2.1.1 covers. The
				     accessible name comes with it so the landmark says what it holds. -->
				<div
					class="ui-table-wrap ui-table-wrap--scroll"
					tabindex="0"
					role="region"
					aria-label="Speaker task matrix, scrolls sideways">
					<table class="ui-table ui-table--columns">
						<thead>
							<tr>
								<th>Speaker</th>
								<th class="ui-table__number">Bio</th>
								<th class="ui-table__number">Headshot</th>
								<th class="ui-table__number">Slides</th>
								<th class="ui-table__number">Travel</th>
								<th class="ui-table__number">Consent</th>
							</tr>
						</thead>
						<tbody>
							{#each rows as row (row.id)}
								<tr>
									<td>{row.speaker}</td>
									<td class="ui-table__number">Done</td>
									<td class="ui-table__number">Done</td>
									<td class="ui-table__number">Due</td>
									<td class="ui-table__number">—</td>
									<td class="ui-table__number">Done</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
			<p class="caption">
				The shadow at the trailing edge rides the scroll: it appears only while there is
				something past it and clears at both ends.
			</p>
		</figure>
	</section>

	<!-- ─────────────────────────────────────────────────────────────────── -->
	<section id="detail" class="section">
		<h2>Detail: one component, two presentations</h2>
		<p class="note">
			Desktop keeps the inline expansion, because comparing one record against the list it came
			from is the whole reason a power user expands rather than opens. A phone gets the same
			content as a full-screen sheet — same fields, same order, same words — because a labelled
			two-column detail inside a 390px column is unreadable. Expand a row above for the inline
			presentation.
		</p>

		<Button variant="secondary" onclick={() => (sheetOpen = true)}>Open as a sheet</Button>

		{#if sheetOpen}
			<RecordDetail
				title={rows[0].title}
				presentation="sheet"
				onclose={() => (sheetOpen = false)}>
				{#snippet fields()}
					<RecordField label="Speaker" role="person">{rows[0].speaker}</RecordField>
				{/snippet}
				{#snippet blocks()}
					<RecordField label="Abstract" prose emphasis="primary">{rows[0].abstract}</RecordField>
					<RecordField label="Materials" block>
						<span class="muted">No materials attached to this submission.</span>
					</RecordField>
				{/snippet}
				{#snippet meta()}
					<RecordField label="Track">
						<TrackChip name={trackNames['organizer-craft']} id="organizer-craft" order={trackOrder} />
					</RecordField>
					<RecordField label="Format">{rows[0].format}</RecordField>
					<RecordField label="Received" role="time">4 weeks ago</RecordField>
					<RecordField label="Decision"><Badge {...badgeFor('accepted')} value="Accepted" /></RecordField>
				{/snippet}
				{#snippet actions()}
					<Button variant="secondary">Set aside</Button>
					<Button variant="danger-quiet">Mark as spam</Button>
				{/snippet}
				{#snippet footnote()}
					Neither is sent to the submitter and both can be undone.
				{/snippet}
			</RecordDetail>
		{/if}
	</section>

	<!-- ─────────────────────────────────────────────────────────────────── -->
	<section id="quiet-danger" class="section">
		<h2>Quiet danger</h2>
		<p class="note">
			Destructive and secondary at the same time. A filled red button here would take the one
			accent-dominant slot the region has and give it to the action nobody should reach for by
			momentum; filled danger is reserved for the confirming press inside a dialog, where
			destroying the thing genuinely is the primary action.
		</p>

		<div class="line">
			<Button>Send their results</Button>
			<Button variant="secondary">Set aside</Button>
			<Button variant="danger-quiet">Mark as spam</Button>
		</div>

		<p class="caption">
			Beside it, for comparison, the tier it is not: <Button variant="danger" size="sm"
				>Delete event</Button> — a confirming press, and only inside a dialog.
		</p>
	</section>
</main>

<style>
	.page {
		max-inline-size: 72rem;
		margin-inline: auto;
		padding: var(--je-space-8) var(--je-space-4) var(--je-space-12);
		display: grid;
		gap: var(--je-space-10);
	}

	.page__head {
		display: grid;
		gap: var(--je-space-2);
	}

	.eyebrow {
		margin: 0;
		color: var(--je-color-text-subtle);
		font-size: var(--je-font-size-2xs);
		font-weight: 700;
		letter-spacing: var(--je-tracking-caps);
		text-transform: uppercase;
	}

	h1 {
		margin: 0;
		font-size: var(--je-font-size-2xl);
	}

	h2 {
		margin: 0;
		font-size: var(--je-font-size-lg);
	}

	.lede,
	.note {
		max-inline-size: 62ch;
		margin: 0;
		color: var(--je-color-text-muted);
		line-height: var(--je-leading-normal);
	}

	.section {
		display: grid;
		gap: var(--je-space-4);
	}

	.specimens {
		display: grid;
		gap: var(--je-space-6);
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
	}

	.specimen {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		min-inline-size: 0;
	}

	figcaption {
		color: var(--je-color-text-subtle);
		font-size: var(--je-font-size-2xs);
		font-weight: 700;
		letter-spacing: var(--je-tracking-caps);
		text-transform: uppercase;
	}

	.caption {
		max-inline-size: 62ch;
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-snug);
	}

	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		min-inline-size: 0;
	}

	.muted {
		color: var(--je-color-text-muted);
	}

	/* Deliberately too narrow: the badge must hold and the text must give way. */
	.cramped {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		inline-size: 11.25rem;
		max-inline-size: 100%;
		padding: var(--je-space-2);
		border: 1px dashed var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
	}

	.cramped__text {
		min-inline-size: 0;
		overflow: hidden;
		font-size: var(--je-font-size-sm);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* A phone-width column inside a desktop page: the container query answers
	   about this box, which is the whole point of asking the container. */
	.narrow {
		inline-size: min(100%, 22.5rem);
	}

	.tones {
		display: grid;
		gap: var(--je-space-2);
		grid-template-columns: max-content max-content minmax(0, 1fr);
		justify-content: start;
		align-items: center;
	}

	.tone {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: center;
	}

	.tone__name {
		font-size: var(--je-font-size-sm);
		font-weight: 650;
	}

	.tone__family {
		font-family: var(--je-font-mono);
		font-size: var(--je-font-size-2xs);
	}

	.tracks {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.title-line {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-inline-size: 0;
	}
</style>
