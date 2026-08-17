import type { Database } from 'bun:sqlite';
import {
  createOperatorAuthorityPolicyCatalog,
  createOperatorCurrentAuthorityResolver,
  type CurrentOperatorSessionRepository,
  type EffectAuthorityRecheckSource,
  type OperatorAuthorityPolicyCatalog,
  type OperatorAuthorityPolicyRegistration
} from '@jooevents/application';
import type { Clock, WorkspaceId } from '@jooevents/kernel';
import {
  createSQLiteOperatorAuthorityPersistence,
  createSQLiteTransactionBoundOperatorAuthorityPersistence,
  type SQLiteOperatorEventRelationshipSource,
  type SQLiteOperatorSubjectRelationshipSource
} from '@jooevents/persistence';

export interface SQLiteOperatorAuthorityComposition {
  readonly policies: OperatorAuthorityPolicyCatalog;
  readonly resolver: ReturnType<typeof createOperatorCurrentAuthorityResolver>;
  readonly transactionResolver: ReturnType<typeof createOperatorCurrentAuthorityResolver>;
  readonly effectRecheckSource: EffectAuthorityRecheckSource;
}

/**
 * Composes operator authority from one caller-owned SQLite connection. The resolver
 * never refreshes a web session or performs network work; every call reloads durable
 * session, scope, membership, role, assignment, and override evidence.
 */
export function createSQLiteOperatorAuthorityComposition(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly policies: readonly OperatorAuthorityPolicyRegistration[];
  readonly clock: Clock;
  readonly eventRelationships?: SQLiteOperatorEventRelationshipSource;
  readonly additionalSubjectRelationships?: SQLiteOperatorSubjectRelationshipSource;
  /** Server-minted, process-local evidence for an approved action step. */
  readonly internalSessions?: CurrentOperatorSessionRepository;
}): SQLiteOperatorAuthorityComposition {
  const policies = createOperatorAuthorityPolicyCatalog(input.policies);
  const persistence = createSQLiteOperatorAuthorityPersistence({
    sqlite: input.sqlite,
    workspaceId: input.workspaceId,
    ...(input.eventRelationships === undefined
      ? {}
      : { eventRelationships: input.eventRelationships }),
    ...(input.additionalSubjectRelationships === undefined
      ? {}
      : { additionalSubjectRelationships: input.additionalSubjectRelationships })
  });
  const sessions = input.internalSessions === undefined
    ? persistence.sessions
    : Object.freeze({
        async resolveCurrent(
          request: Parameters<CurrentOperatorSessionRepository['resolveCurrent']>[0]
        ) {
          const internal = await input.internalSessions!.resolveCurrent(request);
          return internal.kind === 'current'
            ? internal
            : persistence.sessions.resolveCurrent(request);
        }
      }) satisfies CurrentOperatorSessionRepository;
  const resolver = createOperatorCurrentAuthorityResolver({
    workspaceId: input.workspaceId,
    policies,
    sessions,
    memberships: persistence.memberships,
    authorization: persistence.authorization,
    scopeRelationships: persistence.scopeRelationships
  });
  const transactionPersistence = createSQLiteTransactionBoundOperatorAuthorityPersistence({
    sqlite: input.sqlite,
    workspaceId: input.workspaceId,
    ...(input.eventRelationships === undefined
      ? {}
      : { eventRelationships: input.eventRelationships }),
    ...(input.additionalSubjectRelationships === undefined
      ? {}
      : { additionalSubjectRelationships: input.additionalSubjectRelationships })
  });
  const transactionSessions = input.internalSessions === undefined
    ? transactionPersistence.sessions
    : Object.freeze({
        async resolveCurrent(
          request: Parameters<CurrentOperatorSessionRepository['resolveCurrent']>[0]
        ) {
          const internal = await input.internalSessions!.resolveCurrent(request);
          return internal.kind === 'current'
            ? internal
            : transactionPersistence.sessions.resolveCurrent(request);
        }
      }) satisfies CurrentOperatorSessionRepository;
  const rawTransactionResolver = createOperatorCurrentAuthorityResolver({
    workspaceId: input.workspaceId,
    policies,
    sessions: transactionSessions,
    memberships: transactionPersistence.memberships,
    authorization: transactionPersistence.authorization,
    scopeRelationships: transactionPersistence.scopeRelationships
  });
  const transactionResolver: ReturnType<typeof createOperatorCurrentAuthorityResolver> =
    Object.freeze({
      resolve: (resolutionInput: Parameters<typeof rawTransactionResolver.resolve>[0]) => {
        transactionPersistence.assertInTransaction();
        return rawTransactionResolver.resolve(resolutionInput);
      }
    });
  const effectRecheckSource = Object.freeze({
    resolveAuthority: transactionResolver.resolve,
    now: input.clock.now.bind(input.clock)
  });
  return Object.freeze({ policies, resolver, transactionResolver, effectRecheckSource });
}
