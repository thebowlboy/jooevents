import type { WorkspaceGateway } from '../workspace-gateway';
import { api, sampleScenario } from '../workspace';
import { sampleViewer } from './registry';

const source = Object.freeze({
	kind: 'sample' as const,
	scenario: Object.freeze(sampleScenario)
});

export const sampleWorkspaceGateway = Object.freeze({
	api,
	source,
	viewer: Object.freeze(sampleViewer())
}) satisfies WorkspaceGateway;
