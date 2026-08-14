import {
	createEffectfulOperationResultSchema,
	createReadOperationResultSchema,
	publicApplicationDraftResumeSchema,
	publicApplicationDraftStatusSchema,
	publicApplicationSubmitResultSchema,
	type PublicApplicationDraftResumeDto,
	type PublicApplicationDraftStatusDto,
	type PublicApplicationSubmitResultDto,
	type StructuredOutcome,
	type TransientApplicationAnswersInput
} from '@jooevents/contracts';
import { z } from 'zod';

/**
 * The public application ceremony over HTTP: mint a continuation, then
 * autosave, resume, and submit against the published apply surface.
 *
 * Every request is same-origin and anonymous. The continuation token is the
 * only durable capability; the form id header routes but never grants. A
 * stopped ceremony deliberately arrives as one undifferentiated
 * `not_available` — expired, revoked, rolled back, and never-existed are the
 * same sentence to an outside caller, so this client never invents a finer
 * distinction than the server serves.
 *
 * Paths and header names mirror the server's published ceremony surface
 * (`@jooevents/persistence` intake-public-ceremony); the web app cannot import
 * that package, so the protocol literals live here beside their only consumer.
 */

export const PUBLIC_APPLICATION_MINT_PATH = '/api/public/forms/application/continuations';
export const PUBLIC_APPLICATION_RESUME_PATH = '/api/public/forms/application';
export const PUBLIC_APPLICATION_MUTATE_PATH = '/api/public/forms/application/mutate';
export const PUBLIC_APPLICATION_FORM_HEADER = 'jooevents-form-id';
export const PUBLIC_APPLICATION_CONTINUATION_HEADER = 'jooevents-continuation';

const continuationSchema = z.string().regex(/^gsr_[A-Za-z0-9_-]{43}$/);
const instantSchema = z.iso.datetime({ offset: true });

const mintResponseSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('issued'),
		continuation: continuationSchema,
		expiresAt: instantSchema
	}),
	z.strictObject({ kind: z.literal('already_issued'), expiresAt: instantSchema }),
	z.strictObject({
		kind: z.literal('rejected'),
		reason: z.enum([
			'origin_rejected',
			'csrf_rejected',
			'rate_limited',
			'replay_rejected',
			'verifier_invalid'
		])
	}),
	z.strictObject({ kind: z.literal('unavailable') })
]);

const mutationDataSchema = z.discriminatedUnion('action', [
	z.strictObject({ action: z.literal('begin'), draft: publicApplicationDraftStatusSchema }),
	z.strictObject({ action: z.literal('save'), draft: publicApplicationDraftStatusSchema }),
	z.strictObject({
		action: z.literal('submit'),
		submission: publicApplicationSubmitResultSchema
	})
]);
const mutateResultSchema = createEffectfulOperationResultSchema(mutationDataSchema);
const resumeReadResultSchema = createReadOperationResultSchema(publicApplicationDraftResumeSchema);

const transportBodySchema = z.looseObject({
	kind: z.literal('transport_error'),
	code: z.string().min(1).max(64)
});

export type PublicApplicationMutationData = z.infer<typeof mutationDataSchema>;

export type PublicApplicationMutateBody =
	| { readonly action: 'begin'; readonly input: { readonly formId: string } }
	| {
			readonly action: 'save';
			readonly input: {
				readonly expectedDraftVersion: number;
				readonly answers: TransientApplicationAnswersInput;
			};
	  }
	| { readonly action: 'submit'; readonly input: { readonly expectedDraftVersion: number } };

export interface PublicApplicationTransportFailure {
	readonly code: string;
	readonly retryable: boolean;
}

export type PublicApplicationMintResult =
	| { readonly kind: 'issued'; readonly continuation: string; readonly expiresAt: string }
	| { readonly kind: 'already_issued'; readonly expiresAt: string }
	| {
			readonly kind: 'rejected';
			readonly reason:
				| 'origin_rejected'
				| 'csrf_rejected'
				| 'rate_limited'
				| 'replay_rejected'
				| 'verifier_invalid';
	  }
	| { readonly kind: 'not_available' }
	| { readonly kind: 'transport_error'; readonly error: PublicApplicationTransportFailure };

export type PublicApplicationMutateResult =
	| { readonly kind: 'success'; readonly data: PublicApplicationMutationData }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal: boolean;
	  }
	| { readonly kind: 'stopped' }
	| { readonly kind: 'transport_error'; readonly error: PublicApplicationTransportFailure };

export type PublicApplicationResumeResult =
	| { readonly kind: 'resume'; readonly data: PublicApplicationDraftResumeDto }
	| { readonly kind: 'submitted'; readonly submission: PublicApplicationSubmitResultDto }
	| { readonly kind: 'stopped' }
	| { readonly kind: 'transport_error'; readonly error: PublicApplicationTransportFailure };

export interface PublicApplicationClient {
	mint(input: {
		readonly formId: string;
		readonly bootstrap: string;
	}): Promise<PublicApplicationMintResult>;
	resume(input: {
		readonly formId: string;
		readonly continuation: string;
	}): Promise<PublicApplicationResumeResult>;
	mutate(input: {
		readonly formId: string;
		readonly continuation: string;
		readonly idempotencyKey: string;
		readonly body: PublicApplicationMutateBody;
	}): Promise<PublicApplicationMutateResult>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Fresh client-held mint entropy; equal values replay to one ceremony. */
export function newPublicApplicationBootstrap(
	random: (bytes: number) => Uint8Array = (bytes) =>
		crypto.getRandomValues(new Uint8Array(bytes))
): string {
	const entropy = random(36);
	let binary = '';
	for (const byte of entropy) binary += String.fromCharCode(byte);
	const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
	if (!/^[A-Za-z0-9_-]{48}$/.test(encoded)) {
		throw new TypeError('public_application_bootstrap_invalid');
	}
	return encoded;
}

function transportFailure(code: string, retryable: boolean): {
	readonly kind: 'transport_error';
	readonly error: PublicApplicationTransportFailure;
} {
	return { kind: 'transport_error', error: { code, retryable } };
}

async function readBody(response: Response): Promise<unknown | undefined> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

function stoppedOrTransport(
	response: Response,
	body: unknown
):
	| { readonly kind: 'stopped' }
	| { readonly kind: 'transport_error'; readonly error: PublicApplicationTransportFailure } {
	const transport = transportBodySchema.safeParse(body);
	if (transport.success && transport.data.code === 'not_available') return { kind: 'stopped' };
	if (transport.success) {
		return transportFailure(transport.data.code, response.status >= 500);
	}
	return transportFailure(`http_${response.status}`, response.status >= 500);
}

export function createPublicApplicationClient(
	options: { readonly fetcher?: FetchLike } = {}
): PublicApplicationClient {
	const fetcher: FetchLike = options.fetcher ?? ((input, init) => fetch(input, init));

	async function request(input: {
		readonly path: string;
		readonly method: 'GET' | 'POST';
		readonly headers: Record<string, string>;
		readonly body?: unknown;
	}): Promise<{ readonly response: Response; readonly body: unknown | undefined } | {
		readonly kind: 'transport_error';
		readonly error: PublicApplicationTransportFailure;
	}> {
		try {
			const response = await fetcher(input.path, {
				method: input.method,
				headers: {
					accept: 'application/json',
					'x-correlation-id': crypto.randomUUID(),
					...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
					...input.headers
				},
				...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
				cache: 'no-store'
			});
			return { response, body: await readBody(response) };
		} catch {
			return transportFailure('network_unavailable', true);
		}
	}

	return Object.freeze({
		async mint(input: { readonly formId: string; readonly bootstrap: string }) {
			const exchanged = await request({
				path: PUBLIC_APPLICATION_MINT_PATH,
				method: 'POST',
				headers: { [PUBLIC_APPLICATION_FORM_HEADER]: input.formId },
				body: { schemaVersion: 1, bootstrap: input.bootstrap }
			});
			if ('kind' in exchanged) return exchanged;
			const parsed = mintResponseSchema.safeParse(exchanged.body);
			if (!parsed.success) {
				const fallback = stoppedOrTransport(exchanged.response, exchanged.body);
				return fallback.kind === 'stopped' ? { kind: 'not_available' as const } : fallback;
			}
			if (parsed.data.kind === 'unavailable') return { kind: 'not_available' as const };
			return parsed.data;
		},

		async resume(input: { readonly formId: string; readonly continuation: string }) {
			const exchanged = await request({
				path: PUBLIC_APPLICATION_RESUME_PATH,
				method: 'GET',
				headers: {
					[PUBLIC_APPLICATION_FORM_HEADER]: input.formId,
					[PUBLIC_APPLICATION_CONTINUATION_HEADER]: input.continuation
				}
			});
			if ('kind' in exchanged) return exchanged;
			const read = resumeReadResultSchema.safeParse(exchanged.body);
			if (read.success) {
				if (read.data.kind === 'success') {
					return { kind: 'resume' as const, data: read.data.data };
				}
				return stoppedOrTransport(exchanged.response, exchanged.body);
			}
			// A terminal ceremony replays its committed submit result here.
			const replay = mutateResultSchema.safeParse(exchanged.body);
			if (replay.success && replay.data.kind === 'success'
				&& replay.data.data.action === 'submit') {
				return { kind: 'submitted' as const, submission: replay.data.data.submission };
			}
			return stoppedOrTransport(exchanged.response, exchanged.body);
		},

		async mutate(input: {
			readonly formId: string;
			readonly continuation: string;
			readonly idempotencyKey: string;
			readonly body: PublicApplicationMutateBody;
		}) {
			const exchanged = await request({
				path: PUBLIC_APPLICATION_MUTATE_PATH,
				method: 'POST',
				headers: {
					[PUBLIC_APPLICATION_FORM_HEADER]: input.formId,
					[PUBLIC_APPLICATION_CONTINUATION_HEADER]: input.continuation,
					'idempotency-key': input.idempotencyKey
				},
				body: input.body
			});
			if ('kind' in exchanged) return exchanged;
			const parsed = mutateResultSchema.safeParse(exchanged.body);
			if (!parsed.success) return stoppedOrTransport(exchanged.response, exchanged.body);
			if (parsed.data.kind === 'success') {
				return { kind: 'success' as const, data: parsed.data.data };
			}
			return {
				kind: 'outcome' as const,
				outcome: parsed.data.outcome,
				terminal: parsed.data.terminal === true
			};
		}
	});
}
