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

export interface FormPublishReview {
	readonly action: 'publish_and_open';
	readonly selector: {
		readonly draftId: string;
		readonly revisionId: string;
		readonly revisionDigestSha256: string;
	};
	readonly formId: string;
	readonly formName: string;
	readonly versionNumber: number;
	readonly resultingStatus: 'open';
	readonly surfaceSuccessorCount: number;
}

export type FormPublishPreparation =
	| { readonly ok: true; readonly review: FormPublishReview }
	| { readonly ok: false; readonly reason: string };

/**
 * Everything the tuned Forms page consumes. Source selection belongs to the
 * composition root; the page keeps one interaction model for sample and live.
 */
export interface FormsPagePort {
	readonly templates: {
		applicationFormSurfaceId(): Promise<string | null>;
		/**
		 * Whether the shared application page — the `/s/apply` surface every
		 * form's public address renders through — currently has a published
		 * release. The form's own publication is a separate release record;
		 * an address is live only when both stand. `null` means the
		 * composition cannot say, and the page keeps its silence rather than
		 * guessing in either direction.
		 */
		applicationSurfacePublished(): Promise<boolean | null>;
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
		setClosing(id: string, closesAt: string | null): Promise<MutationOutcome>;
		setStatus(id: string, status: 'open' | 'closed'): Promise<MutationOutcome>;
		preparePublish(id: string): Promise<FormPublishPreparation>;
		publish(review: FormPublishReview): Promise<MutationOutcome>;
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
