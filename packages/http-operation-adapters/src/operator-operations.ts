import type {
  ApplicationOperationRuntime,
  RegisteredOperatorHttpEffectBinding,
  RegisteredOperatorHttpReadBinding
} from '@jooevents/application';
import { assertApplicationOperationRuntime } from '@jooevents/application';
import { safeOperationManifestSchema } from '@jooevents/contracts';
import { Hono } from 'hono';
import { createOperatorEffectHttpAdapter } from './effect-operation-adapter';
import { createOperatorReadHttpAdapter } from './read-operation-adapter';
import type { ReturnTypeOrPromise } from './types';

type OperatorBinding = RegisteredOperatorHttpReadBinding | RegisteredOperatorHttpEffectBinding;

export type OperatorOperationEvidenceResult =
  | { readonly kind: 'verified'; readonly evidence: unknown }
  | { readonly kind: 'rejected'; readonly reason: 'unauthenticated' | 'forbidden' };

export interface OperatorOperationEvidenceVerifier {
  verify(input: {
    readonly request: Request;
    readonly correlationId: string;
    readonly binding: OperatorBinding;
  }): ReturnTypeOrPromise<OperatorOperationEvidenceResult>;
}

export interface OperatorOperationsHttpRuntime {
  readonly operations: ApplicationOperationRuntime;
  readonly evidence: OperatorOperationEvidenceVerifier;
}

const reservedExactPaths = new Set([
  '/api/auth',
  '/api/entry',
  '/api/me/access-context',
  '/api/me/participant-context',
  '/api/agent-actions',
  '/api/communications/email-readiness/check',
  '/api/communications/email-diagnostic/send-test',
  '/api/communications/email-deliverability/check',
  '/api/communications/email-setup-guide',
  '/api/integrations/airtable',
  '/api/events/current/integrations/accelevents/locations.csv',
  '/api/events/current/integrations/accelevents/package.zip',
  '/api/openapi.json',
  '/api/operations/manifest',
  '/api/public'
]);
const reservedPrefixes = [
  '/api/auth/',
  '/api/entry/',
  '/api/agent-actions/',
  '/api/me/participant-context/',
  '/api/operations/manifest/',
  '/api/public/',
  '/api/portal/entry/',
  '/api/workspace/api-key-secrets/',
  '/api/integrations/airtable/',
  '/api/v1/'
];

export function isServerOwnedOperationPath(path: string): boolean {
  return reservedExactPaths.has(path)
    || reservedPrefixes.some((prefix) => path.startsWith(prefix));
}

function assertOperatorRegistry(registry: ApplicationOperationRuntime['registry']): void {
  const manifest = safeOperationManifestSchema.parse(registry.safeManifest);
  if (manifest.registryDigestSha256 !== registry.manifestDigestSha256) {
    throw new TypeError('Operation manifest digest does not match its registry.');
  }
  const paths = [
    ...registry.operatorHttpBindings.map((binding) => binding.path),
    ...registry.operatorHttpEffectBindings.map((binding) => binding.path)
  ];
  if (paths.some(isServerOwnedOperationPath)) {
    throw new TypeError('An operation binding cannot replace a server-owned route.');
  }
}

/** Mounts the exact registry's operator bindings and its browser-safe manifest only. */
export function createOperatorOperationsHttpAdapter(input: OperatorOperationsHttpRuntime) {
  assertApplicationOperationRuntime(input.operations);
  const { registry, readExecutor, effectBuilder, effectExecutor } = input.operations;
  assertOperatorRegistry(registry);
  const app = new Hono();
  const manifest = safeOperationManifestSchema.parse(registry.safeManifest);

  app.get('/api/operations/manifest', (context) => {
    context.header('cache-control', 'no-store, max-age=0');
    context.header('pragma', 'no-cache');
    context.header('etag', `"${registry.manifestDigestSha256}"`);
    return context.json(manifest);
  });

  app.route('/', createOperatorReadHttpAdapter({
    registry,
    executor: readExecutor,
    evidence: {
      verify: (request) => input.evidence.verify(request)
    }
  }));
  app.route('/', createOperatorEffectHttpAdapter({
    registry,
    builder: effectBuilder,
    executor: effectExecutor,
    evidence: {
      verify: (request) => input.evidence.verify(request)
    }
  }));
  return app;
}
