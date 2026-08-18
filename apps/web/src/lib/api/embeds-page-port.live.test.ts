import { describe, expect, test } from 'bun:test';
import {
	releaseOverviewSchema,
	releaseSafeDiffSchema,
	type ReleaseAuthorInput,
	type ReleaseOverviewDto
} from '@jooevents/contracts';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleTemplatesPagePort } from './templates-page-port.sample';
import { createLiveEmbedsPagePort } from './embeds-page-port.live';
import type { ReleaseLiveClient, ReleaseMutationKeys } from './operations/release-live';
import { createReleaseWorkspacePort } from './release-workspace-adapter';

/** The reviewed half these doubles never reach: this port publishes in one press. */
const unreviewed: Pick<ReleaseLiveClient, 'draft' | 'publishDrafted'> = {
	draft() { throw new Error('draft_not_used'); },
	publishDrafted() { throw new Error('publish_drafted_not_used'); }
};


const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = 'a'.repeat(64);
const now = '2026-08-15T08:00:00.000Z';
const scope = { workspaceId: id(1), eventId: id(2) };

function program() {
	return {
		schemaVersion: 1 as const,
		scope,
		id: id(10),
		number: 1,
		origin: { kind: 'publish' as const },
		predecessor: null,
		pins: {
			sessionCatalog: { version: 2, digestSha256: digest },
			scheduleVersion: 3,
			engagementSnapshotDigestSha256: digest,
			vocabulary: { setVersion: 4, digestSha256: digest },
			eventSettingsVersion: 5,
			speakerLineupDigestSha256: digest
		},
		rooms: [{ id: id(20), name: 'Main room' }],
		sessions: [{
			sessionId: id(30), title: 'Released session', plannedDurationMinutes: 45,
			format: { id: id(31), name: 'Talk' }, track: null,
			occurrences: [{
				occurrenceId: id(32), roomId: id(20),
				startAt: '2026-09-01T01:00:00.000Z', endAt: '2026-09-01T01:45:00.000Z'
			}],
			participants: [{ personId: id(40), role: 'speaker' as const, position: 0, displayName: 'Released Speaker' }]
		}],
		speakerLineup: {
			schemaVersion: 1 as const,
			version: 2,
			digestSha256: digest,
			categories: [{ id: id(41), name: 'Keynotes', accent: 'lavender' as const, position: 0 }],
			entries: [{
				speakerId: id(42), personId: id(40), position: 0, categoryId: id(41),
				publiclyVisible: true, displayName: 'Released Speaker'
			}]
		},
		nameDeclassifications: [{ personId: id(40), displayName: 'Released Speaker' }],
		releasedByUserId: id(3), releasedAt: now, digestSha256: digest
	};
}

function releaseState(): ReleaseOverviewDto {
	const common = {
		schemaVersion: 1 as const, scope, number: 1, predecessor: null,
		sourceTemplateRevision: {
			artifactId: id(70), revisionId: id(71), revisionNumber: 1, digestSha256: digest
		},
		manifest: { schemaVersion: 1 as const, heading: null, intro: null },
		styleSetReleaseId: id(50), releasedByUserId: id(3), releasedAt: now,
		digestSha256: digest
	};
	return releaseOverviewSchema.parse({
		schemaVersion: 1,
		scope,
		currentProgramRelease: program(),
		currentStyleSetRelease: null,
		surfaceHeads: [
			{
				schemaVersion: 1, scope, kind: 'schedule', activeReleaseId: id(60), version: 1,
				allowedFrameOrigins: [], updatedByUserId: id(3), updatedAt: now
			},
			{
				schemaVersion: 1, scope, kind: 'speakers', activeReleaseId: id(61), version: 1,
				allowedFrameOrigins: [], updatedByUserId: id(3), updatedAt: now
			}
		],
		activeSurfaceReleases: [
			{ kind: 'schedule', id: id(60), ...common },
			{ kind: 'speakers', id: id(61), ...common }
		]
	});
}

describe('live Embeds page adapter', () => {
	test('targets, speaker targets, and the template list share one overview and one library read', async () => {
		let overviews = 0;
		let libraries = 0;
		const overviewGate = Promise.withResolvers<void>();
		const libraryGate = Promise.withResolvers<void>();
		const overviewStarted = Promise.withResolvers<void>();
		const libraryStarted = Promise.withResolvers<void>();
		const release: ReleaseLiveClient = {
			...unreviewed,
			async overview() {
				overviews += 1;
				overviewStarted.resolve();
				await overviewGate.promise;
				return { kind: 'success', data: releaseState(), correlationId: 'overview-correlation' };
			},
			async mutate() { throw new Error('unused'); }
		};
		const sample = createSampleTemplatesPagePort(sampleWorkspaceGateway.api);
		const templates = {
			...sample,
			templates: {
				...sample.templates,
				async list() {
					libraries += 1;
					libraryStarted.resolve();
					await libraryGate.promise;
					return sample.templates.list();
				}
			}
		};
		const port = createLiveEmbedsPagePort({
			release: createReleaseWorkspacePort(release),
			templates
		});
		const targets = port.embeds.targets();
		const speakers = port.embeds.speakerTargets();
		const library = port.templates.list();
		await Promise.all([overviewStarted.promise, libraryStarted.promise]);
		expect(overviews).toBe(1);
		expect(libraries).toBe(1);
		overviewGate.resolve();
		libraryGate.resolve();
		expect((await targets).length).toBeGreaterThan(0);
		expect((await speakers).length).toBeGreaterThan(0);
		expect((await library).surfaces.length).toBeGreaterThan(0);
		expect(overviews).toBe(1);
		expect(libraries).toBe(1);
	});

	test('catalogues only released facts and commits the surface-head allowlist', async () => {
		let state = releaseState();
		const mutations: ReleaseAuthorInput[] = [];
		const mutationKeys: ReleaseMutationKeys[] = [];
		const release: ReleaseLiveClient = {
			...unreviewed,
			async overview() {
				return { kind: 'success', data: state, correlationId: 'overview-correlation' };
			},
			async mutate(input, keys) {
				mutations.push(input);
				mutationKeys.push(keys);
				if (input.action !== 'surface_allowlist') throw new Error('unexpected action');
				const before = state.surfaceHeads.find((entry) => entry.kind === input.kind)!;
				const after = {
					...before,
					version: before.version + 1,
					allowedFrameOrigins: [...input.allowedFrameOrigins],
					updatedAt: '2026-08-15T08:01:00.000Z'
				};
				state = releaseOverviewSchema.parse({
					...state,
					surfaceHeads: state.surfaceHeads.map((entry) => entry.kind === input.kind ? after : entry)
				});
				return {
					kind: 'success',
					data: {
						mutation: { action: 'surface_allowlist', head: after },
						safeDiff: releaseSafeDiffSchema.parse({
							action: 'surface_allowlist', kind: input.kind, before, after
						})
					},
					correlationId: 'mutation-correlation'
				};
			}
		};
		const port = createLiveEmbedsPagePort({
			release: createReleaseWorkspacePort(release),
			templates: createSampleTemplatesPagePort(sampleWorkspaceGateway.api)
		});

		const initial = await port.embeds.targets();
		expect(initial.map((entry) => [entry.scope.kind, entry.count])).toEqual([
			['all', 1],
			['all', 1],
			['category', 1]
		]);
		expect(initial.every((entry) => entry.allowedOrigins.length === 0)).toBe(true);
		expect(await port.embeds.speakerTargets()).toEqual([
			expect.objectContaining({
				key: expect.stringContaining(`:speaker:${id(42)}`),
				scope: { kind: 'speaker', speakerId: id(42) },
				name: 'Released Speaker',
				count: 1
			})
		]);

		expect(await port.embeds.setAllowedOrigins('speaker-roster', ['https://host.example'])).toEqual({ ok: true });
		expect(mutations).toEqual([{
			action: 'surface_allowlist', kind: 'speakers',
			allowedFrameOrigins: ['https://host.example'], expectedSurfaceHeadVersion: 1
		}]);
		expect(mutationKeys).toHaveLength(1);
		expect(mutationKeys[0]?.draft).not.toBe(mutationKeys[0]?.publish);
		const refreshed = await port.embeds.targets();
		expect(refreshed.find((entry) => entry.kind === 'speaker-roster')?.allowedOrigins)
			.toEqual(['https://host.example']);
	});

	test('keeps indexing disabled until its canonical publication setting exists', async () => {
		const release: ReleaseLiveClient = {
			...unreviewed,
			async overview() { return { kind: 'success', data: releaseState(), correlationId: 'read' }; },
			async mutate() { throw new Error('not used'); }
		};
		const port = createLiveEmbedsPagePort({
			release: createReleaseWorkspacePort(release),
			templates: createSampleTemplatesPagePort(sampleWorkspaceGateway.api)
		});
		expect(await port.settings.get()).toEqual({
			publicIndexing: false,
			publicIndexingEditable: false,
			publicIndexingReason: 'Search indexing stays off until publication settings own this choice.'
		});
	});
});
