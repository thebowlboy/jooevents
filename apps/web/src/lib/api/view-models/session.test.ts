import { describe, expect, test } from 'bun:test';
import {
	sessionCatalogSchema,
	sessionDraftDataSchema,
	type SessionCatalogDto,
	type SessionDraftData
} from '@jooevents/contracts/sessions';
import type { SessionCatalogView, SessionDraftView, SessionView } from './session';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const scope = { workspaceId: id(1), eventId: id(2) };

describe('session view models', () => {
	test('canonical wire values inhabit the deep-readonly views without loss', () => {
		const catalog: SessionCatalogDto = sessionCatalogSchema.parse({
			schemaVersion: 1,
			scope,
			version: 7,
			digestSha256: digest('e'),
			sessions: [
				{
					schemaVersion: 1,
					scope,
					id: id(20),
					title: 'Opening keynote',
					plannedDurationMinutes: 45,
					lifecycle: 'collecting',
					programTarget: {
						setVersion: 3,
						setDigestSha256: digest('b'),
						format: { kind: 'format', id: id(10), name: 'Talk', status: 'active', version: 1 },
						track: {
							kind: 'track',
							id: id(11),
							name: 'Product',
							accent: 'sea',
							status: 'active',
							version: 1
						}
					},
					roster: {
						version: 1,
						digestSha256: digest('c'),
						participants: [
							{
								personId: id(60),
								role: 'speaker',
								position: 0,
								publiclyVisible: true,
								source: { kind: 'roster.manual', id: 'seed', version: 1 }
							}
						]
					},
					version: 1,
					digestSha256: digest('d'),
					createdByUserId: id(90),
					createdAt: '2026-08-01T09:00:00.000Z',
					updatedByUserId: id(90),
					updatedAt: '2026-08-01T09:00:00.000Z'
				}
			]
		});
		const draft: SessionDraftData = sessionDraftDataSchema.parse({
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
			safeDiff: {
				action: 'transition',
				before: catalog.sessions[0],
				after: { ...catalog.sessions[0]!, lifecycle: 'programmed', version: 2 }
			}
		});

		// The views are structural readonly projections of the same canonical
		// shapes, so parsed wire values inhabit them directly.
		const catalogView: SessionCatalogView = catalog;
		const draftView: SessionDraftView = draft;

		expect(catalogView.sessions[0]?.roster.participants[0]?.role).toBe('speaker');
		expect(draftView.safeDiff.after?.lifecycle).toBe('programmed');
	});

	test('the views refuse mutation at the type level, arrays included', () => {
		type Head = SessionCatalogView['sessions'][number];

		// @ts-expect-error -- a view field is readonly.
		const rejectField = (head: Head) => void (head.title = 'x');
		// @ts-expect-error -- nested evidence is readonly.
		const rejectNested = (head: Head) => void (head.programTarget.setVersion = 9);
		// @ts-expect-error -- readonly arrays carry no push.
		const rejectArray = (catalog: SessionCatalogView) => catalog.sessions.push();
		// Functions survive the mapped type untouched.
		const callable: SessionView<() => number> = () => 4;

		expect(typeof rejectField).toBe('function');
		expect(typeof rejectNested).toBe('function');
		expect(typeof rejectArray).toBe('function');
		expect(callable()).toBe(4);
	});
});
