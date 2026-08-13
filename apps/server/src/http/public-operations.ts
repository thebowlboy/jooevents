import {
  assertApplicationOperationRuntime,
  type ApplicationOperationRuntime,
  type RegisteredPublicHttpEffectBinding,
  type RegisteredPublicHttpReadBinding
} from '@jooevents/application';
import { safeOperationManifestSchema } from '@jooevents/contracts';
import { Hono } from 'hono';
import { createPublicEffectHttpAdapter } from './effect-operation-adapter';
import { createPublicReadHttpAdapter } from './read-operation-adapter';
import type { ReturnTypeOrPromise } from './types';

type PublicBinding = RegisteredPublicHttpReadBinding | RegisteredPublicHttpEffectBinding;

export type PublicOperationEvidenceResult =
  | { readonly kind: 'verified'; readonly evidence: unknown }
  | { readonly kind: 'rejected'; readonly reason: 'unauthenticated' | 'forbidden' };

export interface PublicOperationEvidenceVerifier {
  verify(input: {
    readonly request: Request;
    readonly correlationId: string;
    readonly binding: PublicBinding;
  }): ReturnTypeOrPromise<PublicOperationEvidenceResult>;
}

export interface PublicOperationsHttpRuntime {
  readonly operations: ApplicationOperationRuntime;
  readonly evidence: PublicOperationEvidenceVerifier;
}

export function isPublicOperationPath(path: string): boolean {
  return path.startsWith('/api/public/');
}

function assertPublicRegistry(registry: ApplicationOperationRuntime['registry']): void {
  const manifest = safeOperationManifestSchema.parse(registry.safeManifest);
  if (manifest.registryDigestSha256 !== registry.manifestDigestSha256) {
    throw new TypeError('Operation manifest digest does not match its registry.');
  }
  const paths = [
    ...registry.publicHttpBindings.map((binding) => binding.path),
    ...registry.publicHttpEffectBindings.map((binding) => binding.path)
  ];
  if (paths.some((path) => !isPublicOperationPath(path))) {
    throw new TypeError('A public operation binding must remain under /api/public/.');
  }
}

/**
 * Mounts only an exact registry's declared public bindings. Ordinary server
 * composition deliberately does not call this factory.
 */
export function createPublicOperationsHttpAdapter(input: PublicOperationsHttpRuntime) {
  assertApplicationOperationRuntime(input.operations);
  const { registry, readExecutor, effectBuilder, effectExecutor } = input.operations;
  assertPublicRegistry(registry);

  const app = new Hono();
  app.route('/', createPublicReadHttpAdapter({
    registry,
    executor: readExecutor,
    evidence: { verify: (request) => input.evidence.verify(request) }
  }));
  app.route('/', createPublicEffectHttpAdapter({
    registry,
    builder: effectBuilder,
    executor: effectExecutor,
    evidence: { verify: (request) => input.evidence.verify(request) }
  }));
  return app;
}
