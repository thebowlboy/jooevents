import type { WorkspaceGateway } from './workspace-gateway';
import {
	cloneWorkspaceShellSummary,
	type WorkspaceShellPort
} from './workspace-shell-port';

export function createSampleWorkspaceShellPort(gateway: WorkspaceGateway): WorkspaceShellPort {
	const { api } = gateway;
	const createEvent: NonNullable<WorkspaceShellPort['createFirstEvent']> = (input) =>
		api.workspace.createEvent({
			name: input.name,
			timezone: input.timezone,
			startDate: input.startDate,
			endDate: input.endDate
		});

	return Object.freeze({
		source: gateway.source,
		viewer: gateway.viewer,
		summary: Object.freeze({
			snapshot() {
				const snapshot = api.workspace.summarySnapshot();
				return snapshot ? cloneWorkspaceShellSummary(snapshot) : null;
			},
			async read() {
				return {
					kind: 'success' as const,
					data: cloneWorkspaceShellSummary(await api.workspace.summary())
				};
			}
		}),
		account: Object.freeze({
			current: api.account.current,
			async signOut() {
				return api.account.signOut();
			},
			emailChange: Object.freeze({
				request: api.account.requestEmailChange,
				resend: api.account.resendEmailChange,
				cancel: api.account.cancelEmailChange
			})
		}),
		events: Object.freeze({
			list: api.workspace.events,
			switchEvent: api.workspace.switchEvent,
			createEvent
		}),
		createFirstEvent: createEvent
	});
}
