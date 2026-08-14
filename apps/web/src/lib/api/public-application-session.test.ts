import { describe, expect, test } from 'bun:test';
import type { PublicApplicationDraftStatusDto } from '@jooevents/contracts';
import {
	type PublicApplicationClient,
	type PublicApplicationMintResult,
	type PublicApplicationMutateResult,
	type PublicApplicationResumeResult
} from './public-application-client';
import { createPublicApplicationSession } from './public-application-session';
import { PUBLIC_APPLICATION_TARGET_REOFFER_COPY } from './view-models/public-application';

const formId = '019c2f33-0000-7000-8000-000000000001';
const formVersionId = '019c2f33-0000-7000-8000-000000000002';
const submissionId = '019c2f33-0000-7000-8000-000000000003';
const continuation = `gsr_${'a'.repeat(43)}`;

function draftStatus(version: number): PublicApplicationDraftStatusDto {
	return {
		schemaVersion: 1,
		formId,
		formVersionId,
		draftVersion: version,
		status: 'in_progress',
		answeredFieldIds: [],
		submittedSubmissionId: null,
		updatedAt: '2026-08-14T12:00:00.000Z'
	} as PublicApplicationDraftStatusDto;
}

function outcome(
	klass: 'conflict' | 'policy_violation' | 'idempotency_conflict',
	kind: string
): Extract<PublicApplicationMutateResult, { kind: 'outcome' }> {
	return {
		kind: 'outcome',
		outcome: {
			class: klass, kind, retryable: false,
			subjects: [], detail: null, detailSchemaVersion: 1
		} as Extract<PublicApplicationMutateResult, { kind: 'outcome' }>['outcome'],
		terminal: false
	};
}

interface ScriptedCall {
	readonly kind: 'mint' | 'resume' | 'mutate';
	readonly detail: unknown;
}

function scriptedClient(script: {
	mint?: PublicApplicationMintResult[];
	resume?: PublicApplicationResumeResult[];
	mutate?: PublicApplicationMutateResult[];
}): { readonly client: PublicApplicationClient; readonly calls: ScriptedCall[] } {
	const calls: ScriptedCall[] = [];
	const take = <Value,>(queue: Value[] | undefined, label: string): Value => {
		const value = queue?.shift();
		if (value === undefined) throw new Error(`script exhausted: ${label}`);
		return value;
	};
	return {
		calls,
		client: {
			async mint(input) {
				calls.push({ kind: 'mint', detail: input });
				return take(script.mint, 'mint');
			},
			async resume(input) {
				calls.push({ kind: 'resume', detail: input });
				return take(script.resume, 'resume');
			},
			async mutate(input) {
				calls.push({ kind: 'mutate', detail: input });
				return take(script.mutate, 'mutate');
			}
		}
	};
}

function manualScheduler(): {
	readonly schedule: (run: () => void, delayMs: number) => () => void;
	readonly fire: () => void;
	readonly pendingCount: () => number;
} {
	const pending = new Map<number, () => void>();
	let handle = 0;
	return {
		schedule(run) {
			handle += 1;
			const id = handle;
			pending.set(id, run);
			return () => pending.delete(id);
		},
		fire() {
			const runs = [...pending.values()];
			pending.clear();
			for (const run of runs) run();
		},
		pendingCount: () => pending.size
	};
}

const issued: PublicApplicationMintResult = {
	kind: 'issued', continuation, expiresAt: '2026-08-14T12:05:00.000Z'
};
const begun: PublicApplicationMutateResult = {
	kind: 'success', data: { action: 'begin', draft: draftStatus(1) }
};

describe('public application session', () => {
	test('start mints a fresh ceremony and begins the durable draft', async () => {
		const { client, calls } = scriptedClient({ mint: [issued], mutate: [begun] });
		const session = createPublicApplicationSession({ client, formId });
		const state = await session.start();
		expect(state).toMatchObject({
			phase: 'ready',
			draft: { draftVersion: 1 },
			continuation,
			dirty: false,
			refusal: null
		});
		expect(calls.map((call) => call.kind)).toEqual(['mint', 'mutate']);
	});

	test('editing schedules one autosave that saves the collected answers', async () => {
		const timer = manualScheduler();
		const { client, calls } = scriptedClient({
			mint: [issued],
			mutate: [begun, { kind: 'success', data: { action: 'save', draft: draftStatus(2) } }]
		});
		const session = createPublicApplicationSession({
			client, formId, schedule: timer.schedule
		});
		await session.start();
		session.setAnswer({ kind: 'text', fieldId: formVersionId, value: 'First title' });
		session.setAnswer({ kind: 'text', fieldId: formVersionId, value: 'A better title' });
		expect(session.state().dirty).toBe(true);
		expect(timer.pendingCount()).toBe(1);
		timer.fire();
		await session.flush();
		const state = session.state();
		expect(state).toMatchObject({ phase: 'ready', dirty: false, draft: { draftVersion: 2 } });
		const save = calls.filter((call) => call.kind === 'mutate')[1]!.detail as {
			readonly body: {
				readonly action: string;
				readonly input: { readonly answers: readonly unknown[] };
			};
		};
		expect(save.body.action).toBe('save');
		expect(save.body.input.answers).toEqual([
			{ kind: 'text', fieldId: formVersionId, value: 'A better title' }
		]);
	});

	test('a stale save reconciles from the server and says the draft changed', async () => {
		const timer = manualScheduler();
		const serverAnswers = [
			{ kind: 'text', fieldId: formVersionId, value: 'Server copy' }
		] as const;
		const { client } = scriptedClient({
			mint: [issued],
			mutate: [begun, outcome('conflict', 'intake.changed')],
			resume: [{
				kind: 'resume',
				data: {
					schemaVersion: 1,
					draft: draftStatus(4),
					answers: serverAnswers
				} as never
			}]
		});
		const session = createPublicApplicationSession({
			client, formId, schedule: timer.schedule
		});
		await session.start();
		session.setAnswer({ kind: 'text', fieldId: formVersionId, value: 'Local copy' });
		const state = await session.flush();
		expect(state).toMatchObject({
			phase: 'ready',
			draft: { draftVersion: 4 },
			refusal: { kind: 'draft_changed' },
			answers: serverAnswers
		});
	});

	test('submit flushes unsaved work first and replays the same key across a retry', async () => {
		const timer = manualScheduler();
		const submitted: PublicApplicationMutateResult = {
			kind: 'success',
			data: {
				action: 'submit',
				submission: {
					schemaVersion: 1,
					submissionId,
					formId,
					formVersionId,
					submittedAt: '2026-08-14T12:03:00.000Z'
				} as never
			}
		};
		const { client, calls } = scriptedClient({
			mint: [issued],
			mutate: [
				begun,
				{ kind: 'success', data: { action: 'save', draft: draftStatus(2) } },
				{ kind: 'transport_error', error: { code: 'network_unavailable', retryable: true } },
				submitted
			]
		});
		const session = createPublicApplicationSession({
			client, formId, schedule: timer.schedule
		});
		await session.start();
		session.setAnswer({ kind: 'checkbox', fieldId: formVersionId, checked: true });
		const failed = await session.submit();
		expect(failed).toMatchObject({
			phase: 'ready',
			transport: { code: 'network_unavailable' }
		});
		const retried = await session.submit();
		expect(retried).toMatchObject({ phase: 'submitted', submission: { submissionId } });
		const submits = calls
			.filter((call) => call.kind === 'mutate')
			.map((call) => call.detail as { readonly idempotencyKey: string; readonly body: { readonly action: string } })
			.filter((detail) => detail.body.action === 'submit');
		expect(submits).toHaveLength(2);
		expect(submits[1]!.idempotencyKey).toBe(submits[0]!.idempotencyKey);
	});

	test('a refused submit on a session-targeted form presents the recorded re-offer', async () => {
		const { client } = scriptedClient({
			mint: [issued],
			mutate: [begun, outcome('policy_violation', 'intake.refused')]
		});
		const session = createPublicApplicationSession({
			client,
			formId,
			target: { kind: 'session', sessionId: formVersionId, title: 'Collecting Panel' }
		});
		await session.start();
		const state = await session.submit();
		expect(state.refusal).toEqual({
			kind: 'target_no_longer_collecting',
			headline: PUBLIC_APPLICATION_TARGET_REOFFER_COPY.headline,
			reason: null,
			reasonCode: null,
			exits: PUBLIC_APPLICATION_TARGET_REOFFER_COPY.exits
		});
		expect(state.phase).toBe('ready');
	});

	test('an unpublished surface stops the session with the not-open sentence', async () => {
		const { client } = scriptedClient({ mint: [{ kind: 'not_available' }] });
		const session = createPublicApplicationSession({ client, formId });
		const state = await session.start();
		expect(state).toMatchObject({ phase: 'stopped', refusal: { kind: 'not_open' } });
		session.setAnswer({ kind: 'checkbox', fieldId: formVersionId, checked: true });
		expect(session.state().answers).toEqual([]);
	});

	test('a stopped ceremony mid-flight ends the session as gone, keeping submitted work safe', async () => {
		const timer = manualScheduler();
		const { client } = scriptedClient({
			mint: [issued],
			mutate: [begun, { kind: 'stopped' }]
		});
		const session = createPublicApplicationSession({
			client, formId, schedule: timer.schedule
		});
		await session.start();
		session.setAnswer({ kind: 'checkbox', fieldId: formVersionId, checked: true });
		const state = await session.flush();
		expect(state).toMatchObject({ phase: 'stopped', refusal: { kind: 'session_gone' } });
	});

	test('resuming a handed-off continuation adopts the server draft without minting', async () => {
		const { client, calls } = scriptedClient({
			resume: [{
				kind: 'resume',
				data: { schemaVersion: 1, draft: draftStatus(3), answers: [] } as never
			}]
		});
		const session = createPublicApplicationSession({ client, formId, continuation });
		const state = await session.start();
		expect(state).toMatchObject({ phase: 'ready', draft: { draftVersion: 3 }, continuation });
		expect(calls.map((call) => call.kind)).toEqual(['resume']);
	});
});
