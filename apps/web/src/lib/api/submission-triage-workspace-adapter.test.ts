import { describe, expect, test } from 'bun:test';
import type {
	SubmissionTriageAction,
	SubmissionTriageTransitionInput,
	SubmissionTriageVisibleTray
} from '@jooevents/contracts/submission-triage';
import type { SubmissionTriagePageView, SubmissionTriageRowView } from './mappers/submission-triage';
import type {
	SubmissionTriageLiveApplyResult,
	SubmissionTriageLiveClient,
	SubmissionTriageLiveReadResult
} from './operations/submission-triage-live';
import {
	createSubmissionTriageWorkspaceAdapter,
	SubmissionTriageWorkspaceAdapterError
} from './submission-triage-workspace-adapter';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const workspaceId = id(1);
const eventId = id(2);
const submissionId = id(3);
const formId = id(4);
const formVersionId = id(5);
const fieldId = id(6);
const correlationId = id(900);

const queryGuard = Object.freeze({
	schemaVersion: 1 as const,
	scope: { workspaceId, eventId },
	version: 7,
	digestSha256: digest('a')
});

function row(input: {
	readonly state?: 'inbox' | 'set_aside' | 'spam';
	readonly tray?: SubmissionTriageVisibleTray;
	readonly version?: number;
} = {}): SubmissionTriageRowView {
	const state = input.state ?? 'inbox';
	const tray = input.tray ?? 'late';
	return {
		source: {
			id: submissionId,
			formId,
			formVersionId,
			target: { kind: 'general_pool' },
			title: 'A durable proposal',
			primaryParticipantName: 'Avery Stone',
			submittedAt: '2026-08-13T10:01:00.000Z',
			source: 'public_form',
			abstract: null,
			track: null,
			format: null,
			detail: {
				schemaVersion: 1,
				submissionId,
				formId,
				formVersionId,
				submittedAt: '2026-08-13T10:01:00.000Z',
				participantCount: 1,
				answers: [{
					kind: 'textarea', fieldId, fieldLabel: 'Abstract', value: 'Practical systems.'
				}],
				affirmedConsentFieldIds: []
			}
		},
		head: {
			version: input.version ?? 4,
			state,
			setAsideAttribution: state === 'set_aside' ? { kind: 'manual' } : null,
			updatedAt: '2026-08-13T10:02:00.000Z'
		},
		arrival: {
			schemaVersion: 1,
			id: id(7),
			scope: { workspaceId, eventId },
			submissionId,
			formId,
			formVersionId,
			source: 'public_form',
			submittedAt: '2026-08-13T10:01:00.000Z',
			classification: tray === 'late' ? 'late' : 'on_time',
			closeEvidence: tray === 'late'
				? {
					closeAt: '2026-08-13T10:00:00.000Z',
					policy: {
						reference: { key: 'intake.soft_close', version: 1 },
						definitionDigestSha256: digest('b')
					}
				}
				: null,
			recordedAt: '2026-08-13T10:01:00.000Z'
		},
		visibleTray: tray,
		queryGuard
	};
}

function page(view: SubmissionTriageRowView = row()): SubmissionTriagePageView {
	return {
		rows: [view],
		trayTotals: { inbox: 0, set_aside: 0, late: 1, spam: 0 },
		search: null,
		queryGuard
	};
}

function stateForAction(action: SubmissionTriageAction) {
	return action === 'return_to_inbox'
		? { state: 'set_aside' as const, tray: 'set_aside' as const }
		: action === 'not_spam'
			? { state: 'spam' as const, tray: 'spam' as const }
			: { state: 'inbox' as const, tray: 'late' as const };
}

function applied(action: SubmissionTriageAction): SubmissionTriageLiveApplyResult {
	return {
		kind: 'success',
		data: {
			schemaVersion: 1,
			action,
			queryGuard: { ...queryGuard, version: 8, digestSha256: digest('c') },
			submissionIds: [submissionId]
		},
		receipt: {
			id: id(22),
			operationName: 'submission.triage.transition',
			operationVersion: 1
		},
		correlationId
	};
}

function client(input: {
	readonly list?: SubmissionTriageLiveReadResult<SubmissionTriagePageView>;
	readonly read?: SubmissionTriageLiveReadResult<SubmissionTriageRowView>;
	readonly apply?: (
		request: SubmissionTriageTransitionInput,
		key: string
	) => SubmissionTriageLiveApplyResult | Promise<SubmissionTriageLiveApplyResult>;
}): SubmissionTriageLiveClient {
	return {
		async list() {
			if (!input.list) throw new TypeError('unexpected_list');
			return input.list;
		},
		async read() {
			if (!input.read) throw new TypeError('unexpected_read');
			return input.read;
		},
		async apply(request, key) {
			if (!input.apply) throw new TypeError('unexpected_apply');
			return input.apply(request, key);
		}
	};
}

const readSuccess = (data: SubmissionTriageRowView): SubmissionTriageLiveReadResult<SubmissionTriageRowView> => ({
	kind: 'success', data, correlationId
});

describe('source-neutral Submission Triage workspace adapter', () => {
	test('lists detached factual triage rows without manufacturing aggregate submission fields', async () => {
		const original = page();
		const port = createSubmissionTriageWorkspaceAdapter({
			client: client({ list: { kind: 'success', data: original, correlationId } })
		});
		const listed = await port.list({ tray: 'late' });
		expect(listed).toEqual(original);
		(listed.rows[0]!.source as { title: string }).title = 'consumer-only';
		expect(original.rows[0]!.source.title).toBe('A durable proposal');
		const serialized = JSON.stringify(listed.rows[0]);
		for (const absent of ['email', 'decision', 'notified', 'signals', 'reviewCount']) {
			expect(serialized).not.toContain(`\"${absent}\"`);
		}
		expect(Object.keys(port).sort()).toEqual([
			'list', 'markSpam', 'notSpam', 'read', 'returnToInbox', 'setAside'
		]);
	});

	test('uses cached server query/head guards for every ordinary action', async () => {
		const cases: readonly {
			readonly method: 'setAside' | 'returnToInbox' | 'markSpam' | 'notSpam';
			readonly action: SubmissionTriageAction;
		}[] = [
			{ method: 'setAside', action: 'set_aside' },
			{ method: 'returnToInbox', action: 'return_to_inbox' },
			{ method: 'markSpam', action: 'mark_spam' },
			{ method: 'notSpam', action: 'not_spam' }
		];
		for (const entry of cases) {
			const state = stateForAction(entry.action);
			const source = row(state);
			let captured: { request: SubmissionTriageTransitionInput; key: string } | undefined;
			const port = createSubmissionTriageWorkspaceAdapter({
				client: client({
					list: { kind: 'success', data: page(source), correlationId },
					apply(request, key) {
						captured = { request, key };
						return applied(entry.action);
					}
				}),
				newIdempotencyKey: () => `triage-${entry.action}`
			});
			await port.list();
			await port[entry.method]([submissionId]);
			expect(captured).toEqual({
				key: `triage-${entry.action}`,
				request: {
					action: entry.action,
					submissionIds: [submissionId],
					expectedHeads: [{ submissionId, version: 4 }],
					expectedQueryGuard: { version: 7, digestSha256: digest('a') }
				}
			});
		}
	});

	test('maps a stale query refusal to reviewed copy without leaking detail', async () => {
		const stale: SubmissionTriageLiveApplyResult = {
			kind: 'outcome',
			terminal: false,
			correlationId,
			outcome: {
				class: 'stale_revision',
				kind: 'submission_triage.changed',
				retryable: false,
				subjects: [],
				detail: {
					code: 'stale_query_set',
					action: 'set_aside',
					submissionIds: [submissionId],
					secret: 'never render this'
				},
				detailSchemaVersion: 1
			}
		};
		const port = createSubmissionTriageWorkspaceAdapter({
			client: client({
				read: readSuccess(row()),
				apply: () => stale
			})
		});
		await expect(port.setAside([submissionId])).rejects.toEqual(expect.objectContaining({
			name: 'SubmissionTriageWorkspaceAdapterError',
			code: 'submission_triage.changed',
			message: 'Submissions changed while you were working. Reload this tray and try again.'
		}));
	});

	test('fails pure-live reads visibly instead of falling back to sample state', async () => {
		const port = createSubmissionTriageWorkspaceAdapter({
			client: client({
				list: {
					kind: 'unavailable', operation: 'list', reason: 'operation_not_registered'
				}
			})
		});
		await expect(port.list()).rejects.toBeInstanceOf(SubmissionTriageWorkspaceAdapterError);
		try {
			await port.list();
		} catch (error) {
			expect(error).toMatchObject({ code: 'operation_not_registered' });
			expect(String(error)).not.toContain('sample');
		}
	});
});
