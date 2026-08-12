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

export interface WorkspaceGateway {
	readonly api: WorkspaceApi;
	readonly source: SampleWorkspaceSource;
}

export const [useWorkspaceGateway, setWorkspaceGateway] = createContext<WorkspaceGateway>();
