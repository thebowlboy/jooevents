import { createContext } from 'svelte';

export type PortalApi = typeof import('./sample/api').api;

export interface SamplePortalSource {
	readonly kind: 'sample';
	readonly scenario: {
		readonly key: string;
		readonly name: string;
		readonly description: string;
	};
}

export interface PortalGateway {
	readonly api: PortalApi;
	readonly source: SamplePortalSource;
}

export const [usePortalGateway, setPortalGateway] = createContext<PortalGateway>();
