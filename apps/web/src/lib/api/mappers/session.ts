import type {
	SessionCatalogDto,
	SessionDraftData,
	SessionHeadDto
} from '@jooevents/contracts/sessions';
import type {
	SessionCatalogView,
	SessionChangeCommittedView,
	SessionDraftView,
	SessionHeadView,
	SessionView
} from '../view-models/session';

function freezeJson(value: unknown): void {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freezeJson(child);
	Object.freeze(value);
}

/**
 * Severs mutable wire aliases without translating canonical absence into a UI
 * guess. Contract additions are kept by value and by type instead of being
 * silently dropped.
 */
function immutableCopy<Value>(value: Value): SessionView<Value> {
	const copy = structuredClone(value);
	freezeJson(copy);
	return copy as SessionView<Value>;
}

export function mapSessionHead(head: SessionHeadDto): SessionHeadView {
	return immutableCopy(head);
}

export function mapSessionCatalog(catalog: SessionCatalogDto): SessionCatalogView {
	return immutableCopy(catalog);
}

export function mapSessionDraft(draft: SessionDraftData): SessionDraftView {
	return immutableCopy(draft);
}

export function mapSessionChangeCommit(input: {
	readonly draft: SessionDraftData;
	readonly proposedHeadVersion: number;
	readonly committedHeadVersion: number;
}): SessionChangeCommittedView {
	const draft = mapSessionDraft(input.draft);
	const session = draft.safeDiff.after;
	if (draft.safeDiff.action !== draft.action || session === null) {
		throw new TypeError('Session change commit has no resulting session head.');
	}
	return Object.freeze({
		action: draft.action,
		selector: Object.freeze({
			changesetId: draft.changesetId,
			revisionId: draft.revision.id,
			revisionDigest: draft.revision.digestSha256
		}),
		changesetHead: Object.freeze({
			proposedVersion: input.proposedHeadVersion,
			committedVersion: input.committedHeadVersion
		}),
		session,
		safeDiff: draft.safeDiff
	});
}
