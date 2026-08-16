import type {
	ReleaseAuthorInput,
	ReleaseOverviewDto,
	ReleaseTemplateRevisionPinDto,
	SurfaceKind,
	TemplateArtifactDocumentDto,
	TemplateArtifactSnapshotDto
} from '@jooevents/contracts';
import type { OrganizerFormsPort } from './view-models/intake-forms';
import type {
	ReleaseMutateClient,
	ReleaseLiveResult,
	ReleaseMutationKeys
} from './operations/release-live';
import type { TemplateArtifactLiveClient, TemplateArtifactLiveResult } from './operations/template-artifacts-live';
import type { MutationOutcome, SurfaceKind as TemplateSurfaceKind } from './types';

const RELEASE_KIND: Readonly<Record<TemplateSurfaceKind, SurfaceKind>> = Object.freeze({
	schedule: 'schedule',
	'speaker-roster': 'speakers',
	'application-form': 'apply'
});

const key = (stage: string) => `je.template.publish.${stage}.${globalThis.crypto.randomUUID()}`;

function releaseKeys(stage: 'style' | 'surface'): ReleaseMutationKeys {
	return Object.freeze({
		draft: key(`${stage}.draft`),
		publish: key(`${stage}.publish`)
	});
}

function releaseFailure(result: Exclude<ReleaseLiveResult<unknown>, { readonly kind: 'success' }>): string {
	if (result.kind === 'unavailable') return 'Publication is not available in this workspace.';
	if (result.kind === 'transport_error') return result.error.retryable
		? 'Publication could not be reached. Try again.'
		: 'This publication request is not valid.';
	if (result.outcome.class === 'stale_revision' || result.outcome.class === 'conflict') {
		return 'The Template or public release changed while you were working. Reload and try again.';
	}
	if (result.outcome.class === 'access_denied') return 'You no longer have permission to publish.';
	return 'This public surface could not be published.';
}

function artifactFailure(
	result: Exclude<TemplateArtifactLiveResult<unknown>, { readonly kind: 'success' }>
): string {
	if (result.kind === 'unavailable') return 'Templates are not available in this workspace.';
	if (result.kind === 'transport_error') return result.error.retryable
		? 'Templates could not be reached. Try again.'
		: 'This Template request is not valid.';
	return result.outcome.class === 'access_denied'
		? 'You no longer have permission to read this Template.'
		: 'The Template changed while publication was being prepared.';
}

function sourcePin(snapshot: TemplateArtifactSnapshotDto): ReleaseTemplateRevisionPinDto {
	return {
		artifactId: snapshot.head.artifactId,
		revisionId: snapshot.current.revisionId,
		revisionNumber: snapshot.current.number,
		digestSha256: snapshot.current.digestSha256
	};
}

function samePin(
	left: ReleaseTemplateRevisionPinDto,
	right: ReleaseTemplateRevisionPinDto
): boolean {
	return left.artifactId === right.artifactId
		&& left.revisionId === right.revisionId
		&& left.revisionNumber === right.revisionNumber
		&& left.digestSha256 === right.digestSha256;
}

function normalized(value: string): string | null {
	const text = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
	return text.length === 0 ? null : text;
}

function manifest(document: Extract<TemplateArtifactDocumentDto, { readonly kind: 'surface' }>) {
	const hero = document.blocks.find((block) => block.type === 'hero');
	return {
		schemaVersion: 1 as const,
		heading: hero ? normalized(hero.title) : null,
		intro: hero ? normalized(hero.intro) : null
	};
}

/**
 * Explicit Template → immutable public-release bridge. Template edits remain
 * private authoring revisions. A press snapshots the exact current surface
 * and theme revisions; the server re-resolves both pins and derives the same
 * manifest/recipe before either owner-native Release revision may publish.
 */
export function createTemplatePublicationLivePort(input: {
	readonly artifacts: TemplateArtifactLiveClient;
	readonly release: ReleaseMutateClient;
	readonly forms: OrganizerFormsPort;
}) {
	async function artifacts(): Promise<readonly TemplateArtifactSnapshotDto[]> {
		const result = await input.artifacts.list();
		if (result.kind === 'success') return result.data;
		throw new Error(artifactFailure(result));
	}

	async function overview(): Promise<ReleaseOverviewDto> {
		const result = await input.release.overview();
		if (result.kind === 'success') return result.data;
		throw new Error(releaseFailure(result));
	}

	return Object.freeze({
		async status(templateId: string) {
			const [library, state] = await Promise.all([artifacts(), overview()]);
			const template = library.find((entry) => entry.head.artifactId === templateId);
			if (!template || template.current.document.kind !== 'surface') {
				return { state: 'never_published' as const, publishedRevisionNumber: null };
			}
			const kind = RELEASE_KIND[template.current.document.surfaceKind];
			const active = state.activeSurfaceReleases.find((entry) => entry.kind === kind);
			if (!active) return { state: 'never_published' as const, publishedRevisionNumber: null };
			return samePin(active.sourceTemplateRevision, sourcePin(template))
				? { state: 'published' as const, publishedRevisionNumber: active.sourceTemplateRevision.revisionNumber }
				: { state: 'changes_pending' as const, publishedRevisionNumber: active.sourceTemplateRevision.revisionNumber };
		},

		async publish(templateId: string, formId?: string): Promise<MutationOutcome> {
			try {
				const [library, initial] = await Promise.all([artifacts(), overview()]);
				const template = library.find((entry) => entry.head.artifactId === templateId);
				const theme = library.find((entry) => entry.current.document.kind === 'theme');
				if (!template || template.current.document.kind !== 'surface') {
					return { ok: false, reason: 'This public-surface Template no longer exists.' };
				}
				if (!theme || theme.current.document.kind !== 'theme') {
					return { ok: false, reason: 'The event brand is not available.' };
				}

				let styleSetReleaseId = initial.currentStyleSetRelease?.id;
				const themePin = sourcePin(theme);
				if (!initial.currentStyleSetRelease
						|| !samePin(initial.currentStyleSetRelease.sourceTemplateRevision, themePin)) {
					const styleInput: ReleaseAuthorInput = {
						action: 'style_set_publish',
						sourceTemplateRevision: themePin,
						recipe: theme.current.document.recipe,
						expectedCurrentStyleSetNumber: initial.currentStyleSetRelease?.number ?? null
					};
					const publishedStyle = await input.release.mutate(styleInput, releaseKeys('style'));
					if (publishedStyle.kind !== 'success') {
						return { ok: false, reason: releaseFailure(publishedStyle) };
					}
					if (publishedStyle.data.safeDiff.action !== 'style_set_publish') {
						return { ok: false, reason: 'The reviewed brand release did not match this Template.' };
					}
					styleSetReleaseId = publishedStyle.data.safeDiff.after.releaseId;
				}
				if (!styleSetReleaseId) return { ok: false, reason: 'The event brand could not be released.' };

				const kind = RELEASE_KIND[template.current.document.surfaceKind];
				let formRef: null | { readonly formId: string; readonly formVersionId: string } = null;
				if (kind === 'apply') {
					const forms = await input.forms.list();
					if (forms.kind !== 'success') {
						return { ok: false, reason: 'The published Form pin could not be read.' };
					}
					const publishable = forms.data.forms.filter((form) => form.currentPublishedVersionId !== null);
					const selected = formId
						? publishable.find((form) => form.id === formId)
						: publishable.length === 1 ? publishable[0] : undefined;
					if (!selected?.currentPublishedVersionId) return {
						ok: false,
						reason: publishable.length > 1
							? 'Choose the Form this public application should publish, then try again.'
							: 'Publish a Form version before publishing the application surface.'
					};
					formRef = { formId: selected.id, formVersionId: selected.currentPublishedVersionId };
				}

				const current = initial.surfaceHeads.find((entry) => entry.kind === kind);
				const published = await input.release.mutate({
					action: 'surface_publish',
					kind,
					sourceTemplateRevision: sourcePin(template),
					manifest: manifest(template.current.document),
					styleSetReleaseId,
					formRef,
					expectedSurfaceHeadVersion: current?.version ?? null
				}, releaseKeys('surface'));
				return published.kind === 'success'
					? { ok: true }
					: { ok: false, reason: releaseFailure(published) };
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : 'Publication failed.' };
			}
		}
	});
}
