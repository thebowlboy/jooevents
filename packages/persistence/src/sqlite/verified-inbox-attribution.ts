import type { Instant, SourceConnectionId, UserId, WorkspaceId } from '@jooevents/kernel';

/** Human connector owner retained where a domain event still requires a user id. */
export interface SQLiteVerifiedInboxAttributionResolver {
  resolve(input: Readonly<{
    sourceConnectionId: SourceConnectionId;
    workspaceId: WorkspaceId;
    eventId: string;
    evaluatedAt: Instant;
  }>): UserId | undefined;
}
