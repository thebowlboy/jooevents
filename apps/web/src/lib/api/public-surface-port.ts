import { createContext } from 'svelte';
import type {
	EventTheme,
	FormSummary,
	PublicSpeakerCard,
	ScheduleState,
	SpeakerCategory,
	SurfaceTemplate,
	Track
} from './types';

/**
 * Factual capabilities consumed by the hosted public pages (`/s/*`) and the
 * embed documents (`/embed/*`): the published surface, its brand, and the
 * released data each surface kind renders. Read-only by construction — a
 * visitor is not a user of this product, and no member mutates anything.
 *
 * The sample composition fulfills this from the workspace fixture; the live
 * composition fulfills it from the anonymous `/api/public/*` reads, where
 * "published" is a release fact and absence is a typed outcome, never an
 * empty page pretending to be a published one.
 */
export interface PublicSurfacePort {
	readonly templates: {
		list(): Promise<{ readonly surfaces: SurfaceTemplate[] }>;
	};
	readonly theme: {
		get(): Promise<EventTheme>;
	};
	readonly workspace: {
		summary(): Promise<{
			readonly event: null | {
				readonly name: string;
				readonly dates: string;
				readonly location: string;
			};
		}>;
	};
	readonly settings: {
		get(): Promise<{ readonly publicIndexing?: boolean } | null>;
	};
	readonly schedule: {
		state(): Promise<ScheduleState>;
	};
	readonly vocab: {
		tracks(): Promise<Track[]>;
		speakerCategories(): Promise<SpeakerCategory[]>;
	};
	readonly speakers: {
		publicRoster(): Promise<PublicSpeakerCard[]>;
	};
	readonly forms: {
		list(): Promise<FormSummary[]>;
	};
}

export const [usePublicSurfacePort, setPublicSurfacePort] = createContext<PublicSurfacePort>();
