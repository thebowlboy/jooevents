import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import type { ProgramVocabularyScopeDto } from '@jooevents/contracts';
import { encodeCanonicalJson } from '@jooevents/kernel';
import {
  createProgramVocabularyState,
  type ProgramReferenceContributorRef,
  type ProgramReferenceContributorSnapshot,
  type ProgramVocabularyState,
  ProgramVocabularyPlanningError
} from '@jooevents/program';
import type { SQLiteProgramVocabularyTrialStore } from './program-vocabulary-trial';

function changedExactlyOnce(result: { readonly changes: number }): void {
  if (result.changes !== 1) throw new ProgramVocabularyPlanningError('stale_reference');
}

function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

export function seedProgramVocabularyTrialStateForTest(
  sqlite: Database,
  state: ProgramVocabularyState
): void {
  if (sqlite.inTransaction) throw new TypeError('program_vocabulary_trial_nested_seed');
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    sqlite.query<never, [string, string, number]>(`
      INSERT INTO program_vocabulary_trial_sets (workspace_id, event_id, set_version)
      VALUES (?, ?, ?)
    `).run(state.scope.workspaceId, state.scope.eventId, state.setVersion);
    for (const room of state.rooms) {
      sqlite.query<never, [string, string, string, string, number | null, string, number]>(`
        INSERT INTO program_vocabulary_trial_rooms (
          workspace_id, event_id, id, name, capacity, status, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        state.scope.workspaceId, state.scope.eventId, room.id, room.name,
        room.capacity, room.status, room.version
      );
    }
    for (const track of state.tracks) {
      sqlite.query<never, [string, string, string, string, string, number]>(`
        INSERT INTO program_vocabulary_trial_tracks (
          workspace_id, event_id, id, name, status, version
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        state.scope.workspaceId, state.scope.eventId, track.id, track.name,
        track.status, track.version
      );
    }
    for (const format of state.formats) {
      sqlite.query<never, [string, string, string, string, string, number]>(`
        INSERT INTO program_vocabulary_trial_formats (
          workspace_id, event_id, id, name, status, version
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        state.scope.workspaceId, state.scope.eventId, format.id, format.name,
        format.status, format.version
      );
    }
    sqlite.exec('COMMIT;');
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

export function seedProgramVocabularyTrialContributorForTest(
  sqlite: Database,
  snapshot: ProgramReferenceContributorSnapshot
): void {
  if (sqlite.inTransaction) throw new TypeError('program_vocabulary_trial_nested_seed');
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    sqlite.query<never, [string, string, string, number, string, number, string]>(`
      INSERT INTO program_vocabulary_trial_test_contributors (
        workspace_id, event_id, contributor_key, contributor_version,
        guard_id, guard_version, guard_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.scope.workspaceId,
      snapshot.scope.eventId,
      snapshot.contributor.key,
      snapshot.contributor.version,
      snapshot.guard.id,
      snapshot.guard.version,
      snapshot.guard.digest
    );
    for (const reference of snapshot.references) {
      sqlite.query<never, [string, string, string, number, string, number, string, string, string, string, string]>(`
        INSERT INTO program_vocabulary_trial_test_references (
          workspace_id, event_id, contributor_key, contributor_version,
          reference_key, reference_version, item_kind, item_id,
          reference_mode, destination_kind, destination_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.scope.workspaceId,
        snapshot.scope.eventId,
        snapshot.contributor.key,
        snapshot.contributor.version,
        reference.referenceKey,
        reference.version,
        reference.item.kind,
        reference.item.id,
        reference.mode,
        reference.destination.kind,
        reference.destination.id
      );
    }
    sqlite.exec('COMMIT;');
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

export function rewriteProgramVocabularyTrialReferenceForTest(input: {
  readonly sqlite: Database;
  readonly store: SQLiteProgramVocabularyTrialStore;
  readonly scope: ProgramVocabularyScopeDto;
  readonly contributor: ProgramReferenceContributorRef;
  readonly referenceKey: string;
  readonly to: { readonly kind: 'room' | 'track' | 'format'; readonly id: string };
}): void {
  const { sqlite } = input;
  if (sqlite.inTransaction) throw new TypeError('program_vocabulary_trial_nested_reference_edit');
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    changedExactlyOnce(sqlite.query<never, [string, string, string, string, string, number, string]>(`
      UPDATE program_vocabulary_trial_test_references
         SET item_kind = ?, item_id = ?, reference_version = reference_version + 1
       WHERE workspace_id = ? AND event_id = ?
         AND contributor_key = ? AND contributor_version = ?
         AND reference_key = ? AND reference_mode = 'current'
    `).run(
      input.to.kind,
      input.to.id,
      input.scope.workspaceId,
      input.scope.eventId,
      input.contributor.key,
      input.contributor.version,
      input.referenceKey
    ));
    const snapshot = input.store.readContributor(
      input.contributor,
      createProgramVocabularyState({ scope: input.scope, setVersion: 1 }).scope
    ) as ProgramReferenceContributorSnapshot | undefined;
    if (!snapshot) throw new ProgramVocabularyPlanningError('stale_reference');
    const guardVersion = snapshot.guard.version + 1;
    const guardDigest = canonicalDigest({
      contributor: snapshot.contributor,
      guardVersion,
      references: snapshot.references
    });
    changedExactlyOnce(sqlite.query<never, [number, string, string, string, string, number, number, string]>(`
      UPDATE program_vocabulary_trial_test_contributors
         SET guard_version = ?, guard_digest = ?
       WHERE workspace_id = ? AND event_id = ?
         AND contributor_key = ? AND contributor_version = ?
         AND guard_version = ? AND guard_digest = ?
    `).run(
      guardVersion,
      guardDigest,
      input.scope.workspaceId,
      input.scope.eventId,
      input.contributor.key,
      input.contributor.version,
      snapshot.guard.version,
      snapshot.guard.digest
    ));
    sqlite.exec('COMMIT;');
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}
