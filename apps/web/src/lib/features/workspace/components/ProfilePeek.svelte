<script lang="ts">
	/**
	 * Who submitted this, read from the row it was submitted on.
	 *
	 * The name is the control, because the name is what an operator is already
	 * looking at when the question arrives — so the peek costs a press instead of
	 * a departure, and the table keeps its place. It is a press-and-focus
	 * disclosure like every other in this product: never a hover tooltip, never a
	 * `title`, because meaning carried by hover never arrives on touch at all.
	 *
	 * Two presentations, one content. Where there is room beside the name and a
	 * pointer that can rest on it, the profile opens as an anchored panel over the
	 * row. On a coarse pointer or a narrow viewport there is no "beside", so the
	 * same facts take the screen as a dialog rather than an anchored panel fighting
	 * for space it does not have.
	 *
	 * What it shows is split on purpose: what the person says about themselves
	 * first, then what they are to *this* event — how many submissions carry their
	 * address, the sessions they already hold, and the way to their roster entry.
	 * The second half is why an organizer opened it.
	 *
	 * Within the first half the addresses lead, ahead of where the person lives:
	 * the question behind the press is "who is this, and can I put them on a
	 * stage", and an X account or a LinkedIn page answers it in one click where a
	 * city only narrows it. Location stays, one line below.
	 */
	import { ExternalLink, GitBranch, Globe, Link2 } from 'lucide-svelte';
	import { Marked, Modal, Popover } from '$lib/ui';
	import type { IconComponent } from '$lib/ui';
	import type { MatchRange } from '$lib/api/search';
	import type { SpeakerLinkKind, SpeakerProfile } from '$lib/api/types';

	interface Props {
		profile: SpeakerProfile;
		/**
		 * Accessible name of the control. It begins with the visible name, so
		 * speech input can reach it by what it says.
		 */
		label?: string;
		/**
		 * Spans of the trigger name a search matched.
		 *
		 * A name that opens a profile is still a name a query can hit, and a row
		 * that came back because of this person must be able to say so — without
		 * it, the one row whose match is invisible is the one where the match was
		 * the person.
		 */
		ranges?: readonly MatchRange[];
	}

	let { profile, label, ranges = [] }: Props = $props();

	const triggerLabel = $derived(label ?? `${profile.name} — speaker profile`);

	// Counted by the API over this event's submissions, so the sentence is a
	// fact about the event rather than a claim in the profile.
	const countPhrase = $derived(
		`${profile.submissionCount} ${profile.submissionCount === 1 ? 'submission' : 'submissions'} this event`
	);

	/**
	 * How each kind of address is marked, and what a screen reader hears before
	 * the label.
	 *
	 * lucide-svelte 1.0.1 ships no brand marks — its `X` is the close cross, and
	 * there is no LinkedIn or GitHub glyph — so the two platforms whose wordmarks
	 * are letters are drawn as letters, in the same 13px box as the icons. No new
	 * dependency is worth a logo, and a generic icon on an X link would be a
	 * mark that says nothing.
	 *
	 * `name` is the spoken prefix: a handle or a domain does not say which
	 * network it belongs to, and the mark beside it is decoration. "Talks
	 * archive" already reads as what it is, so `other` adds nothing.
	 */
	const linkMarks: Record<
		SpeakerLinkKind,
		{ icon?: IconComponent; text?: string; name?: string }
	> = {
		x: { text: '𝕏', name: 'X' },
		linkedin: { text: 'in', name: 'LinkedIn' },
		github: { icon: GitBranch, name: 'GitHub' },
		website: { icon: Globe, name: 'Website' },
		other: { icon: Link2 }
	};

	/* A coarse pointer, or a viewport too narrow to hold a panel beside the row.
	   Read live rather than once at construction: a rotation or a resized window
	   changes which presentation the next press should open, and a person who
	   turns their phone should not get the wrong one. */
	const DIALOG_QUERY = '(pointer: coarse), (max-width: 719.98px)';

	let asDialog = $state(
		typeof window !== 'undefined' && window.matchMedia(DIALOG_QUERY).matches
	);

	$effect(() => {
		const query = window.matchMedia(DIALOG_QUERY);
		const sync = () => (asDialog = query.matches);
		sync();
		query.addEventListener('change', sync);
		return () => query.removeEventListener('change', sync);
	});

	let dialogOpen = $state(false);
	let dialogTrigger = $state<HTMLButtonElement>();
	let wasOpen = false;

	/* However the dialog is left — Escape, the close control, a press outside —
	   focus goes back to the name that opened it, so a keyboard reader resumes on
	   the row they were reading instead of at the top of the document. */
	$effect(() => {
		if (dialogOpen) {
			wasOpen = true;
			return;
		}
		if (!wasOpen) return;
		wasOpen = false;
		dialogTrigger?.focus();
	});
</script>

{#snippet facts(named: boolean)}
	<!-- The profile states its own type, alignment and wrapping rather than
	     inheriting them. Both presentations open from inside a row, and a row is
	     a place with opinions: a dense table line is nowrap, ellipsized and two
	     sizes down, and a profile that inherited that would arrive clipped on one
	     surface and not on another. -->
	<div class="peek__facts">
		<!-- The dialog puts the name in its title bar, so the panel is the only one
		     of the two that has to say it. -->
		{#if named}
			<p class="peek__name"><strong>{profile.name}</strong></p>
		{/if}
		<p class="peek__headline">{profile.headline}</p>
		<!-- The identity row, ahead of everything else the person offers: each
		     address is its own target, marked by where it goes and labelled with
		     what it is called there. New tab, because the profile was opened to
		     keep a place in the table, not to leave it. -->
		{#if profile.links && profile.links.length > 0}
			<ul class="peek__links">
				{#each profile.links as link (link.href)}
					{@const mark = linkMarks[link.kind]}
					<li>
						<a class="peek__link" href={link.href} target="_blank" rel="noopener noreferrer">
							{#if mark.icon}
								{@const Mark = mark.icon}
								<Mark class="peek__mark" size={13} aria-hidden="true" />
							{:else}
								<span class="peek__mark peek__mark--letters" aria-hidden="true">{mark.text}</span>
							{/if}
							{#if mark.name}<span class="ui-sr-only">{mark.name}: </span>{/if}
							<span class="peek__link-label">{link.label}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
		{#if profile.location}
			<p class="peek__where">{profile.location}</p>
		{/if}

		<div class="peek__event">
			<p class="peek__count">{countPhrase}</p>
			{#if profile.sessions && profile.sessions.length > 0}
				<h3 class="peek__label">Sessions</h3>
				<ul class="peek__sessions">
					{#each profile.sessions as session (session.id)}
						<!-- A session is a place on the schedule, so its title links directly
						     to the focused occurrence. Preview links open a new window so a
						     quick context check preserves the review in progress. The glyph
						     and accessible name both expose that behavior. -->
						<li>
							<a
								href={`/app/schedule?session=${session.id}`}
								target="_blank"
								rel="noopener"
								aria-label={`${session.title} — opens in new window`}>
								{session.title}<ExternalLink size={12} aria-hidden="true" />
							</a>
						</li>
					{/each}
				</ul>
			{/if}
			{#if profile.speakerId}
				<!-- Scoped, not merely aimed: the roster restores the speaker from the
				     address, so the link lands on their row expanded and marked
				     instead of on a list to search. -->
				<a
					class="ui-button ui-button--soft ui-button--sm peek__open"
					href={`/app/speakers?speaker=${profile.speakerId}`}
					target="_blank"
					rel="noopener"
					aria-label="Open in Speakers — opens in new window">
					Open in Speakers<ExternalLink size={13} aria-hidden="true" />
				</a>
			{/if}
		</div>
	</div>
{/snippet}

<span class="peek">
	{#if asDialog}
		<button
			type="button"
			class="peek__trigger"
			aria-haspopup="dialog"
			aria-label={triggerLabel}
			bind:this={dialogTrigger}
			onclick={() => (dialogOpen = true)}><Marked text={profile.name} {ranges} /></button>
		<Modal bind:open={dialogOpen} title={profile.name} dismissible>
			{@render facts(false)}
		</Modal>
	{:else}
		<Popover label={triggerLabel} kind="word">
			{#snippet trigger()}
				<span class="peek__trigger-text"><Marked text={profile.name} {ranges} /></span>
			{/snippet}
			{#snippet children()}
				{@render facts(true)}
			{/snippet}
		</Popover>
	{/if}
</span>

<style>
	.peek {
		display: inline-flex;
		min-inline-size: 0;
	}

	/* The name keeps the metrics of the plain text it replaces — same family,
	   same size, same weight — and differs only in ink. A profile that lands a
	   moment after the rows would otherwise re-flow the column under someone
	   mid-scan, and the arriving fact is "this name is now pressable", not "this
	   name changed size". */
	/* Ink, not link. This name reveals detail in place; it does not navigate, and
	   the link colour promised a destination there is none of. The standing
	   dotted underline says "there is more here" without spending the action
	   colour, and it goes solid on hover, focus, and while the panel is open. The
	   distinction is the flow grammar in the typographic layer: solid + action
	   colour takes you somewhere, dotted + ink tells you more, right here. */
	.peek__trigger,
	.peek__trigger-text {
		font: inherit;
		color: inherit;
		text-decoration: underline dotted;
		text-decoration-color: var(--je-color-border-strong);
		text-underline-offset: 0.15em;
	}

	.peek__trigger {
		margin: 0;
		padding: 0;
		border: 0;
		border-radius: var(--je-radius-round);
		background: none;
		text-align: start;
		cursor: pointer;
	}

	.peek:hover .peek__trigger,
	.peek:hover .peek__trigger-text,
	.peek__trigger:focus-visible {
		text-decoration: underline solid;
		text-decoration-color: currentColor;
	}

	.peek__trigger:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.peek__facts {
		display: grid;
		gap: var(--je-space-1);
		min-inline-size: 0;
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
		text-align: start;
		white-space: normal;
		color: var(--je-color-text);
	}

	.peek__name {
		margin: 0;
		font-size: var(--je-font-size-md);
	}

	.peek__headline {
		margin: 0;
		line-height: var(--je-leading-normal);
	}

	.peek__where {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* With no chip edge to do the grouping, proportion does it: the gap between
	   two addresses is four times the gap inside one, so a mark clings to its
	   own label and can never read as trailing punctuation on the neighbour's. */
	.peek__links {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		column-gap: var(--je-space-4);
		row-gap: var(--je-space-1);
		margin: 0;
		padding: 0;
		font-size: var(--je-font-size-xs);
	}

	/* Links, in the product's own link voice — not chips. A bordered pill here
	   read as a badge at rest and as an apparition on hover; the mark already
	   separates one address from the next, so the link needs no box of its own. */
	.peek__link {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		max-inline-size: 100%;
		color: var(--je-color-link);
		text-decoration: none;
	}

	.peek__link:hover .peek__link-label {
		text-decoration: underline;
	}

	.peek__link:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
		border-radius: var(--je-radius-control);
	}

	/* A handle can be longer than the panel is wide; it ellipsizes rather than
	   pushing the chip past the edge. */
	.peek__link-label {
		min-inline-size: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* One box for both kinds of mark, so a drawn icon and a letterform sit on the
	   same baseline and take the same width in the row. */
	.peek__link :global(.peek__mark) {
		flex: none;
		block-size: 0.8125rem;
		color: var(--je-color-text-muted);
	}

	/* Letters keep the icons' height and take the width they need: a two-letter
	   wordmark squeezed into a 13px square would overlap the label beside it. */
	.peek__mark--letters {
		display: grid;
		place-items: center;
		min-inline-size: 0.8125rem;
		font-size: 0.6875rem;
		font-weight: 700;
		line-height: 1;
	}

	.peek__link:hover :global(.peek__mark) {
		color: inherit;
	}

	/* What the person says, and what they are to this event, are two different
	   kinds of claim; the rule between them says so without a second heading. */
	.peek__event {
		display: grid;
		gap: var(--je-space-1);
		margin-block-start: var(--je-space-1);
		padding-block-start: var(--je-space-2);
		border-block-start: 1px solid var(--je-color-border);
	}

	.peek__count {
		margin: 0;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.peek__label {
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-2xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.peek__sessions {
		list-style: none;
		display: grid;
		gap: var(--je-space-1);
		margin: 0;
		padding: 0;
		font-size: var(--je-font-size-sm);
	}

	/* The new-window glyph rides the link's own line, a breath after the words. */
	.peek__sessions a,
	.peek__open {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
	}

	.peek__open {
		justify-self: start;
		margin-block-start: var(--je-space-2);
	}
</style>
