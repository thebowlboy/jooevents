import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  compareAuthoritySubject,
  REVIEWER_CAPABILITY_IDS,
  type ReviewerAuthoritySetDto,
  type ReviewerRosterScopeDto
} from '@jooevents/contracts/reviewer-roster';
import {
  createEmptyReviewerRoster,
  parseReviewerRosterRecord,
  parseReviewerRosterState,
  projectReviewerRosterSnapshot,
  reviewerAuthorityFactDigest,
  reviewerAuthoritySetDigest,
  reviewerRosterDigest
} from '@jooevents/review/roster';
import { parseApplicationId } from '@jooevents/kernel';
import { openSQLite, type OpenSQLiteResult } from './database';
import {
  SQLiteReviewerAuthorityEvidenceError,
  SQLiteReviewerAuthoritySource
} from './reviewer-authority-source';

const id = (suffix: number) => parseApplicationId(
  'user',
  `01890f47-9abc-7def-8123-${suffix.toString(16).padStart(12, '0')}`
);
const workspaceId = id(1);
const otherWorkspaceId = id(2);
const eventA = id(3);
const eventB = id(4);
const otherEvent = id(5);
const userBryn = id(0x10);
const userPartial = id(0x11);
const userEventScoped = id(0x12);
const userDenied = id(0x13);
const userOther = id(0x14);
const membershipBryn = id(0x20);
const membershipPartial = id(0x21);
const membershipEventScoped = id(0x22);
const membershipDenied = id(0x23);
const membershipOther = id(0x24);
const roleReviewer = id(0x30);
const rolePartial = id(0x31);
const roleOtherWorkspace = id(0x32);
const reservationOpen = id(0x60);
const reservationConsumed = id(0x61);
const reservationExpired = id(0x62);
const reservationBare = id(0x63);
const now = '2026-08-13T09:00:00.000Z';
const nowMs = Date.parse(now);
const scopeA: ReviewerRosterScopeDto = Object.freeze({ workspaceId, eventId: eventA });
const opened: OpenSQLiteResult[] = [];

function fixture(): { readonly sqlite: Database; readonly source: SQLiteReviewerAuthoritySource } {
  const result = openSQLite(':memory:');
  opened.push(result);
  const sqlite = result.sqlite;
  sqlite.query(`
    insert into workspaces (id, name, state, created_at, updated_at, version)
    values (?, 'Summit Ops', 'active', ?, ?, 1), (?, 'Other Ops', 'active', ?, ?, 1)
  `).run(workspaceId, nowMs, nowMs, otherWorkspaceId, nowMs, nowMs);
  sqlite.query(`
    insert into events (id, workspace_id, name, created_at, updated_at)
    values (?, ?, 'Summit A', ?, ?), (?, ?, 'Summit B', ?, ?), (?, ?, 'Other', ?, ?)
  `).run(
    eventA, workspaceId, nowMs, nowMs,
    eventB, workspaceId, nowMs, nowMs,
    otherEvent, otherWorkspaceId, nowMs, nowMs
  );
  const insertUser = sqlite.query(`
    insert into users (id, status, display_name, created_at, updated_at, version)
    values (?, 'active', ?, ?, ?, 1)
  `);
  insertUser.run(userBryn, 'Bryn Reviewer', nowMs, nowMs);
  insertUser.run(userPartial, 'Casey Partial', nowMs, nowMs);
  insertUser.run(userEventScoped, 'Drew EventScoped', nowMs, nowMs);
  insertUser.run(userDenied, 'Devon Denied', nowMs, nowMs);
  insertUser.run(userOther, 'Otto Other', nowMs, nowMs);
  const insertMembership = sqlite.query(`
    insert into workspace_memberships (id, workspace_id, user_id, status, created_at, updated_at, version)
    values (?, ?, ?, 'active', ?, ?, ?)
  `);
  insertMembership.run(membershipBryn, workspaceId, userBryn, nowMs, nowMs, 3);
  insertMembership.run(membershipPartial, workspaceId, userPartial, nowMs, nowMs, 1);
  insertMembership.run(membershipEventScoped, workspaceId, userEventScoped, nowMs, nowMs, 1);
  insertMembership.run(membershipDenied, workspaceId, userDenied, nowMs, nowMs, 1);
  insertMembership.run(membershipOther, otherWorkspaceId, userOther, nowMs, nowMs, 1);
  const insertRole = sqlite.query(`
    insert into roles (id, workspace_id, name, description, created_at, updated_at, version)
    values (?, ?, ?, '', ?, ?, 1)
  `);
  insertRole.run(roleReviewer, workspaceId, 'Speaker Reviewer', nowMs, nowMs);
  insertRole.run(rolePartial, workspaceId, 'Almost Reviewer', nowMs, nowMs);
  insertRole.run(roleOtherWorkspace, otherWorkspaceId, 'Speaker Reviewer', nowMs, nowMs);
  const insertRolePermission = sqlite.query(
    'insert into role_permissions (role_id, permission_id) values (?, ?)'
  );
  for (const capability of REVIEWER_CAPABILITY_IDS) {
    insertRolePermission.run(roleReviewer, capability);
    insertRolePermission.run(roleOtherWorkspace, capability);
    if (capability !== 'submission.score') insertRolePermission.run(rolePartial, capability);
  }
  const insertAssignment = sqlite.query(`
    insert into role_assignments
      (id, user_id, role_id, workspace_id, scope_kind, event_id, assigned_at, version)
    values (?, ?, ?, ?, ?, ?, ?, 1)
  `);
  insertAssignment.run(id(0x40), userBryn, roleReviewer, workspaceId, 'workspace', null, nowMs);
  insertAssignment.run(id(0x41), userPartial, rolePartial, workspaceId, 'workspace', null, nowMs);
  insertAssignment.run(id(0x42), userEventScoped, roleReviewer, workspaceId, 'event', eventA, nowMs);
  insertAssignment.run(id(0x43), userDenied, roleReviewer, workspaceId, 'workspace', null, nowMs);
  insertAssignment.run(id(0x44), userOther, roleOtherWorkspace, otherWorkspaceId, 'workspace', null, nowMs);
  sqlite.query(`
    insert into permission_overrides
      (id, user_id, permission_id, effect, workspace_id, scope_kind, event_id,
       reason, decided_at, version)
    values (?, ?, 'submission.comment', 'deny', ?, 'event', ?, 'Investigation hold', ?, 1)
  `).run(id(0x50), userDenied, workspaceId, eventA, nowMs);
  const insertReservation = sqlite.query(`
    insert into access_reservations
      (id, workspace_id, normalized_email, status, expires_at, created_by_user_id,
       consumed_by_user_id, consumed_at, created_at, version)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertReservation.run(
    reservationOpen, workspaceId, 'invitee@example.test', 'open',
    null, userBryn, null, null, nowMs, 1
  );
  insertReservation.run(
    reservationConsumed, workspaceId, 'bryn@example.test', 'consumed',
    null, userBryn, userBryn, nowMs, nowMs, 2
  );
  insertReservation.run(
    reservationExpired, workspaceId, 'late@example.test', 'open',
    nowMs - 1_000, userBryn, null, null, nowMs - 2_000, 1
  );
  insertReservation.run(
    reservationBare, workspaceId, 'bare@example.test', 'open',
    null, userBryn, null, null, nowMs, 1
  );
  const insertReservedAssignment = sqlite.query(`
    insert into reservation_role_assignments (id, reservation_id, role_id, scope_kind, event_id)
    values (?, ?, ?, 'workspace', null)
  `);
  insertReservedAssignment.run(id(0x70), reservationOpen, roleReviewer);
  insertReservedAssignment.run(id(0x71), reservationExpired, roleReviewer);
  return { sqlite, source: new SQLiteReviewerAuthoritySource(sqlite, () => now) };
}

function factFor(set: ReviewerAuthoritySetDto, subjectId: string) {
  return set.facts.find((fact) => fact.rosterSubject.id === subjectId);
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.sqlite.close();
});

describe('SQLite reviewer authority source', () => {
  test('emits subject-keyed facts in canonical order with the exact capability tuple and true digests', () => {
    const { source } = fixture();
    const set = source.readReviewerAuthority(scopeA);
    expect(set).toBeDefined();
    for (let index = 1; index < set!.facts.length; index += 1) {
      expect(compareAuthoritySubject(
        set!.facts[index - 1]!.rosterSubject,
        set!.facts[index]!.rosterSubject
      )).toBeLessThan(0);
    }
    const bryn = factFor(set!, membershipBryn);
    expect(bryn).toMatchObject({
      state: 'active',
      version: 3,
      rosterSubject: { kind: 'workspace_membership', id: membershipBryn, version: 3 },
      currentSubject: { kind: 'workspace_membership', id: membershipBryn, version: 3 },
      displayName: 'Bryn Reviewer'
    });
    expect(bryn?.capabilityIds).toEqual([...REVIEWER_CAPABILITY_IDS]);
    expect(factFor(set!, membershipPartial)).toBeUndefined();
    expect(factFor(set!, membershipDenied)).toBeUndefined();
    expect(factFor(set!, membershipEventScoped)?.state).toBe('active');
    const open = factFor(set!, reservationOpen);
    expect(open).toMatchObject({
      state: 'reserved',
      version: 1,
      rosterSubject: { kind: 'access_reservation', id: reservationOpen, version: 1 },
      currentSubject: { kind: 'access_reservation', id: reservationOpen, version: 1 }
    });
    expect(open && 'displayName' in open && open.displayName !== undefined).toBe(false);
    expect(factFor(set!, reservationExpired)).toBeUndefined();
    expect(factFor(set!, reservationBare)).toBeUndefined();
    for (const fact of set!.facts) {
      const { digestSha256, ...unsigned } = fact;
      expect(digestSha256).toBe(reviewerAuthorityFactDigest(unsigned));
    }
    const { digestSha256, ...unsigned } = set!;
    expect(digestSha256).toBe(reviewerAuthoritySetDigest(unsigned));
  });

  test('never keys or discloses by email: same-address subjects stay distinct and no address leaves', () => {
    const { source } = fixture();
    const set = source.readReviewerAuthority(scopeA)!;
    // bryn@example.test appears on both the consumed reservation and the admitted
    // user; the facts stay keyed by their distinct subject refs.
    expect(factFor(set, reservationConsumed)?.rosterSubject.kind).toBe('access_reservation');
    expect(factFor(set, membershipBryn)?.rosterSubject.kind).toBe('workspace_membership');
    const serialized = JSON.stringify(set);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('example.test');
    expect(serialized).not.toContain('Speaker Reviewer');
  });

  test('unreleasable display names read as absent without failing the workspace authority read', () => {
    const { sqlite, source } = fixture();
    // Provider-sourced names can be schema-legal yet unreleasable: '' satisfies
    // TEXT NOT NULL and reaches storage through provisioning. Neither an
    // unrelated member's empty name nor an eligible reviewer's unreleasable one
    // may take down the read; names degrade to absent while eligibility holds.
    sqlite.query("update users set display_name = '' where id = ?").run(userDenied);
    sqlite.query("update users set display_name = ' Bryn Reviewer ' where id = ?").run(userBryn);
    const set = source.readReviewerAuthority(scopeA)!;
    const bryn = factFor(set, membershipBryn);
    expect(bryn?.state).toBe('active');
    expect(bryn && 'displayName' in bryn && bryn.displayName !== undefined).toBe(false);
    expect(factFor(set, membershipEventScoped)?.displayName).toBe('Drew EventScoped');
  });

  test('holds cross-event and cross-workspace isolation and reads unknown events as unavailable', () => {
    const { source } = fixture();
    const setB = source.readReviewerAuthority({ workspaceId, eventId: eventB })!;
    expect(factFor(setB, membershipEventScoped)).toBeUndefined();
    expect(factFor(setB, membershipBryn)?.state).toBe('active');
    // The deny override is pinned to event A only.
    expect(factFor(setB, membershipDenied)?.state).toBe('active');
    const setOther = source.readReviewerAuthority({
      workspaceId: otherWorkspaceId, eventId: otherEvent
    })!;
    expect(setOther.facts.map((fact) => fact.rosterSubject.id)).toEqual([membershipOther]);
    expect(source.readReviewerAuthority({ workspaceId, eventId: otherEvent })).toBeUndefined();
    expect(source.readReviewerAuthority({ workspaceId, eventId: id(0xff) })).toBeUndefined();
  });

  test('a consumed reservation keeps its original roster subject so invited reviewers stay active', () => {
    const { source } = fixture();
    const promoted = factFor(source.readReviewerAuthority(scopeA)!, reservationConsumed);
    expect(promoted).toMatchObject({
      state: 'active',
      version: 3,
      rosterSubject: { kind: 'access_reservation', id: reservationConsumed, version: 2 },
      currentSubject: { kind: 'workspace_membership', id: membershipBryn, version: 3 },
      displayName: 'Bryn Reviewer'
    });
    const reviewers = [
      parseReviewerRosterRecord({
        schemaVersion: 1, scope: scopeA, reviewerId: id(0x90), version: 1,
        accessSubject: { kind: 'access_reservation', id: reservationConsumed, version: 2 },
        reviews: [], state: 'included', addedByUserId: userBryn, addedAt: now
      }),
      parseReviewerRosterRecord({
        schemaVersion: 1, scope: scopeA, reviewerId: id(0x91), version: 1,
        accessSubject: { kind: 'access_reservation', id: reservationBare, version: 1 },
        reviews: [], state: 'included', addedByUserId: userBryn, addedAt: now
      })
    ];
    const roster = parseReviewerRosterState({
      schemaVersion: 1,
      scope: scopeA,
      version: 3,
      digestSha256: reviewerRosterDigest({ scope: scopeA, version: 3, reviewers }),
      reviewers
    });
    // The snapshot revalidates every digest this source emitted before projecting.
    const snapshot = projectReviewerRosterSnapshot({
      scope: scopeA,
      repository: { readReviewerRoster: () => roster },
      authority: source
    });
    expect(snapshot?.reviewers.map((reviewer) => `${reviewer.reviewerId}:${reviewer.status}`))
      .toEqual([`${id(0x90)}:active`, `${id(0x91)}:revoked`]);
  });

  test('rejects tampered digests and refuses malformed permission evidence', () => {
    const { sqlite, source } = fixture();
    const set = source.readReviewerAuthority(scopeA)!;
    const tampered = structuredClone(set) as { facts: { digestSha256: string }[] };
    tampered.facts[0]!.digestSha256 = 'f'.repeat(64);
    expect(() => projectReviewerRosterSnapshot({
      scope: scopeA,
      repository: { readReviewerRoster: () => createEmptyReviewerRoster(scopeA) },
      authority: { readReviewerAuthority: () => tampered as unknown as ReviewerAuthoritySetDto }
    })).toThrow(TypeError);
    sqlite.query(
      'insert into role_permissions (role_id, permission_id) values (?, ?)'
    ).run(rolePartial, 'not.a.permission');
    expect(() => source.readReviewerAuthority(scopeA))
      .toThrow(SQLiteReviewerAuthorityEvidenceError);
  });

  test('loses eligibility when one capability is dropped and moves version with subject evidence', () => {
    const { sqlite, source } = fixture();
    const before = source.readReviewerAuthority(scopeA)!;
    expect(factFor(before, membershipBryn)).toBeDefined();
    sqlite.query(
      'delete from role_permissions where role_id = ? and permission_id = ?'
    ).run(roleReviewer, 'submission.score');
    const dropped = source.readReviewerAuthority(scopeA)!;
    expect(factFor(dropped, membershipBryn)).toBeUndefined();
    expect(factFor(dropped, reservationOpen)).toBeUndefined();
    expect(dropped.digestSha256).not.toBe(before.digestSha256);
    sqlite.query(
      'insert into role_permissions (role_id, permission_id) values (?, ?)'
    ).run(roleReviewer, 'submission.score');
    sqlite.query(
      'update workspace_memberships set version = version + 1 where id = ?'
    ).run(membershipBryn);
    const bumped = source.readReviewerAuthority(scopeA)!;
    expect(bumped.version).toBe(before.version + 1);
    expect(factFor(bumped, membershipBryn)).toMatchObject({
      version: 4,
      rosterSubject: { kind: 'workspace_membership', id: membershipBryn, version: 4 }
    });
  });
});
