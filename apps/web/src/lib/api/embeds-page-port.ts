import type {
	EmbedTarget,
	EventTheme,
	FormSummary,
	PublicSpeakerCard,
	ScheduleState,
	SpeakerCategory,
	SurfaceTemplate,
	Track
} from './types';

/** Factual capabilities consumed by the tuned public-surface/embed publisher. */
export interface EmbedsPagePort {
	readonly embeds: {
		targets(): Promise<EmbedTarget[]>;
		speakerTargets(): Promise<EmbedTarget[]>;
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
		get(): Promise<{ readonly publicIndexing?: boolean } | null>;
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
