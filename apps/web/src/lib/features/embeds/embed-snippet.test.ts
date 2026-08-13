import { describe, expect, test } from 'bun:test';
import {
	bindsOriginAllowlist,
	deliveryLimitation,
	embedSnippet,
	embedUrl,
	frameMinHeight,
	loaderSnippet,
	normalizeOrigin,
	parseScope,
	serializeScope,
	specRefusals,
	standaloneUrl
} from './embed-snippet';
import type { EmbedScope, EmbedSpec } from '$lib/api/types';

function spec(patch: Partial<EmbedSpec> = {}): EmbedSpec {
	return {
		surfaceId: 'srf-speaker-roster',
		kind: 'speaker-roster',
		scope: { kind: 'all' },
		fit: { maxWidth: null, align: 'start' },
		style: 'event',
		delivery: 'inline',
		allowedOrigins: [],
		...patch
	};
}

describe('scope round-trips as one attribute value', () => {
	const cases: EmbedScope[] = [
		{ kind: 'all' },
		{ kind: 'category', categoryId: 'cat-keynote' },
		{ kind: 'speaker', speakerId: 'spk-4' },
		{ kind: 'day', dayKey: 'day-1' },
		{ kind: 'form', formId: 'form-workshops' }
	];

	test('every scope survives serialize → parse', () => {
		for (const scope of cases) expect(parseScope(serializeScope(scope))).toEqual(scope);
	});

	test('anything unrecognized reads as the whole surface rather than throwing', () => {
		// A host page can hand us any string; the boundary answers with the safe
		// projection instead of a filter it invented.
		for (const raw of ['', null, 'nonsense', 'speaker:', ':spk-4', 'track:trk-ai']) {
			expect(parseScope(raw)).toEqual({ kind: 'all' });
		}
	});
});

describe('addresses', () => {
	test('a whole-surface embed carries no query at all', () => {
		expect(embedUrl('https://event.example', spec())).toBe('https://event.example/embed/speakers');
	});

	test('scope and style ride the query; a trailing slash on the origin never doubles', () => {
		const url = embedUrl(
			'https://event.example/',
			spec({ scope: { kind: 'speaker', speakerId: 'spk-4' }, style: 'match-site' })
		);
		expect(url).toBe('https://event.example/embed/speakers?scope=speaker%3Aspk-4&style=match-site');
	});

	test('every kind has its own public route', () => {
		expect(embedUrl('https://e.example', spec({ kind: 'schedule' }))).toContain('/embed/schedule');
		expect(embedUrl('https://e.example', spec({ kind: 'application-form' }))).toContain('/embed/apply');
	});

	test('the standalone page is the escape from any embed, carrying the same scope', () => {
		expect(
			standaloneUrl('https://event.example', spec({ scope: { kind: 'category', categoryId: 'cat-keynote' } }))
		).toBe('https://event.example/s/speakers?scope=category%3Acat-keynote');
	});
});

describe('the inline snippet', () => {
	test('the loader is its own line, so a second embed on a page does not repeat it', () => {
		expect(loaderSnippet('https://event.example')).toBe(
			'<script src="https://event.example/embed/v1/joo-embed.js" async></script>'
		);
		expect(embedSnippet('https://event.example', spec(), 'Speakers')).not.toContain('<script');
	});

	test('a default spec is one short line: defaults are never spelled out', () => {
		expect(embedSnippet('https://event.example', spec(), 'Speakers')).toBe(
			'<joo-embed src="https://event.example/embed/speakers"></joo-embed>'
		);
	});

	test('every non-default choice becomes one attribute, aligned under the first', () => {
		const snippet = embedSnippet(
			'https://event.example',
			spec({
				scope: { kind: 'category', categoryId: 'cat-keynote' },
				style: 'match-site',
				fit: { maxWidth: 960, align: 'center' }
			}),
			'Keynotes'
		);
		expect(snippet.split('\n')).toEqual([
			'<joo-embed src="https://event.example/embed/speakers?scope=category%3Acat-keynote&style=match-site"',
			'           scope="category:cat-keynote"',
			'           style-mode="match-site"',
			'           max-width="960"',
			'           align="center"></joo-embed>'
		]);
	});
});

describe('the frame snippet', () => {
	test('carries a title, a fluid width, and a per-kind minimum height', () => {
		const snippet = embedSnippet(
			'https://event.example',
			spec({ kind: 'schedule', delivery: 'frame' }),
			'Schedule — AI Engineer NYC 2026'
		);
		expect(snippet).toContain('title="Schedule — AI Engineer NYC 2026"');
		expect(snippet).toContain('width:100%');
		expect(snippet).toContain('min-height:720px');
		expect(snippet).toContain('loading="lazy"');
		// Never a fixed pixel width: the host's box decides how wide it runs.
		expect(snippet).not.toMatch(/width:\s*\d+px/);
	});

	test('one speaker is a fraction of a roster and asks for a fraction of its height', () => {
		expect(frameMinHeight(spec({ scope: { kind: 'speaker', speakerId: 'spk-4' } }))).toBeLessThan(
			frameMinHeight(spec())
		);
	});

	test('centring only applies where a maximum width makes it mean something', () => {
		const unbounded = embedSnippet(
			'https://e.example',
			spec({ delivery: 'frame', fit: { maxWidth: null, align: 'center' } }),
			'Speakers'
		);
		expect(unbounded).not.toContain('margin:0 auto');
		const bounded = embedSnippet(
			'https://e.example',
			spec({ delivery: 'frame', fit: { maxWidth: 640, align: 'center' } }),
			'Speakers'
		);
		expect(bounded).toContain('max-width:640px');
		expect(bounded).toContain('margin:0 auto');
	});

	test('never asks for a style the mechanism cannot honour', () => {
		// A separate document has no host cascade to inherit from, so the frame's
		// address carries no `style` even when match-site is selected — the
		// builder states the limitation rather than sending an impossible request.
		const framed = spec({ delivery: 'frame', style: 'match-site' });
		expect(embedUrl('https://e.example', framed)).not.toContain('style=');
		expect(embedSnippet('https://e.example', framed, 'Speakers')).not.toContain('style=match-site');
		// Inline can, so it does.
		expect(embedUrl('https://e.example', spec({ style: 'match-site' }))).toContain('style=match-site');
	});

	test('a title carrying markup is escaped rather than emitted as markup', () => {
		const snippet = embedSnippet(
			'https://e.example',
			spec({ delivery: 'frame' }),
			'Speakers <script>alert(1)</script> & friends'
		);
		expect(snippet).toContain('&lt;script&gt;');
		expect(snippet).toContain('&amp; friends');
		expect(snippet).not.toContain('<script>');
	});
});

describe('what a delivery cannot do is said before it is chosen', () => {
	test('a frame cannot inherit the host page’s typography', () => {
		expect(deliveryLimitation('frame', 'match-site')).toContain('separate page');
		expect(deliveryLimitation('frame', 'event')).toBeNull();
	});

	test('inline has no limitation in either style mode', () => {
		expect(deliveryLimitation('inline', 'event')).toBeNull();
		expect(deliveryLimitation('inline', 'match-site')).toBeNull();
	});

	test('the hosted page is a link, not a delivery: it has an address and no snippet', () => {
		// Offering the same thing twice — a URL to hand out and an <a> to paste —
		// is one control too many, so the address stands alone.
		expect(standaloneUrl('https://e.example', spec())).toBe('https://e.example/s/speakers');
		expect(embedSnippet('https://e.example', spec(), 'Our speakers')).toContain('<joo-embed');
	});
});

describe('origin allowlist', () => {
	test('only a surface that accepts submissions binds one', () => {
		expect(bindsOriginAllowlist({ kind: 'application-form' })).toBe(true);
		expect(bindsOriginAllowlist({ kind: 'speaker-roster' })).toBe(false);
		expect(bindsOriginAllowlist({ kind: 'schedule' })).toBe(false);
	});

	test('a form embed with no named site is refused; a roster embed is not', () => {
		expect(specRefusals(spec({ kind: 'application-form' }))).toHaveLength(1);
		expect(specRefusals(spec({ kind: 'application-form', allowedOrigins: ['https://a.example'] }))).toEqual([]);
		expect(specRefusals(spec())).toEqual([]);
	});

	test('an origin normalizes to scheme and host, and nothing else', () => {
		expect(normalizeOrigin('conf.example.org')).toBe('https://conf.example.org');
		expect(normalizeOrigin('  https://conf.example.org/speakers?x=1  ')).toBe('https://conf.example.org');
		expect(normalizeOrigin('http://localhost:5176/anything')).toBe('http://localhost:5176');
	});

	test('a value that is not an origin is refused rather than stored as decoration', () => {
		for (const bad of ['', '   ', 'not a host', 'javascript:alert(1)', 'ftp://files.example.org']) {
			expect(normalizeOrigin(bad)).toBeNull();
		}
	});
});
