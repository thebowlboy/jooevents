import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import type { ApiResult } from '../../client';
import {
	createParticipantEntryLiveClient,
	PARTICIPANT_ENTRY_PATHS,
	type ParticipantEntryRequester
} from './entry-client';

interface RecordedCall {
	readonly path: string;
	readonly method?: 'GET' | 'POST';
	readonly body?: unknown;
	readonly schema: z.ZodType<unknown>;
	readonly signal?: AbortSignal;
}

function stubRequester(payloads: Readonly<Record<string, unknown>>) {
	const calls: RecordedCall[] = [];
	const request = (async (input: {
		readonly path: string;
		readonly schema: z.ZodType<unknown>;
		readonly method?: 'GET' | 'POST';
		readonly body?: unknown;
		readonly signal?: AbortSignal;
	}) => {
		calls.push(input);
		const payload = payloads[input.path];
		if (payload === undefined) {
			return {
				kind: 'error',
				error: { code: 'http_404', retryable: false }
			} satisfies ApiResult<never>;
		}
		// The stub honors the client's own schema so a drifted contract fails
		// here exactly as the real transport would refuse it.
		const parsed = input.schema.safeParse(payload);
		if (!parsed.success) {
			return {
				kind: 'error',
				error: { code: 'invalid_contract', retryable: true }
			} satisfies ApiResult<never>;
		}
		return { kind: 'success', data: parsed.data };
	}) as ParticipantEntryRequester;
	return { calls, request };
}

describe('participant entry live client', () => {
	test('reads the participant context over its reserved same-origin path', async () => {
		const { calls, request } = stubRequester({
			[PARTICIPANT_ENTRY_PATHS.context]: { state: 'anonymous' }
		});
		const client = createParticipantEntryLiveClient(request);
		expect(await client.getContext()).toEqual({
			kind: 'success',
			data: { state: 'anonymous' }
		});
		expect(calls[0]).toMatchObject({ path: '/api/me/participant-context' });
		expect(calls[0]!.method).toBeUndefined();
	});

	test('an active context passes through with participant and event intact', async () => {
		const active = {
			state: 'active',
			participant: { id: 'per-1', displayName: 'Maya Kern', email: 'maya@example.test' },
			event: {
				id: 'evt-1',
				name: 'JooConf 2026',
				timezone: 'Europe/Helsinki',
				cfpClosesAt: '2026-09-01T12:00:00.000Z',
				closePolicy: 'soft'
			}
		};
		const { request } = stubRequester({ [PARTICIPANT_ENTRY_PATHS.context]: active });
		const client = createParticipantEntryLiveClient(request);
		expect(await client.getContext()).toEqual({ kind: 'success', data: active as never });
	});

	test('the link request posts the address and accepts only the one non-enumerating shape', async () => {
		const { calls, request } = stubRequester({
			[PARTICIPANT_ENTRY_PATHS.requestLink]: { outcome: 'link_requested' }
		});
		const client = createParticipantEntryLiveClient(request);
		expect(await client.requestLink({ email: 'maya@example.test' })).toEqual({
			kind: 'success',
			data: { outcome: 'link_requested' }
		});
		expect(calls[0]).toMatchObject({
			path: '/api/portal/entry/link',
			method: 'POST',
			body: { email: 'maya@example.test' }
		});
	});

	test('an answer that claims anything beyond the acknowledgement is refused as contract drift', async () => {
		const { request } = stubRequester({
			[PARTICIPANT_ENTRY_PATHS.requestLink]: { outcome: 'link_requested', addressKnown: true }
		});
		const client = createParticipantEntryLiveClient(request);
		expect(await client.requestLink({ email: 'maya@example.test' })).toEqual({
			kind: 'error',
			error: { code: 'invalid_contract', retryable: true }
		});
	});

	test('completing a link exchanges the token once and keeps every named outcome', async () => {
		for (const outcome of ['signed_in', 'link_expired', 'link_used', 'link_invalid'] as const) {
			const { calls, request } = stubRequester({
				[PARTICIPANT_ENTRY_PATHS.completeLink]: { outcome }
			});
			const client = createParticipantEntryLiveClient(request);
			expect(await client.completeLink({ token: 'plt1_example' })).toEqual({
				kind: 'success',
				data: { outcome }
			});
			expect(calls[0]).toMatchObject({
				path: '/api/portal/entry/complete',
				method: 'POST',
				body: { token: 'plt1_example' }
			});
		}
	});

	test('signing out posts to the participant lane and expects the server to say it happened', async () => {
		const { calls, request } = stubRequester({
			[PARTICIPANT_ENTRY_PATHS.signOut]: { signedOut: true }
		});
		const client = createParticipantEntryLiveClient(request);
		expect(await client.signOut()).toEqual({ kind: 'success', data: { signedOut: true } });
		expect(calls[0]).toMatchObject({
			path: '/api/portal/entry/sign-out',
			method: 'POST',
			body: {}
		});
	});

	test('an unserved route stays an honest transport error, never a fabricated answer', async () => {
		const { request } = stubRequester({});
		const client = createParticipantEntryLiveClient(request);
		expect(await client.requestLink({ email: 'maya@example.test' })).toEqual({
			kind: 'error',
			error: { code: 'http_404', retryable: false }
		});
	});
});
