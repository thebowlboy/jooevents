<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowLeft, Check, CodeXml, Copy, ExternalLink, Frame, Globe } from 'lucide-svelte';
	import { Button, CopyValue, Switch, writeToClipboard } from '$lib/ui';
	import type { EmbedsPagePort } from '$lib/api/embeds-page-port';
	import { describePortFailure, type PortFailureView } from '$lib/api/port-failure';
	import { applyParams, clearParams, param, paramIn } from '$lib/features/workspace/url-state.svelte';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import ScheduleSurfaceRender from '$lib/features/templates/ScheduleSurfaceRender.svelte';
	import FormSurfaceRender from '$lib/features/templates/FormSurfaceRender.svelte';
	import RosterSurfaceRender from '$lib/features/templates/RosterSurfaceRender.svelte';
	import { applyFormLens } from '$lib/api/fields';
	import { isSurfaceTemplate } from '$lib/api/types';
	import {
		bindsOriginAllowlist,
		deliveryLimitation,
		embedSnippet,
		embedUrl,
		frameMinHeight,
		loaderSnippet,
		normalizeOrigin,
		originRefusalCopy,
		specRefusals,
		standaloneUrl
	} from './embed-snippet';
	import { HOST_TYPE, hostThemeFor } from './host-preview';
	import type {
		EmbedDelivery,
		EmbedSpec,
		EmbedStyleMode,
		EmbedTarget,
		EventTheme,
		FormSummary,
		PublicSpeakerCard,
		ScheduleState,
		SpeakerCategory,
		SurfaceTemplate,
		Track
	} from '$lib/api/types';

	/**
	 * Embeds: the code that puts one of this event's public pages onto somebody
	 * else's website.
	 *
	 * The split with Templates is the whole design. Templates authors the
	 * artifact — what a page says, how it is laid out, what brand it wears.
	 * This page publishes it: which slice, how it sits in a host box, which of
	 * three delivery mechanisms that host will accept, and the code to paste. A
	 * person who arrives at either one finds the other by name.
	 */

	interface Props {
		port: EmbedsPagePort;
	}

	let { port }: Props = $props();
	const api = $derived(port);

	let targets = $state<EmbedTarget[] | null>(null);
	let speakerTargets = $state<EmbedTarget[]>([]);
	let surfaces = $state<SurfaceTemplate[]>([]);
	let theme = $state<EventTheme | null>(null);
	let eventName = $state('Your event');
	let eventMeta = $state('');

	/** The open embed is shareable state, so it lives in the address. */
	const selectedKey = $derived(param('embed'));

	/** Whether the hosted pages ask to be indexed. Null until the setting is read. */
	let indexing = $state<boolean | null>(null);
	let indexingBusy = $state(false);
	let indexingEditable = $state(true);
	let indexingReason = $state('');

	/**
	 * The page's read, with its failure kept beside its value. A rejection left
	 * `targets` null and nothing in flight, and the picker skeletons on exactly
	 * that condition — so an unreachable read was a permanent "loading".
	 */
	let loadFailure = $state<PortFailureView | null>(null);
	let loadTicket = 0;

	async function load() {
		const ticket = (loadTicket += 1);
		try {
			await readAll(ticket);
		} catch (error) {
			if (ticket !== loadTicket) return;
			loadFailure = describePortFailure(error, 'The embeddable pages could not be loaded.');
		}
	}

	let retrying = $state(false);
	async function retry() {
		retrying = true;
		try {
			await load();
		} finally {
			retrying = false;
		}
	}

	async function readAll(ticket: number) {
		const [list, people, library, brand, summary, settings] = await Promise.all([
			api.embeds.targets(),
			api.embeds.speakerTargets(),
			api.templates.list(),
			api.theme.get(),
			api.workspace.summary(),
			api.settings.get()
		]);
		// Newest wins: a superseded read never installs its answer.
		if (ticket !== loadTicket) return;
		targets = list;
		speakerTargets = people;
		surfaces = library.surfaces;
		theme = brand;
		indexing = settings?.publicIndexing === true;
		indexingEditable = settings?.publicIndexingEditable !== false;
		indexingReason = settings?.publicIndexingReason ?? '';
		loadFailure = null;
		if (summary.event) {
			eventName = summary.event.name;
			eventMeta = `${summary.event.dates} · ${summary.event.location}`;
		}
	}

	/**
	 * One switch for every hosted page, because it is one fact about the event
	 * rather than about any single page: whether these addresses ask to be found.
	 * A commit with its own receipt — turning it on is easy to undo in the
	 * product and hard to undo on the open web.
	 */
	async function setIndexing(next: boolean) {
		if (indexingBusy || !indexingEditable) return;
		indexingBusy = true;
		const before = indexing === true;
		await api.settings.update({ publicIndexing: next });
		indexing = next;
		recordAction({
			area: 'settings',
			label: next
				? 'Let search engines find your public pages'
				: 'Hid your public pages from search engines',
			undo: async () => {
				await api.settings.update({ publicIndexing: before });
				indexing = before;
			}
		});
		indexingBusy = false;
	}

	onMount(() => void load());

	const allTargets = $derived([...(targets ?? []), ...speakerTargets]);
	const target = $derived(allTargets.find((entry) => entry.key === selectedKey) ?? null);
	const missing = $derived(Boolean(selectedKey && targets !== null && !target));
	const surface = $derived(
		target ? (surfaces.find((entry) => entry.id === target.surfaceId) ?? null) : null
	);

	function open(key: string) {
		void applyParams({ embed: key }, { history: 'push' });
	}

	function close() {
		void clearParams(['embed'], { history: 'push' });
	}

	// -----------------------------------------------------------------------
	// The spec. Fit, style, and delivery are choices about *this* paste, not
	// about the surface, so they are local rather than committed: nothing here
	// changes what the page says, and the code is regenerated as they move.

	let maxWidth = $state<number | null>(null);
	let align = $state<'start' | 'center'>('start');
	let styleMode = $state<EmbedStyleMode>('event');
	let delivery = $state<EmbedDelivery>('inline');
	let allowedOrigins = $state<string[]>([]);
	let originDraft = $state('');
	let originError = $state('');
	let originBusy = $state(false);
	let copied = $state('');

	// A different embed is a different set of choices; opening one starts from
	// the defaults rather than inheriting whatever the last one was set to.
	let choicesFor: string | null = null;
	$effect(() => {
		if (selectedKey === choicesFor) return;
		choicesFor = selectedKey;
		maxWidth = null;
		align = 'start';
		styleMode = 'event';
		delivery = 'inline';
		allowedOrigins = target ? [...target.allowedOrigins] : [];
		originDraft = '';
		originError = '';
		copied = '';
	});

	const spec = $derived.by<EmbedSpec | null>(() => {
		if (!target) return null;
		return {
			surfaceId: target.surfaceId,
			kind: target.kind,
			scope: target.scope,
			fit: { maxWidth, align },
			style: styleMode,
			delivery,
			allowedOrigins: [...allowedOrigins]
		};
	});

	/**
	 * The origin the snippet is written against. Whatever host this console is
	 * served from is the host the public routes will be served from, so the code
	 * on screen is the code that will work rather than a placeholder somebody has
	 * to search and replace.
	 */
	const origin = $derived(typeof window === 'undefined' ? 'https://your-event.example' : window.location.origin);

	/**
	 * The hosted page's own address — the zero-work path. Built from the same
	 * function the `link` snippet uses, so the URL somebody copies here and the
	 * one an anchor points at can never disagree.
	 */
	const hostedUrl = $derived(spec ? standaloneUrl(origin, spec) : '');
	const hostedPath = $derived(hostedUrl ? hostedUrl.slice(origin.length) || '/' : '/');

	const snippetTitle = $derived(target ? `${target.name} — ${eventName}` : eventName);
	const code = $derived(spec ? embedSnippet(origin, spec, snippetTitle) : '');
	const loader = $derived(loaderSnippet(origin));
	const limitation = $derived(deliveryLimitation(delivery, styleMode));
	const refusals = $derived(spec ? specRefusals(spec, allowedOrigins) : []);
	const needsOrigins = $derived(target ? bindsOriginAllowlist({ kind: target.kind }) : false);

	async function saveAllowedOrigins(next: string[]): Promise<boolean> {
		if (!target || originBusy) return false;
		originBusy = true;
		try {
			const result = await api.embeds.setAllowedOrigins(target.kind, next);
			if (!result.ok) {
				originError = result.reason;
				return false;
			}
			allowedOrigins = next;
			return true;
		} catch (error) {
			originError = describePortFailure(error, 'The allowed sites could not be saved.').message;
			return false;
		} finally {
			originBusy = false;
		}
	}

	async function addOrigin(event: SubmitEvent) {
		event.preventDefault();
		const normalized = normalizeOrigin(originDraft);
		if (normalized.kind !== 'normalized') {
			originError = originRefusalCopy(normalized.code);
			return;
		}
		if (allowedOrigins.includes(normalized.origin)) {
			originError = '';
			originDraft = '';
			return;
		}
		const before = [...allowedOrigins];
		const next = [...allowedOrigins, normalized.origin].sort();
		if (!(await saveAllowedOrigins(next))) return;
		originError = '';
		originDraft = '';
		recordAction({
			area: 'embeds', label: `Allowed ${normalized.origin} to host this embed`,
			undo: async () => { await saveAllowedOrigins(before); }
		});
	}

	async function removeOrigin(value: string) {
		const before = [...allowedOrigins];
		const next = allowedOrigins.filter((entry) => entry !== value);
		if (!(await saveAllowedOrigins(next))) return;
		recordAction({
			area: 'embeds', label: `Stopped allowing ${value} to host this embed`,
			undo: async () => { await saveAllowedOrigins(before); }
		});
	}

	// -----------------------------------------------------------------------
	// The host preview. Width presets are the real question — an embed is
	// pasted into a box whose width the organizer knows and the product does
	// not, and the layout answers to that box rather than to the window.

	const widthKeys = ['sidebar', 'column', 'wide', 'fill'] as const;
	type WidthKey = (typeof widthKeys)[number];
	const hostWidth = $derived(paramIn('at', widthKeys, 'column'));

	const widths: { key: WidthKey; label: string; px: number | null; sub: string }[] = [
		{ key: 'sidebar', label: 'Sidebar', px: 320, sub: '320px' },
		{ key: 'column', label: 'Article', px: 640, sub: '640px' },
		{ key: 'wide', label: 'Wide', px: 960, sub: '960px' },
		{ key: 'fill', label: 'Full', px: null, sub: 'fills the page' }
	];

	const hostPx = $derived(widths.find((entry) => entry.key === hostWidth)?.px ?? null);

	function setWidth(key: WidthKey) {
		void applyParams({ at: key === 'column' ? null : key });
	}

	/**
	 * The theme the preview renders with.
	 *
	 * `match-site` is not a second renderer: it is the same surface with the
	 * host page's ground, ink, and typography substituted for the event's, which
	 * is exactly what a shadow root does when the embed leaves `color` and
	 * `font-family` undeclared and lets the host's cascade through. Every
	 * structural decision — layout, spacing, radii, the action colour — stays
	 * ours in both modes, which is why one derived recipe covers all three
	 * surfaces without any renderer knowing this control exists.
	 */
	const previewTheme = $derived.by<EventTheme | null>(() => {
		if (!theme) return null;
		return styleMode === 'match-site' ? hostThemeFor(theme) : theme;
	});

	// -----------------------------------------------------------------------
	// What each preview needs, loaded when a surface of that kind is first
	// opened and kept for the session.

	/**
	 * What a preview could not read. Only one preview kind is open at a time, so
	 * one failure cell states it. Without this the preview skeleton was the only
	 * thing a rejected read could produce, permanently.
	 */
	let previewFailure = $state<PortFailureView | null>(null);
	/** Kinds with a request already open, so a target flipping back never stacks one. */
	let previewInFlight = $state<string[]>([]);

	function loadPreview(kind: string, read: () => Promise<void>) {
		if (previewInFlight.includes(kind)) return;
		previewInFlight = [...previewInFlight, kind];
		void read()
			.then(() => {
				previewFailure = null;
			})
			.catch((error: unknown) => {
				previewFailure = describePortFailure(error, 'This preview could not be loaded.');
			})
			.finally(() => {
				previewInFlight = previewInFlight.filter((entry) => entry !== kind);
			});
	}

	let program = $state<{ schedule: ScheduleState; tracks: Track[] } | null>(null);
	$effect(() => {
		if (program || target?.kind !== 'schedule') return;
		loadPreview('schedule', async () => {
			const [schedule, tracks] = await Promise.all([api.schedule.state(), api.vocab.tracks()]);
			program = { schedule, tracks };
		});
	});

	let lineup = $state<{ roster: PublicSpeakerCard[]; categories: SpeakerCategory[] } | null>(null);
	$effect(() => {
		if (lineup || target?.kind !== 'speaker-roster') return;
		loadPreview('speaker-roster', async () => {
			const [roster, categories] = await Promise.all([
				api.speakers.publicRoster(),
				api.vocab.speakerCategories()
			]);
			lineup = { roster, categories };
		});
	});

	let formList = $state<FormSummary[] | null>(null);
	$effect(() => {
		if (formList || target?.kind !== 'application-form') return;
		loadPreview('application-form', async () => {
			formList = await api.forms.list();
		});
	});

	/** The application surface seen as the one form this embed carries. */
	const formSurface = $derived.by<SurfaceTemplate | null>(() => {
		if (!surface || !isSurfaceTemplate(surface) || surface.kind !== 'application-form') return null;
		const scope = target?.scope;
		if (scope?.kind !== 'form') return surface;
		const form = formList?.find((entry) => entry.id === scope.formId);
		return form ? applyFormLens(surface, form) : null;
	});

	const previewReady = $derived(
		target?.kind === 'schedule'
			? Boolean(program)
			: target?.kind === 'speaker-roster'
				? Boolean(lineup)
				: Boolean(formSurface)
	);

	// -----------------------------------------------------------------------
	// Copy

	function onCopied(what: string) {
		copied = what;
	}

	/**
	 * Which block is currently confirming. Held as the copied text rather than a
	 * boolean so two snippets on screen confirm independently, and cleared by an
	 * owned timer that supersession cancels.
	 */
	let copiedBlock = $state('');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	/** Long enough to be read, short enough not to linger as state. */
	const COPY_HELD_MS = 1600;

	async function copyBlock(text: string, announced: string) {
		clearTimeout(copyTimer);
		if (!(await writeToClipboard(text))) {
			// Say nothing succeeded rather than showing a success the clipboard
			// never received; the code stays selectable by hand either way.
			copiedBlock = '';
			copied = `${announced} could not be copied`;
			return;
		}
		copiedBlock = text;
		onCopied(announced);
		copyTimer = setTimeout(() => (copiedBlock = ''), COPY_HELD_MS);
	}

	$effect(() => () => clearTimeout(copyTimer));

	const deliveryOptions: { key: EmbedDelivery; label: string; line: string }[] = [
		{
			key: 'inline',
			label: 'Inline',
			line: 'Renders inside your page and grows with its content. Needs your site to allow one script tag.'
		},
		{
			key: 'frame',
			label: 'Frame',
			line: 'A self-contained box, for sites that strip scripts. You give it a starting height.'
		},
	];

	const deliveryIcon = { inline: CodeXml, frame: Frame } as const;

	/** Rows in the picker, grouped so a long form list never buries the roster. */
	const pickerGroups = $derived([
		{
			key: 'pages',
			label: 'Pages',
			items: (targets ?? []).filter((entry) => entry.kind !== 'application-form')
		},
		{
			key: 'forms',
			label: 'Forms',
			items: (targets ?? []).filter((entry) => entry.kind === 'application-form')
		},
		{ key: 'people', label: 'One speaker', items: speakerTargets }
	]);
</script>

{#snippet copyButton(text: string, name: string, announced: string)}
	<!--
		A snippet is a multi-line block, so it cannot be the copy primitive's
		value — that slot is one selectable run beside a small glyph. The rule the
		primitive exists to keep is still kept here: the `<pre>` below stays
		ordinary selectable text that nothing wraps or intercepts, and this is the
		adjacent control. It shares the one clipboard implementation, including the
		non-secure-origin fallback, so there is no second way to copy in this app.
	-->
	<Button
		variant="ghost"
		size="sm"
		aria-label={copiedBlock === text ? `${name} copied` : `Copy ${name}`}
		onclick={() => void copyBlock(text, announced)}>
		{#if copiedBlock === text}
			<Check size={14} aria-hidden="true" />Copied
		{:else}
			<Copy size={14} aria-hidden="true" />Copy
		{/if}
	</Button>
{/snippet}

{#snippet targetRow(entry: EmbedTarget)}
	<li>
		<button type="button" class="pick" onclick={() => open(entry.key)}>
			<span class="pick__main">
				<span class="pick__name">{entry.name}</span>
				<span class="pick__purpose">{entry.purpose}</span>
			</span>
			<!-- The count is the one fact worth knowing before pasting: an embed
			     that would arrive empty says so here rather than on the website. -->
			<span class="ui-badge ui-badge--neutral pick__count" class:pick__count--empty={entry.count === 0}>
				{entry.count}
				{entry.countNoun}{entry.count === 1 ? '' : 's'}
			</span>
		</button>
	</li>
{/snippet}

{#if !selectedKey}
	<div class="intro">
		<h2 class="intro__title">Put this event on your own website</h2>
	<p class="intro__copy">
			We host every page here — the programme, your speakers, one speaker on their own, and each
			form. Pick one and you get a link to hand out, and code to put it inside your own site if you
			want that instead. Both keep your <a href="/app/templates?tab=brand">brand</a>, and both stay
			current: change the roster or the schedule here and everywhere showing it changes too.
		</p>
	</div>

	<!-- The picker's cards are a stack, and a stack's spacing belongs to its
	     container. It used to be an adjacent-sibling margin, which silently also
	     matched the builder's rail — a `.card` following a `.card` in a two-column
	     grid — and pushed the whole right column 16px below the left. -->
	<div class="picker">
		{#if loadFailure}
			<!-- Answered, and the answer was no: no skeleton claims otherwise. -->
			<section class="card" role="alert" aria-label="What you can embed">
				<header class="card__head"><h2 class="card__title">Pages</h2></header>
				<p class="embeds-failure">{loadFailure.message}</p>
				{#if loadFailure.retryable}
					<button
						type="button"
						class="ui-button ui-button--secondary ui-button--sm"
						aria-busy={retrying || undefined}
						disabled={retrying}
						onclick={retry}>Try again</button>
				{/if}
			</section>
		{:else if targets === null}
			<section class="card" aria-label="What you can embed" aria-busy="true">
			<header class="card__head"><h2 class="card__title">Pages</h2></header>
			<ul class="picks" aria-hidden="true">
				{#each Array(3) as _, index (index)}
					<li class="pick pick--fill">
						<span class="pick__main">
							<span class="pick__name"><span class="ui-skeleton sk-line" style="inline-size: 10rem"></span></span>
							<span class="pick__purpose"><span class="ui-skeleton sk-line" style="inline-size: min(26rem, 100%)"></span></span>
						</span>
						<span class="ui-skeleton sk-chip"></span>
					</li>
				{/each}
			</ul>
		</section>
	{:else if allTargets.length === 0}
		<section class="card empty" aria-label="What you can embed">
			<p class="empty__title">Nothing to embed yet.</p>
			<p class="empty__copy">
				Your public pages arrive with your first event. Once they exist, their code appears here.
			</p>
		</section>
	{:else}
		{#each pickerGroups as group (group.key)}
			{#if group.items.length > 0}
				<section class="card" aria-label={group.label}>
					<header class="card__head">
						<h2 class="card__title">{group.label}</h2>
						{#if group.key === 'people'}
							<a class="card__door" href="/app/speakers?view=lineup">Who appears, and in what order</a>
						{/if}
					</header>
					<ul class="picks">
						{#each group.items as entry (entry.key)}
							{@render targetRow(entry)}
						{/each}
					</ul>
				</section>
			{/if}
		{/each}

		<!-- One fact about the event, not about any single page, so it lives once
		     here rather than inside every builder. -->
		<section class="card" aria-label="Search engines">
			<header class="card__head"><h2 class="card__title">Search engines</h2></header>
			<div class="findable">
				<Switch
					label="Let search engines find these pages"
					checked={indexing === true}
					disabled={indexing === null || indexingBusy || !indexingEditable}
					onchange={(next) => void setIndexing(next)} />
				<p class="findable__line">
					{#if indexing}
						These pages ask to be indexed. Anyone searching for your event may find them.
					{:else if !indexingEditable && indexingReason}
						{indexingReason}
					{:else}
						Off. Your links work exactly the same — they just stay out of search results, which is
						the right default while a call is being written or a programme is half built.
					{/if}
				</p>
			</div>
		</section>
		{/if}
	</div>
{:else if missing}
	<section class="card empty" aria-label="Embed not found">
		<p class="empty__title">This embed no longer exists.</p>
		<p class="empty__copy">The page it showed may have been removed, or the link is stale.</p>
		<Button variant="secondary" size="sm" onclick={close}>
			<ArrowLeft size={14} aria-hidden="true" />Everything you can embed
		</Button>
	</section>
{:else if target && spec && previewTheme}
	<div class="builder">
		<header class="card builder__head">
			<button type="button" class="ui-button ui-button--ghost ui-button--sm builder__back" onclick={close}>
				<ArrowLeft size={14} aria-hidden="true" />All embeds
			</button>
			<h2 class="builder__name">{target.name}</h2>
			<p class="builder__purpose">{target.purpose}</p>

			<!--
				Where this page already lives, stated as part of its identity rather
				than as one option among the settings below.

				On a page called Embeds, a link needs a reason, and the reason is
				this: the surface is *already a page* — we host it, it has an
				address, and for most events handing that address out is the entire
				job. Everything else here exists only for the narrower want of
				putting it inside a site you already run, and the last line says so,
				which is what makes the rest of this screen make sense.
			-->
			<div class="standalone">
				<p class="standalone__lead">
					<Globe size={14} aria-hidden="true" />It’s already a page
				</p>
				<div class="standalone__link">
					<CopyValue
						value={hostedUrl}
						label="the link to this page"
						oncopy={() => onCopied('The link')} />
					<a
						class="ui-button ui-button--secondary ui-button--sm standalone__open"
						href={hostedPath}
						target="_blank"
						rel="noopener">
						Open it<ExternalLink size={14} aria-hidden="true" /><span class="ui-sr-only">
							— opens in a new window</span>
					</a>
				</div>
				<p class="standalone__line">
					Send this link to anyone — in an email, a newsletter, your bio. Nothing to install and no
					website needed{#if indexing === false}, and it stays out of search results until you turn
						that on{/if}. Everything below is only for putting it
					<em>inside</em> a page you already have.
				</p>
			</div>

			<!-- The two things this page does not decide, named where somebody who
			     wanted them would look. Both are the same addresses the rest of the
			     product uses for those jobs. -->
			<div class="builder__doors">
				{#if surface}
					<a class="builder__door" href={`/app/templates?tab=surfaces&template=${surface.id}`}>
						Change the wording and layout
					</a>
				{/if}
				<a class="builder__door" href="/app/templates?tab=brand">Change the colours and fonts</a>
				{#if target.kind === 'speaker-roster'}
					<a class="builder__door" href="/app/speakers?view=lineup">Change who appears, and in what order</a>
				{:else if target.scope.kind === 'form'}
					<a class="builder__door" href={`/app/forms?form=${target.scope.formId}`}>
						Change what it asks
					</a>
				{/if}
			</div>
		</header>

		<div class="builder__work">
			<section class="card preview" aria-label="How it will look on your site">
				<div class="preview__top">
					<p class="preview__state">On a page this wide:</p>
					<div class="ui-segmented preview__widths" role="group" aria-label="Host width">
						{#each widths as entry (entry.key)}
							<button
								type="button"
								class="ui-segmented__item"
								aria-pressed={hostWidth === entry.key}
								onclick={() => setWidth(entry.key)}>
								{entry.label}<span class="preview__width-sub">{entry.sub}</span>
							</button>
						{/each}
					</div>
				</div>

				<!--
					The host simulation. Its own type and colour are deliberately not
					this app's and not the event's: they stand in for a stranger's
					website, which is the only way "match my site" can be judged
					before pasting. The embed sits between two pieces of host content
					because that is where it will actually sit.
				-->
				<!-- The room is held while the preview is on its way and released the
				     moment it lands: a one-person card is genuinely short, and holding
				     38rem under it would be a reservation for content that is never
				     coming. Width and scope changes after that are the operator's own
				     press, and content is allowed to grow the surface. -->
					<div class="preview__reserve" class:preview__reserve--waiting={!previewReady}>
					<div class="host" class:host--match={styleMode === 'match-site'} style={HOST_TYPE}>
						<p class="host__line host__line--title">Your website</p>
						<p class="host__line">…the page your visitors are already reading.</p>
					<!-- The slot is the host's own column and always sits where a host
					     column sits. `align` is about the embed inside that box, so it
					     belongs on the embed alone — and an auto inline margin here would
					     be worse than wrong: on a grid item it cancels `stretch` and
					     collapses the box to its content width. -->
						<div
							class="host__slot"
							style={hostPx === null ? '' : `max-inline-size:${hostPx}px;`}>
							<div
								class="host__embed"
								class:host__embed--framed={delivery === 'frame'}
								style={`${
									maxWidth === null
										? ''
										: `max-inline-size:${maxWidth}px;${align === 'center' ? 'margin-inline:auto;' : ''}`
								}${
									// A frame is shown at the height it is actually given, clipped.
									// This is the mechanism's real cost and the preview is the only
									// place it can be seen before a visitor sees it.
									delivery === 'frame' ? `block-size:${frameMinHeight(spec)}px;` : ''
								}`}>
								{#if previewFailure && !previewReady}
									<!-- The preview's read answered no; the skeleton would keep
									     claiming it is still coming. -->
									<p class="preview-failure" role="alert">{previewFailure.message}</p>
								{:else if !previewReady}
									<span class="ui-skeleton sk-preview" aria-hidden="true"></span>
								{:else if target.kind === 'schedule' && program && surface}
									<ScheduleSurfaceRender
										template={surface}
										theme={previewTheme}
										{eventName}
										{eventMeta}
										schedule={program.schedule}
										tracks={program.tracks}
										frame="bare" />
								{:else if target.kind === 'speaker-roster' && lineup && surface}
									<RosterSurfaceRender
										template={surface}
										theme={previewTheme}
										{eventName}
										{eventMeta}
										roster={lineup.roster}
										categories={lineup.categories}
										scope={target.scope}
										frame="bare" />
								{:else if formSurface}
									<FormSurfaceRender
										template={formSurface}
										theme={previewTheme}
										{eventName}
										{eventMeta}
										frame="bare" />
								{/if}
							</div>
						</div>
						<p class="host__line">…and the page carries on underneath.</p>
					</div>
				</div>

				<p class="preview__hint">
					{#if target.scope.kind === 'speaker'}
						One person is a card, not a page — no event header, no introduction. For the event’s
						own framing, embed the lineup or a group instead.
					{:else if delivery === 'frame'}
						Shown at the {frameMinHeight(spec)}px the snippet asks for. A frame cannot grow itself,
						so anything past that line is cut off until you raise <code>min-height</code> — which is
						the reason the inline snippet is the better one where your site allows it.
					{:else}
						Laid out against the box it is given, not the window — so this is what that width
						actually produces.
					{/if}
				</p>
			</section>

			<aside class="card rail">
				<!-- The rail is only about putting the page inside another page; the
				     page's own address is stated in the header, where it belongs to the
				     page's identity rather than to these settings. -->
			<section class="rail__group" aria-label="How it sits">
					<h2 class="rail__title rail__title--lead">How it sits</h2>
					<div class="rail__row">
						<span class="rail__legend" id="embed-width">Widest it runs</span>
						<div class="ui-segmented" role="group" aria-labelledby="embed-width">
							<button
								type="button"
								class="ui-segmented__item"
								aria-pressed={maxWidth === null}
								onclick={() => (maxWidth = null)}>Fill the box</button>
							<button
								type="button"
								class="ui-segmented__item"
								aria-pressed={maxWidth === 720}
								onclick={() => (maxWidth = 720)}>720px</button>
							<button
								type="button"
								class="ui-segmented__item"
								aria-pressed={maxWidth === 960}
								onclick={() => (maxWidth = 960)}>960px</button>
						</div>
					</div>
					{#if maxWidth !== null}
						<div class="rail__row">
							<span class="rail__legend" id="embed-align">When it is narrower</span>
							<div class="ui-segmented" role="group" aria-labelledby="embed-align">
								<button
									type="button"
									class="ui-segmented__item"
									aria-pressed={align === 'start'}
									onclick={() => (align = 'start')}>Left</button>
								<button
									type="button"
									class="ui-segmented__item"
									aria-pressed={align === 'center'}
									onclick={() => (align = 'center')}>Centred</button>
							</div>
						</div>
					{/if}
				</section>

				<section class="rail__group" aria-label="How it looks">
					<h2 class="rail__title">How it looks</h2>
					<div class="ui-segmented rail__wide" role="group" aria-label="Style">
						<button
							type="button"
							class="ui-segmented__item"
							aria-pressed={styleMode === 'event'}
							onclick={() => (styleMode = 'event')}>Your event’s look</button>
						<button
							type="button"
							class="ui-segmented__item"
							aria-pressed={styleMode === 'match-site'}
							onclick={() => (styleMode = 'match-site')}>Match my site</button>
					</div>
					<p class="rail__line">
						{#if styleMode === 'event'}
							Your brand travels with it — the same page your visitors see here.
						{:else}
							It picks up your site’s font and text colour and keeps everything else: your
							spacing, your groups, your accent.
						{/if}
					</p>
				</section>

				<section class="rail__group" aria-label="How you add it">
				<h2 class="rail__title">Put it inside a page</h2>
					<div class="rail__deliveries" role="group" aria-label="Delivery">
						{#each deliveryOptions as option (option.key)}
							{@const Glyph = deliveryIcon[option.key]}
							<button
								type="button"
								class="deliv"
								class:deliv--on={delivery === option.key}
								aria-pressed={delivery === option.key}
								onclick={() => (delivery = option.key)}>
								<span class="deliv__head">
									<Glyph size={14} aria-hidden="true" />
									<span class="deliv__label">{option.label}</span>
									{#if option.key === 'inline'}
										<span class="ui-badge ui-badge--sea">Best</span>
									{/if}
								</span>
								<span class="deliv__line">{option.line}</span>
							</button>
						{/each}
					</div>
					<!-- What the chosen mechanism cannot do, said before it is pasted
					     rather than discovered afterwards. -->
					{#if limitation}
						<p class="rail__limit" role="status">{limitation}</p>
					{/if}
				</section>

				{#if needsOrigins}
					<section class="rail__group" aria-label="Where it may appear">
						<h2 class="rail__title">Where it may appear</h2>
						<p class="rail__line">
							An embed loads only on sites you name here — that is what keeps another page from
							passing itself off as the event. The hosted page's own link works everywhere.
						</p>
						<form class="origins__form" onsubmit={(event) => void addOrigin(event)}>
							<label class="ui-sr-only" for="embed-origin">Website address</label>
							<input
								id="embed-origin"
								class="ui-control origins__input"
								type="text"
								placeholder="conference.example.org"
								autocomplete="off"
								bind:value={originDraft}
								disabled={originBusy} />
							<Button type="submit" size="sm" disabled={!originDraft.trim() || originBusy}>Add</Button>
						</form>
						{#if originError}<p class="rail__error" role="alert">{originError}</p>{/if}
						{#if allowedOrigins.length > 0}
							<ul class="origins">
								{#each allowedOrigins as value (value)}
									<li class="origins__row">
										<span class="origins__value">{value}</span>
										<Button
											variant="ghost"
											size="sm"
											aria-label={`Remove ${value}`}
											disabled={originBusy}
											onclick={() => void removeOrigin(value)}>Remove</Button>
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				{/if}

				<section class="rail__group" aria-label="The code">
					<h2 class="rail__title">The code</h2>
					{#each refusals as refusal (refusal)}
						<p class="rail__error" role="alert">{refusal}</p>
					{/each}
					{#if delivery === 'inline'}
						<!-- Two snippets, not one string to be split by hand: the loader
						     goes once per page however many embeds that page carries. -->
						<div class="snip">
							<div class="snip__head">
								<span class="snip__label">1 · Once per page</span>
								{@render copyButton(loader, 'the loader script', 'The loader script')}
							</div>
							<pre class="snip__code"><code>{loader}</code></pre>
						</div>
						<div class="snip">
							<div class="snip__head">
								<span class="snip__label">2 · Where it should appear</span>
								{@render copyButton(code, 'the embed code', 'The embed code')}
							</div>
							<pre class="snip__code"><code>{code}</code></pre>
						</div>
					{:else}
						<div class="snip">
							<div class="snip__head">
								<span class="snip__label">Paste this where it should appear</span>
								{@render copyButton(code, 'the embed code', 'The embed code')}
							</div>
							<pre class="snip__code"><code>{code}</code></pre>
						</div>
					{/if}
					<p class="ui-sr-only" role="status">{copied ? `${copied} copied.` : ''}</p>
					<p class="rail__line">
						Nothing above is a copy of your page — it points at
						<a href={standaloneUrl(origin, spec)}>the hosted one</a>, so what your visitors see
						changes when you change it here.
					</p>
					<!-- Targets exist only for an active surface release, so both addresses
					     named here are live by construction. -->
					<p class="rail__pending">
						The page and its embedded route
						(<code>{new URL(embedUrl(origin, spec)).pathname}</code>) are live. Both read the same
						published release, so there is no second copy to keep in sync.
					</p>
				</section>
			</aside>
		</div>
	</div>
{:else}
	<!-- The builder's own composition with skeleton fills, so arrival replaces
	     content without moving the page. -->
	<div class="builder" aria-busy="true" aria-label="Loading embed">
		<header class="card builder__head" aria-hidden="true">
			<span class="ui-skeleton sk-line" style="inline-size: 4.5rem"></span>
			<p class="builder__name"><span class="ui-skeleton sk-line" style="inline-size: 14rem"></span></p>
			<p class="builder__purpose"><span class="ui-skeleton sk-line" style="inline-size: min(30rem, 100%)"></span></p>
		</header>
		<div class="builder__work" aria-hidden="true">
			<section class="card preview"><span class="ui-skeleton sk-preview"></span></section>
		<aside class="card rail">
				<span class="ui-skeleton sk-control"></span>
				<span class="ui-skeleton sk-line" style="inline-size: 12rem"></span>
				<span class="ui-skeleton sk-control"></span>
			</aside>
		</div>
	</div>
{/if}

<CommitReceipt onUndone={load} />

<style>
	.intro {
		display: grid;
		gap: var(--je-space-2);
		margin-block-end: var(--je-space-4);
	}

	.intro__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 650;
	}

	.intro__copy {
		margin: 0;
		max-inline-size: 76ch;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.card {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.preview-failure {
		margin: 0;
		padding: var(--je-space-4);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-danger);
	}

	.embeds-failure {
		margin: 0 0 var(--je-space-3);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-danger);
	}

	.picker {
		display: grid;
		gap: var(--je-space-4);
	}

	.card__head {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-block-size: var(--je-control-height-sm);
		margin-block-end: var(--je-space-2);
	}

	.card__title {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.card__door {
		margin-inline-start: auto;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.card__door:hover {
		color: var(--je-color-text);
	}

	/* Picker rows */
	.picks {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.picks > li + li,
	.pick--fill + .pick--fill {
		border-block-start: 1px solid var(--je-color-border);
	}

	.pick {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
		inline-size: 100%;
		padding: var(--je-space-3) var(--je-space-2);
		border: 0;
		border-radius: var(--je-radius-control);
		background: transparent;
		text-align: start;
		cursor: pointer;
	}

	.pick:hover {
		background: var(--je-color-surface-sunken);
	}

	.pick--fill {
		cursor: default;
	}

	.pick__main {
		display: grid;
		gap: 0.125rem;
		min-width: 0;
	}

	.pick__name {
		font-size: var(--je-font-size-md);
		font-weight: 600;
		color: var(--je-color-text);
	}

	.pick__purpose {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.pick__count {
		font-variant-numeric: tabular-nums;
	}

	/* Nothing to show is worth a different weight, not a different colour: it is
	   a fact about the content, not a fault. */
	.pick__count--empty {
		font-style: italic;
	}

	/* Builder */
	.builder {
		display: grid;
		gap: var(--je-space-4);
	}

	.builder__head {
		display: grid;
		gap: var(--je-space-2);
		justify-items: start;
	}

	.builder__back {
		margin-inline-start: calc(var(--je-space-2) * -1);
	}

	.builder__name {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 650;
	}

	.builder__purpose {
		margin: 0;
		max-inline-size: 72ch;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.builder__doors {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-1) var(--je-space-4);
	}

	.builder__door {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.builder__door:hover {
		color: var(--je-color-text);
	}

	.builder__work {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 26rem);
		gap: var(--je-space-4);
		align-items: start;
	}

	.preview {
		display: grid;
		gap: var(--je-space-2);
		min-width: 0;
	}

	.preview__top {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-2);
		min-block-size: calc(var(--je-control-height-sm) + 4px);
	}

	.preview__state {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.preview__widths {
		flex: none;
	}

	.preview__width-sub {
		margin-inline-start: var(--je-space-1);
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
		opacity: 0.7;
	}

	/* The preview's reserved room: a width change swaps content inside a
	   container that never collapses. */
	.preview__reserve {
		display: grid;
		align-items: start;
		min-width: 0;
	}

	.preview__reserve--waiting {
		min-block-size: 38rem;
	}

	/* The stranger's website. Its ground and rule are neutral and its type is
	   its own, so "match my site" has something to match. */
	.host {
		display: grid;
		gap: var(--je-space-3);
		min-width: 0;
		background: var(--host-canvas);
		color: var(--host-ink);
		font-family: var(--host-font);
		border: 1px dashed var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-5) var(--je-space-4);
	}

	/*
	 * Match-site, made real in the preview: the host's own typography is handed
	 * to the tokens the surfaces read. In a shipped embed this is the shadow
	 * root inheriting `font-family` from the host page rather than declaring its
	 * own — the same substitution, arrived at the same way.
	 */
	.host--match {
		--je-font-body: var(--host-font);
		--je-font-display: var(--host-font);
	}

	.host__line {
		margin: 0;
		font-size: 0.875rem;
		opacity: 0.75;
	}

	.host__line--title {
		font-size: 1.125rem;
		font-weight: 700;
		opacity: 1;
	}

	.host__slot {
		min-width: 0;
	}

	.host__embed {
		min-width: 0;
	}

	/* A frame is a box with an edge the host cannot see through; the preview
	   says so rather than pretending the two mechanisms look identical. */
	.host__embed--framed {
		outline: 1px solid var(--je-color-border-strong);
		outline-offset: 0;
		overflow: hidden;
		border-radius: var(--je-radius-surface);
	}

	.preview__hint {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.preview__hint code {
		font-family: var(--je-font-mono);
	}

	/* Rail */
	.rail {
		display: grid;
		gap: var(--je-space-4);
		align-content: start;
		min-width: 0;
	}

	.rail__group {
		display: grid;
		gap: var(--je-space-2);
		min-width: 0;
	}

	.rail__group + .rail__group {
		border-block-start: 1px solid var(--je-color-border);
		padding-block-start: var(--je-space-4);
	}

	.rail__title {
		margin: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.rail__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-2);
	}

	.rail__legend {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.rail__wide {
		inline-size: 100%;
	}

	.rail__line {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.rail__limit {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text);
		background: var(--je-color-surface-sunken);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-2) var(--je-space-3);
	}

	.rail__error {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-danger);
	}

	.rail__pending {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.rail__pending code {
		font-family: var(--je-font-mono);
	}

	/* Delivery choices: each says what it costs, so the pick is informed rather
	   than a name to guess at. */
	.rail__deliveries {
		display: grid;
		gap: var(--je-space-2);
	}

	.deliv {
		display: grid;
		gap: 0.125rem;
		text-align: start;
		padding: var(--je-space-2) var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: transparent;
		cursor: pointer;
	}

	.deliv:hover {
		background: var(--je-color-surface-sunken);
	}

	.deliv--on {
		background: var(--je-color-mark-surface);
		border-color: var(--je-color-mark-border);
	}

	.deliv__head {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		font-size: var(--je-font-size-sm);
	}

	.deliv__label {
		font-weight: 650;
	}

	.deliv__line {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Origins */
	.origins__form {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.origins__input {
		flex: 1;
		min-inline-size: 10rem;
	}

	.origins {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--je-space-1);
	}

	.origins__row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-2);
		font-size: var(--je-font-size-sm);
	}

	.origins__value {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	/*
	 * The standalone strip. Marked rather than plain, because it is the one
	 * thing on this screen a person may have come for without knowing it exists,
	 * and it must not read as a caption under the purpose line.
	 */
	.standalone {
		display: grid;
		gap: var(--je-space-2);
		justify-items: start;
		inline-size: 100%;
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-3);
	}

	.standalone__lead {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
	}

	.standalone__link {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		inline-size: 100%;
		min-width: 0;
	}

	/* The address takes the room and the action keeps its own; on a narrow
	   column the action wraps under rather than crushing the address. */
	.standalone__link :global(.ui-copy) {
		flex: 1 1 18rem;
		min-width: 0;
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-1) var(--je-space-2);
	}

	.standalone__link :global(.ui-copy__value) {
		flex: 1;
		min-width: 0;
		font-family: var(--je-font-mono);
		font-size: var(--je-font-size-xs);
	}

	/*
	 * The copy control stands here instead of waiting for hover.
	 *
	 * Hiding it until hover is right where it is an incidental affordance beside
	 * a value in a dense row — it would otherwise be clutter repeated down the
	 * whole table. In this box it is the point: the box exists to hand over the
	 * address, there is no row to hover as a hint, and an invisible primary
	 * action is not an action. Same reasoning the primitive already applies on a
	 * coarse pointer, where there is no hover to reveal it with either.
	 */
	.standalone__link :global(.ui-copy__button) {
		opacity: 1;
	}

	.standalone__open {
		flex: none;
	}

	.standalone__line {
		margin: 0;
		max-inline-size: 78ch;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/*
	 * Both columns open on one line. The left column's first row carries a
	 * segmented control and therefore sets the height; the right column's first
	 * title reserves exactly the same, so the two headers share a baseline and
	 * every row beneath them agrees. Without this the rail's 13px label sat
	 * 16px below the preview's 30px control row and the columns read as
	 * misaligned all the way down.
	 */
	.preview__top,
	.rail__title--lead {
		min-block-size: calc(var(--je-control-height-sm) + 4px);
		display: flex;
		align-items: center;
	}

	.findable {
		display: grid;
		gap: var(--je-space-2);
		justify-items: start;
	}

	.findable__line {
		margin: 0;
		max-inline-size: 72ch;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* Snippets */
	.snip {
		display: grid;
		gap: var(--je-space-1);
		min-width: 0;
	}

	.snip__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-2);
	}

	.snip__label {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	/* Code scrolls inside its own box; the document never gains a sideways
	   scrollbar because a snippet is long. The snippet is the deliverable, so it
	   is read rather than scrolled: long attribute lines wrap inside the box,
	   and the exact string still comes from the Copy control rather than from a
	   selection. `overflow-x` stays as the backstop for an unbreakable run. */
	.snip__code {
		margin: 0;
		overflow-x: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-2) var(--je-space-3);
		font-family: var(--je-font-mono);
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-normal);
		tab-size: 2;
	}

	/* Skeleton fills borrow their geometry from what they stand in for. */
	.sk-line {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.sk-chip {
		display: inline-block;
		block-size: 1.35rem;
		inline-size: 6.5rem;
	}

	.sk-control {
		display: block;
		block-size: var(--je-control-height);
		border-radius: var(--je-radius-control);
	}

	.sk-preview {
		display: block;
		min-block-size: 38rem;
		border-radius: var(--je-radius-surface);
	}

	/* Empty / missing */
	.empty {
		display: grid;
		justify-items: center;
		gap: var(--je-space-1);
		padding-block: var(--je-space-8);
		text-align: center;
	}

	.empty__title {
		margin: 0;
		font-weight: 600;
	}

	.empty__copy {
		margin: 0 0 var(--je-space-2);
		max-inline-size: 60ch;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	@media (max-width: 1100px) {
		.builder__work {
			grid-template-columns: minmax(0, 1fr);
		}

		.preview__reserve--waiting,
		.sk-preview {
			min-block-size: 24rem;
		}
	}

	@media (max-width: 720px) {
		/* Four presets in one row are wider than a phone, and a preset is exactly
		   the control a thumb reaches for. Two rows of two, full width, each with
		   its measurement under the name and a touch-sized target. */
		.preview__top {
			display: grid;
		}

		.preview__widths {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			inline-size: 100%;
		}

		.preview__widths :global(.ui-segmented__item) {
			display: grid;
			gap: 0;
			min-block-size: 2.75rem;
			justify-items: center;
			align-content: center;
		}

		.preview__width-sub {
			margin-inline-start: 0;
		}
	}
</style>
