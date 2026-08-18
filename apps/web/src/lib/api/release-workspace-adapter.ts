import type { ReleaseOverviewDto, SurfaceKind } from '@jooevents/contracts';
import type {
	ReleaseLiveClient,
	ReleaseLiveDraftData,
	ReleaseLiveResult,
	ReleaseMutationKeys
} from './operations/release-live';
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

function idempotencyKeys(): ReleaseMutationKeys {
	return Object.freeze({
		draft: `je.release.surface-allowlist.draft.${globalThis.crypto.randomUUID()}`,
		publish: `je.release.surface-allowlist.publish.${globalThis.crypto.randomUUID()}`
	});
}

/**
 * What a person reads before the second press: how much of the programme this
 * release carries, and — the half that is easy to omit — exactly which speaker
 * names the commit copies into public state. A schedule publish is the one
 * release action that discloses people, so the names are the review, not a
 * footnote to it.
 */
export interface SchedulePublicationReview {
	/** The release number this publish would create. */
	readonly releaseNumber: number;
	readonly sessions: number;
	readonly occurrences: number;
	readonly declassifiedNames: readonly string[];
	readonly lineupNames: readonly string[];
	readonly speakerGroups: readonly string[];
	/**
	 * Opaque continuation, handed straight back to `publishSchedule`. The port
	 * that produced a review is the only thing that reads it, so a source with
	 * no server draft behind it simply omits one.
	 */
	readonly continuation?: unknown;
}

/** One browser projection of the canonical release owner, shared by operator areas. */
export interface ReleaseWorkspacePort {
	overview(): Promise<ReleaseOverviewDto>;
	setAllowedOrigins(kind: SurfaceKind, origins: readonly string[]): Promise<MutationOutcome>;
	/** Drafts the next programme release. Nothing is public until it is published. */
	draftSchedulePublication(): Promise<SchedulePublicationReview | { readonly ok: false; readonly reason: string }>;
	/** Publishes exactly the reviewed draft. */
	publishSchedule(review: SchedulePublicationReview): Promise<MutationOutcome>;
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
			}, idempotencyKeys());
			return result.kind === 'success'
				? { ok: true }
				: { ok: false, reason: failure(result).reason };
		},

		async draftSchedulePublication() {
			let state: ReleaseOverviewDto;
			try {
				state = await overview();
			} catch (error) {
				return {
					ok: false as const,
					reason: error instanceof ReleaseWorkspaceError
						? error.message
						: 'Publication state could not be read.'
				};
			}
			const drafted = await client.draft({
				action: 'publish_schedule',
				// Fences the chain: null says "no release yet", and a number says
				// "this exact head". A schedule published from another tab in the
				// meantime lands as a conflict rather than overwriting it.
				expectedCurrentReleaseNumber: state.currentProgramRelease?.number ?? null
			}, `je.release.publish-schedule.draft.${globalThis.crypto.randomUUID()}`);
			if (drafted.kind !== 'success') return { ok: false as const, reason: failure(drafted).reason };
			const diff = drafted.data.safeDiff;
			if (diff.action !== 'publish_schedule') {
				return { ok: false as const, reason: 'The reviewed release did not describe a schedule publication.' };
			}
			return {
				releaseNumber: diff.after.number,
				sessions: diff.releasedSessionCount,
				occurrences: diff.releasedOccurrenceCount,
				declassifiedNames: diff.nameDeclassifications.map((entry) => entry.displayName),
				lineupNames: diff.speakerLineup?.publicSpeakers.map((entry) => entry.name) ?? [],
				speakerGroups: diff.speakerLineup?.categories.map((entry) => entry.name) ?? [],
				continuation: drafted.data
			};
		},

		async publishSchedule(review: SchedulePublicationReview): Promise<MutationOutcome> {
			const drafted = review.continuation as ReleaseLiveDraftData | undefined;
			if (!drafted || drafted.action !== 'publish_schedule') {
				return { ok: false, reason: 'Review this publication again before publishing it.' };
			}
			const result = await client.publishDrafted(
				drafted,
				`je.release.publish-schedule.publish.${globalThis.crypto.randomUUID()}`
			);
			return result.kind === 'success' ? { ok: true } : { ok: false, reason: failure(result).reason };
		}
	});
}
