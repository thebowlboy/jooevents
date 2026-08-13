import type {
	FormClosingChangeDraftInput,
	FormConfigurationIssueDto,
	FormDefinitionAuthorInput,
	FormDefinitionCreateDraftInput,
	FormDefinitionReviseDraftInput,
	FormLifecycleChangeDraftInput,
	FormRegistryPinDto,
	FormStatus,
	FormVersionPublishDraftInput,
	IntakeFormDraftAction,
	IntakeFormSafeDiff,
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

/** Canonical safe diffs are retained without lossy browser aliases. */
export type OrganizerFormSafeDiffView = IntakeFormSafeDiff;

export interface OrganizerFormDraftView {
	readonly action: IntakeFormDraftAction;
	readonly changesetId: string;
	readonly headVersion: number;
	readonly revisionId: string;
	readonly revisionNumber: number;
	readonly revisionDigest: string;
	readonly riskTier: 'low' | 'normal' | 'consequential';
	readonly approvalRequirement: 'none' | 'distinct_current_human';
	readonly safeDiff: OrganizerFormSafeDiffView;
}

export interface OrganizerFormChangesetDiffView {
	readonly changesetId: string;
	readonly headVersion: number;
	readonly status: 'draft' | 'proposed' | 'committed' | 'discarded';
	readonly revisionId: string;
	readonly revisionNumber: number;
	readonly revisionDigest: string;
	readonly riskTier: 'low' | 'normal' | 'consequential';
	readonly approvalRequirement: 'none' | 'distinct_current_human';
	readonly operations: readonly {
		readonly kind: string;
		readonly version: number;
		readonly riskTier: 'low' | 'normal' | 'consequential';
		readonly dependencyGroup: string;
		readonly safeDiff: OrganizerFormSafeDiffView;
		readonly consequences: readonly string[];
	}[];
}

export interface OrganizerFormCommitView {
	readonly changesetId: string;
	readonly expectedHeadVersion: number;
	readonly committedHeadVersion: number;
	readonly revisionId: string;
	readonly revisionDigest: string;
}

export type OrganizerFormsOperation =
	| 'list'
	| 'detail'
	| 'draft_create'
	| 'draft_revise'
	| 'draft_publish'
	| 'draft_lifecycle'
	| 'draft_closing'
	| 'diff'
	| 'propose'
	| 'commit';

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

export interface OrganizerFormsChangesetSelector {
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
}

export type OrganizerFormsChangesetEffectInput = OrganizerFormsChangesetSelector & {
	readonly expectedHeadVersion: number;
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
	draftCreate(
		input: FormDefinitionCreateDraftInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormDraftView>>;
	draftRevise(
		input: FormDefinitionReviseDraftInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormDraftView>>;
	draftPublish(
		input: FormVersionPublishDraftInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormDraftView>>;
	draftLifecycle(
		input: FormLifecycleChangeDraftInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormDraftView>>;
	draftClosing(
		input: FormClosingChangeDraftInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormDraftView>>;
	readDiff(
		input: OrganizerFormsChangesetSelector,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormChangesetDiffView>>;
	propose(
		input: OrganizerFormsChangesetEffectInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormChangesetDiffView>>;
	commit(
		input: OrganizerFormsChangesetEffectInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerFormsResult<OrganizerFormCommitView>>;
	reset?(): void | Promise<void>;
}
