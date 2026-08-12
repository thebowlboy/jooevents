import type { WorkspaceGateway } from '../workspace-gateway';
import { api, sampleScenario } from '../workspace';

const source = Object.freeze({
	kind: 'sample' as const,
	scenario: Object.freeze(sampleScenario)
});

export const sampleWorkspaceGateway = Object.freeze({
	api,
	source
}) satisfies WorkspaceGateway;
