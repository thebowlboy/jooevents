import type { OperatorOperationEvidenceVerifier } from './operator-operations';
import type { ReturnTypeOrPromise } from './types';

interface BetterAuthSessionView {
  readonly session: {
    readonly id: string;
    readonly userId: string;
  };
  readonly user: {
    readonly id: string;
  };
}

/** Narrow session-reader seam shared by Bun and Worker transports. */
export interface BetterAuthSessionReader {
  getSession(headers: Headers): ReturnTypeOrPromise<unknown>;
}

function canonicalOrigins(values: readonly string[]): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of values) {
    const parsed = new URL(value);
    if (parsed.origin !== value) throw new TypeError('Operator origin must be a canonical origin.');
    origins.add(value);
  }
  if (origins.size === 0) throw new TypeError('At least one operator origin is required.');
  return origins;
}

function sessionView(value: unknown): BetterAuthSessionView {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid Better Auth session result.');
  const session = (value as { readonly session?: unknown }).session;
  const user = (value as { readonly user?: unknown }).user;
  if (!session || typeof session !== 'object' || !user || typeof user !== 'object') {
    throw new TypeError('Invalid Better Auth session result.');
  }
  const id = (session as { readonly id?: unknown }).id;
  const sessionUserId = (session as { readonly userId?: unknown }).userId;
  const userId = (user as { readonly id?: unknown }).id;
  if (
    typeof id !== 'string' || id.length === 0 || id.length > 255
    || typeof sessionUserId !== 'string' || sessionUserId.length === 0
    || typeof userId !== 'string' || userId.length === 0
    || sessionUserId !== userId
  ) {
    throw new TypeError('Invalid Better Auth session result.');
  }
  return { session: { id, userId: sessionUserId }, user: { id: userId } };
}

/** Converts one currently verified Better Auth session into server-owned operator evidence. */
export function createBetterAuthOperatorEvidenceVerifier(input: {
  readonly sessions: BetterAuthSessionReader;
  readonly allowedOrigins: readonly string[];
}): OperatorOperationEvidenceVerifier {
  const allowedOrigins = canonicalOrigins(input.allowedOrigins);
  const verifier: OperatorOperationEvidenceVerifier = {
    async verify({ request, binding }) {
      if (request.method !== binding.method) return { kind: 'rejected', reason: 'forbidden' };
      if (binding.method === 'POST') {
        const origin = request.headers.get('origin');
        if (!origin || !allowedOrigins.has(origin)) {
          return { kind: 'rejected', reason: 'forbidden' };
        }
      }

      const candidate = await input.sessions.getSession(request.headers);
      if (candidate === null || candidate === undefined) {
        return { kind: 'rejected', reason: 'unauthenticated' };
      }
      const current = sessionView(candidate);
      return {
        kind: 'verified',
        evidence: Object.freeze({
          kind: 'operator' as const,
          surface: 'operator_http' as const,
          client: Object.freeze({ key: 'web.operator' }),
          sessionHandle: current.session.id
        })
      };
    }
  };
  return Object.freeze(verifier);
}
