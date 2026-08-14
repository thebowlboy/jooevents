import { createContext } from 'svelte';
import type { LivePortalApi, LivePortalSource } from './portal-page-port.live';

/** The frozen portal page port. Structural (sample-free) so both compositions may name it;
 *  the sample api remains the behavioral spec and `portal-page-port.live.test.ts` pins the equivalence. */
export type PortalApi = LivePortalApi;

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
	readonly source: SamplePortalSource | LivePortalSource;
}

export const [usePortalGateway, setPortalGateway] = createContext<PortalGateway>();
