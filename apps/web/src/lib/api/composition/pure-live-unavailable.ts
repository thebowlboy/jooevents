import type {
	UnavailableWorkspaceCapabilityPorts,
	WorkspaceCapabilityManifest,
	WorkspaceComposition
} from './capabilities';

const notEnabled = Object.freeze({
	kind: 'unavailable',
	reason: 'not_enabled',
	remedy: 'return_to_overview'
} as const);

/**
 * Pure-live posture when no aggregate implementation is installed.
 *
 * This composition carries no workspace API and no callable domain port.
 * Consumers render the explicit state instead of inventing empty rows or
 * reaching for sample data.
 */
const capabilities = Object.freeze({
	workspace_shell: notEnabled,
	event: notEnabled,
	program_vocabulary: notEnabled,
	schedule: notEnabled,
	forms_submissions: notEnabled,
	review_decisions: notEnabled,
	speaker_operations: notEnabled,
	templates_surfaces: notEnabled,
	communications: notEnabled
}) satisfies WorkspaceCapabilityManifest<UnavailableWorkspaceCapabilityPorts, 'live'>;

export const pureLiveUnavailableComposition = Object.freeze({
	schemaVersion: 1,
	kind: 'live',
	capabilities
}) satisfies WorkspaceComposition<UnavailableWorkspaceCapabilityPorts, 'live'>;
