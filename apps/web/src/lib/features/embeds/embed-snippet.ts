import {
	EMBED_ELEMENT_TAG,
	EMBED_FRAME_MIN_HEIGHT_PX,
	EMBED_LOADER_PATH,
	normalizeEmbedFrameOrigin,
	type EmbedFrameOriginNormalization,
	type EmbedFrameOriginRefusalCode
} from '@jooevents/contracts';
import type {
	EmbedDelivery,
	EmbedScope,
	EmbedSpec,
	EmbedStyleMode,
	SurfaceKind
} from '$lib/api/types';

/**
 * The code an organizer pastes into their own site, and the rules that keep it
 * pasteable.
 *
 * Everything here is a pure function of the spec and the origin, because the
 * snippet is the product's contract with a page nobody here controls: it has to
 * be reproducible, diffable, testable, and identical whether a person or an
 * agent asked for it. Nothing in this module reads the DOM or the clock.
 *
 * ## Two deliveries, and what each costs
 *
 * A host page permits different things, and the honest answer is not one
 * snippet — it is the best one that page will accept, with its cost stated:
 *
 * - **`inline`** renders into a **shadow root**. Style isolation runs both ways
 *   (the host cannot restyle the embed; the embed cannot leak into the host),
 *   the block takes its **natural height** — no resize handshake, no fixed
 *   `min-height`, no scrollbar inside a scrollbar, which is the failure that
 *   makes most iframe embeds feel broken — and the content is in the host's own
 *   document. It needs one `<script>` tag.
 * - **`frame`** is an iframe, for pages that strip scripts. Isolation is
 *   absolute, but a separate document cannot inherit the host's typography, and
 *   the host must be given a height up front.
 *
 * The hosted page's own address is deliberately *not* a third delivery: it is a
 * link, handed out as a URL rather than as markup, and it needs no snippet at
 * all. Offering the same thing twice in two shapes is one control too many.
 *
 * ## Why the layout is fluid rather than breakpointed
 *
 * The embed is laid out against **its own box**, never the viewport: the same
 * snippet has to look composed in a 300px sidebar and in a 1100px content
 * column of the same site. That is a renderer rule (`container-type:
 * inline-size` and `@container` queries) — the snippet's part is to state a
 * maximum width and otherwise get out of the way, which is why it declares
 * `width: 100%` and never a fixed pixel width.
 */

/** The published surface each embeddable kind serves from. */
const ROUTE: Record<SurfaceKind, string> = {
	schedule: 'schedule',
	'speaker-roster': 'speakers',
	'application-form': 'apply'
};

/** The custom element's tag, and the one script that defines it — the contract's own constants. */
export const EMBED_TAG = EMBED_ELEMENT_TAG;
export const LOADER_PATH = EMBED_LOADER_PATH;

/**
 * A scope as one attribute value: `all`, or `kind:id`. Flat on purpose — it has
 * to survive being typed by hand into a site builder's attribute box, and it is
 * parsed back by an exhaustive switch on the server rather than by `JSON.parse`
 * on whatever a host page happened to send.
 */
export function serializeScope(scope: EmbedScope): string {
	switch (scope.kind) {
		case 'all':
			return 'all';
		case 'category':
			return `category:${scope.categoryId}`;
		case 'speaker':
			return `speaker:${scope.speakerId}`;
		case 'day':
			return `day:${scope.dayKey}`;
		case 'form':
			return `form:${scope.formId}`;
	}
}

/** The inverse of {@link serializeScope}; anything unrecognized reads as the whole surface. */
export function parseScope(value: string | null): EmbedScope {
	if (!value || value === 'all') return { kind: 'all' };
	const separator = value.indexOf(':');
	if (separator < 1) return { kind: 'all' };
	const id = value.slice(separator + 1);
	if (!id) return { kind: 'all' };
	switch (value.slice(0, separator)) {
		case 'category':
			return { kind: 'category', categoryId: id };
		case 'speaker':
			return { kind: 'speaker', speakerId: id };
		case 'day':
			return { kind: 'day', dayKey: id };
		case 'form':
			return { kind: 'form', formId: id };
		default:
			return { kind: 'all' };
	}
}

/**
 * The public address this embed renders, standalone or framed.
 *
 * A frame never carries `style`: a separate document has no host cascade to
 * inherit from, so the parameter could not be honoured, and a request that asks
 * for something the mechanism cannot do is a lie in the address bar. The
 * builder states the same limitation beside the control.
 */
export function embedUrl(origin: string, spec: EmbedSpec): string {
	const base = `${trimOrigin(origin)}/embed/${ROUTE[spec.kind]}`;
	const query = new URLSearchParams();
	const scope = serializeScope(spec.scope);
	if (scope !== 'all') query.set('scope', scope);
	if (spec.style !== 'event' && spec.delivery !== 'frame') query.set('style', spec.style);
	const search = query.toString();
	return search ? `${base}?${search}` : base;
}

/** The canonical standalone page the same surface publishes — the escape from every embed. */
export function standaloneUrl(origin: string, spec: EmbedSpec): string {
	const base = `${trimOrigin(origin)}/s/${ROUTE[spec.kind]}`;
	const scope = serializeScope(spec.scope);
	return scope === 'all' ? base : `${base}?scope=${encodeURIComponent(scope)}`;
}

/**
 * The one-line script that defines the custom element, emitted once per page
 * however many embeds that page carries. It is separated from the element
 * markup below for exactly that reason: a person pasting a second embed needs
 * the element, not a second copy of the loader.
 */
export function loaderSnippet(origin: string): string {
	return `<script src="${trimOrigin(origin)}${LOADER_PATH}" async></script>`;
}

/**
 * The pasteable code for a spec. `inline` returns the element alone — the
 * loader is its own snippet — so the two can be pasted where each belongs
 * (theme footer, page body) instead of being pulled apart by hand.
 */
export function embedSnippet(origin: string, spec: EmbedSpec, title: string): string {
	if (spec.delivery === 'frame') {
		return frameSnippet(origin, spec, title);
	}
	return elementSnippet(origin, spec);
}

function elementSnippet(origin: string, spec: EmbedSpec): string {
	const attributes = [`src="${embedUrl(origin, spec)}"`];
	const scope = serializeScope(spec.scope);
	if (scope !== 'all') attributes.push(`scope="${scope}"`);
	if (spec.style !== 'event') attributes.push(`style-mode="${spec.style}"`);
	if (spec.fit.maxWidth !== null) attributes.push(`max-width="${spec.fit.maxWidth}"`);
	if (spec.fit.align !== 'start') attributes.push(`align="${spec.fit.align}"`);
	// One attribute per line past the first: a single long line is what makes a
	// pasted snippet unreadable in the box it lands in.
	const [first, ...rest] = attributes;
	const head = `<${EMBED_TAG} ${first}`;
	if (rest.length === 0) return `${head}></${EMBED_TAG}>`;
	const indent = ' '.repeat(EMBED_TAG.length + 2);
	return `${head}\n${rest.map((line) => `${indent}${line}`).join('\n')}></${EMBED_TAG}>`;
}

/**
 * A frame has to be told a height, because a cross-document child cannot size
 * its parent. The floor below is per kind and generous: too short crops the
 * content behind an inner scrollbar, too tall leaves a band of empty page, and
 * of the two only the first loses information.
 */
const FRAME_MIN_HEIGHT: Record<SurfaceKind, number> = {
	schedule: EMBED_FRAME_MIN_HEIGHT_PX.schedule,
	'speaker-roster': EMBED_FRAME_MIN_HEIGHT_PX.speakers,
	'application-form': EMBED_FRAME_MIN_HEIGHT_PX.apply
};

/** A single speaker's card is a fraction of a roster and says so in its height. */
const PROFILE_MIN_HEIGHT = 320;

export function frameMinHeight(spec: EmbedSpec): number {
	if (spec.kind === 'speaker-roster' && spec.scope.kind === 'speaker') return PROFILE_MIN_HEIGHT;
	return FRAME_MIN_HEIGHT[spec.kind];
}

function frameSnippet(origin: string, spec: EmbedSpec, title: string): string {
	const style = [
		'width:100%',
		spec.fit.maxWidth !== null ? `max-width:${spec.fit.maxWidth}px` : null,
		spec.fit.align === 'center' && spec.fit.maxWidth !== null ? 'margin:0 auto' : null,
		'border:0',
		`min-height:${frameMinHeight(spec)}px`
	]
		.filter((part) => part !== null)
		.join(';');
	return [
		`<iframe src="${embedUrl(origin, spec)}"`,
		`        title="${escapeText(title)}"`,
		`        style="${style}"`,
		'        loading="lazy"></iframe>'
	].join('\n');
}

/**
 * What a delivery cannot do, said before it is chosen rather than discovered
 * after pasting. Null means the delivery is fully available for this spec.
 *
 * These are the real constraints of the mechanisms, not policy: a separate
 * document has no host cascade to inherit from, and an anchor is a link to a
 * page rather than a rendering of it.
 */
export function deliveryLimitation(delivery: EmbedDelivery, style: EmbedStyleMode): string | null {
	if (delivery === 'frame' && style === 'match-site') {
		return 'A frame is a separate page, so it cannot pick up your site’s font and text colour. Choose the event’s own look, or switch to the inline snippet.';
	}
	return null;
}

/**
 * True when this surface binds an origin allowlist before it can be framed.
 * Every embed kind does: framing is allowlist-only for the whole product — an
 * empty list means the served page denies all framing — so the snippet builder
 * and the response policy agree about the obligation.
 */
export function bindsOriginAllowlist(_spec: Pick<EmbedSpec, 'kind'>): boolean {
	return true;
}

/**
 * What still stands between this spec and a site, in the terms an organizer
 * can act on. Empty means ready.
 *
 * The origin allowlist is the one rule here that is not advice, and it is the
 * surface's own configured list — the same fact the served `frame-ancestors`
 * policy derives from — never a per-snippet decoration: an embed pasted on an
 * unnamed site simply refuses to load.
 */
export function specRefusals(
	spec: EmbedSpec,
	surfaceAllowedOrigins: readonly string[]
): string[] {
	const refusals: string[] = [];
	if (bindsOriginAllowlist(spec) && surfaceAllowedOrigins.length === 0) {
		refusals.push(
			spec.kind === 'application-form'
				? 'Name at least one site before this form can be embedded anywhere.'
				: 'Name at least one site before this can be embedded anywhere.'
		);
	}
	return refusals;
}

/**
 * An origin as the allowlist stores it: scheme and host, nothing else — the
 * contract's own normalizer, so the builder refuses exactly what the served
 * `frame-ancestors` policy would refuse. Paths, queries, fragments,
 * credentials, wildcards, and header-unserializable host characters refuse in
 * place rather than being truncated into a rule that never matches.
 */
export function normalizeOrigin(input: string): EmbedFrameOriginNormalization {
	return normalizeEmbedFrameOrigin(input);
}

/**
 * The organizer-facing sentence for each origin refusal, in terms they can
 * act on. Exhaustive over the contract's refusal codes so a new code fails
 * the compile here rather than rendering an empty error.
 */
const ORIGIN_REFUSAL_COPY: Readonly<Record<EmbedFrameOriginRefusalCode, string>> = Object.freeze({
	empty: 'Enter a website address, like conference.example.org.',
	not_an_origin: 'That is not a website address. Try something like conference.example.org.',
	unsupported_scheme: 'Only web addresses (http or https) can host this embed.',
	credentials_present: 'A site address never carries a username or password.',
	path_present: 'Name just the site itself — without a path. Try conference.example.org.',
	query_present: 'Name just the site itself — without a query. Try conference.example.org.',
	fragment_present: 'Name just the site itself — without a fragment. Try conference.example.org.',
	wildcard_host: 'Name each site exactly — wildcards cannot be allowed.',
	hostname_forbidden_characters: 'That address contains characters a site origin cannot carry.',
	hostname_unqualified: 'Use the site’s full address, like conference.example.org.'
});

export function originRefusalCopy(code: EmbedFrameOriginRefusalCode): string {
	return ORIGIN_REFUSAL_COPY[code];
}

/** Trailing slashes make `${origin}/embed` read as `//embed`; strip them once, here. */
function trimOrigin(origin: string): string {
	return origin.replace(/\/+$/, '');
}

/** The snippet is source someone reads; a title with markup in it must not become markup. */
function escapeText(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
