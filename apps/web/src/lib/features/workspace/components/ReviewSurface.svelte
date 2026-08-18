<script module lang="ts">
	import type {
		EmailReadiness,
		MessageReview,
		MessageTemplate,
		ReadinessState
	} from '$lib/api/types';

	/** Recipients that actually receive an email — the count every label uses. */
	export function includedCount(review: MessageReview | null): number {
		return review ? review.recipients.filter((recipient) => recipient.state === 'included').length : 0;
	}

	/** Review labels that render from a stored template, by that template's key. */
	const templateKeyByLabel: Record<string, string> = {
		'decision-notice': 'decision-accepted'
	};

	/**
	 * One fact, one door: the template line links to the stored template it
	 * names when the label maps to a known key. Unknown labels stay plain text —
	 * a link that opens nothing is worse than a word that never claimed to be one.
	 */
	export function templateDoor(
		label: string | undefined,
		templates: MessageTemplate[] | null
	): { href: string; name: string } | null {
		const match = templateFor(label, templates);
		return match ? { href: `/app/templates?template=${match.id}`, name: match.name } : null;
	}

	/**
	 * The stored template a review label names, or null when nothing matches.
	 * The door and the rendered body resolve through this one lookup, so a
	 * ceremony can never link to one template while rendering another.
	 */
	export function templateFor(
		label: string | undefined,
		templates: MessageTemplate[] | null
	): MessageTemplate | null {
		if (!label || !templates) return null;
		const statedName = label.split(' @ ')[0] ?? '';
		const key = templateKeyByLabel[statedName];
		const match = key
			? templates.find((template) => template.key === key)
			: templates.find((template) => template.name === statedName);
		return match ?? null;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Search } from 'lucide-svelte';
	import { CopyValue, Marked } from '$lib/ui';
	import { matchFields, parseSearch, type MatchRange } from '$lib/api/search';
	import type { RecipientRow } from '$lib/api/types';

	interface Props {
		/** Null while the projection is still loading; the shell keeps its footprint. */
		review: MessageReview | null;
		/** Null while provider readiness is still loading. */
		readiness?: EmailReadiness | null;
		/** Column header over the per-recipient sample. */
		previewLabel?: string;
		/** Subject control, rendered above the summary. */
		subject?: Snippet;
		/** Door behind the template fact (see `templateDoor`); null keeps it plain text. */
		templateDoor?: { href: string; name: string } | null;
		/**
		 * Lets the host render one included recipient's whole email: the sample
		 * line becomes the press that asks for it. Excluded and blocked rows can
		 * never request content, so their reasons stay plain text.
		 */
		onPreview?: (recipient: RecipientRow) => void;
		/** The recipient whose preview is currently open, by email. */
		previewingEmail?: string | null;
	}

	let {
		review,
		readiness = null,
		previewLabel = 'What they see',
		subject,
		templateDoor: door = null,
		onPreview,
		previewingEmail = null
	}: Props = $props();

	const uid = $props.id();

	let query = $state('');

	// Narrow widths get a two-column composition instead of a squeezed third
	// column: the sample moves under the person it belongs to.
	let narrow = $state(false);

	$effect(() => {
		const media = window.matchMedia('(max-width: 620px)');
		const sync = () => (narrow = media.matches);
		sync();
		media.addEventListener('change', sync);
		return () => media.removeEventListener('change', sync);
	});

	const readinessBadge: Record<ReadinessState, { label: string; tone: string; solid: boolean }> = {
		ready: { label: 'Ready', tone: 'success', solid: false },
		action_required: { label: 'Action required', tone: 'warning', solid: true },
		unknown: { label: 'Not checked', tone: 'neutral', solid: false },
		not_applicable: { label: 'Not set up', tone: 'neutral', solid: false }
	};

	const included = $derived(includedCount(review));
	const excluded = $derived(
		review ? review.recipients.filter((recipient) => recipient.state === 'excluded').length : 0
	);
	// Counted from the rows rather than asserted alongside them, so the number
	// and the people it refers to cannot disagree.
	const blocked = $derived(
		review ? review.recipients.filter((recipient) => recipient.state === 'blocked').length : 0
	);

	/**
	 * Search covers everything the table shows, so a person found by their
	 * preview line or exclusion reason is found by the same box.
	 *
	 * This runs through the shared matcher rather than a local `includes`, which
	 * buys three things the joined-string version could not do: a name folds, so
	 * "Sorensen" reaches "Sørensen"; several words narrow instead of having to
	 * appear contiguously; and no match can straddle two fields, which a joined
	 * haystack allowed at every seam.
	 *
	 * There is no settle here and there should not be. These rows are already in
	 * hand, so filtering costs nothing and a delay would only be a delay — the
	 * settle on the submissions board exists to space out a round trip, not to
	 * space out typing.
	 *
	 * Identity fields are passed deliberately. This surface is the organizer
	 * addressing people by name; the partition that withholds them is for
	 * reviewer-scoped surfaces, where a name in a result set is a disclosure.
	 */
	const parsed = $derived(parseSearch(query));
	const matches = $derived.by(() => {
		const rows = review?.recipients ?? [];
		if (parsed.terms.length === 0) return rows.map((recipient) => ({ recipient, match: null }));
		return rows
			.map((recipient) => ({
				recipient,
				match: matchFields(
					[
						{ text: recipient.name, space: 'identity', weight: 'primary' },
						{ text: recipient.email, space: 'identity', weight: 'secondary' },
						{ text: recipient.mergeSample ?? '', space: 'body', weight: 'secondary' },
						{ text: recipient.reason ?? '', space: 'body', weight: 'secondary' }
					],
					parsed
				)
			}))
			.filter((entry) => entry.match !== null);
	});

	const RECIPIENT_FIELD_NAME = 0;
	const RECIPIENT_FIELD_EMAIL = 1;
	const RECIPIENT_FIELD_LINE = 2;
	const RECIPIENT_FIELD_REASON = 3;

	function plural(count: number, singular: string, many = `${singular}s`) {
		return `${count} ${count === 1 ? singular : many}`;
	}

	/** Included rows show what the person reads; the rest show why they are out. */
	function line(recipient: { state: string; mergeSample?: string; reason?: string }) {
		return recipient.state === 'included' ? (recipient.mergeSample ?? '') : (recipient.reason ?? '');
	}
</script>

{#snippet sampleCell(recipient: RecipientRow, ranges: readonly MatchRange[], inline: boolean)}
	{#if onPreview && recipient.state === 'included' && line(recipient)}
		<!-- Dotted underline, row ink: this tells more in place — the whole
		     rendered email opens below the table, nothing navigates. -->
		<button
			type="button"
			class="sample sample--door"
			class:sample--inline={inline}
			aria-pressed={previewingEmail === recipient.email}
			aria-label={`Preview the email for ${recipient.name}`}
			onclick={() => onPreview?.(recipient)}>
			<Marked text={line(recipient)} {ranges} />
		</button>
	{:else}
		<span
			class="sample"
			class:sample--inline={inline}
			class:sample--reason={recipient.state !== 'included'}>
			<Marked text={line(recipient)} {ranges} />
		</span>
	{/if}
{/snippet}

{#if subject}
	<div class="subject">{@render subject()}</div>
{/if}

{#if review}
	<section class="summary" aria-labelledby="{uid}-summary">
		<h3 class="summary__title" id="{uid}-summary">Sends {plural(included, 'email message')}</h3>
		<dl class="summary__rows">
			<div class="pair">
				<dt class="pair__label">Template</dt>
				<dd class="pair__value">
					{#if door}
						<a href={door.href} aria-label={`Edit template — ${door.name}`}>{review.templateLabel}</a>
					{:else}
						{review.templateLabel}
					{/if}
				</dd>
			</div>
			<div class="pair">
				<dt class="pair__label">Audience</dt>
				<dd class="pair__value">
					{review.audienceLabel}
					{#if review.binding === 'current_snapshot'}
						<span class="pair__note">
							Fixed to the people who qualify right now — anyone who qualifies later is not added.
						</span>
					{/if}
				</dd>
			</div>
			<div class="pair">
				<dt class="pair__label">Counts</dt>
				<dd class="pair__value counts">
					<span class="count">{included} included</span>
					<span class="count" class:count--warning={excluded > 0}>{excluded} excluded</span>
					<!-- Only when it is true. A permanent "0 could not be prepared" is
					     chrome; the fault is worth a line exactly when there is one,
					     and it says outright that these are not in the total above. -->
					{#if blocked > 0}
						<span class="count count--danger">
							{plural(blocked, 'message')} could not be prepared — not in the {included} above
						</span>
					{/if}
				</dd>
			</div>
			<div class="pair">
				<dt class="pair__label">Sender</dt>
				<dd class="pair__value">
					<CopyValue value={review.sender} label="sender address" />
					<span class="pair__note">{review.replyModel}</span>
				</dd>
			</div>
			<div class="pair">
				<dt class="pair__label">Provider readiness</dt>
				<dd class="pair__value states">
					{#if readiness}
						{@const outbound = readinessBadge[readiness.outbound]}
						{@const callbacks = readinessBadge[readiness.callbacks]}
						<span class="state">
							Outbound
							<span class="ui-badge ui-badge--{outbound.tone}" class:ui-badge--solid={outbound.solid}>
								{outbound.label}
							</span>
						</span>
						<!-- "Delivery callbacks" named the mechanism — the provider calling
						     back after it tries to deliver. What an operator needs is what
						     they lose without it, and that sending itself is unaffected:
						     this row must not read as a reason to hesitate over a send it
						     does not gate. -->
						<span class="state">
							Delivery reports
							<span class="ui-badge ui-badge--{callbacks.tone}" class:ui-badge--solid={callbacks.solid}>
								{callbacks.label}
							</span>
							{#if readiness.callbacks !== 'ready'}
								<span class="state__note">
									Messages still send. Without these, JooEvents never hears which ones
									bounced, so bad addresses stay on your lists.
								</span>
							{/if}
						</span>
					{:else}
						<span class="ui-skeleton skeleton-chip" aria-hidden="true"></span>
						<span class="ui-skeleton skeleton-chip" aria-hidden="true"></span>
					{/if}
				</dd>
			</div>
		</dl>
		<p class="irreversible">
			<span class="irreversible__count">
				Irreversible after provider acceptance: {plural(included, 'external email effect')}
			</span>
			<span class="irreversible__note">{review.irreversibleNote}</span>
		</p>
	</section>

	<section class="recipients" aria-labelledby="{uid}-recipients">
		<header class="recipients__head">
			<h3 class="recipients__title" id="{uid}-recipients">Recipients</h3>
			<p class="recipients__count" role="status">
				{#if query.trim()}
					{matches.length} of {review.recipients.length} shown
				{:else}
					{plural(review.recipients.length, 'person', 'people')} on this list
				{/if}
			</p>
			<div class="ui-input-wrap ui-input-wrap--leading recipients__search">
				<span class="ui-input-wrap__icon" aria-hidden="true"><Search size={14} /></span>
				<input
					class="ui-control"
					type="search"
					placeholder="Search name or email"
					aria-label="Search recipients"
					bind:value={query} />
			</div>
		</header>
		<div class="ui-table-wrap recipients__wrap">
			<table class="ui-table ui-table--multiline">
				<thead>
					<tr>
						<th>Recipient</th>
						{#if !narrow}<th>{previewLabel}</th>{/if}
						<th>In this send</th>
					</tr>
				</thead>
				<tbody>
					{#if matches.length === 0}
						<tr>
							<td colspan={narrow ? 2 : 3}>
								<p class="none">No recipient matches “{query.trim()}”.</p>
							</td>
						</tr>
					{:else}
						{#each matches as { recipient, match } (recipient.email + recipient.name)}
							{@const lineField =
								recipient.state === 'included' ? RECIPIENT_FIELD_LINE : RECIPIENT_FIELD_REASON}
							<tr data-excluded={recipient.state !== 'included' ? 'true' : undefined}>
								<td>
									<span class="who"
										><Marked
											text={recipient.name}
											ranges={match?.fields[RECIPIENT_FIELD_NAME]?.ranges ?? []} /></span>
									<span class="mail"><CopyValue value={recipient.email} label="recipient address" /></span>
									{#if narrow}
										{@render sampleCell(recipient, match?.fields[lineField]?.ranges ?? [], true)}
									{/if}
								</td>
								{#if !narrow}
									<td>
										{@render sampleCell(recipient, match?.fields[lineField]?.ranges ?? [], false)}
									</td>
								{/if}
								<td>
									{#if recipient.state === 'blocked'}
										<span class="ui-badge ui-badge--danger">Could not be prepared</span>
									{:else if recipient.state === 'excluded'}
										<span class="ui-badge ui-badge--warning">Excluded</span>
									{:else}
										<span class="ui-badge ui-badge--success">Included</span>
									{/if}
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</section>
{:else}
	<!-- The projection's own shell holding skeleton fills: labelled facts in the
	     same two-column pairs, then the evidence table with real rows, so the
	     dialog keeps its footprint while the review is fetched. -->
	<section class="summary" aria-labelledby="{uid}-summary" aria-busy="true">
		<h3 class="summary__title" id="{uid}-summary">Send summary</h3>
		<!-- The five facts this summary always states, in order: only their values
		     are unknown, so the notes that belong to audience and sender hold
		     their lines here too. -->
		<dl class="summary__rows" aria-hidden="true">
			<div class="pair">
				<dt class="pair__label"><span class="ui-skeleton sk-line" style="inline-size: 4.5rem"></span></dt>
				<dd class="pair__value"><span class="ui-skeleton sk-line" style="inline-size: min(13rem, 100%)"></span></dd>
			</div>
			<div class="pair">
				<dt class="pair__label"><span class="ui-skeleton sk-line" style="inline-size: 4.5rem"></span></dt>
				<dd class="pair__value">
					<span class="ui-skeleton sk-line" style="inline-size: min(18rem, 100%)"></span>
					<span class="pair__note"><span class="ui-skeleton sk-line" style="inline-size: 100%"></span></span>
					<span class="pair__note"><span class="ui-skeleton sk-line" style="inline-size: 55%"></span></span>
				</dd>
			</div>
			<div class="pair">
				<dt class="pair__label"><span class="ui-skeleton sk-line" style="inline-size: 3.5rem"></span></dt>
				<dd class="pair__value"><span class="ui-skeleton sk-line" style="inline-size: min(16rem, 100%)"></span></dd>
			</div>
			<div class="pair">
				<dt class="pair__label"><span class="ui-skeleton sk-line" style="inline-size: 3.5rem"></span></dt>
				<dd class="pair__value">
					<span class="ui-skeleton sk-line" style="inline-size: min(15rem, 100%)"></span>
					<span class="pair__note"><span class="ui-skeleton sk-line" style="inline-size: 12rem"></span></span>
				</dd>
			</div>
			<div class="pair">
				<dt class="pair__label"><span class="ui-skeleton sk-line" style="inline-size: 7.5rem"></span></dt>
				<dd class="pair__value states states--fill">
					<span class="ui-skeleton skeleton-chip"></span>
					<span class="ui-skeleton skeleton-chip"></span>
				</dd>
			</div>
		</dl>
		<p class="irreversible" aria-hidden="true">
			<span class="irreversible__count"><span class="ui-skeleton sk-line" style="inline-size: min(20rem, 100%)"></span></span>
			<span class="irreversible__note"><span class="ui-skeleton sk-line" style="inline-size: min(24rem, 100%)"></span></span>
		</p>
	</section>
	<section class="recipients" aria-labelledby="{uid}-recipients" aria-busy="true">
		<header class="recipients__head">
			<h3 class="recipients__title" id="{uid}-recipients">Recipients</h3>
			<p class="recipients__count"><span class="ui-skeleton sk-line" style="inline-size: 6rem"></span></p>
			<span class="ui-skeleton sk-search recipients__search" aria-hidden="true"></span>
		</header>
		<div class="ui-table-wrap recipients__wrap" aria-hidden="true">
			<table class="ui-table ui-table--multiline">
				<thead>
					<tr>
						<th>Recipient</th>
						{#if !narrow}<th>{previewLabel}</th>{/if}
						<th>In this send</th>
					</tr>
				</thead>
				<tbody>
					{#each Array(3) as _, index (index)}
						<tr>
							<td>
								<span class="who"><span class="ui-skeleton sk-line" style="inline-size: 7rem"></span></span>
								<span class="mail"><span class="ui-skeleton sk-line" style="inline-size: 10rem"></span></span>
							</td>
							{#if !narrow}
								<td><span class="sample"><span class="ui-skeleton sk-line" style="inline-size: min(14rem, 100%)"></span></span></td>
							{/if}
							<td><span class="ui-skeleton skeleton-chip"></span></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

<style>
	.subject {
		margin-block-end: var(--je-space-5);
	}

	.summary {
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
	}

	.summary__title {
		margin: 0 0 var(--je-space-3);
		font-size: var(--je-font-size-base);
		font-weight: 700;
	}

	.summary__rows {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
	}

	.pair {
		display: grid;
		grid-template-columns: 9.5rem minmax(0, 1fr);
		gap: var(--je-space-1) var(--je-space-3);
		align-items: baseline;
	}

	.pair__label {
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-text-muted);
	}

	.pair__value {
		margin: 0;
		min-width: 0;
		font-size: var(--je-font-size-md);
		overflow-wrap: anywhere;
	}

	.pair__note {
		display: block;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.counts,
	.states {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-3);
	}

	.count {
		font-variant-numeric: tabular-nums;
	}

	/* Counts carry their own tone: an exclusion, or a message that could not be
	   prepared, is the part of this summary that needs a second look. */
	.count--warning {
		color: var(--je-color-warning);
		font-weight: 650;
	}

	.count--danger {
		color: var(--je-color-danger);
		font-weight: 650;
	}

	.state {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-1);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* Takes the whole line under its badge rather than trailing it, so the
	   consequence reads as a sentence instead of a third chip. */
	.state__note {
		flex-basis: 100%;
		font-size: var(--je-font-size-xs);
	}

	.irreversible {
		display: grid;
		gap: 0.15rem;
		margin: var(--je-space-3) 0 0;
		padding-block-start: var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border);
	}

	.irreversible__count {
		font-size: var(--je-font-size-md);
		font-weight: 650;
		color: var(--je-color-warning);
	}

	.irreversible__note {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.recipients {
		margin-block-start: var(--je-space-5);
	}

	.recipients__head {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		align-items: baseline;
		gap: var(--je-space-1) var(--je-space-3);
		margin-block-end: var(--je-space-2);
	}

	.recipients__title {
		margin: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.recipients__count {
		margin: 0;
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-muted);
	}

	.recipients__search {
		grid-column: 1 / -1;
	}

	/* The evidence table scrolls inside its own region so the summary and the
	   send button stay reachable however long the list is. */
	.recipients__wrap {
		max-block-size: 20rem;
		overflow-y: auto;
	}

	.recipients__wrap thead th {
		position: sticky;
		inset-block-start: 0;
		z-index: 1;
	}

	.recipients__wrap .ui-table {
		min-width: 30rem;
	}

	/* The person keeps enough width for a full address; the state column takes
	   only what its badge needs. */
	.recipients__wrap .ui-table th:first-child {
		min-width: 11rem;
	}

	.recipients__wrap .ui-table th:last-child,
	.recipients__wrap .ui-table td:last-child {
		width: 1%;
		white-space: nowrap;
	}

	.who {
		display: block;
		font-size: var(--je-font-size-md);
		font-weight: 650;
		overflow-wrap: anywhere;
	}

	.mail {
		display: block;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		overflow-wrap: anywhere;
	}

	.sample {
		display: block;
		font-size: var(--je-font-size-sm);
		overflow-wrap: anywhere;
	}

	.sample--inline {
		margin-block-start: 0.15rem;
	}

	/* The in-place disclosure grammar: dotted underline in the row's own ink.
	   Open state tints like a marked thing — chosen, not a status. */
	.sample--door {
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: inherit;
		text-align: start;
		cursor: pointer;
		text-decoration: underline dotted;
		text-underline-offset: 0.18em;
	}

	.sample--door:hover {
		text-decoration-style: solid;
	}

	.sample--door[aria-pressed='true'] {
		background: var(--je-color-mark-surface);
		color: var(--je-color-mark-ink);
	}

	/* The exclusion reason takes the place of the preview: what they would have
	   read is replaced by why they are not receiving it. */
	.sample--reason {
		color: var(--je-color-warning);
	}

	tbody tr[data-excluded='true'] .who {
		font-weight: 500;
		color: var(--je-color-text-muted);
	}

	.none {
		margin: 0;
		padding-block: var(--je-space-2);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, a chip is badge-height, and the
	   search box is control-height. Free-standing rectangles drift; these cannot. */
	.sk-line {
		display: inline-block;
		block-size: 1em;
		/* One line box exactly: the line inherits the height it stands in for. */
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.skeleton-chip {
		display: inline-block;
		block-size: 1.35rem;
		inline-size: 5rem;
		vertical-align: bottom;
	}

	/* Centred rather than baseline-aligned: chips with no text have no baseline
	   of their own, and aligning their bottom edge to one would deepen the row. */
	.states--fill {
		align-self: center;
	}

	.sk-search {
		display: block;
		block-size: var(--je-control-height);
		border-radius: var(--je-radius-control);
	}

	/* Narrow widths stack each labelled fact and let the two remaining columns
	   fit the dialog instead of scrolling sideways. */
	@media (max-width: 620px) {
		.pair {
			grid-template-columns: minmax(0, 1fr);
			gap: 0;
		}

		.recipients__wrap .ui-table {
			min-width: 0;
		}
	}
</style>
