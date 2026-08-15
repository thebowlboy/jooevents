import type { ReleaseOverviewDto, SurfaceHeadDto, SurfaceKind as ReleaseSurfaceKind } from '@jooevents/contracts';
import type { EmbedsPagePort } from './embeds-page-port';
import { ReleaseWorkspaceError, type ReleaseWorkspacePort } from './release-workspace-adapter';
import type { TemplatesPagePort } from './templates-page-port';
import type { EmbedTarget, MutationOutcome, SurfaceKind } from './types';

export class EmbedsPageLiveError extends ReleaseWorkspaceError {}

const RELEASE_KIND: Readonly<Record<SurfaceKind, ReleaseSurfaceKind>> = Object.freeze({
	schedule: 'schedule',
	'speaker-roster': 'speakers',
	'application-form': 'apply'
});

function head(overview: ReleaseOverviewDto, kind: ReleaseSurfaceKind): SurfaceHeadDto | undefined {
	return overview.surfaceHeads.find((entry) => entry.kind === kind);
}

/**
 * Release-backed adapter for the refined Embeds surface.
 *
 * The catalogue contains only active surface releases. Its counts come from
 * the immutable program/form pins those releases serve, never from a mutable
 * organizer table or from sample data. Individual and grouped speaker embeds
 * stay absent until their canonical public-lineup identity owner exists.
 */
export function createLiveEmbedsPagePort(input: {
	readonly release: ReleaseWorkspacePort;
	readonly templates: TemplatesPagePort;
}): EmbedsPagePort {
	async function overview(): Promise<ReleaseOverviewDto> {
		return input.release.overview();
	}

	async function targets(): Promise<EmbedTarget[]> {
		const [state, library, forms] = await Promise.all([
			overview(),
			input.templates.templates.list(),
			input.templates.forms.list()
		]);
		const targets: EmbedTarget[] = [];
		const surfaceFor = (kind: SurfaceKind) =>
			library.surfaces.find((surface) => surface.kind === kind);

		const program = state.currentProgramRelease;
		const scheduleHead = head(state, 'schedule');
		const scheduleSurface = surfaceFor('schedule');
		if (program && scheduleHead && scheduleSurface) {
			const sessions = program.sessions.filter((session) => session.occurrences.length > 0).length;
			targets.push({
				key: scheduleSurface.id,
				surfaceId: scheduleSurface.id,
				kind: 'schedule',
				scope: { kind: 'all' },
				name: 'The programme',
				purpose: 'Every session in the latest published programme, with its released times and rooms.',
				count: sessions,
				countNoun: 'session',
				acceptsSubmissions: false,
				allowedOrigins: [...scheduleHead.allowedFrameOrigins]
			});
		}

		const speakersHead = head(state, 'speakers');
		const speakersSurface = surfaceFor('speaker-roster');
		if (program && speakersHead && speakersSurface) {
			targets.push({
				key: speakersSurface.id,
				surfaceId: speakersSurface.id,
				kind: 'speaker-roster',
				scope: { kind: 'all' },
				name: 'The whole lineup',
				purpose: 'Everyone named in the latest published programme, joined to their released sessions.',
				count: program.nameDeclassifications.length,
				countNoun: 'speaker',
				acceptsSubmissions: false,
				allowedOrigins: [...speakersHead.allowedFrameOrigins]
			});
		}

		const applyHead = head(state, 'apply');
		const applyRelease = state.activeSurfaceReleases.find((release) => release.kind === 'apply');
		const applySurface = surfaceFor('application-form');
		if (applyHead && applyRelease?.kind === 'apply' && applySurface) {
			const form = forms.find((entry) => entry.id === applyRelease.formRef.formId);
			if (form) targets.push({
				key: `${applySurface.id}:form:${form.id}`,
				surfaceId: applySurface.id,
				kind: 'application-form',
				scope: { kind: 'form', formId: form.id },
				name: form.name,
				purpose: form.status === 'open'
					? 'The exact published form this public surface accepts.'
					: `Currently ${form.status}: visitors are told it is not taking applications.`,
				count: form.fieldCount,
				countNoun: 'question',
				acceptsSubmissions: true,
				allowedOrigins: [...applyHead.allowedFrameOrigins]
			});
		}
		return targets;
	}

	return Object.freeze({
		embeds: Object.freeze({
			targets,
			async speakerTargets(): Promise<EmbedTarget[]> {
				// A released public speaker card intentionally carries no person id.
				// Until the lineup owner mints one, an individual address cannot be
				// represented without leaking an organizer identity or inventing one.
				return [];
			},
			async setAllowedOrigins(kind: SurfaceKind, origins: readonly string[]): Promise<MutationOutcome> {
				return input.release.setAllowedOrigins(RELEASE_KIND[kind], origins);
			}
		}),
		templates: Object.freeze({
			async list() {
				const library = await input.templates.templates.list();
				return { surfaces: library.surfaces };
			}
		}),
		theme: input.templates.theme,
		workspace: input.templates.workspace,
		settings: Object.freeze({
			async get() {
				return {
					publicIndexing: false,
					publicIndexingEditable: false,
					publicIndexingReason: 'Search indexing stays off until publication settings own this choice.'
				};
			},
			async update() {
				throw new EmbedsPageLiveError({
					code: 'public_indexing_unavailable',
					reason: 'Search indexing is not available until publication settings own this choice.'
				});
			}
		}),
		schedule: input.templates.schedule,
		vocab: input.templates.vocab,
		speakers: input.templates.speakers,
		forms: input.templates.forms
	});
}
