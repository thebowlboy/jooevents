import {
  OperationInputError,
  type ReadOperationExecutor,
  type ReadOperationRegistry,
  type RegisteredOperatorHttpReadBinding
} from '@jooevents/application';
import {
  correlationIdSchema,
  operationTransportErrorSchema,
  readOperationResultSchema
} from '@jooevents/contracts';
import { Hono } from 'hono';
import type { ReturnTypeOrPromise } from './types';

export type OperatorProtocolEvidenceResult =
  | { readonly kind: 'verified'; readonly evidence: unknown }
  | { readonly kind: 'rejected'; readonly reason: 'unauthenticated' | 'forbidden' };

export interface OperatorProtocolEvidenceVerifier {
  verify(input: {
    readonly request: Request;
    readonly correlationId: string;
    readonly binding: RegisteredOperatorHttpReadBinding;
  }): ReturnTypeOrPromise<OperatorProtocolEvidenceResult>;
}

function queryInput(request: Request): Record<string, string | readonly string[]> {
  const values: Record<string, string | readonly string[]> = Object.create(null) as Record<string, string | readonly string[]>;
  const search = new URL(request.url).searchParams;
  for (const key of new Set(search.keys())) {
    const candidates = search.getAll(key);
    values[key] = candidates.length === 1 ? candidates[0] as string : candidates;
  }
  return values;
}

function correlationId(request: Request): string {
  const incoming = correlationIdSchema.safeParse(request.headers.get('x-correlation-id'));
  return incoming.success ? incoming.data : crypto.randomUUID();
}

export function createOperatorReadHttpAdapter(input: {
  readonly registry: ReadOperationRegistry;
  readonly executor: ReadOperationExecutor;
  readonly evidence: OperatorProtocolEvidenceVerifier;
}) {
  const app = new Hono();

  app.use('*', async (context, next) => {
    const id = correlationId(context.req.raw);
    context.set('operationCorrelationId' as never, id as never);
    context.header('x-correlation-id', id);
    context.header('cache-control', 'no-store, max-age=0');
    context.header('pragma', 'no-cache');
    await next();
  });

  for (const binding of input.registry.operatorHttpBindings) {
    app.get(binding.path, async (context) => {
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
          businessInput: queryInput(context.req.raw),
          verifiedEvidence: evidence.evidence
        });
        const parsed = readOperationResultSchema.safeParse(result);
        if (!parsed.success) throw new TypeError('Executor returned an invalid read result.');
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
