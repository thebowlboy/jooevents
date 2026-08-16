import type {
	SessionCatalogDto,
	SessionDirectResult,
	SessionHeadDto
} from '@jooevents/contracts/sessions';
import type {
	SessionCatalogView,
	SessionChangeCommittedView,
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

export function mapSessionChangeResult(result: SessionDirectResult): SessionChangeCommittedView {
	return immutableCopy(result);
}
