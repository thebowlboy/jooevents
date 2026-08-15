import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { TemplateArtifactDocumentDto, TemplateArtifactScopeDto } from '@jooevents/contracts';
import { planTemplateArtifactMutation } from '@jooevents/template-authoring';
import {
  installTemplateAuthoringSchema,
  SQLiteTemplateAuthoringError,
  SQLiteTemplateAuthoringRepository
} from './template-authoring';

const scope: TemplateArtifactScopeDto = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  eventId: '00000000-0000-4000-8000-000000000002'
};
const actor = '00000000-0000-4000-8000-000000000003';
const artifactId = '00000000-0000-4000-8000-000000000004';

function message(subject = 'Welcome'): TemplateArtifactDocumentDto {
  return {
    kind: 'message', key: 'welcome-message', name: 'Welcome', purpose: 'Welcomes a participant.',
    subject, blocks: [{ type: 'paragraph', text: 'Hello {{person.name}}' }],
    mergeFields: [{ key: 'person.name', label: 'Name', sample: 'Ada' }], usedBy: ['Invitations']
  };
}

function database(): Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE event_spine_scope_roots (
      workspace_id TEXT NOT NULL, event_id TEXT NOT NULL,
      PRIMARY KEY(workspace_id,event_id)
    ) STRICT, WITHOUT ROWID;
    INSERT INTO event_spine_scope_roots VALUES (
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    );
  `);
  installTemplateAuthoringSchema(sqlite);
  return sqlite;
}

describe('SQLite template authoring repository', () => {
  test('seeds in the event transaction and applies an immutable successor atomically', () => {
    const sqlite = database();
    const repository = new SQLiteTemplateAuthoringRepository(sqlite);
    sqlite.transaction(() => repository.initializeCreatedEvent({
      scope,
      createdByUserId: actor,
      createdAt: '2026-08-15T00:00:00.000Z',
      artifacts: [{
        artifactId,
        revisionId: '00000000-0000-4000-8000-000000000005',
        document: message()
      }]
    })).immediate();
    const before = repository.readArtifact(scope, artifactId)!;
    const plan = planTemplateArtifactMutation({
      scope,
      current: before,
      mutation: {
        action: 'replace', artifactId, expectedRevisionNumber: 1,
        document: message('A warmer welcome'), author: 'organizer', note: 'Adjusted subject'
      },
      revisionId: '00000000-0000-4000-8000-000000000006',
      actorUserId: actor,
      occurredAt: '2026-08-15T00:01:00.000Z'
    });
    const after = sqlite.transaction(() => repository.applyMutation(plan)).immediate();
    expect(after.head.version).toBe(2);
    expect(after.history.map((revision) => revision.number)).toEqual([1, 2]);
    expect(sqlite.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM template_artifact_revisions'
    ).get()?.count).toBe(2);
  });

  test('requires one outer unit of work and rejects stale plans without partial history', () => {
    const sqlite = database();
    const repository = new SQLiteTemplateAuthoringRepository(sqlite);
    expect(() => repository.initializeCreatedEvent({
      scope, createdByUserId: actor, createdAt: '2026-08-15T00:00:00.000Z',
      artifacts: [{
        artifactId, revisionId: '00000000-0000-4000-8000-000000000005', document: message()
      }]
    })).toThrow(new SQLiteTemplateAuthoringError('transaction_required'));

    sqlite.transaction(() => repository.initializeCreatedEvent({
      scope, createdByUserId: actor, createdAt: '2026-08-15T00:00:00.000Z',
      artifacts: [{
        artifactId, revisionId: '00000000-0000-4000-8000-000000000005', document: message()
      }]
    })).immediate();
    const before = repository.readArtifact(scope, artifactId)!;
    const plan = planTemplateArtifactMutation({
      scope, current: before,
      mutation: {
        action: 'replace', artifactId, expectedRevisionNumber: 1,
        document: message('Changed'), author: 'organizer', note: 'Changed'
      },
      revisionId: '00000000-0000-4000-8000-000000000006', actorUserId: actor,
      occurredAt: '2026-08-15T00:01:00.000Z'
    });
    sqlite.transaction(() => repository.applyMutation(plan)).immediate();
    expect(() => sqlite.transaction(() => repository.applyMutation(plan)).immediate())
      .toThrow(new SQLiteTemplateAuthoringError('stale_revision'));
    expect(repository.readArtifact(scope, artifactId)?.history).toHaveLength(2);
  });
});
