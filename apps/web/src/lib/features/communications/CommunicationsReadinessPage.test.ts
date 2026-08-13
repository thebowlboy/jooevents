import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'CommunicationsReadinessPage.svelte'), 'utf8');

describe('live Communications readiness-only page boundary', () => {
	test('renders exact capability states without setup or send affordances', () => {
		expect(source).toContain("case 'not_supported':");
		expect(source).toContain("label: 'Not supported'");
		expect(source).toContain("case 'not_enabled':");
		expect(source).toContain("label: 'Not enabled'");
		expect(source).toContain('{#if providerLabel}<span class="card__meta">via {providerLabel}</span>{/if}');
		expect(source).toContain("failure.kind === 'transport_error'");
		expect(source).toContain('Support code:');
		expect(source).not.toContain('Continue setup');
		expect(source).not.toContain('Compose');
		expect(source).not.toContain('Send ');
		expect(source).not.toContain('communications-page-port');
		expect(source).not.toContain('/sample/');
	});

	test('keeps the tuned card geometry on semantic design tokens only', () => {
		expect(source).toContain('aria-label="Email delivery"');
		expect(source).toContain('class="card"');
		expect(source).toContain('class="checks"');
		expect(source).toContain('var(--je-color-surface)');
		expect(source).toContain('var(--je-space-4)');
		expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
	});
});
