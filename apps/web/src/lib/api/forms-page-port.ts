import type { PlacementSuggestion } from './placement';
import type {
	FieldContext,
	FieldKind,
	Format,
	FormComposition,
	FormFieldRow,
	FormSummary,
	FormTarget,
	MutationOutcome,
	RegistryField,
	Track
} from './types';

/**
 * Everything the tuned Forms page consumes. Source selection belongs to the
 * composition root; the page keeps one interaction model for sample and live.
 */
export interface FormsPagePort {
	readonly templates: {
		applicationFormSurfaceId(): Promise<string | null>;
	};
	readonly vocab: {
		tracks(): Promise<Track[]>;
		formats(): Promise<Format[]>;
	};
	readonly schedule: {
		sessions(): Promise<readonly {
			readonly id: string;
			readonly title: string;
			readonly state: string;
		}[]>;
	};
	readonly forms: {
		list(): Promise<FormSummary[]>;
		get(id: string): Promise<FormSummary | null>;
		fields(id: string): Promise<FormFieldRow[] | null>;
		create(input: {
			readonly name: string;
			readonly target: FormTarget;
			readonly closesAt?: string;
		}): Promise<FormSummary>;
		setComposition(id: string, composition: FormComposition): Promise<MutationOutcome>;
		restoreComposition(id: string, composition: FormComposition): Promise<void>;
		setClosing(id: string, closesAt: string | null): Promise<MutationOutcome>;
		setStatus(id: string, status: 'open' | 'closed'): Promise<MutationOutcome>;
	};
	readonly fields: {
		move(id: string, toIndex: number): Promise<MutationOutcome>;
		remove(id: string): Promise<MutationOutcome>;
		restore(field: RegistryField, index: number): Promise<void>;
		add(input: {
			readonly kind: FieldKind;
			readonly label: string;
			readonly help?: string;
			readonly options?: string[];
			readonly collectAt: FieldContext[];
			readonly requiredIn?: FieldContext[];
			readonly formScope?: string;
		}): Promise<{ readonly field: RegistryField; readonly placement: PlacementSuggestion }>;
	};
}
