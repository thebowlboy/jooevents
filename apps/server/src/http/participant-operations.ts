import {
  assertApplicationOperationRuntime,
  type ApplicationOperationRuntime,
  type RegisteredParticipantHttpEffectBinding,
  type RegisteredParticipantHttpReadBinding
} from '@jooevents/application';
import { safeOperationManifestSchema } from '@jooevents/contracts';
import { Hono } from 'hono';
import { createParticipantEffectHttpAdapter } from './effect-operation-adapter';
import { createParticipantReadHttpAdapter } from './read-operation-adapter';
import type { ReturnTypeOrPromise } from './types';

type ParticipantBinding =
  | RegisteredParticipantHttpReadBinding
  | RegisteredParticipantHttpEffectBinding;

export type ParticipantOperationEvidenceResult =
  | { readonly kind: 'verified'; readonly evidence: unknown }
  | { readonly kind: 'rejected'; readonly reason: 'unauthenticated' | 'forbidden' };

export interface ParticipantOperationEvidenceVerifier {
  verify(input: {
    readonly request: Request;
    readonly correlationId: string;
    readonly binding: ParticipantBinding;
  }): ReturnTypeOrPromise<ParticipantOperationEvidenceResult>;
}

export interface ParticipantOperationsHttpRuntime {
  readonly operations: ApplicationOperationRuntime;
  readonly evidence: ParticipantOperationEvidenceVerifier;
}

/**
 * The participant lane owns `/api/portal/*` except the server-owned entry
 * ceremony routes under `/api/portal/entry/`, which never ride operation
 * bindings.
 */
export function isParticipantOperationPath(path: string): boolean {
  return path.startsWith('/api/portal/') && !path.startsWith('/api/portal/entry/');
}

function assertParticipantBindings(registry: ApplicationOperationRuntime['registry']): void {
  const manifest = safeOperationManifestSchema.parse(registry.safeManifest);
  if (manifest.registryDigestSha256 !== registry.manifestDigestSha256) {
    throw new TypeError('Operation manifest digest does not match its registry.');
  }
  const paths = [
    ...registry.participantHttpBindings.map((binding) => binding.path),
    ...registry.participantHttpEffectBindings.map((binding) => binding.path)
  ];
  if (paths.some((path) => !isParticipantOperationPath(path))) {
    throw new TypeError(
      'A participant operation binding must remain under /api/portal/ outside /api/portal/entry/.'
    );
  }
}

/** Mounts exactly the registry's declared participant bindings. */
export function createParticipantOperationsHttpAdapter(input: ParticipantOperationsHttpRuntime) {
  assertApplicationOperationRuntime(input.operations);
  const { registry, readExecutor, effectBuilder, effectExecutor } = input.operations;
  assertParticipantBindings(registry);

  const app = new Hono();
  app.route('/', createParticipantReadHttpAdapter({
    registry,
    executor: readExecutor,
    evidence: { verify: (request) => input.evidence.verify(request) }
  }));
  app.route('/', createParticipantEffectHttpAdapter({
    registry,
    builder: effectBuilder,
    executor: effectExecutor,
    evidence: { verify: (request) => input.evidence.verify(request) }
  }));
  return app;
}
