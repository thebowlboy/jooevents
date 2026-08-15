import type {
	EmbedTarget,
	EventTheme,
	FormSummary,
	MutationOutcome,
	PublicSpeakerCard,
	ScheduleState,
	SpeakerCategory,
	SurfaceTemplate,
	SurfaceKind,
	Track
} from './types';

/** Factual capabilities consumed by the tuned public-surface/embed publisher. */
export interface EmbedsPagePort {
	readonly embeds: {
		targets(): Promise<EmbedTarget[]>;
		speakerTargets(): Promise<EmbedTarget[]>;
		setAllowedOrigins(kind: SurfaceKind, origins: readonly string[]): Promise<MutationOutcome>;
	};
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
		get(): Promise<{
			readonly publicIndexing?: boolean;
			readonly publicIndexingEditable?: boolean;
			readonly publicIndexingReason?: string;
		} | null>;
		update(patch: { readonly publicIndexing: boolean }): Promise<unknown>;
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
