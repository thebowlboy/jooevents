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
import type { ReleaseLiveClient } from './operations/release-live';
import { createReleaseWorkspacePort } from './release-workspace-adapter';

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
			eventSettingsVersion: 5
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
	test('catalogues only released facts and commits the surface-head allowlist', async () => {
		let state = releaseState();
		const mutations: ReleaseAuthorInput[] = [];
		const release: ReleaseLiveClient = {
			async overview() {
				return { kind: 'success', data: state, correlationId: 'overview-correlation' };
			},
			async mutate(input) {
				mutations.push(input);
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
						safeDiff: releaseSafeDiffSchema.parse({
							action: 'surface_allowlist', kind: input.kind, before, after
						}),
						committedHeadVersion: 1
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
		expect(initial.map((entry) => [entry.kind, entry.count])).toEqual([
			['schedule', 1],
			['speaker-roster', 1]
		]);
		expect(initial.every((entry) => entry.allowedOrigins.length === 0)).toBe(true);
		expect(await port.embeds.speakerTargets()).toEqual([]);

		expect(await port.embeds.setAllowedOrigins('speaker-roster', ['https://host.example'])).toEqual({ ok: true });
		expect(mutations).toEqual([{
			action: 'surface_allowlist', kind: 'speakers',
			allowedFrameOrigins: ['https://host.example'], expectedSurfaceHeadVersion: 1
		}]);
		const refreshed = await port.embeds.targets();
		expect(refreshed.find((entry) => entry.kind === 'speaker-roster')?.allowedOrigins)
			.toEqual(['https://host.example']);
	});

	test('keeps indexing disabled until its canonical publication setting exists', async () => {
		const release: ReleaseLiveClient = {
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
