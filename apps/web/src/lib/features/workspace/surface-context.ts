/**
 * A surface context is the typed, serializable description an operator screen
 * publishes about itself: what the surface is for, the scope it is looking at,
 * the fields currently editable on it, and the operations available from it.
 * Intent clients (a prompt overlay, agents) consume this to turn language into
 * structured draft actions against the same operations the UI uses; nothing
 * here executes anything by itself.
 */

export type OperationTier = 'read' | 'draft' | 'commit';

export interface SurfaceFieldRef {
	key: string;
	label: string;
	kind: 'text' | 'select' | 'date' | 'number' | 'toggle';
}

export interface SurfaceOperationRef {
	operation: string;
	tier: OperationTier;
	label: string;
}

export interface SurfaceScope {
	eventId: string;
	entity?: string;
	selection?: string[];
}

export interface SurfaceContext {
	surface: string;
	purpose: string;
	scope: SurfaceScope;
	fields: SurfaceFieldRef[];
	operations: SurfaceOperationRef[];
}

/** The overview dashboard's declaration; consumed by intent clients as they land. */
export const dashboardSurfaceContext: SurfaceContext = {
	surface: 'workspace.overview',
	purpose: 'Event-wide status: what needs attention, pipeline state, deadlines, and recent activity.',
	scope: { eventId: 'evt_aie-nyc-2026' },
	fields: [],
	operations: [
		{ operation: 'events.summary', tier: 'read', label: 'Read event summary' },
		{ operation: 'notifications.compose', tier: 'draft', label: 'Draft decision notifications' },
		{ operation: 'messages.compose', tier: 'draft', label: 'Draft an email' },
		{ operation: 'reviews.remind', tier: 'draft', label: 'Draft reviewer reminders' }
	]
};
