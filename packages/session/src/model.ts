import {
  sessionCatalogSchema,
  sessionHeadSchema,
  sessionRosterEvidenceSchema,
  sessionScopeSchema,
  type SessionCatalogDto,
  type SessionHeadDto,
  type SessionRosterEvidenceDto,
  type SessionScopeDto
} from '@jooevents/contracts';
import { canonicalJsonSha256 } from '@jooevents/changesets';

export type SessionScope = SessionScopeDto;
export type SessionHead = SessionHeadDto;
export type SessionCatalog = SessionCatalogDto;

export interface SessionReadPort {
  readSessionCatalog(scope: SessionScope): SessionCatalog | undefined;
}

export function sessionRosterDigest(roster: unknown): string {
  return canonicalJsonSha256(roster);
}

export function sessionHeadDigest(head: unknown): string {
  return canonicalJsonSha256(head);
}

export function sessionCatalogDigest(catalog: unknown): string {
  return canonicalJsonSha256(catalog);
}

export function parseSessionScope(value: unknown): SessionScope {
  return deepFreeze(sessionScopeSchema.parse(value));
}

export function parseSessionRosterEvidence(value: unknown): SessionRosterEvidenceDto {
  const roster = sessionRosterEvidenceSchema.parse(value);
  const { digestSha256, ...unsigned } = roster;
  if (sessionRosterDigest(unsigned) !== digestSha256) throw new TypeError('session_roster_digest_mismatch');
  return deepFreeze(roster);
}

export function parseSessionHead(value: unknown): SessionHead {
  const head = sessionHeadSchema.parse(value);
  parseSessionRosterEvidence(head.roster);
  const { digestSha256, ...unsigned } = head;
  if (sessionHeadDigest(unsigned) !== digestSha256) throw new TypeError('session_head_digest_mismatch');
  return deepFreeze(head);
}

export function parseSessionCatalog(value: unknown): SessionCatalog {
  const catalog = sessionCatalogSchema.parse(value);
  for (const head of catalog.sessions) parseSessionHead(head);
  const { digestSha256, ...unsigned } = catalog;
  if (sessionCatalogDigest(unsigned) !== digestSha256) throw new TypeError('session_catalog_digest_mismatch');
  return deepFreeze(catalog);
}

export function createEmptySessionCatalog(scopeInput: SessionScope): SessionCatalog {
  const scope = parseSessionScope(scopeInput);
  const unsigned = { schemaVersion: 1 as const, scope, version: 1, sessions: [] as const };
  return parseSessionCatalog({ ...unsigned, digestSha256: sessionCatalogDigest(unsigned) });
}

export function findSession(catalog: SessionCatalog, sessionId: string): SessionHead | undefined {
  return catalog.sessions.find((session) => session.id === sessionId);
}

export function sameSessionScope(left: SessionScope, right: SessionScope): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

export function sessionRosterCount(head: SessionHead): number {
  return head.roster.participants.length;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
