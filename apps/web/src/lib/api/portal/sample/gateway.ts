import type { PortalGateway } from '../gateway';
import { api, portalScenario } from './api';

const source = Object.freeze({
	kind: 'sample' as const,
	scenario: Object.freeze(portalScenario)
});

export const samplePortalGateway = Object.freeze({
	api,
	source
}) satisfies PortalGateway;
