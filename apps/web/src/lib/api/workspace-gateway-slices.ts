import type { WorkspaceApi } from './workspace-gateway';

/** API methods required by the overview dashboard. */
export type OverviewWorkspaceGatewayApi = Readonly<{
	workspace: Pick<WorkspaceApi['workspace'], 'summary' | 'summarySnapshot'>;
}>;

/**
 * API methods required by the event/settings page and its field-registry
 * section. A live adapter is complete only when it can
 * honor every method in this slice through registered operations.
 */
export type SettingsWorkspaceGatewayApi = Readonly<{
	workspace: Pick<WorkspaceApi['workspace'], 'summarySnapshot'>;
	settings: Pick<
		WorkspaceApi['settings'],
		'get' | 'update' | 'members' | 'invite' | 'changeRole' | 'removeMember'
	>;
	vocab: Pick<
		WorkspaceApi['vocab'],
		| 'rooms'
		| 'tracks'
		| 'formats'
		| 'addRoom'
		| 'addTrack'
		| 'addFormat'
		| 'removeRoom'
		| 'removeTrack'
		| 'removeFormat'
		| 'retireRoom'
		| 'retireTrack'
		| 'retireFormat'
		| 'restoreRoom'
		| 'restoreTrack'
		| 'restoreFormat'
	>;
	fields: Pick<WorkspaceApi['fields'], 'list' | 'add' | 'update' | 'remove' | 'move' | 'restore'>;
}>;
