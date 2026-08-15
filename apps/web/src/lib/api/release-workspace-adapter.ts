import type { ReleaseOverviewDto, SurfaceKind } from '@jooevents/contracts';
import type { ReleaseLiveClient, ReleaseLiveResult } from './operations/release-live';
import type { MutationOutcome } from './types';

type Failure = Readonly<{ code: string; reason: string }>;

export class ReleaseWorkspaceError extends Error {
	readonly code: string;
	constructor(failure: Failure) {
		super(failure.reason);
		this.name = 'ReleaseWorkspaceError';
		this.code = failure.code;
	}
}

function failure(result: Exclude<ReleaseLiveResult<unknown>, { readonly kind: 'success' }>): Failure {
	if (result.kind === 'unavailable') return {
		code: result.reason,
		reason: 'Publication is not available in this live workspace.'
	};
	if (result.kind === 'transport_error') return {
		code: result.error.code,
		reason: result.error.retryable
			? 'Publication state could not be reached. Try again.'
			: 'This publication request is not valid.'
	};
	if (result.outcome.class === 'access_denied') return {
		code: result.outcome.kind,
		reason: 'You no longer have permission to manage publication.'
	};
	if (result.outcome.class === 'stale_revision' || result.outcome.class === 'conflict') return {
		code: result.outcome.kind,
		reason: 'Publication changed while you were working. Reload and try again.'
	};
	return { code: result.outcome.kind, reason: 'This publication change could not be applied.' };
}

function idempotencyKey(): string {
	return `je.release.surface-allowlist.${globalThis.crypto.randomUUID()}`;
}

/** One browser projection of the canonical release owner, shared by operator areas. */
export interface ReleaseWorkspacePort {
	overview(): Promise<ReleaseOverviewDto>;
	setAllowedOrigins(kind: SurfaceKind, origins: readonly string[]): Promise<MutationOutcome>;
}

export function createReleaseWorkspacePort(client: ReleaseLiveClient): ReleaseWorkspacePort {
	async function overview(): Promise<ReleaseOverviewDto> {
		const result = await client.overview();
		if (result.kind === 'success') return result.data;
		throw new ReleaseWorkspaceError(failure(result));
	}

	return Object.freeze({
		overview,
		async setAllowedOrigins(kind: SurfaceKind, origins: readonly string[]): Promise<MutationOutcome> {
			const state = await overview();
			const current = state.surfaceHeads.find((entry) => entry.kind === kind);
			if (!current) return { ok: false, reason: 'Publish this page before naming sites that may embed it.' };
			const result = await client.mutate({
				action: 'surface_allowlist',
				kind,
				allowedFrameOrigins: [...origins],
				expectedSurfaceHeadVersion: current.version
			}, idempotencyKey());
			return result.kind === 'success'
				? { ok: true }
				: { ok: false, reason: failure(result).reason };
		}
	});
}
