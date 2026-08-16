import type {
	FormConfigurationIssueDto,
	FormDefinitionAuthorInput,
	FormDefinitionCreateDraftInput,
	FormDefinitionReviseDraftInput,
	FormClosingChangeDraftInput,
	FormRegistryPinDto,
	FormStatus,
	intakeFormDirectLifecycleInputSchema,
	IntakeFormVersionPublishInput,
	intakeFormVersionReviewDraftDataSchema,
	IntakeFormVersionReviewInput,
	IntakeFormWriteData,
	StructuredOutcome
} from '@jooevents/contracts';
import type { SafeApiError } from '../client';
import type { OperatorHttpBindingUnavailableReason } from '../operations/operator-http-binding';
import type { FormComposition, FormFieldRow } from '../types';

export type OrganizerFormTargetView =
	| {
			readonly kind: 'general_pool';
			readonly label: 'General pool';
	  }
	| {
			readonly kind: 'category';
			readonly categoryKind: 'track' | 'format';
			readonly categoryId: string;
			readonly label: 'Track target' | 'Format target';
	  }
	| {
			readonly kind: 'session';
			readonly sessionId: string;
			readonly label: 'Session target';
	  };

export interface OrganizerFormSummaryView {
	readonly id: string;
	readonly name: string;
	readonly target: OrganizerFormTargetView;
	readonly status: FormStatus;
	readonly statusLabel: 'Draft' | 'Open' | 'Closed';
	readonly version: number;
	readonly currentPublishedVersionId: string | null;
	readonly composition: FormComposition;
	readonly registryPin: FormRegistryPinDto;
	readonly closesAt: string | null;
	readonly fieldCount: number;
	readonly configurationIssues: readonly FormConfigurationIssueDto[];
	readonly submissionCount: number;
	readonly updatedAt: string;
	readonly updatedAtLabel: string;
}

export interface OrganizerFormCatalogView {
	readonly catalogVersion: number;
	readonly registryPin: FormRegistryPinDto;
	readonly forms: readonly OrganizerFormSummaryView[];
}

export interface OrganizerFormDefinitionView {
	readonly id: string;
	readonly version: number;
	readonly status: FormStatus;
	readonly currentPublishedVersionId: string | null;
	readonly name: string;
	readonly target: OrganizerFormTargetView;
	readonly definition: FormDefinitionAuthorInput;
}

export interface OrganizerFormDetailView {
	readonly form: OrganizerFormDefinitionView;
	readonly registryPin: FormRegistryPinDto;
	readonly fields: readonly FormFieldRow[];
	readonly configurationIssues: readonly FormConfigurationIssueDto[];
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly updatedAtLabel: string;
	readonly publishedVersion:
		| {
				readonly id: string;
				readonly number: number;
				readonly sourceDefinitionVersion: number;
				readonly publishedAt: string;
				readonly publishedAtLabel: string;
		  }
		| null;
}

export type OrganizerFormWriteView = IntakeFormWriteData;
export type OrganizerFormVersionReviewView = ReturnType<typeof intakeFormVersionReviewDraftDataSchema.parse>;
export type OrganizerFormVersionPublishSelector = IntakeFormVersionPublishInput;
export type OrganizerFormLifecycleInput = ReturnType<typeof intakeFormDirectLifecycleInputSchema.parse>;

export type OrganizerFormsOperation =
	| 'list'
	| 'detail'
	| 'create'
	| 'revise'
	| 'draft_publish'
	| 'publish'
	| 'lifecycle'
	| 'closing';

export type OrganizerFormsUnavailableReason = OperatorHttpBindingUnavailableReason;

export type OrganizerFormsResult<Data> =
	| {
			readonly kind: 'success';
			readonly data: Data;
			readonly correlationId?: string;
			readonly receipt?: {
				readonly id: string;
				readonly operationName: string;
				readonly operationVersion: number;
			};
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal?: boolean;
			readonly correlationId: string;
			readonly receipt?: {
				readonly id: string;
				readonly operationName: string;
				readonly operationVersion: number;
			};
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| {
			readonly kind: 'unavailable';
			readonly operation: OrganizerFormsOperation;
			readonly reason: OrganizerFormsUnavailableReason;
	  };

export type OrganizerFormsSource =
	| { readonly kind: 'live' }
	| {
			readonly kind: 'sample';
			readonly label: 'Sample data';
			readonly scenario: {
				readonly key: string;
				readonly name: string;
				readonly description: string;
			};
	  };

export interface OrganizerFormsPort {
	readonly source: OrganizerFormsSource;
	list(options?: {
		readonly signal?: AbortSignal;
	}): Promise<OrganizerFormsResult<OrganizerFormCatalogView>>;
	readDetail(
		formId: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormDetailView>>;
	create(
		input: FormDefinitionCreateDraftInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormWriteView>>;
	revise(
		input: FormDefinitionReviseDraftInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormWriteView>>;
	draftPublish(
		input: IntakeFormVersionReviewInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormVersionReviewView>>;
	publish(
		input: IntakeFormVersionPublishInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormWriteView>>;
	lifecycle(
		input: OrganizerFormLifecycleInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormWriteView>>;
	closing(
		input: FormClosingChangeDraftInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormWriteView>>;
	reset?(): void | Promise<void>;
}
