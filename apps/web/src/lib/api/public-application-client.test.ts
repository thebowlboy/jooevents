import { describe, expect, test } from 'bun:test';
import {
	PUBLIC_APPLICATION_CONTINUATION_HEADER,
	PUBLIC_APPLICATION_FORM_HEADER,
	PUBLIC_APPLICATION_MINT_PATH,
	PUBLIC_APPLICATION_MUTATE_PATH,
	PUBLIC_APPLICATION_RESUME_PATH,
	createPublicApplicationClient,
	newPublicApplicationBootstrap
} from './public-application-client';

const formId = '019c2f22-0000-7000-8000-000000000001';
const draftFormVersionId = '019c2f22-0000-7000-8000-000000000002';
const submissionId = '019c2f22-0000-7000-8000-000000000003';
const receiptId = '019c2f22-0000-7000-8000-000000000004';
const correlationId = '019c2f22-0000-7000-8000-000000000005';
const continuation = `gsr_${'a'.repeat(43)}`;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function draftStatus(version: number) {
	return {
		schemaVersion: 1,
		formId,
		formVersionId: draftFormVersionId,
		draftVersion: version,
		status: 'in_progress',
		answeredFieldIds: [],
		submittedSubmissionId: null,
		updatedAt: '2026-08-14T12:00:00.000Z'
	};
}

function fetcherFor(
	handler: (path: string, init: RequestInit | undefined) => Response
): {
	readonly fetcher: (path: string, init?: RequestInit) => Promise<Response>;
	readonly calls: { path: string; init: RequestInit | undefined }[];
} {
	const calls: { path: string; init: RequestInit | undefined }[] = [];
	return {
		calls,
		fetcher: async (path, init) => {
			calls.push({ path, init });
			return handler(path, init);
		}
	};
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
	return (init?.headers as Record<string, string> | undefined)?.[name];
}

describe('public application client', () => {
	test('mints with the form selector header and maps unavailable to not_available', async () => {
		const { fetcher, calls } = fetcherFor((path) =>
			path === PUBLIC_APPLICATION_MINT_PATH
				? json({ kind: 'unavailable' }, 409)
				: json({}, 500)
		);
		const client = createPublicApplicationClient({ fetcher });
		const bootstrap = newPublicApplicationBootstrap();
		expect(bootstrap).toMatch(/^[A-Za-z0-9_-]{48}$/);
		const minted = await client.mint({ formId, bootstrap });
		expect(minted).toEqual({ kind: 'not_available' });
		expect(calls).toHaveLength(1);
		expect(headerOf(calls[0]!.init, PUBLIC_APPLICATION_FORM_HEADER)).toBe(formId);
		expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ schemaVersion: 1, bootstrap });
	});

	test('an issued mint carries the continuation and its expiry', async () => {
		const { fetcher } = fetcherFor(() =>
			json({ kind: 'issued', continuation, expiresAt: '2026-08-14T12:05:00.000Z' }, 201)
		);
		const client = createPublicApplicationClient({ fetcher });
		expect(await client.mint({ formId, bootstrap: 'b'.repeat(48) })).toEqual({
			kind: 'issued',
			continuation,
			expiresAt: '2026-08-14T12:05:00.000Z'
		});
	});

	test('mutate sends ceremony headers plus the idempotency key and parses each result class', async () => {
		let mode: 'success' | 'outcome' | 'stopped' = 'success';
		const { fetcher, calls } = fetcherFor(() => {
			if (mode === 'success') {
				return json({
					kind: 'success',
					data: { action: 'save', draft: draftStatus(2) },
					receipt: { id: receiptId, operationName: 'application.public.mutate', operationVersion: 1 },
					correlationId
				});
			}
			if (mode === 'outcome') {
				return json({
					kind: 'outcome',
					outcome: {
						class: 'conflict', kind: 'intake.changed', retryable: false,
						subjects: [], detail: null, detailSchemaVersion: 1
					},
					terminal: false,
					correlationId
				});
			}
			return json({ kind: 'transport_error', code: 'not_available' }, 404);
		});
		const client = createPublicApplicationClient({ fetcher });
		const saved = await client.mutate({
			formId,
			continuation,
			idempotencyKey: 'save-1',
			body: { action: 'save', input: { expectedDraftVersion: 1, answers: [] } }
		});
		expect(saved).toMatchObject({ kind: 'success', data: { action: 'save' } });
		expect(calls[0]!.path).toBe(PUBLIC_APPLICATION_MUTATE_PATH);
		expect(headerOf(calls[0]!.init, PUBLIC_APPLICATION_CONTINUATION_HEADER)).toBe(continuation);
		expect(headerOf(calls[0]!.init, 'idempotency-key')).toBe('save-1');
		mode = 'outcome';
		expect(await client.mutate({
			formId, continuation, idempotencyKey: 'save-2',
			body: { action: 'submit', input: { expectedDraftVersion: 2 } }
		})).toMatchObject({
			kind: 'outcome',
			terminal: false,
			outcome: { class: 'conflict', kind: 'intake.changed' }
		});
		mode = 'stopped';
		expect(await client.mutate({
			formId, continuation, idempotencyKey: 'save-3',
			body: { action: 'submit', input: { expectedDraftVersion: 2 } }
		})).toEqual({ kind: 'stopped' });
	});

	test('resume parses the draft projection, and a terminal ceremony replays its submit', async () => {
		let terminal = false;
		const { fetcher, calls } = fetcherFor(() =>
			terminal
				? json({
						kind: 'success',
						data: {
							action: 'submit',
							submission: {
								schemaVersion: 1,
								submissionId,
								formId,
								formVersionId: draftFormVersionId,
								submittedAt: '2026-08-14T12:03:00.000Z'
							}
						},
						receipt: {
							id: receiptId,
							operationName: 'application.public.mutate',
							operationVersion: 1
						},
						correlationId
					})
				: json({
						kind: 'success',
						data: { schemaVersion: 1, draft: draftStatus(2), answers: [] },
						correlationId
					})
		);
		const client = createPublicApplicationClient({ fetcher });
		const resumed = await client.resume({ formId, continuation });
		expect(resumed).toMatchObject({ kind: 'resume', data: { draft: { draftVersion: 2 } } });
		expect(calls[0]!.path).toBe(PUBLIC_APPLICATION_RESUME_PATH);
		expect(calls[0]!.init?.method).toBe('GET');
		terminal = true;
		expect(await client.resume({ formId, continuation })).toMatchObject({
			kind: 'submitted',
			submission: { submissionId }
		});
	});

	test('a network failure is a retryable transport error, never a fabricated refusal', async () => {
		const client = createPublicApplicationClient({
			fetcher: async () => {
				throw new Error('offline');
			}
		});
		expect(await client.mint({ formId, bootstrap: 'c'.repeat(48) })).toEqual({
			kind: 'transport_error',
			error: { code: 'network_unavailable', retryable: true }
		});
		expect(await client.resume({ formId, continuation })).toEqual({
			kind: 'transport_error',
			error: { code: 'network_unavailable', retryable: true }
		});
	});
});
