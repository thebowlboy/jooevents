/**
 * Aggregate closures exposed to the operator workspace.
 *
 * These are product-data closures, not routes. A route may depend on more than
 * one closure, but it must never choose a different source for one of them.
 * Extending this list changes the source-selection contract for the workspace.
 */
export const workspaceCapabilityIds = Object.freeze([
	'workspace_shell',
	'event',
	'program_vocabulary',
	'schedule',
	'forms_submissions',
	'review_decisions',
	'speaker_operations',
	'templates_surfaces',
	'communications'
] as const);

export type WorkspaceCapabilityId = (typeof workspaceCapabilityIds)[number];

export type WorkspaceCapabilitySource = 'sample' | 'live';
export type WorkspaceCompositionKind = 'sample' | 'live' | 'bridge';

/**
 * A product-safe reason/remedy pair. Detailed manifest, transport, provider, or
 * server diagnostics stop below this boundary and are never rendered as copy.
 */
export type WorkspaceCapabilityUnavailable =
	| {
			readonly kind: 'unavailable';
			readonly reason: 'not_enabled';
			readonly remedy: 'return_to_overview';
	  }
	| {
			readonly kind: 'unavailable';
			readonly reason: 'temporarily_unavailable';
			readonly remedy: 'retry';
	  };

/**
 * Prerequisite locks describe missing live product state. If an aggregate has
 * no installed implementation, `unavailable` takes precedence.
 */
export type WorkspaceCapabilityPrerequisiteLocked = {
	readonly kind: 'prerequisite_locked';
	readonly prerequisite: 'current_event';
	readonly reason: 'current_event_required';
	readonly remedy: 'create_event';
};

/**
 * Only an available capability carries a callable port. Unavailable and locked
 * states deliberately cannot contain an API, empty rows, or a throwing stub.
 */
export type WorkspaceCapabilityAvailable<
	Port,
	Source extends WorkspaceCapabilitySource = WorkspaceCapabilitySource
> = {
	readonly kind: 'available';
	readonly source: Source;
	readonly port: Port;
};

export type WorkspaceCapabilityState<
	Port,
	Source extends WorkspaceCapabilitySource = WorkspaceCapabilitySource
> =
	| WorkspaceCapabilityAvailable<Port, Source>
	| WorkspaceCapabilityUnavailable
	| WorkspaceCapabilityPrerequisiteLocked;

/**
 * A concrete composition supplies the exact port type for every aggregate.
 * There is intentionally no default `unknown` port catalog: callers cannot
 * make a capability available without naming the interface it actually serves.
 */
export type WorkspaceCapabilityPortCatalog = Readonly<
	Record<WorkspaceCapabilityId, unknown>
>;

type SourceForComposition<Kind extends WorkspaceCompositionKind> =
	Kind extends 'sample'
		? 'sample'
		: Kind extends 'live'
			? 'live'
			: WorkspaceCapabilitySource;

export type WorkspaceCapabilityManifest<
	Ports extends WorkspaceCapabilityPortCatalog,
	Kind extends WorkspaceCompositionKind
> = Readonly<{
	[Capability in WorkspaceCapabilityId]: WorkspaceCapabilityState<
		Ports[Capability],
		SourceForComposition<Kind>
	>;
}>;

export interface WorkspaceComposition<
	Ports extends WorkspaceCapabilityPortCatalog,
	Kind extends WorkspaceCompositionKind
> {
	readonly schemaVersion: 1;
	readonly kind: Kind;
	readonly capabilities: WorkspaceCapabilityManifest<Ports, Kind>;
}

/** Port catalog for a composition in which no aggregate is callable yet. */
export type UnavailableWorkspaceCapabilityPorts = Readonly<{
	[Capability in WorkspaceCapabilityId]: never;
}>;
