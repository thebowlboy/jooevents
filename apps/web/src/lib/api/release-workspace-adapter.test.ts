import { describe, expect, test } from 'bun:test';
import {
	releaseMutationResultSchema,
	releaseOverviewSchema,
	releaseSafeDiffSchema,
	type ReleaseAuthorInput,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { ReleaseLiveClient, ReleaseMutationKeys } from './operations/release-live';
import { createReleaseWorkspacePort } from './release-workspace-adapter';

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
			async overview() { return { kind: 'success', data: overview, correlationId: id(90) }; },
			async mutate() { calls += 1; return { kind: 'outcome', outcome, correlationId: id(91) }; }
		};
		const port = createReleaseWorkspacePort(refused);
		expect(await port.setAllowedOrigins('schedule', [])).toEqual({ ok: false,
			reason: 'You no longer have permission to manage publication.' });
		expect(calls).toBe(1);

		const absent: ReleaseLiveClient = {
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
