import type {
	operationHttpIdempotencyKeySchema,
	OperationReceiptRef,
	StructuredOutcome
} from '@jooevents/contracts';
import type { sessionAuthorInputSchema } from '@jooevents/contracts/sessions';
import type { z } from 'zod';
import type { SafeApiError } from './client';
import type { OperatorHttpBindingUnavailableReason } from './operations/operator-http-binding';
import type { SessionCatalogView, SessionChangeCommittedView } from './view-models/session';

export type SessionAuthorRequest = z.input<typeof sessionAuthorInputSchema>;
export type SessionCreateRequest = Extract<SessionAuthorRequest, { readonly action: 'create' }>;
export type SessionTransitionRequest = Extract<
	SessionAuthorRequest,
	{ readonly action: 'transition' }
>;
export type SessionCatalogIdempotencyKey = z.input<typeof operationHttpIdempotencyKeySchema>;

export type SessionCatalogCoreOperation = 'catalog' | 'draft' | 'propose' | 'commit';

export type SessionCatalogUnavailableResult = {
	readonly kind: 'unavailable';
	readonly operation: SessionCatalogCoreOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type SessionCatalogReadResult =
	| {
			readonly kind: 'success';
			readonly data: SessionCatalogView;
			readonly correlationId: string;
	  }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| SessionCatalogUnavailableResult;

export type SessionChangeApplyResult =
	| {
			readonly kind: 'success';
			readonly data: SessionChangeCommittedView;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal: boolean;
			readonly receipt?: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| SessionCatalogUnavailableResult;

export type SessionCatalogCoreSource =
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

/**
 * Source-neutral boundary over the canonical Session catalog only.
 *
 * It deliberately carries just what the backend owns today: the catalog read
 * and the inert change draft (`create` | forward-only `transition`), which a
 * client completes through the generic changeset propose/commit lifecycle.
 * Rosters with resolvable people, submission attachment, per-session proposal
 * counts, breaks, and publication have no canonical owner here; a live source
 * never fills those gaps with sample behavior or inferred facts, and `restore`
 * is internal compensation that never appears on any web path.
 */
export interface SessionCatalogCorePort {
	readonly source: SessionCatalogCoreSource;

	readCatalog(
		options?: { readonly signal?: AbortSignal }
	): Promise<SessionCatalogReadResult>;

	/**
	 * Drafts one authored Session change and commits it through the generic
	 * changeset lifecycle (draft -> propose -> commit). The draft is inert; no
	 * effective state changes until the commit receipt arrives.
	 */
	applyChange(
		request: SessionAuthorRequest,
		idempotencyKey: SessionCatalogIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<SessionChangeApplyResult>;
}
