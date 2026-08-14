import {
  getCompiledReadOperation,
  OperationInputError,
  type ReadOperationExecutor,
  type ReadOperationRegistry,
  type RegisteredOperatorHttpReadBinding,
  type RegisteredParticipantHttpReadBinding,
  type RegisteredPublicHttpReadBinding
} from '@jooevents/application';
import {
  correlationIdSchema,
  operationTransportErrorSchema,
  readOperationResultSchema
} from '@jooevents/contracts';
import { Hono } from 'hono';
import { createSchemaAwareQueryInputDecoder } from './schema-aware-query-input';
import type { ReturnTypeOrPromise } from './types';

type HttpReadBinding =
  | RegisteredOperatorHttpReadBinding
  | RegisteredParticipantHttpReadBinding
  | RegisteredPublicHttpReadBinding;

export type ReadProtocolEvidenceResult =
  | { readonly kind: 'verified'; readonly evidence: unknown }
  | { readonly kind: 'rejected'; readonly reason: 'unauthenticated' | 'forbidden' };

export interface ReadProtocolEvidenceVerifier<Binding extends HttpReadBinding = HttpReadBinding> {
  verify(input: {
    readonly request: Request;
    readonly correlationId: string;
    readonly binding: Binding;
  }): ReturnTypeOrPromise<ReadProtocolEvidenceResult>;
}

export type OperatorProtocolEvidenceResult = ReadProtocolEvidenceResult;
export type OperatorProtocolEvidenceVerifier =
  ReadProtocolEvidenceVerifier<RegisteredOperatorHttpReadBinding>;
export type ParticipantReadProtocolEvidenceVerifier =
  ReadProtocolEvidenceVerifier<RegisteredParticipantHttpReadBinding>;
export type PublicReadProtocolEvidenceVerifier =
  ReadProtocolEvidenceVerifier<RegisteredPublicHttpReadBinding>;

function correlationId(request: Request, shared?: unknown): string {
  const inherited = correlationIdSchema.safeParse(shared);
  if (inherited.success) return inherited.data;
  const incoming = correlationIdSchema.safeParse(request.headers.get('x-correlation-id'));
  return incoming.success ? incoming.data : crypto.randomUUID();
}

function createReadHttpAdapter<Binding extends HttpReadBinding>(input: {
  readonly registry: ReadOperationRegistry;
  readonly bindings: readonly Binding[];
  readonly executor: ReadOperationExecutor;
  readonly evidence: ReadProtocolEvidenceVerifier<Binding>;
}) {
  const app = new Hono();

  app.use('*', async (context, next) => {
    const id = correlationId(
      context.req.raw,
      context.get('correlationId' as never) as unknown
    );
    context.set('operationCorrelationId' as never, id as never);
    context.header('x-correlation-id', id);
    context.header('cache-control', 'no-store, max-age=0');
    context.header('pragma', 'no-cache');
    await next();
  });

  const routes = input.bindings.map((binding) => {
    const resolved = getCompiledReadOperation(
      input.registry,
      binding.operationName,
      binding.operationVersion,
      binding.surface
    );
    if (!resolved) throw new TypeError('Registered read binding is unavailable.');
    try {
      return {
        binding,
        query: createSchemaAwareQueryInputDecoder(resolved.operation.inputSchema.schema)
      } as const;
    } catch (error) {
      throw new TypeError(
        `Registered GET query input is unsupported for ${binding.operationName}@${binding.operationVersion}.`,
        { cause: error }
      );
    }
  });

  for (const { binding, query } of routes) {
    app.get(binding.path, async (context) => {
      if (context.req.method !== 'GET') return context.body(null, 405);
      const id = context.res.headers.get('x-correlation-id') ?? crypto.randomUUID();
      try {
        const evidence = await input.evidence.verify({ request: context.req.raw, correlationId: id, binding });
        if (evidence.kind === 'rejected') {
          if (evidence.reason === 'unauthenticated') {
            return context.json(operationTransportErrorSchema.parse({
              kind: 'transport_error', code: 'unauthenticated', retryable: false, correlationId: id
            }), 401);
          }
          return context.json(operationTransportErrorSchema.parse({
            kind: 'transport_error', code: 'forbidden', retryable: false, correlationId: id
          }), 403);
        }
        if (evidence.kind !== 'verified') throw new TypeError('Invalid evidence-verifier result.');

        const result = await input.executor.execute({
          operationName: binding.operationName,
          operationVersion: binding.operationVersion,
          surface: binding.surface,
          correlationId: id,
          businessInput: query.decode(new URL(context.req.url).searchParams),
          verifiedEvidence: evidence.evidence
        });
        const parsed = readOperationResultSchema.safeParse(result);
        if (!parsed.success || parsed.data.correlationId !== id) {
          throw new TypeError('Executor returned an invalid read result.');
        }
        return context.json(parsed.data);
      } catch (error) {
        if (error instanceof OperationInputError) {
          return context.json(operationTransportErrorSchema.parse({
            kind: 'transport_error', code: 'invalid_request', retryable: false, correlationId: id
          }), 400);
        }
        return context.json(operationTransportErrorSchema.parse({
          kind: 'transport_error', code: 'internal_error', retryable: true, correlationId: id
        }), 500);
      }
    });
  }

  return app;
}

export function createOperatorReadHttpAdapter(input: {
  readonly registry: ReadOperationRegistry;
  readonly executor: ReadOperationExecutor;
  readonly evidence: OperatorProtocolEvidenceVerifier;
}) {
  return createReadHttpAdapter({
    registry: input.registry,
    bindings: input.registry.operatorHttpBindings,
    executor: input.executor,
    evidence: input.evidence
  });
}

export function createParticipantReadHttpAdapter(input: {
  readonly registry: ReadOperationRegistry;
  readonly executor: ReadOperationExecutor;
  readonly evidence: ParticipantReadProtocolEvidenceVerifier;
}) {
  return createReadHttpAdapter({
    registry: input.registry,
    bindings: input.registry.participantHttpBindings,
    executor: input.executor,
    evidence: input.evidence
  });
}

export function createPublicReadHttpAdapter(input: {
  readonly registry: ReadOperationRegistry;
  readonly executor: ReadOperationExecutor;
  readonly evidence: PublicReadProtocolEvidenceVerifier;
}) {
  return createReadHttpAdapter({
    registry: input.registry,
    bindings: input.registry.publicHttpBindings,
    executor: input.executor,
    evidence: input.evidence
  });
}
