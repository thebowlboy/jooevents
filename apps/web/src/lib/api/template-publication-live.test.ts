import { describe, expect, test } from 'bun:test';
import type { ReleaseAuthorInput, ReleaseOverviewDto, TemplateArtifactSnapshotDto } from '@jooevents/contracts';
import type { OrganizerFormsPort } from './view-models/intake-forms';
import type { ReleaseLiveClient } from './operations/release-live';
import type { TemplateArtifactLiveClient } from './operations/template-artifacts-live';
import { createTemplatePublicationLivePort } from './template-publication-live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const digest = (value: string) => value.repeat(64);
const scope = { workspaceId: id(1), eventId: id(2) };

function snapshot(input: {
	readonly artifactId: string;
	readonly revisionId: string;
	readonly document: TemplateArtifactSnapshotDto['current']['document'];
}): TemplateArtifactSnapshotDto {
	const current = {
		schemaVersion: 1 as const,
		scope,
		artifactId: input.artifactId,
		revisionId: input.revisionId,
		number: 1,
		predecessor: null,
		document: input.document,
		author: 'system' as const,
		note: 'Starter',
		createdByUserId: id(3),
		createdAt: '2026-08-15T00:00:00.000Z',
		digestSha256: digest('a')
	};
	return {
		head: {
			schemaVersion: 1, scope, artifactId: input.artifactId,
			artifactKind: input.document.kind,
			currentRevisionId: input.revisionId,
			currentRevisionNumber: 1,
			version: 1
		},
		current,
		history: [current]
	} as TemplateArtifactSnapshotDto;
}

describe('live Template publication bridge', () => {
	test('publishes exact current theme and surface pins through reviewed release operations', async () => {
		const theme = snapshot({
			artifactId: id(10), revisionId: id(11),
			document: {
				kind: 'theme', markText: 'JE',
				recipe: {
					name: 'Warm', canvas: '#faf8f5', surface: '#ffffff', text: '#2a2522',
					action: '#b05a4f', radius: 6, controlHeight: 36
				}
			}
		});
		const surface = snapshot({
			artifactId: id(20), revisionId: id(21),
			document: {
				kind: 'surface', surfaceKind: 'schedule', name: 'Schedule', purpose: 'Public programme.',
				blocks: [{ type: 'hero', title: '  Event schedule  ', intro: 'Find every session.' }],
				usedBy: []
			}
		});
		const calls: ReleaseAuthorInput[] = [];
		let overview: ReleaseOverviewDto = {
			schemaVersion: 1, scope, currentProgramRelease: null, currentStyleSetRelease: null,
			surfaceHeads: [], activeSurfaceReleases: []
		};
		const release = {
			async overview() { return { kind: 'success', data: overview, correlationId: id(90) }; },
			async mutate(input: ReleaseAuthorInput) {
				calls.push(input);
				if (input.action === 'style_set_publish') return {
					kind: 'success', correlationId: id(90), data: {
						committedHeadVersion: 3,
						safeDiff: {
							action: 'style_set_publish', before: null,
							after: { releaseId: id(30), number: 1, digestSha256: digest('b') },
							sourceTemplateRevision: input.sourceTemplateRevision,
							recipe: input.recipe
						}
					}
				};
				if (input.action !== 'surface_publish') throw new Error('unexpected release action');
				overview = {
					...overview,
					surfaceHeads: [{
						schemaVersion: 1, scope, kind: input.kind, activeReleaseId: id(31), version: 1,
						allowedFrameOrigins: [], updatedByUserId: id(3), updatedAt: '2026-08-15T00:00:00.000Z'
					}],
					activeSurfaceReleases: [{
						kind: 'schedule', schemaVersion: 1, scope, id: id(31), number: 1,
						predecessor: null, sourceTemplateRevision: input.sourceTemplateRevision,
						manifest: input.manifest, styleSetReleaseId: input.styleSetReleaseId,
						releasedByUserId: id(3), releasedAt: '2026-08-15T00:00:00.000Z', digestSha256: digest('c')
					}]
				};
				return {
					kind: 'success', correlationId: id(90), data: {
						committedHeadVersion: 3,
						safeDiff: {
							action: 'surface_publish', kind: input.kind, before: null,
							after: overview.surfaceHeads[0]!,
							sourceTemplateRevision: input.sourceTemplateRevision,
							styleSetReleaseId: input.styleSetReleaseId, formRef: null
						}
					}
				};
			}
		} as unknown as ReleaseLiveClient;
		const artifacts = {
			async list() { return { kind: 'success', data: [theme, surface], correlationId: id(90) }; }
		} as unknown as TemplateArtifactLiveClient;
		const forms = { source: { kind: 'live' } } as unknown as OrganizerFormsPort;
		const port = createTemplatePublicationLivePort({ artifacts, release, forms });

		expect(await port.publish(surface.head.artifactId)).toEqual({ ok: true });
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({
			action: 'style_set_publish',
			sourceTemplateRevision: { artifactId: theme.head.artifactId, revisionId: theme.current.revisionId },
			recipe: theme.current.document.kind === 'theme' ? theme.current.document.recipe : undefined
		});
		expect(calls[1]).toMatchObject({
			action: 'surface_publish', kind: 'schedule', styleSetReleaseId: id(30),
			sourceTemplateRevision: { artifactId: surface.head.artifactId, revisionId: surface.current.revisionId },
			manifest: { schemaVersion: 1, heading: 'Event schedule', intro: 'Find every session.' }
		});
		expect(await port.status(surface.head.artifactId)).toEqual({
			state: 'published', publishedRevisionNumber: 1
		});
	});
});
