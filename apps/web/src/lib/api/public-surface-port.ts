import { createContext } from 'svelte';
import type { ServedPublicFormDto } from '@jooevents/contracts';
import type { PublicApplicationSession } from './public-application-session';
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
 * released data each surface kind renders. Reads stay read-only — a visitor
 * is not a user of this product — and the one write capability, the public
 * application ceremony, is its own optional member: a fulfillment without a
 * writable apply surface simply omits it, and the page renders the same
 * honest read-only call it always has.
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
	readonly application?: {
		/**
		 * The published form exactly as served — field kinds, constraints, and
		 * option identities intact. The answering surface binds to this DTO;
		 * the flattened `SurfaceTemplate.fields` pool drops option ids and is
		 * presentation-only.
		 */
		served(input: { readonly formId: string }): Promise<ServedPublicFormDto | null>;
		/**
		 * One submitter's autosave/resume/submit session for the published
		 * apply surface's pinned form. Standalone and embedded rendering call
		 * this identically; the render mode never alters the ceremony. The
		 * served target, when passed, lets a session-targeted refusal render
		 * the recorded re-offer.
		 */
		session(input: {
			readonly formId: string;
			readonly target?: ServedPublicFormDto['target'];
			readonly continuation?: string;
		}): PublicApplicationSession;
		/**
		 * The embed ↔ standalone continuation handoff is a single-purpose POST
		 * exchange. No public exchange endpoint is served yet, so that absence
		 * is typed here; a continuation never rides a query string or a
		 * `postMessage` payload.
		 */
		readonly continuationHandoff: { readonly kind: 'not_served' };
	};
}

export const [usePublicSurfacePort, setPublicSurfacePort] = createContext<PublicSurfacePort>();
