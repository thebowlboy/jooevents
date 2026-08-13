import { createContext } from 'svelte';

export type WorkspaceApi = typeof import('./workspace').api;

export interface SampleWorkspaceSource {
	readonly kind: 'sample';
	readonly scenario: {
		readonly key: string;
		readonly name: string;
		readonly description: string;
	};
}

/**
 * A live source identifies only the authenticated workspace it is scoped to.
 * Event identity remains canonical server state and is resolved through the
 * Event operation instead of being copied into gateway composition metadata.
 */
export interface LiveWorkspaceSource {
	readonly kind: 'live';
	readonly workspaceId: string;
}

export type WorkspaceSource = SampleWorkspaceSource | LiveWorkspaceSource;

/**
 * Whose authority the workspace is being rendered under. Surfaces read this
 * projection instead of inferring a role from the data they were handed; a
 * reviewer projection names the roster entry it speaks for.
 */
export type WorkspaceViewer =
	| { readonly kind: 'organizer' }
	| { readonly kind: 'reviewer'; readonly reviewerId: string };

/**
 * Source-neutral gateway envelope. `Api` may be one coherently closed feature
 * slice while it is being built; only a gateway carrying the complete
 * `WorkspaceApi` is eligible for the shared tuned workspace context below.
 */
export interface WorkspaceGatewayEnvelope<
	Api extends object,
	Source extends WorkspaceSource
> {
	readonly api: Api;
	readonly source: Source;
	readonly viewer: WorkspaceViewer;
}

/** The shared workspace context requires the complete browser API contract. */
export type WorkspaceGateway = WorkspaceGatewayEnvelope<WorkspaceApi, SampleWorkspaceSource>;

/** A live gateway over either a feature slice or, after closure, the complete API. */
export type LiveWorkspaceGateway<Api extends object> = WorkspaceGatewayEnvelope<
	Api,
	LiveWorkspaceSource
>;

/**
 * Builds honest live gateway metadata without importing sample scenarios or
 * manufacturing an Event scope. This does not mount the gateway into Svelte;
 * composition does that only after its rendered consumer API is complete.
 */
export function createLiveWorkspaceGateway<Api extends object>(input: {
	readonly api: Api;
	readonly workspaceId: string;
	readonly viewer: WorkspaceViewer;
}): LiveWorkspaceGateway<Api> {
	return Object.freeze({
		api: input.api,
		source: Object.freeze({ kind: 'live' as const, workspaceId: input.workspaceId }),
		viewer: Object.freeze({ ...input.viewer })
	});
}

export const [useWorkspaceGateway, setWorkspaceGateway] = createContext<WorkspaceGateway>();
