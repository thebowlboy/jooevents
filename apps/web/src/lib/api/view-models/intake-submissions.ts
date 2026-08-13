import type { StructuredOutcome } from '@jooevents/contracts';
import type { ProgramVocabularyReadPort } from '../category-targets';
import type { SafeApiError } from '../client';

export type OrganizerSubmissionTargetView =
	| {
			readonly kind: 'general_pool';
			readonly label: string;
	  }
	| {
			readonly kind: 'category';
			readonly categoryKind: 'track' | 'format';
			readonly categoryId: string;
			readonly label: string;
	  }
	| {
			readonly kind: 'session';
			readonly sessionId: string;
			readonly label: string;
	  };

export interface OrganizerSubmissionSummaryView {
	readonly id: string;
	readonly formId: string;
	readonly formVersionId: string;
	readonly target: OrganizerSubmissionTargetView;
	readonly title: string;
	readonly primaryParticipantName: string | null;
	readonly submittedAt: string;
	readonly submittedAtLabel: string;
}

export interface OrganizerSubmissionChoiceView {
	readonly id: string;
	readonly label: string;
}

interface OrganizerSubmissionAnswerBaseView {
	readonly fieldId: string;
	/** The label pinned to the immutable form version this submission answered. */
	readonly fieldLabel: string;
}

export type OrganizerSubmissionAnswerView =
	| (OrganizerSubmissionAnswerBaseView & {
			readonly type: 'text' | 'textarea' | 'url' | 'phone' | 'date' | 'datetime';
			readonly value: string;
	  })
	| (OrganizerSubmissionAnswerBaseView & {
			readonly type: 'number';
			readonly value: number;
	  })
	| (OrganizerSubmissionAnswerBaseView & {
			readonly type: 'select';
			readonly choice: OrganizerSubmissionChoiceView;
	  })
	| (OrganizerSubmissionAnswerBaseView & {
			readonly type: 'multiselect';
			readonly choices: readonly OrganizerSubmissionChoiceView[];
	  })
	| (OrganizerSubmissionAnswerBaseView & {
			readonly type: 'checkbox';
			readonly checked: boolean;
	  });

export interface OrganizerSubmissionDetailView {
	readonly submissionId: string;
	readonly formId: string;
	readonly formVersionId: string;
	readonly submittedAt: string;
	readonly submittedAtLabel: string;
	readonly participantCount: number;
	readonly answers: readonly OrganizerSubmissionAnswerView[];
	readonly affirmedConsentFieldIds: readonly string[];
}

/**
 * The only contact value the organizer surface needs. Person, participant, and
 * source-field identifiers stay below the presentation boundary.
 */
export interface OrganizerSubmissionContactView {
	readonly submissionId: string;
	readonly email: string;
}

export type OrganizerSubmissionOperation = 'list' | 'detail' | 'contact';

export type OrganizerSubmissionUnavailableReason =
	| 'invalid_operation_manifest'
	| 'operation_not_registered'
	| 'operation_registration_ambiguous'
	| 'operation_not_active'
	| 'operation_contract_mismatch'
	| 'operator_http_binding_not_registered'
	| 'operator_http_binding_ambiguous'
	| 'operator_http_binding_unsupported'
	| 'not_enabled'
	| 'not_authorized';

export type OrganizerSubmissionReadResult<Data> =
	| {
			readonly kind: 'success';
			readonly data: Data;
			readonly correlationId?: string;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly correlationId: string;
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| {
			readonly kind: 'unavailable';
			readonly operation: OrganizerSubmissionOperation;
			readonly reason: OrganizerSubmissionUnavailableReason;
	  };

export type OrganizerSubmissionsSource =
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

export type OrganizerSubmissionContactPort =
	| {
			readonly kind: 'available';
			read(
				submissionId: string,
				options?: { readonly signal?: AbortSignal }
			): Promise<OrganizerSubmissionReadResult<OrganizerSubmissionContactView>>;
	  }
	| {
			readonly kind: 'unavailable';
			readonly reason: Extract<OrganizerSubmissionUnavailableReason, 'not_enabled' | 'not_authorized'>;
	  };

/**
 * One safe aggregate port consumed by the organizer page in either sample or
 * live composition. Contact is deliberately a sibling capability: an
 * unavailable branch cannot carry a read method or contact data.
 */
export interface OrganizerSubmissionsPort {
	readonly source: OrganizerSubmissionsSource;
	list(options?: {
		readonly signal?: AbortSignal;
	}): Promise<OrganizerSubmissionReadResult<readonly OrganizerSubmissionSummaryView[]>>;
	readDetail(
		submissionId: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<OrganizerSubmissionReadResult<OrganizerSubmissionDetailView>>;
	readonly contact: OrganizerSubmissionContactPort;
}

/** Injection contract for the bounded organizer submissions component. */
export interface OrganizerSubmissionsPageProps {
	readonly port: OrganizerSubmissionsPort;
	readonly vocabulary: ProgramVocabularyReadPort;
}
