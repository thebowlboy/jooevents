import type { TemplateArtifactDocumentDto, TemplateArtifactSnapshotDto } from '@jooevents/contracts';
import { projectApplicationForm } from './fields';
import type { TemplatesPagePort } from './templates-page-port';
import type {
	AnyTemplate,
	EditClassification,
	EventTheme,
	FormSummary,
	ModelChoice,
	MutationOutcome,
	PublicSpeakerCard,
	RegistryField,
	ReviseProgress,
	ScheduleState,
	SpeakerCategory,
	SpeakerRow,
	SurfaceTemplate,
	MessageTemplate,
	Track
} from './types';
import type {
	TemplateArtifactLiveClient,
	TemplateArtifactLiveResult
} from './operations/template-artifacts-live';

export interface TemplateModelDraftPort {
	choices(): Promise<ModelChoice[]>;
	classify(artifactId: string, instruction: string, modelId?: string): Promise<EditClassification>;
	revise(
		artifactId: string,
		instruction: string,
		onProgress?: (progress: ReviseProgress) => void,
		modelId?: string
	): Promise<{ readonly document: TemplateArtifactDocumentDto; readonly note: string }>;
}

type Failure = Readonly<{ code: string; reason: string }>;
export class TemplatesPageLiveError extends Error {
	readonly code: string;
	constructor(failure: Failure) {
		super(failure.reason);
		this.name = 'TemplatesPageLiveError';
		this.code = failure.code;
	}
}

function failure(result: Exclude<TemplateArtifactLiveResult<unknown>, { readonly kind: 'success' }>): Failure {
	if (result.kind === 'unavailable') return {
		code: result.reason,
		reason: 'Template authoring is not available in this live workspace.'
	};
	if (result.kind === 'transport_error') return {
		code: result.error.code,
		reason: result.error.retryable
			? 'Template authoring could not be reached. Try again.'
			: 'This Template request is not valid.'
	};
	if (result.outcome.class === 'stale_revision') return {
		code: result.outcome.kind,
		reason: 'This template changed while you were editing. Reload and try again.'
	};
	if (result.outcome.class === 'access_denied') return {
		code: result.outcome.kind,
		reason: 'You no longer have permission to change this template.'
	};
	return { code: result.outcome.kind, reason: 'This Template change could not be applied.' };
}

function revisions(snapshot: TemplateArtifactSnapshotDto): AnyTemplate['revisions'] {
	return snapshot.history.map((revision) => ({
		number: revision.number,
		at: revision.createdAt,
		by: revision.author === 'agent' ? 'agent' as const : 'you' as const,
		note: revision.note
	}));
}

function message(snapshot: TemplateArtifactSnapshotDto): MessageTemplate {
	const document = snapshot.current.document;
	if (document.kind !== 'message') throw new TypeError('template_message_kind_mismatch');
	return {
		id: snapshot.head.artifactId,
		key: document.key,
		name: document.name,
		purpose: document.purpose,
		subject: document.subject,
		blocks: document.blocks,
		mergeFields: document.mergeFields,
		revision: snapshot.head.currentRevisionNumber,
		revisions: revisions(snapshot),
		usedBy: document.usedBy
	};
}

function surface(snapshot: TemplateArtifactSnapshotDto, fields: RegistryField[]): SurfaceTemplate {
	const document = snapshot.current.document;
	if (document.kind !== 'surface') throw new TypeError('template_surface_kind_mismatch');
	const mapped: SurfaceTemplate = {
		id: snapshot.head.artifactId,
		kind: document.surfaceKind,
		name: document.name,
		purpose: document.purpose,
		blocks: document.blocks,
		...(document.submitLabel === undefined ? {} : { submitLabel: document.submitLabel }),
		revision: snapshot.head.currentRevisionNumber,
		revisions: revisions(snapshot),
		usedBy: document.usedBy
	};
	return projectApplicationForm(mapped, fields);
}

function document(template: AnyTemplate): TemplateArtifactDocumentDto {
	if ('kind' in template) return {
		kind: 'surface', surfaceKind: template.kind, name: template.name,
		purpose: template.purpose, blocks: template.blocks,
		...(template.submitLabel === undefined ? {} : { submitLabel: template.submitLabel }),
		usedBy: template.usedBy
	};
	return {
		kind: 'message', key: template.key, name: template.name, purpose: template.purpose,
		subject: template.subject, blocks: template.blocks,
		mergeFields: template.mergeFields, usedBy: template.usedBy
	};
}

function idempotencyKey(action: string): string {
	return `je.template.${action}.${globalThis.crypto.randomUUID()}`;
}

/** Maps canonical artifacts and existing joined projections into the frozen tuned Templates port. */
export function createLiveTemplatesPagePort(input: {
	readonly artifacts: TemplateArtifactLiveClient;
	readonly model: TemplateModelDraftPort;
	readonly event: { get(): Promise<null | { readonly name: string; readonly dates: string; readonly location: string }> };
	readonly schedule: { state(): Promise<ScheduleState> };
	readonly vocabulary: { tracks(): Promise<Track[]>; speakerCategories(): Promise<SpeakerCategory[]> };
	readonly speakers: { list(): Promise<SpeakerRow[]> };
	readonly forms: { list(): Promise<FormSummary[]> };
	readonly fields: {
		list(): Promise<RegistryField[]>;
		update(id: string, patch: Partial<RegistryField>): Promise<MutationOutcome>;
		remove(id: string): Promise<MutationOutcome>;
	};
	readonly publication?: NonNullable<TemplatesPagePort['publication']>;
}): TemplatesPagePort {
	async function readArtifacts(): Promise<readonly TemplateArtifactSnapshotDto[]> {
		const result = await input.artifacts.list();
		if (result.kind === 'success') return result.data;
		throw new TemplatesPageLiveError(failure(result));
	}

	async function list() {
		const [artifacts, fields] = await Promise.all([readArtifacts(), input.fields.list()]);
		return {
			messages: artifacts.filter((entry) => entry.head.artifactKind === 'message').map(message),
			surfaces: artifacts
				.filter((entry) => entry.head.artifactKind === 'surface')
				.map((entry) => surface(entry, fields))
		};
	}

	async function current(id: string): Promise<TemplateArtifactSnapshotDto | undefined> {
		return (await readArtifacts()).find((entry) => entry.head.artifactId === id);
	}

	async function mutate(
		id: string,
		create: (snapshot: TemplateArtifactSnapshotDto) => Parameters<TemplateArtifactLiveClient['mutate']>[0]
	): Promise<MutationOutcome> {
		const snapshot = await current(id);
		if (!snapshot) return { ok: false, reason: 'This template no longer exists.' };
		const result = await input.artifacts.mutate(create(snapshot), idempotencyKey('change'));
		return result.kind === 'success' ? { ok: true } : { ok: false, reason: failure(result).reason };
	}

	return Object.freeze({
		templates: Object.freeze({
			list,
			modelChoices: () => input.model.choices(),
			classify: (id: string, instruction: string, modelId?: string) =>
				input.model.classify(id, instruction, modelId),
			async revise(
				id: string,
				instruction: string,
				onProgress?: (progress: ReviseProgress) => void,
				modelId?: string
			) {
				const snapshot = await current(id);
				if (!snapshot) throw new TemplatesPageLiveError({ code: 'not_found', reason: 'This template no longer exists.' });
				const candidate = await input.model.revise(id, instruction, onProgress, modelId);
				const base = snapshot.head.artifactKind === 'message'
					? message(snapshot)
					: surface(snapshot, await input.fields.list());
				let draft: AnyTemplate;
				if (candidate.document.kind === 'message') {
					draft = {
						...base,
						key: candidate.document.key,
						name: candidate.document.name,
						purpose: candidate.document.purpose,
						subject: candidate.document.subject,
						blocks: candidate.document.blocks,
						mergeFields: candidate.document.mergeFields,
						usedBy: candidate.document.usedBy
					} as MessageTemplate;
				} else {
					const candidateSurface = candidate.document as Extract<
						TemplateArtifactDocumentDto,
						{ readonly kind: 'surface' }
					>;
					draft = {
						...base,
						kind: candidateSurface.surfaceKind,
						name: candidateSurface.name,
						purpose: candidateSurface.purpose,
						blocks: candidateSurface.blocks,
						...(candidateSurface.submitLabel === undefined
							? {} : { submitLabel: candidateSurface.submitLabel }),
						usedBy: candidateSurface.usedBy
					} as SurfaceTemplate;
				}
				return {
					draft: {
						...draft,
						revision: base.revision + 1,
						revisions: [...base.revisions, {
							number: base.revision + 1, at: 'Just now', by: 'agent', note: candidate.note
						}]
					} as AnyTemplate,
					note: candidate.note
				};
			},
			applyRevision(id: string, draft: AnyTemplate) {
				return mutate(id, (snapshot) => ({
					action: 'replace', artifactId: id,
					expectedRevisionNumber: snapshot.head.currentRevisionNumber,
					document: document(draft), author: 'agent',
					note: draft.revisions.at(-1)?.note ?? 'Applied an assisted revision.'
				}));
			},
			commitInline(id: string, next: AnyTemplate, note: string) {
				return mutate(id, (snapshot) => ({
					action: 'replace', artifactId: id,
					expectedRevisionNumber: snapshot.head.currentRevisionNumber,
					document: document(next), author: 'organizer', note
				}));
			},
			revertTo(id: string, revisionNumber: number) {
				return mutate(id, (snapshot) => ({
					action: 'revert', artifactId: id,
					expectedRevisionNumber: snapshot.head.currentRevisionNumber,
					targetRevisionNumber: revisionNumber
				}));
			}
		}),
		theme: Object.freeze({
			async get(): Promise<EventTheme> {
				const theme = (await readArtifacts()).find((entry) => entry.head.artifactKind === 'theme');
				if (!theme || theme.current.document.kind !== 'theme') {
					throw new TemplatesPageLiveError({ code: 'theme_missing', reason: 'The event brand is not available.' });
				}
				return { ...theme.current.document.recipe, markText: theme.current.document.markText };
			},
			async set(theme: EventTheme) {
				const artifact = (await readArtifacts()).find((entry) => entry.head.artifactKind === 'theme');
				if (!artifact) throw new TemplatesPageLiveError({ code: 'theme_missing', reason: 'The event brand is not available.' });
				const result = await input.artifacts.mutate({
					action: 'replace', artifactId: artifact.head.artifactId,
					expectedRevisionNumber: artifact.head.currentRevisionNumber,
					document: { kind: 'theme', recipe: {
						name: theme.name, canvas: theme.canvas, surface: theme.surface,
						text: theme.text, action: theme.action, radius: theme.radius,
						controlHeight: theme.controlHeight
					}, markText: theme.markText },
					author: 'organizer', note: `Saved the event brand “${theme.name}”.`
				}, idempotencyKey('theme'));
				if (result.kind !== 'success') throw new TemplatesPageLiveError(failure(result));
			}
		}),
		...(input.publication === undefined ? {} : { publication: input.publication }),
		workspace: Object.freeze({ async summary() { return { event: await input.event.get() }; } }),
		schedule: input.schedule,
		vocab: input.vocabulary,
		speakers: Object.freeze({
			async publicRoster(): Promise<PublicSpeakerCard[]> {
				return (await input.speakers.list())
					.filter((speaker) => speaker.publiclyVisible)
					.sort((left, right) => left.position - right.position)
					.map((speaker) => ({
						id: speaker.id, name: speaker.name, links: [], sessions: speaker.sessions,
						...(speaker.categoryId === undefined ? {} : { categoryId: speaker.categoryId }),
						provisional: !speaker.contentApproved
					}));
			}
		}),
		forms: input.forms,
		fields: input.fields
	});
}
