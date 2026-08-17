import { describe, expect, test } from 'bun:test';
import { API_KEY_EXPIRES_SOON_DAYS } from '@jooevents/contracts';
import {
	SAMPLE_API_KEY_CATALOG,
	SAMPLE_API_KEY_PROFILES
} from '$lib/api/api-keys-page-port.sample';
import type { ApiKeyView } from '$lib/api/api-keys-page-port';
import {
	EXPIRES_SOON_DAYS,
	accessSummary,
	apiKeyState,
	apiKeyStateBadge,
	grantSummary,
	groupSelection,
	heldPermissionIds,
	matchProfileKey,
	resolveProfileIds
} from './api-keys-view';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 7, 16, 12, 0, 0);

function key(overrides: Partial<ApiKeyView>): ApiKeyView {
	return {
		id: 'key-1',
		name: 'Test key',
		tokenHint: 'jooak1_Vk8j',
		proposesChanges: false,
		permissionIds: ['event.read'],
		eventIds: [],
		createdAt: new Date(now - 10 * DAY_MS).toISOString(),
		expiresAt: new Date(now + 60 * DAY_MS).toISOString(),
		lastUsedAt: null,
		standing: 'active',
		revokedAt: null,
		revokeReason: null,
		...overrides
	};
}

describe('derived key state', () => {
	test('shares the external API warning window', () => {
		expect(EXPIRES_SOON_DAYS).toBe(API_KEY_EXPIRES_SOON_DAYS);
	});
	test('an active key far from expiry is plain active and carries no badge', () => {
		expect(apiKeyState(key({}), now)).toBe('active');
		expect(apiKeyStateBadge('active')).toBeNull();
	});

	test('a never-expiring key stays active without inventing an expiry warning', () => {
		expect(apiKeyState(key({ expiresAt: null }), now)).toBe('active');
	});

	test('expiry inside the caution window is its own state, worded and toned', () => {
		const soon = key({ expiresAt: new Date(now + (EXPIRES_SOON_DAYS - 1) * DAY_MS).toISOString() });
		expect(apiKeyState(soon, now)).toBe('expires_soon');
		expect(apiKeyStateBadge('expires_soon')).toEqual({ label: 'Expires soon', tone: 'caution' });
	});

	test('a passed expiry reads expired, and revocation wins over everything', () => {
		expect(apiKeyState(key({ expiresAt: new Date(now - DAY_MS).toISOString() }), now)).toBe('expired');
		const revoked = key({ standing: 'revoked', revokedAt: new Date(now - DAY_MS).toISOString() });
		expect(apiKeyState(revoked, now)).toBe('revoked');
		expect(apiKeyStateBadge('revoked')).toEqual({ label: 'Revoked', tone: 'neutral' });
	});
});

describe('profiles and the switches agree', () => {
	test('every named profile id exists in the catalog, so a tile cannot promise a ghost', () => {
		const known = new Set(
			SAMPLE_API_KEY_CATALOG.flatMap((group) => group.permissions.map((entry) => entry.id))
		);
		for (const profile of SAMPLE_API_KEY_PROFILES) {
			for (const id of resolveProfileIds(profile, SAMPLE_API_KEY_CATALOG)) {
				expect(known.has(id)).toBe(true);
			}
		}
	});

	test('no named profile hands out private contact details, administration, or audit reads', () => {
		for (const profile of SAMPLE_API_KEY_PROFILES) {
			const ids = resolveProfileIds(profile, SAMPLE_API_KEY_CATALOG);
			if (profile.permissionIds === 'everything-held') continue;
			expect(ids).not.toContain('speaker.contact.read');
			expect(ids.some((id) => id.startsWith('access.'))).toBe(false);
			expect(ids).not.toContain('audit.read');
		}
	});

	test('an exact selection matches its tile; one flipped switch lands on custom', () => {
		const dashboard = SAMPLE_API_KEY_PROFILES.find((profile) => profile.key === 'dashboard');
		if (!dashboard) throw new Error('dashboard profile missing');
		const ids = [...resolveProfileIds(dashboard, SAMPLE_API_KEY_CATALOG)];
		expect(
			matchProfileKey(SAMPLE_API_KEY_PROFILES, SAMPLE_API_KEY_CATALOG, {
				proposesChanges: false,
				permissionIds: ids
			})
		).toBe('dashboard');
		expect(
			matchProfileKey(SAMPLE_API_KEY_PROFILES, SAMPLE_API_KEY_CATALOG, {
				proposesChanges: false,
				permissionIds: [...ids, 'speaker.contact.read']
			})
		).toBe('custom');
		// The capability class is part of the identity: same reads, now proposing.
		expect(
			matchProfileKey(SAMPLE_API_KEY_PROFILES, SAMPLE_API_KEY_CATALOG, {
				proposesChanges: true,
				permissionIds: ids
			})
		).toBe('custom');
	});

	test('full access means the held snapshot, which excludes unheld catalog entries', () => {
		const full = SAMPLE_API_KEY_PROFILES.find((profile) => profile.key === 'full');
		if (!full) throw new Error('full profile missing');
		const ids = resolveProfileIds(full, SAMPLE_API_KEY_CATALOG);
		expect(ids).toEqual(heldPermissionIds(SAMPLE_API_KEY_CATALOG));
		expect(ids).not.toContain('publication.manage');
	});
});

describe('group selection state', () => {
	test('none, some, and all are told apart for the tri-state group control', () => {
		const schedule = SAMPLE_API_KEY_CATALOG.find((group) => group.key === 'schedule');
		if (!schedule) throw new Error('schedule group missing');
		expect(groupSelection(schedule, new Set())).toBe('none');
		expect(groupSelection(schedule, new Set(['schedule.read']))).toBe('some');
		expect(
			groupSelection(schedule, new Set(schedule.permissions.map((entry) => entry.id)))
		).toBe('all');
	});
});

describe('summaries', () => {
	test('access reads as capability plus count, and the held snapshot reads as full access', () => {
		expect(
			accessSummary({ proposesChanges: false, permissionIds: ['event.read'] }, SAMPLE_API_KEY_CATALOG)
		).toBe('Read-only · 1 permission');
		expect(
			accessSummary(
				{ proposesChanges: true, permissionIds: [...heldPermissionIds(SAMPLE_API_KEY_CATALOG)] },
				SAMPLE_API_KEY_CATALOG
			)
		).toBe('Full access');
	});

	test('the grant summary restates access, event scope, and expiry in one line', () => {
		const events = [
			{ id: 'event-2027', name: 'HelsinkiJS 2027' },
			{ id: 'event-2026', name: 'HelsinkiJS 2026' }
		];
		expect(
			grantSummary(
				{ proposesChanges: false, permissionIds: ['event.read', 'schedule.read'], eventIds: [] },
				SAMPLE_API_KEY_CATALOG,
				events,
				'14 Nov 2026'
			)
		).toBe('Read-only · 2 permissions · All events · Expires 14 Nov 2026');
		expect(
			grantSummary(
				{
					proposesChanges: true,
					permissionIds: ['event.read'],
					eventIds: ['event-2027']
				},
				SAMPLE_API_KEY_CATALOG,
				events,
				'14 Nov 2026'
		)
		).toBe('Reads and proposes · 1 permission · HelsinkiJS 2027 · Expires 14 Nov 2026');
		expect(
			grantSummary(
				{ proposesChanges: false, permissionIds: ['event.read'], eventIds: [] },
				SAMPLE_API_KEY_CATALOG,
				events,
				null
			)
		).toBe('Read-only · 1 permission · All events · Never expires');
	});
});
