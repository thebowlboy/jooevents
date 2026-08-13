import { describe, expect, test } from 'bun:test';
import {
	createLiveWorkspaceGateway,
	type LiveWorkspaceGateway,
	type WorkspaceViewer
} from './workspace-gateway';
import type { OverviewWorkspaceGatewayApi } from './workspace-gateway-slices';

describe('live workspace gateway envelope', () => {
	test('carries an arbitrary closed API slice without sample metadata', () => {
		const api = Object.freeze({
			event: Object.freeze({ read: async () => ({ kind: 'no_event' as const }) })
		});
		const viewer: WorkspaceViewer = { kind: 'organizer' };
		const gateway = createLiveWorkspaceGateway({
			api,
			workspaceId: 'workspace-live-1',
			viewer
		}) satisfies LiveWorkspaceGateway<typeof api>;

		expect(gateway.api).toBe(api);
		expect(gateway.source).toEqual({ kind: 'live', workspaceId: 'workspace-live-1' });
		expect('scenario' in gateway.source).toBe(false);
		expect(gateway.viewer).toEqual({ kind: 'organizer' });
		expect(Object.isFrozen(gateway)).toBe(true);
		expect(Object.isFrozen(gateway.source)).toBe(true);
		expect(Object.isFrozen(gateway.viewer)).toBe(true);
	});

	test('preserves the verified reviewer projection instead of inferring it from rows', () => {
		const gateway = createLiveWorkspaceGateway({
			api: Object.freeze({}),
			workspaceId: 'workspace-live-2',
			viewer: { kind: 'reviewer', reviewerId: 'reviewer-7' }
		});

		expect(gateway.viewer).toEqual({ kind: 'reviewer', reviewerId: 'reviewer-7' });
	});

	test('feature slices are accepted without pretending they are the full mounted gateway', () => {
		const overviewApi = {
			workspace: {
				async summary() {
					return {
						event: null,
						lockedAreas: [],
						navCounts: {},
						stats: [],
						attention: [],
						pipeline: [],
						deadlines: [],
						activity: [],
						trays: []
					};
				},
				summarySnapshot() {
					return null;
				}
			}
		} satisfies OverviewWorkspaceGatewayApi;
		const gateway: LiveWorkspaceGateway<OverviewWorkspaceGatewayApi> =
			createLiveWorkspaceGateway({
				api: overviewApi,
				workspaceId: 'workspace-live-3',
				viewer: { kind: 'organizer' }
			});

		expect(gateway.api.workspace.summarySnapshot()).toBeNull();
	});
});
