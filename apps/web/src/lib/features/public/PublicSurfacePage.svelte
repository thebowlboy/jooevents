<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import ScheduleSurfaceRender from '$lib/features/templates/ScheduleSurfaceRender.svelte';
	import FormSurfaceRender from '$lib/features/templates/FormSurfaceRender.svelte';
	import RosterSurfaceRender from '$lib/features/templates/RosterSurfaceRender.svelte';
	import { usePublicSurfacePort } from '$lib/api/public-surface-port';
	import { applyFormLens } from '$lib/api/fields';
	import { parseScope } from '$lib/features/embeds/embed-snippet';
	import { themeStyleProperties } from '$lib/theme/theme-contract';
	import type {
		EmbedScope,
		EventTheme,
		FormSummary,
		PublicSpeakerCard,
		ScheduleState,
		SpeakerCategory,
		SurfaceKind,
		SurfaceTemplate,
		Track
	} from '$lib/api/types';

	/**
	 * A hosted public page: the event's own programme, lineup, or call for
	 * proposals at an address anybody can be handed.
	 *
	 * This is the zero-work path. Embedding asks somebody to edit their website;
	 * a link asks them to paste one line into an email, a newsletter, or a menu —
	 * and for a small event that is the whole job. It renders the *same published
	 * surface* the embed renders, so there is one thing to design and one thing
	 * to keep true.
	 *
	 * Nothing of the operator console is here: no shell, no navigation, no
	 * workspace density. A visitor is not a user of this product.
	 */

	interface Props {
		/** Which public surface this address serves. */
		kind: SurfaceKind;
	}

	let { kind }: Props = $props();

	const api = usePublicSurfacePort();

	/** The slice this address shows, in the same closed vocabulary an embed uses. */
	const scope = $derived<EmbedScope>(parseScope(page.url.searchParams.get('scope')));

	let surface = $state<SurfaceTemplate | null>(null);
	let theme = $state<EventTheme | null>(null);
	let eventName = $state('');
	let eventMeta = $state('');
	let indexing = $state(false);
	let missing = $state(false);

	let program = $state<{ schedule: ScheduleState; tracks: Track[] } | null>(null);
	let lineup = $state<{ roster: PublicSpeakerCard[]; categories: SpeakerCategory[] } | null>(null);
	let forms = $state<FormSummary[] | null>(null);

	onMount(async () => {
		const [library, brand, summary, settings] = await Promise.all([
			api.templates.list(),
			api.theme.get(),
			api.workspace.summary(),
			api.settings.get()
		]);
		surface = library.surfaces.find((entry) => entry.kind === kind) ?? null;
		missing = surface === null;
		theme = brand;
		// A robots directive is opt-in: the page works either way, and a page that
		// has already been crawled is far harder to withdraw than one that has not.
		indexing = settings?.publicIndexing === true;
		if (summary.event) {
			eventName = summary.event.name;
			eventMeta = `${summary.event.dates} · ${summary.event.location}`;
		}
		if (kind === 'schedule') {
			const [schedule, tracks] = await Promise.all([api.schedule.state(), api.vocab.tracks()]);
			program = { schedule, tracks };
		} else if (kind === 'speaker-roster') {
			const [roster, categories] = await Promise.all([
				api.speakers.publicRoster(),
				api.vocab.speakerCategories()
			]);
			lineup = { roster, categories };
		} else {
			forms = await api.forms.list();
		}
	});

	const brandStyle = $derived(
		theme
			? Object.entries(themeStyleProperties(theme))
					.map(([token, value]) => `${token}: ${value}`)
					.join('; ')
			: ''
	);

	/**
	 * The schedule narrowed to one day when the address asks for one. Narrowing
	 * the state rather than the renderer keeps the day page identical to the full
	 * page in every other respect — it is the same surface, shown less of.
	 */
	const shownSchedule = $derived.by<ScheduleState | null>(() => {
		if (!program) return null;
		if (scope.kind !== 'day') return program.schedule;
		const dayKey = scope.dayKey;
		if (!program.schedule.days.some((day) => day.key === dayKey)) return program.schedule;
		return {
			...program.schedule,
			days: program.schedule.days.filter((day) => day.key === dayKey),
			placements: program.schedule.placements.filter((placement) => placement.dayKey === dayKey)
		};
	});

	/** The application surface as the one form this address serves. */
	const shownForm = $derived.by<SurfaceTemplate | null>(() => {
		if (!surface || kind !== 'application-form') return null;
		if (scope.kind !== 'form' || !forms) return surface;
		const form = forms.find((entry) => entry.id === scope.formId);
		return form ? applyFormLens(surface, form) : surface;
	});

	/** The open form this address serves, when it names one. */
	const namedForm = $derived(
		scope.kind === 'form' ? (forms?.find((entry) => entry.id === scope.formId) ?? null) : null
	);

	const heroTitle = $derived.by(() => {
		const hero = surface?.blocks.find((block) => block.type === 'hero');
		return hero && hero.type === 'hero' ? hero.title : '';
	});

	const documentTitle = $derived(
		[heroTitle || eventName, eventName && heroTitle !== eventName ? eventName : null]
			.filter(Boolean)
			.join(' · ')
	);

	const ready = $derived(
		kind === 'schedule'
			? Boolean(shownSchedule && theme && surface)
			: kind === 'speaker-roster'
				? Boolean(lineup && theme && surface)
				: Boolean(shownForm && theme)
	);
</script>

<svelte:head>
	<title>{documentTitle || 'Loading'}</title>
	{#if !indexing}
		<!-- Hidden from search until the organizer says otherwise. A call for
		     proposals, a half-built programme, and a lineup still being announced
		     are all pages an event hands out long before it wants them found. -->
		<meta name="robots" content="noindex, nofollow" />
	{/if}
</svelte:head>

<div class="public" style={brandStyle}>
	<div class="public__body">
		{#if missing}
			<div class="public__state" role="status">
				<p class="public__state-title">This page isn’t published yet.</p>
				<p class="public__state-copy">Check back closer to the event.</p>
			</div>
		{:else if !ready}
			<!-- The page's own shape, held while it arrives, so the first painted
			     frame is the right geometry rather than an empty screen. -->
			<div class="public__state" aria-busy="true" aria-label="Loading">
				<span class="ui-skeleton public__fill" aria-hidden="true"></span>
			</div>
		{:else if kind === 'schedule' && shownSchedule && surface && theme}
			<ScheduleSurfaceRender
				template={surface}
				{theme}
				{eventName}
				{eventMeta}
				schedule={shownSchedule}
				tracks={program?.tracks ?? []}
				frame="bare" />
		{:else if kind === 'speaker-roster' && lineup && surface && theme}
			<RosterSurfaceRender
				template={surface}
				{theme}
				{eventName}
				{eventMeta}
				roster={lineup.roster}
				categories={lineup.categories}
				{scope}
				frame="bare" />
		{:else if shownForm && theme}
			<!--
				The questions are real and the page is real; taking answers is not
				built yet, and saying so above the form is the only honest way to
				publish it. The alternative — controls that look live and lose the
				work — is the failure this notice exists to prevent.
			-->
			<p class="public__notice" role="status">
				{#if namedForm && namedForm.status !== 'open'}
					This call is {namedForm.status === 'closed' ? 'closed' : 'not open yet'}. The questions
					below are what it asks.
				{:else}
					These are the questions this call asks. Submitting isn’t switched on yet — the form opens
					here when it does.
				{/if}
			</p>
			<FormSurfaceRender
				template={shownForm}
				{theme}
				{eventName}
				{eventMeta}
				context="published"
				frame="bare" />
		{/if}
	</div>
</div>

<style>
	/*
	 * The page is the artifact. The brand's canvas is the ground for the whole
	 * viewport — not a card floating on the product's own colours — because a
	 * visitor arriving from a link has no idea what JooEvents is and should not
	 * be shown any of it.
	 */
	.public {
		min-block-size: 100dvh;
		background: var(--je-color-canvas);
		color: var(--je-color-text);
		font-family: var(--je-font-body);
	}

	.public__body {
		max-inline-size: 900px;
		margin-inline: auto;
		padding: var(--je-space-8) var(--je-space-5) var(--je-space-10);
		display: grid;
		gap: var(--je-space-5);
		min-inline-size: 0;
	}

	/* The honest line above a form that cannot yet take answers. */
	.public__notice {
		margin: 0;
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-3) var(--je-space-4);
		font-size: 0.9375rem;
		line-height: var(--je-leading-normal);
	}

	.public__state {
		display: grid;
		gap: var(--je-space-2);
		min-block-size: 24rem;
		align-content: center;
		justify-items: center;
		text-align: center;
	}

	.public__state-title {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: 1.25rem;
		font-weight: 700;
	}

	.public__state-copy {
		margin: 0;
		color: var(--je-color-text-muted);
	}

	.public__fill {
		display: block;
		inline-size: 100%;
		min-block-size: 24rem;
		border-radius: var(--je-radius-surface);
	}

	@media (max-width: 560px) {
		.public__body {
			padding: var(--je-space-5) var(--je-space-4) var(--je-space-8);
		}
	}
</style>
