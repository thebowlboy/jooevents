import {
  hashApiKey,
  isWellFormedApiKey,
  type ApiKeyRecord,
  type ApiKeyStore
} from '@jooevents/identity-access';
import { parseInstant, type WorkspaceId } from '@jooevents/kernel';
import type { InvocationEvidence } from '@jooevents/application';

const INVALID_API_KEY_CANARY = `jooak1_${'A'.repeat(43)}`;

export type ExternalAgentCapability = 'read' | 'submit_plans';

export type ApiKeyEvidenceResult =
  | {
      readonly kind: 'verified';
      readonly key: ApiKeyRecord;
      readonly evidence: Extract<InvocationEvidence, { readonly kind: 'external_mcp' }>;
    }
  | { readonly kind: 'rejected'; readonly reason: 'unauthenticated' | 'forbidden' };

function bearerCredential(request: Request): { readonly raw: string; readonly wellFormed: boolean } {
  const authorization = request.headers.get('authorization');
  const parts = authorization?.split(' ') ?? [];
  const raw = parts.length === 2 && parts[0] === 'Bearer' ? parts[1]! : INVALID_API_KEY_CANARY;
  return { raw, wellFormed: parts.length === 2 && parts[0] === 'Bearer' && isWellFormedApiKey(raw) };
}

/**
 * Bearer-only external-agent authentication. Every failure performs one hash
 * and one indexed lookup before returning the same rejection vocabulary.
 */
export function createApiKeyEvidenceVerifier(input: {
  readonly workspaceId: WorkspaceId;
  readonly apiKeys: ApiKeyStore;
  readonly now: () => string;
  /** Current workspace admission is checked before any capability is accepted. */
  readonly ownerIsCurrent: (key: ApiKeyRecord, evaluatedAt: string) => boolean;
  readonly coalesceLastUsedWithinMs?: number;
}) {
  const coalesceWithinMs = input.coalesceLastUsedWithinMs ?? 60_000;
  if (!Number.isSafeInteger(coalesceWithinMs) || coalesceWithinMs < 0) {
    throw new TypeError('api_key_last_used_coalesce_invalid');
  }
  return Object.freeze({
    verify(request: Request, capability: ExternalAgentCapability): ApiKeyEvidenceResult {
      const candidate = bearerCredential(request);
      const evaluatedAt = parseInstant(input.now());
      const resolution = input.apiKeys.resolveByTokenHash({
        tokenHashSha256: hashApiKey(candidate.raw),
        workspaceId: input.workspaceId,
        evaluatedAt
      });
      if (!candidate.wellFormed || resolution.kind !== 'current') {
        return Object.freeze({ kind: 'rejected' as const, reason: 'unauthenticated' as const });
      }
      const key = resolution.key;
      if (!input.ownerIsCurrent(key, evaluatedAt)) {
        return Object.freeze({ kind: 'rejected' as const, reason: 'unauthenticated' as const });
      }
      if ((capability === 'read' && !key.mayRead)
          || (capability === 'submit_plans' && !key.maySubmitPlans)) {
        return Object.freeze({ kind: 'rejected' as const, reason: 'forbidden' as const });
      }
      input.apiKeys.recordUse({ apiKeyId: key.apiKeyId, usedAt: evaluatedAt, coalesceWithinMs });
      return Object.freeze({
        kind: 'verified' as const,
        key,
        evidence: Object.freeze({
          kind: 'external_mcp' as const,
          surface: 'external_mcp' as const,
          client: Object.freeze({ key: 'api.v1' }),
          credentialHandle: key.apiKeyId,
          clientKey: `api-key:${key.apiKeyId}`
        })
      });
    }
  });
}
