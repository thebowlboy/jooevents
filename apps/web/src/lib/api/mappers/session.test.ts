import { describe, expect, test } from 'bun:test';
import {
	sessionCatalogSchema,
	sessionDraftDataSchema,
	type SessionHeadDto
} from '@jooevents/contracts/sessions';
import {
	mapSessionCatalog,
	mapSessionChangeCommit,
	mapSessionDraft,
	mapSessionHead
} from './session';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);

const scope = Object.freeze({ workspaceId: id(1), eventId: id(2) });

function head(value: number, overrides: Partial<SessionHeadDto> = {}): SessionHeadDto {
	return {
		schemaVersion: 1,
		scope,
		id: id(value),
		title: 'Opening keynote',
		plannedDurationMinutes: 45,
		lifecycle: 'programmed',
		programTarget: {
			setVersion: 3,
			setDigestSha256: digest('b'),
			format: { kind: 'format', id: id(10), name: 'Talk', status: 'active', version: 1 },
			track: null
		},
		roster: { version: 1, digestSha256: digest('c'), participants: [] },
		version: 1,
		digestSha256: digest('d'),
		createdByUserId: id(90),
		createdAt: '2026-08-01T09:00:00.000Z',
		updatedByUserId: id(90),
		updatedAt: '2026-08-01T09:00:00.000Z',
		...overrides
	};
}

function draftData(safeDiff: unknown) {
	return sessionDraftDataSchema.parse({
		schemaVersion: 1,
		action: 'create',
		changesetId: id(30),
		headVersion: 1,
		status: 'draft',
		revision: { id: id(31), number: 1, digestSha256: digest('f') },
		riskTier: 'normal',
		approvalPolicy: {
			reference: { key: 'policy.session.change.bounded', version: 1 },
			definitionDigestSha256: digest('a'),
			requirement: 'none'
		},
		safeDiff
	});
}

describe('session mappers', () => {
	test('maps a canonical catalog into a deeply frozen independent copy', () => {
		const wire = sessionCatalogSchema.parse({
			schemaVersion: 1,
			scope,
			version: 7,
			digestSha256: digest('e'),
			sessions: [head(20), head(21, { id: id(21), lifecycle: 'collecting' })]
		});
		const view = mapSessionCatalog(wire);

		expect(view).toEqual(wire as never);
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(view.sessions)).toBe(true);
		expect(Object.isFrozen(view.sessions[0]?.programTarget.format)).toBe(true);
		expect(Object.isFrozen(view.sessions[0]?.roster.participants)).toBe(true);

		// The copy is severed from the wire alias: mutating the source afterwards
		// must not reach the view.
		(wire.sessions[0] as { title: string }).title = 'Rewritten';
		expect(view.sessions[0]?.title).toBe('Opening keynote');
		expect(Object.isFrozen(mapSessionHead(head(22, { id: id(22) })))).toBe(true);
	});

	test('maps a committed change to its selector, head versions, and after image', () => {
		const created = head(40, { id: id(40), title: 'New session', lifecycle: 'collecting' });
		const draft = draftData({ action: 'create', before: null, after: created });
		const committed = mapSessionChangeCommit({
			draft,
			proposedHeadVersion: 2,
			committedHeadVersion: 3
		});

		expect(committed.action).toBe('create');
		expect(committed.selector).toEqual({
			changesetId: id(30),
			revisionId: id(31),
			revisionDigest: digest('f')
		});
		expect(committed.changesetHead).toEqual({ proposedVersion: 2, committedVersion: 3 });
		expect(committed.session.id).toBe(id(40));
		expect(committed.safeDiff.after?.title).toBe('New session');
		expect(Object.isFrozen(committed)).toBe(true);
		expect(Object.isFrozen(committed.session)).toBe(true);
		expect(Object.isFrozen(mapSessionDraft(draft))).toBe(true);
	});

	test('refuses to fabricate a resulting head when the safe diff has none', () => {
		const degenerate = sessionDraftDataSchema.parse({
			schemaVersion: 1,
			action: 'transition',
			changesetId: id(30),
			headVersion: 1,
			status: 'draft',
			revision: { id: id(31), number: 1, digestSha256: digest('f') },
			riskTier: 'normal',
			approvalPolicy: {
				reference: { key: 'policy.session.change.bounded', version: 1 },
				definitionDigestSha256: digest('a'),
				requirement: 'none'
			},
			// Schema-valid but degenerate: a transition whose after image is absent.
			safeDiff: { action: 'transition', before: head(20), after: null }
		});
		expect(() =>
			mapSessionChangeCommit({ draft: degenerate, proposedHeadVersion: 2, committedHeadVersion: 3 })
		).toThrow(TypeError);
	});
});
