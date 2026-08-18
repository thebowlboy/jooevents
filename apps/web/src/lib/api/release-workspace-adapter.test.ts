import { describe, expect, test } from 'bun:test';
import {
	releaseMutationResultSchema,
	releaseOverviewSchema,
	releaseSafeDiffSchema,
	type ReleaseAuthorInput,
	type StructuredOutcome
} from '@jooevents/contracts';
import type {
	ReleaseLiveClient,
	ReleaseLiveMutationData,
	ReleaseMutationKeys
} from './operations/release-live';
import { createReleaseWorkspacePort } from './release-workspace-adapter';

/** The reviewed half these doubles never reach: this port publishes in one press. */
const unreviewed: Pick<ReleaseLiveClient, 'draft' | 'publishDrafted'> = {
	draft() { throw new Error('draft_not_used'); },
	publishDrafted() { throw new Error('publish_drafted_not_used'); }
};


const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const scope = { workspaceId: id(1), eventId: id(2) };
const now = '2026-08-15T00:00:00.000Z';
const pin = { artifactId: id(10), revisionId: id(11), revisionNumber: 1, digestSha256: digest('a') };
const before = {
	schemaVersion: 1 as const, scope, kind: 'schedule' as const, activeReleaseId: id(20), version: 1,
	allowedFrameOrigins: [], updatedByUserId: id(3), updatedAt: now
};
const overview = releaseOverviewSchema.parse({
	schemaVersion: 1, scope, currentProgramRelease: null, currentStyleSetRelease: null,
	surfaceHeads: [before],
	activeSurfaceReleases: [{
		kind: 'schedule', schemaVersion: 1, scope, id: id(20), number: 1, predecessor: null,
		sourceTemplateRevision: pin, manifest: { schemaVersion: 1, heading: 'Schedule', intro: null },
		styleSetReleaseId: id(21), releasedByUserId: id(3), releasedAt: now, digestSha256: digest('b')
	}]
});

describe('Release workspace adapter', () => {
	test('preserves the fresh head guard and supplies two distinct explicit keys', async () => {
		const calls: { input: ReleaseAuthorInput; keys: ReleaseMutationKeys }[] = [];
		const client: ReleaseLiveClient = {
			...unreviewed,
			async overview() { return { kind: 'success', data: overview, correlationId: id(90) }; },
			async mutate(input, keys) {
				calls.push({ input, keys });
				if (input.action !== 'surface_allowlist') throw new TypeError('unexpected_release_action');
				const after = { ...before, version: 2, allowedFrameOrigins: [...input.allowedFrameOrigins] };
				return { kind: 'success', correlationId: id(91), data: {
					mutation: releaseMutationResultSchema.parse({ action: input.action, head: after }),
					safeDiff: releaseSafeDiffSchema.parse({ action: input.action, kind: input.kind, before, after })
				} };
			}
		};
		const port = createReleaseWorkspacePort(client);
		expect(await port.setAllowedOrigins('schedule', ['https://host.example'])).toEqual({ ok: true });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toEqual({ action: 'surface_allowlist', kind: 'schedule',
			allowedFrameOrigins: ['https://host.example'], expectedSurfaceHeadVersion: 1 });
		expect(calls[0]?.keys.draft.startsWith('je.release.surface-allowlist.draft.')).toBe(true);
		expect(calls[0]?.keys.publish.startsWith('je.release.surface-allowlist.publish.')).toBe(true);
		expect(calls[0]?.keys.draft).not.toBe(calls[0]?.keys.publish);
	});

	test('preserves typed refusal copy and does not publish an absent surface', async () => {
		const outcome: StructuredOutcome = { class: 'access_denied', kind: 'authority.not_authorized',
			retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 };
		let calls = 0;
		const refused: ReleaseLiveClient = {
			...unreviewed,
			async overview() { return { kind: 'success', data: overview, correlationId: id(90) }; },
			async mutate() { calls += 1; return { kind: 'outcome', outcome, correlationId: id(91) }; }
		};
		const port = createReleaseWorkspacePort(refused);
		expect(await port.setAllowedOrigins('schedule', [])).toEqual({ ok: false,
			reason: 'You no longer have permission to manage publication.' });
		expect(calls).toBe(1);

		const absent: ReleaseLiveClient = {
			...unreviewed,
			async overview() { return { kind: 'success', data: releaseOverviewSchema.parse({
				schemaVersion: 1, scope, currentProgramRelease: null, currentStyleSetRelease: null,
				surfaceHeads: [], activeSurfaceReleases: []
			}), correlationId: id(92) }; },
			async mutate() { throw new TypeError('mutation_must_not_run'); }
		};
		expect(await createReleaseWorkspacePort(absent).setAllowedOrigins('schedule', [])).toEqual({
			ok: false, reason: 'Publish this page before naming sites that may embed it.'
		});
	});
});

describe('Schedule publication, reviewed', () => {
	const chainImage = (number: number) => ({
		releaseId: id(30 + number), number, digestSha256: digest(String(number))
	});
	const scheduleDiff = releaseSafeDiffSchema.parse({
		action: 'publish_schedule',
		before: null,
		after: chainImage(1),
		releasedSessionCount: 4,
		releasedOccurrenceCount: 6,
		nameDeclassifications: [
			{ personId: id(40), displayName: 'Ada Lovelace' },
			{ personId: id(41), displayName: 'Grace Hopper' }
		],
		speakerLineup: {
			digestSha256: digest('f'),
			categories: [],
			publicSpeakers: [
				{ speakerId: id(60), name: 'Grace Hopper', categoryId: null },
				{ speakerId: id(61), name: 'Ada Lovelace', categoryId: null }
			]
		},
		rollbackSuppressions: null
	});
	const drafted = {
		action: 'publish_schedule' as const,
		selector: { draftId: id(50), revisionId: id(51), revisionDigestSha256: digest('c') },
		safeDiff: scheduleDiff
	};

	test('drafts against the current chain head and states what would go public', async () => {
		const drafts: { input: ReleaseAuthorInput; key: string }[] = [];
		const client: ReleaseLiveClient = {
			...unreviewed,
			async overview() { return { kind: 'success', data: overview, correlationId: id(90) }; },
			async mutate() { throw new Error('mutate_not_used'); },
			async draft(input, key) {
				drafts.push({ input, key });
				return { kind: 'success', data: drafted, correlationId: id(92) };
			}
		};
		const review = await createReleaseWorkspacePort(client).draftSchedulePublication();
		if ('ok' in review) throw new Error('expected_review');
		// Null fences "no release yet" — the overview above carries none.
		expect(drafts[0]?.input).toEqual({ action: 'publish_schedule', expectedCurrentReleaseNumber: null });
		expect(drafts[0]?.key.startsWith('je.release.publish-schedule.draft.')).toBe(true);
		expect(review.releaseNumber).toBe(1);
		expect(review.sessions).toBe(4);
		expect(review.occurrences).toBe(6);
		// The disclosure is the review: exactly the names the commit makes public.
		expect(review.declassifiedNames).toEqual(['Ada Lovelace', 'Grace Hopper']);
		expect(review.lineupNames).toEqual(['Grace Hopper', 'Ada Lovelace']);
		expect(review.speakerGroups).toEqual([]);
	});

	test('publishes exactly the reviewed draft, under its own explicit key', async () => {
		const published: { drafted: unknown; key: string }[] = [];
		const client: ReleaseLiveClient = {
			...unreviewed,
			async overview() { return { kind: 'success', data: overview, correlationId: id(90) }; },
			async mutate() { throw new Error('mutate_not_used'); },
			async draft() { return { kind: 'success', data: drafted, correlationId: id(92) }; },
			async publishDrafted(input, key) {
				published.push({ drafted: input, key });
				// The adapter reads only the result kind here — the published
				// effect was already checked against the reviewed diff inside the
				// client — so the double states the shape without rebuilding a
				// whole immutable programme release.
				return { kind: 'success', correlationId: id(93), data: {
					mutation: { action: 'publish_schedule' } as ReleaseLiveMutationData['mutation'],
					safeDiff: scheduleDiff
				} };
			}
		};
		const port = createReleaseWorkspacePort(client);
		const review = await port.draftSchedulePublication();
		if ('ok' in review) throw new Error('expected_review');
		expect(await port.publishSchedule(review)).toEqual({ ok: true });
		expect(published[0]?.drafted).toEqual(drafted);
		expect(published[0]?.key.startsWith('je.release.publish-schedule.publish.')).toBe(true);
	});

	test('refuses to publish a review carrying no drafted revision', async () => {
		const client: ReleaseLiveClient = {
			...unreviewed,
			async overview() { return { kind: 'success', data: overview, correlationId: id(90) }; },
			async mutate() { throw new Error('mutate_not_used'); }
		};
		expect(await createReleaseWorkspacePort(client).publishSchedule({
			releaseNumber: 1, sessions: 0, occurrences: 0, declassifiedNames: [],
			lineupNames: [], speakerGroups: []
		})).toEqual({ ok: false, reason: 'Review this publication again before publishing it.' });
	});

	test('a refused draft never reaches the publish request', async () => {
		const outcome: StructuredOutcome = {
			kind: 'release.schedule_conflicts_block', class: 'conflict', retryable: false
		} as StructuredOutcome;
		const client: ReleaseLiveClient = {
			...unreviewed,
			async overview() { return { kind: 'success', data: overview, correlationId: id(90) }; },
			async mutate() { throw new Error('mutate_not_used'); },
			async draft() { return { kind: 'outcome', outcome, correlationId: id(94) }; },
			async publishDrafted() { throw new Error('publish_must_not_run'); }
		};
		expect(await createReleaseWorkspacePort(client).draftSchedulePublication()).toEqual({
			ok: false,
			reason: 'Publication changed while you were working. Reload and try again.'
		});
	});
});
