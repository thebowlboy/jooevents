import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { FormDefinitionCreateDraftInput } from '@jooevents/contracts';
import {
  applyFormMutationPlan,
  parseFormCatalogState,
  planFormCreation,
  planFormLifecycleChange
} from '@jooevents/intake';
import { installDeadlineSchema } from './deadline';
import {
  initializeCanonicalFieldRegistry,
  installFieldRegistrySchema
} from './field-registry';
import {
  installSQLiteIntakeSchema,
  SQLiteIntakeRepository,
  type SQLiteIntakeSubmissionProjectionPort
} from './intake';
import { installProgramVocabularySchema } from './program-vocabulary';

const id = (suffix: number): string =>
  `01890f47-9abc-7def-8123-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = id(1);
const eventId = id(2);
const userId = id(3);
const formId = id(4);
const formVersionId = id(5);
const at1 = '2026-08-12T10:00:00.000Z';
const at2 = '2026-08-12T10:01:00.000Z';

function openDatabase(): { readonly sqlite: Database; readonly repository: SQLiteIntakeRepository } {
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE event_spine_scope_roots (
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, event_id)
    ) STRICT, WITHOUT ROWID;
    INSERT INTO users (id) VALUES ('${userId}');
    INSERT INTO event_spine_scope_roots (workspace_id, event_id)
      VALUES ('${workspaceId}', '${eventId}');
  `);
  installProgramVocabularySchema(sqlite);
  installSQLiteIntakeSchema(sqlite);
  installFieldRegistrySchema(sqlite);
  installDeadlineSchema(sqlite);
  let next = 0x100;
  sqlite.exec('BEGIN IMMEDIATE;');
  initializeCanonicalFieldRegistry({
    sqlite,
    scope: { workspaceId, eventId },
    ids: {
      newFieldId: () => id(next++),
      newChoiceId: () => id(next++)
    }
  });
  sqlite.exec('COMMIT;');
  const repository = new SQLiteIntakeRepository(sqlite, {
    resolveActiveCategory() { return undefined; }
  });
  return { sqlite, repository };
}

function createInput(excludedFieldIds: readonly string[]): FormDefinitionCreateDraftInput {
  return {
    expectedCatalogVersion: 1,
    expectedRegistryVersion: 1,
    definition: {
      kind: 'cfp',
      name: 'Main CFP',
      target: { kind: 'general_pool' },
      availability: { kind: 'evergreen' },
      confirmation: 'Application received.',
      composition: { excludedFieldIds: [...excludedFieldIds], requiredOverrides: {}, optionExposure: {} },
      rules: []
    }
  };
}

describe('ephemeral SQLite Intake repository', () => {
  test('refuses an unauthenticated structural submission projection', () => {
    const { sqlite } = openDatabase();
    try {
      const forged = Object.freeze({
        projectSummary() { return Object.freeze({}); },
        projectDetail() { return Object.freeze({}); },
        resolveContact() { return Object.freeze({}); },
        resolveDraftResume() { return Object.freeze({}); }
      }) as unknown as SQLiteIntakeSubmissionProjectionPort;
      expect(() => new SQLiteIntakeRepository(sqlite, {
        resolveActiveCategory() { return undefined; }
      }, forged)).toThrow('intake_projection_invalid');
    } finally {
      sqlite.close();
    }
  });

  test('stores one Registry-composed head and an immutable first-open FormVersion atomically', () => {
    const { sqlite, repository } = openDatabase();
    try {
      const scope = { workspaceId, eventId };
      const catalog = parseFormCatalogState({ scope, version: 1, heads: [] });
      const registry = repository.readFieldRegistrySnapshot(scope)!;
      const choiceFieldIds = registry.fields
        .filter((field) => field.mapsTo === 'talk.track' || field.mapsTo === 'talk.format')
        .map((field) => field.id);
      expect(choiceFieldIds).toHaveLength(2);
      const create = planFormCreation({
        catalog,
        registry,
        authorInput: createInput(choiceFieldIds),
        identities: { formId, rules: [] },
        references: repository,
        deadlineContribution: null,
        server: { createdByUserId: userId, createdAt: at1 }
      });
      const created = applyFormMutationPlan({
        catalog, registry, plan: create, references: repository
      }).catalog;
      const open = planFormLifecycleChange({
        head: create.after,
        registry,
        existingVersions: [],
        authorInput: {
          transition: 'publish_and_open',
          formId,
          expectedDefinitionVersion: 1,
          expectedRegistryVersion: registry.version
        },
        references: repository,
        server: {
          formVersionId,
          updatedByUserId: userId,
          updatedAt: at2
        }
      });
      expect(open.publishedVersion?.registryPin).toEqual({
        version: registry.version,
        digestSha256: registry.registryDigestSha256
      });
      expect(open.publishedVersion?.definition.fields.some((field) =>
        field.mapsTo === 'person.email'
      )).toBe(true);

      expect(() => repository.applyFormMutation(create)).toThrow('transaction_required');
      sqlite.exec('BEGIN IMMEDIATE;');
      repository.applyFormMutation(create);
      repository.applyFormMutation(open);
      sqlite.exec('COMMIT;');

      expect(repository.readFormHead(scope, formId)).toEqual(open.after);
      expect(repository.readFormVersion(scope, formVersionId)).toEqual(open.publishedVersion ?? undefined);
      expect(repository.readFormCatalog(scope)).toEqual({
        ...created,
        version: created.version + 1,
        heads: [open.after]
      });
      expect(repository.readServedForm(scope, formId)?.fields.some((field) =>
        field.id === registry.fields.find((candidate) => candidate.mapsTo === 'person.email')?.id
      )).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
