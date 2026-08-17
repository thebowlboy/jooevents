import type { StructuredOutcome } from '@jooevents/contracts';
import type {
	SubmissionTriageAction,
	SubmissionTriageListInput,
	SubmissionTriageQueryGuardDto,
	SubmissionTriageTransitionInput
} from '@jooevents/contracts/submission-triage';
import type {
	SubmissionTriagePageView,
	SubmissionTriageRowView
} from './mappers/submission-triage';
import type {
	SubmissionTriageLiveApplyResult,
	SubmissionTriageLiveClient,
	SubmissionTriageLiveReadResult
} from './operations/submission-triage-live';

/**
 * Source-neutral triage capability. It deliberately is not declared as the
 * tuned WorkspaceApi submissions aggregate: contact, decision, review,
 * signal, resource, and direct-entry capabilities must be joined first.
 */
export interface SubmissionTriageWorkspacePort {
	list(query?: SubmissionTriageListInput): Promise<SubmissionTriagePageView>;
	read(id: string): Promise<SubmissionTriageRowView | null>;
	setAside(ids: readonly string[]): Promise<void>;
	returnToInbox(ids: readonly string[]): Promise<void>;
	markSpam(ids: readonly string[]): Promise<void>;
	notSpam(ids: readonly string[]): Promise<void>;
}

type AdapterFailure = Readonly<{ code: string; reason: string }>;

/** Reviewed presentation-safe failure; raw server details never become interface copy. */
export class SubmissionTriageWorkspaceAdapterError extends Error {
	readonly code: string;

	constructor(failure: AdapterFailure) {
		super(failure.reason);
		this.name = 'SubmissionTriageWorkspaceAdapterError';
		this.code = failure.code;
	}
}

function detailCode(outcome: StructuredOutcome): string | undefined {
	if (typeof outcome.detail !== 'object' || outcome.detail === null) return undefined;
	const code = (outcome.detail as { readonly code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}

function outcomeFailure(outcome: StructuredOutcome): AdapterFailure {
	const code = detailCode(outcome);
	if (outcome.class === 'access_denied') {
		return { code: outcome.kind, reason: 'You no longer have permission to triage submissions.' };
	}
	if (outcome.kind === 'submission_triage.event_required') {
		return { code: outcome.kind, reason: 'Create or select an event before triaging submissions.' };
	}
	if (outcome.kind === 'submission_triage.not_initialized') {
		return { code: outcome.kind, reason: 'Submission triage is not initialized for this event.' };
	}
	if (outcome.kind === 'submission_triage.not_found' || code === 'submission_missing') {
		return { code: outcome.kind, reason: 'This submission no longer exists.' };
	}
	if (outcome.class === 'stale_revision'
		|| code === 'stale_query_set'
		|| code === 'stale_submission'
		|| code === 'source_changed') {
		return {
			code: outcome.kind,
			reason: 'Submissions changed while you were working. Reload this tray and try again.'
		};
	}
	if (code === 'invalid_transition' || code === 'invalid_plan') {
		return {
			code: outcome.kind,
			reason: 'That submission is no longer in a tray where this action applies.'
		};
	}
	if (outcome.class === 'idempotency_conflict') {
		return {
			code: outcome.kind,
			reason: 'This triage action changed before it finished. Reload and try it again.'
		};
	}
	return { code: outcome.kind, reason: 'This submission-triage change could not be applied.' };
}

function readFailure(
	result: Exclude<SubmissionTriageLiveReadResult<unknown>, { readonly kind: 'success' }>
): AdapterFailure {
	if (result.kind === 'outcome') return outcomeFailure(result.outcome);
	if (result.kind === 'unavailable') {
		return { code: result.reason, reason: 'Submission triage is not available in this live workspace.' };
	}
	return {
		code: result.error.code,
		reason: result.error.retryable
			? 'Submission triage could not be reached. Try again.'
			: 'This submission-triage request is not valid.'
	};
}

function applyFailure(
	result: Exclude<SubmissionTriageLiveApplyResult, { readonly kind: 'success' }>
): AdapterFailure {
	if (result.kind === 'outcome') return outcomeFailure(result.outcome);
	if (result.kind === 'unavailable') {
		return {
			code: result.reason,
			reason: 'Submission-triage changes are not available in this live workspace.'
		};
	}
	return {
		code: result.error.code,
		reason: result.error.retryable
			? 'The submission-triage change could not be confirmed. Try again.'
			: 'This submission-triage change is not valid.'
	};
}

function sameGuard(
	left: SubmissionTriageQueryGuardDto,
	right: SubmissionTriageQueryGuardDto
): boolean {
	return left.scope.workspaceId === right.scope.workspaceId
		&& left.scope.eventId === right.scope.eventId
		&& left.version === right.version
		&& left.digestSha256 === right.digestSha256;
}

function defaultIdempotencyKey(): string {
	return `je.submission-triage.action.${globalThis.crypto.randomUUID()}`;
}

export function createSubmissionTriageWorkspaceAdapter(input: {
	readonly client: SubmissionTriageLiveClient;
	readonly newIdempotencyKey?: () => string;
}): SubmissionTriageWorkspacePort {
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;
	const rows = new Map<string, SubmissionTriageRowView>();

	function cache(row: SubmissionTriageRowView): void {
		rows.set(row.source.id, row);
	}

	async function readOne(id: string): Promise<SubmissionTriageRowView> {
		const result = await input.client.read(id);
		if (result.kind !== 'success') {
			throw new SubmissionTriageWorkspaceAdapterError(readFailure(result));
		}
		cache(result.data);
		return result.data;
	}

	async function guardedRows(ids: readonly string[]): Promise<{
		readonly selected: readonly SubmissionTriageRowView[];
		readonly guard: SubmissionTriageQueryGuardDto;
	}> {
		const canonical = [...new Set(ids)].sort();
		if (canonical.length !== ids.length || canonical.length === 0) {
			throw new SubmissionTriageWorkspaceAdapterError({
				code: 'invalid_selection', reason: 'Choose one or more distinct submissions.'
			});
		}
		const selected: SubmissionTriageRowView[] = [];
		for (const id of canonical) selected.push(rows.get(id) ?? await readOne(id));
		const guard = selected[0]!.queryGuard;
		if (selected.some((row) => !sameGuard(row.queryGuard, guard))) {
			throw new SubmissionTriageWorkspaceAdapterError({
				code: 'mixed_query_guard',
				reason: 'Submissions changed while you were selecting them. Reload this tray and try again.'
			});
		}
		return { selected: Object.freeze(selected), guard };
	}

	async function mutate(ids: readonly string[], action: SubmissionTriageAction): Promise<void> {
		const { selected, guard } = await guardedRows(ids);
		const request: SubmissionTriageTransitionInput = {
			action,
			submissionIds: selected.map((row) => row.source.id),
			expectedHeads: selected.map((row) => ({
				submissionId: row.source.id,
				version: row.head.version
			})),
			expectedQueryGuard: {
				version: guard.version,
				digestSha256: guard.digestSha256
			}
		};
		const result = await input.client.apply(request, newIdempotencyKey());
		if (result.kind !== 'success') {
			throw new SubmissionTriageWorkspaceAdapterError(applyFailure(result));
		}
		for (const row of selected) rows.delete(row.source.id);
	}

	return Object.freeze({
		async list(query: SubmissionTriageListInput = {}): Promise<SubmissionTriagePageView> {
			const result = await input.client.list(query);
			if (result.kind !== 'success') {
				throw new SubmissionTriageWorkspaceAdapterError(readFailure(result));
			}
			for (const row of result.data.rows) cache(row);
			return structuredClone(result.data);
		},

		async read(id: string): Promise<SubmissionTriageRowView | null> {
			const result = await input.client.read(id);
			if (result.kind === 'outcome' && result.outcome.kind === 'submission_triage.not_found') {
				return null;
			}
			if (result.kind !== 'success') {
				throw new SubmissionTriageWorkspaceAdapterError(readFailure(result));
			}
			cache(result.data);
			return structuredClone(result.data);
		},

		setAside: (ids: readonly string[]) => mutate(ids, 'set_aside'),
		returnToInbox: (ids: readonly string[]) => mutate(ids, 'return_to_inbox'),
		markSpam: (ids: readonly string[]) => mutate(ids, 'mark_spam'),
		notSpam: (ids: readonly string[]) => mutate(ids, 'not_spam')
	});
}
