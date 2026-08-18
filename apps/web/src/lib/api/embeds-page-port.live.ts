import type {
	ProgramReleaseDto,
	ReleaseOverviewDto,
	SurfaceHeadDto,
	SurfaceKind as ReleaseSurfaceKind
} from '@jooevents/contracts';
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
 * The catalogue contains only active surface releases. Its counts, group
 * scopes, and opaque individual-speaker scopes come from the immutable
 * program/form pins those releases serve, never from a mutable organizer table
 * or from sample data.
 */
export function createLiveEmbedsPagePort(input: {
	readonly release: ReleaseWorkspacePort;
	readonly templates: TemplatesPagePort;
}): EmbedsPagePort {
	async function overview(): Promise<ReleaseOverviewDto> {
		return input.release.overview();
	}

	function releasedSpeakerCards(program: ProgramReleaseDto) {
		const lineup = program.speakerLineup;
		if (!lineup) return [];
		return lineup.entries.flatMap((entry) => {
			if (!entry.publiclyVisible || entry.displayName === null) return [];
			const sessions = program.sessions.flatMap((session) =>
				session.participants.some((participant) => participant.personId === entry.personId)
					? [{ id: session.sessionId, title: session.title }]
					: []
			);
			return [{
				id: entry.speakerId,
				name: entry.displayName,
				categoryId: entry.categoryId,
				sessions
			}];
		});
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
			const cards = releasedSpeakerCards(program);
			targets.push({
				key: speakersSurface.id,
				surfaceId: speakersSurface.id,
				kind: 'speaker-roster',
				scope: { kind: 'all' },
				name: 'The whole lineup',
				purpose: 'Everyone named in the latest published programme, joined to their released sessions.',
				count: cards.length,
				countNoun: 'speaker',
				acceptsSubmissions: false,
				allowedOrigins: [...speakersHead.allowedFrameOrigins]
			});
			for (const category of program.speakerLineup?.categories ?? []) {
				targets.push({
					key: `${speakersSurface.id}:category:${category.id}`,
					surfaceId: speakersSurface.id,
					kind: 'speaker-roster',
					scope: { kind: 'category', categoryId: category.id },
					name: category.name,
					purpose: `Only the people filed under ${category.name}.`,
					count: cards.filter((card) => card.categoryId === category.id).length,
					countNoun: 'speaker',
					acceptsSubmissions: false,
					allowedOrigins: [...speakersHead.allowedFrameOrigins]
				});
			}
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
				const [state, library] = await Promise.all([
					overview(),
					input.templates.templates.list()
				]);
				const program = state.currentProgramRelease;
				const speakersHead = head(state, 'speakers');
				const surface = library.surfaces.find((entry) => entry.kind === 'speaker-roster');
				if (!program || !speakersHead || !surface) return [];
				return releasedSpeakerCards(program).map((card) => ({
					key: `${surface.id}:speaker:${card.id}`,
					surfaceId: surface.id,
					kind: 'speaker-roster',
					scope: { kind: 'speaker', speakerId: card.id },
					name: card.name,
					purpose: 'Their published lineup card and any released session appearances.',
					count: card.sessions.length,
					countNoun: 'session',
					acceptsSubmissions: false,
					allowedOrigins: [...speakersHead.allowedFrameOrigins]
				}));
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
