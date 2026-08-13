import {
  OperationInputError,
  type EffectInvocationBuilder,
  type EffectOperationExecutor,
  type OperationRegistry,
  type RegisteredOperatorHttpEffectBinding,
  type RegisteredPublicHttpEffectBinding
} from '@jooevents/application';
import {
  correlationIdSchema,
  effectfulOperationResultSchema,
  operationHttpIdempotencyKeySchema,
  operationTransportErrorSchema
} from '@jooevents/contracts';
import { Hono } from 'hono';
import type { ReturnTypeOrPromise } from './types';

const maxJsonBodyBytes = 1024 * 1024;

type HttpEffectBinding = RegisteredOperatorHttpEffectBinding | RegisteredPublicHttpEffectBinding;

export type EffectProtocolEvidenceResult =
  | { readonly kind: 'verified'; readonly evidence: unknown }
  | { readonly kind: 'rejected'; readonly reason: 'unauthenticated' | 'forbidden' };

export interface EffectProtocolEvidenceVerifier<Binding extends HttpEffectBinding = HttpEffectBinding> {
  verify(input: {
    readonly request: Request;
    readonly correlationId: string;
    readonly binding: Binding;
  }): ReturnTypeOrPromise<EffectProtocolEvidenceResult>;
}

export type OperatorEffectProtocolEvidenceResult = EffectProtocolEvidenceResult;
export type OperatorEffectProtocolEvidenceVerifier =
  EffectProtocolEvidenceVerifier<RegisteredOperatorHttpEffectBinding>;
export type PublicEffectProtocolEvidenceVerifier =
  EffectProtocolEvidenceVerifier<RegisteredPublicHttpEffectBinding>;

function correlationId(request: Request, shared?: unknown): string {
  const inherited = correlationIdSchema.safeParse(shared);
  if (inherited.success) return inherited.data;
  const incoming = correlationIdSchema.safeParse(request.headers.get('x-correlation-id'));
  return incoming.success ? incoming.data : crypto.randomUUID();
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function idempotencyKey(request: Request): string | undefined {
  const candidate = operationHttpIdempotencyKeySchema.safeParse(
    request.headers.get('idempotency-key')
  );
  return candidate.success ? candidate.data : undefined;
}

async function boundedJsonBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxJsonBodyBytes)) {
    throw new OperationInputError();
  }
  if (!request.body) throw new OperationInputError();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      byteLength += part.value.byteLength;
      if (byteLength > maxJsonBodyBytes) {
        await reader.cancel();
        throw new OperationInputError();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new OperationInputError();
  }
}

function createEffectHttpAdapter<Binding extends HttpEffectBinding>(input: {
  readonly bindings: readonly Binding[];
  readonly builder: EffectInvocationBuilder;
  readonly executor: EffectOperationExecutor;
  readonly evidence: EffectProtocolEvidenceVerifier<Binding>;
}) {
  const app = new Hono();

  app.use('*', async (context, next) => {
    const id = correlationId(
      context.req.raw,
      context.get('correlationId' as never) as unknown
    );
    context.header('x-correlation-id', id);
    context.header('cache-control', 'no-store, max-age=0');
    context.header('pragma', 'no-cache');
    await next();
  });

  for (const binding of input.bindings) {
    app.post(binding.path, async (context) => {
      const id = context.res.headers.get('x-correlation-id') ?? crypto.randomUUID();
      try {
        const rawIdempotencyKey = idempotencyKey(context.req.raw);
        if (!rawIdempotencyKey || !isJsonRequest(context.req.raw)) throw new OperationInputError();

        const evidence = await input.evidence.verify({ request: context.req.raw, correlationId: id, binding });
        if (evidence.kind === 'rejected') {
          const status = evidence.reason === 'unauthenticated' ? 401 : 403;
          return context.json(operationTransportErrorSchema.parse({
            kind: 'transport_error', code: evidence.reason, retryable: false, correlationId: id
          }), status);
        }
        if (evidence.kind !== 'verified') throw new TypeError('Invalid evidence-verifier result.');

        const businessInput = await boundedJsonBody(context.req.raw);
        const invocation = await input.builder.build({
          operationName: binding.operationName,
          operationVersion: binding.operationVersion,
          surface: binding.surface,
          correlationId: id,
          businessInput,
          verifiedEvidence: evidence.evidence,
          rawIdempotencyKey
        });
        const result = await input.executor.execute(invocation);
        const parsed = effectfulOperationResultSchema.safeParse(result);
        if (!parsed.success) {
          throw new TypeError('Executor returned an invalid effect result.');
        }
        return context.json(parsed.data);
      } catch (error) {
        if (error instanceof OperationInputError) {
          return context.json(operationTransportErrorSchema.parse({
            kind: 'transport_error', code: 'invalid_request', retryable: false, correlationId: id
          }), 400);
        }
        return context.json(operationTransportErrorSchema.parse({
          // The adapter cannot infer whether an effect was accepted from an exception.
          kind: 'transport_error', code: 'internal_error', retryable: false, correlationId: id
        }), 500);
      }
    });
  }

  return app;
}

export function createOperatorEffectHttpAdapter(input: {
  readonly registry: OperationRegistry;
  readonly builder: EffectInvocationBuilder;
  readonly executor: EffectOperationExecutor;
  readonly evidence: OperatorEffectProtocolEvidenceVerifier;
}) {
  return createEffectHttpAdapter({
    bindings: input.registry.operatorHttpEffectBindings,
    builder: input.builder,
    executor: input.executor,
    evidence: input.evidence
  });
}

export function createPublicEffectHttpAdapter(input: {
  readonly registry: OperationRegistry;
  readonly builder: EffectInvocationBuilder;
  readonly executor: EffectOperationExecutor;
  readonly evidence: PublicEffectProtocolEvidenceVerifier;
}) {
  return createEffectHttpAdapter({
    bindings: input.registry.publicHttpEffectBindings,
    builder: input.builder,
    executor: input.executor,
    evidence: input.evidence
  });
}
