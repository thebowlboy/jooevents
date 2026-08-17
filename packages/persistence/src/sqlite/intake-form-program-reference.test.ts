import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { FormDefinitionCreateDraftInput } from '@jooevents/contracts';
import {
  applyFormMutationPlan,
  parseFormCatalogState,
  planFormCreation,
  planFormLifecycleChange,
  planFormRevision,
  type FormDefinitionIdentityAssignment,
  type FormTargetReferenceResolver
} from '@jooevents/intake';
import {
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  captureRegisteredProgramReferences,
  createProgramReferenceContributorRegistry,
  applyProgramReferenceRepoints,
  planProgramVocabularyMutation,
  programReferenceUsage,
  resolveProgramVocabularyItem,
  type ProgramMergeCompensationInput,
  type ProgramReferenceContributionPlan,
  type ProgramVocabularyMutationPlan
} from '@jooevents/program';
import { installEventSpineSchema } from './event-spine';
import { initializeCanonicalFieldRegistry, installFieldRegistrySchema } from './field-registry';
import {
  createSQLiteIntakeFormProgramVocabularyReferenceAdapter,
  INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR
} from './intake-form-program-reference';
import { installSQLiteIntakeSchema, SQLiteIntakeRepository } from './intake';
import { installDeadlineSchema } from './deadline';
import {
  createSQLiteProgramVocabularyContributorAdapterRegistry,
  installProgramVocabularySchema,
  SQLiteProgramVocabularyRepository
} from './program-vocabulary';

const id = (suffix: number): string =>
  `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId(id(1));
const userId = parseUserId(id(2));
const sourceTrackId = id(3);
const targetTrackId = id(4);
const formId = id(5);
const formVersionId = id(6);
const ruleId = id(7);
const createdAt = parseInstant('2026-08-12T08:00:00.000Z');
const formCreatedAt = parseInstant('2026-08-12T09:00:00.000Z');
const formPublishedAt = parseInstant('2026-08-12T09:01:00.000Z');
const formOpenedAt = parseInstant('2026-08-12T09:02:00.000Z');
const mergedAt = parseInstant('2026-08-12T10:00:00.000Z');
const compensatedAt = parseInstant('2026-08-12T11:00:00.000Z');
const mergedAgainAt = parseInstant('2026-08-12T12:00:00.000Z');
const reconciledAt = parseInstant('2026-08-12T13:00:00.000Z');

function definition(
  trackId: string,
  trackFieldId: string,
  titleFieldId: string,
  formatFieldId: string
): FormDefinitionCreateDraftInput['definition'] {
  return {
    kind: 'cfp',
    name: 'Track CFP',
    target: { kind: 'category', category: { kind: 'track', id: trackId } },
    availability: { kind: 'evergreen' },
    confirmation: 'Application received.',
    composition: {
      excludedFieldIds: [formatFieldId],
      requiredOverrides: {},
      optionExposure: { [trackFieldId]: [trackId] }
    },
    rules: [{
      key: 'track_title_visibility',
      condition: { kind: 'selected_any', sourceFieldId: trackFieldId, choiceIds: [trackId] },
      effect: { kind: 'show', targetFieldIds: [titleFieldId] }
    }]
  };
}

function identities(): FormDefinitionIdentityAssignment {
  return {
    formId,
    rules: [{ key: 'track_title_visibility', id: ruleId }]
  };
}

function setup() {
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    INSERT INTO workspaces VALUES ('${workspaceId}', 'Workspace', 'active', 1, 1, 1);
    INSERT INTO users VALUES ('${userId}', 'active', 'Operator', 1, 1, 1);
  `);
  installEventSpineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSQLiteIntakeSchema(sqlite);
  installFieldRegistrySchema(sqlite);
  installDeadlineSchema(sqlite);
  sqlite.query(`
    INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, NULL)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Intake Event', 'UTC', '2027-01-01', '2027-01-02', 1, ?, ?, ?)
  `).run(workspaceId, eventId, userId, Date.parse(createdAt), 'a'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, eventId);
  sqlite.query(`
    UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ?
     WHERE workspace_id = ?
  `).run(eventId, workspaceId);

  let registrySuffix = 0x2000;
  const registry = transaction(sqlite, () => initializeCanonicalFieldRegistry({
    sqlite, scope: { workspaceId, eventId },
    ids: {
      newFieldId: () => id(registrySuffix++),
      newChoiceId: () => id(registrySuffix++)
    }
  }));
  const trackFieldId = registry.fields.find((field) => field.mapsTo === 'talk.track')?.id;
  const formatFieldId = registry.fields.find((field) => field.mapsTo === 'talk.format')?.id;
  const titleFieldId = registry.fields.find((field) => field.mapsTo === 'talk.title')?.id;
  if (!trackFieldId || !formatFieldId || !titleFieldId) {
    throw new TypeError('baseline_registry_incomplete');
  }

  const referenceAdapter = createSQLiteIntakeFormProgramVocabularyReferenceAdapter();
  const referenceRegistry = createProgramReferenceContributorRegistry({
    expected: [INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR],
    contributors: [INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR]
  });
  const contributorAdapters = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite,
    expected: [INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR],
    adapters: [referenceAdapter]
  });
  let vocabularyAt = createdAt;
  const vocabulary = new SQLiteProgramVocabularyRepository(
    sqlite,
    referenceRegistry,
    contributorAdapters,
    () => ({ actorUserId: userId, occurredAt: vocabularyAt })
  );
  const targetReferences: FormTargetReferenceResolver = Object.freeze({
    resolveActiveCategory(
      scope: Parameters<FormTargetReferenceResolver['resolveActiveCategory']>[0],
      target: Parameters<FormTargetReferenceResolver['resolveActiveCategory']>[1]
    ) {
      const state = vocabulary.readVocabulary(scope);
      const item = target.category.kind === 'track'
        ? state?.tracks.find((candidate) => candidate.id === target.category.id)
        : state?.formats.find((candidate) => candidate.id === target.category.id);
      return item?.status === 'active'
        ? {
            kind: 'category' as const,
            categoryKind: item.kind,
            id: item.id,
            name: item.name,
            version: item.version
          }
        : undefined;
    },
    resolveCollectingSession() { return undefined; },
    resolveCurrentDeadline() { return undefined; }
  });
  const intake = new SQLiteIntakeRepository(sqlite, targetReferences);
  createTrack(sqlite, vocabulary, sourceTrackId, 'Source Track');
  createTrack(sqlite, vocabulary, targetTrackId, 'Target Track');
  installPublishedOpenForm(
    sqlite, intake, targetReferences, trackFieldId, titleFieldId, formatFieldId
  );
  return {
    sqlite,
    vocabulary,
    intake,
    referenceRegistry,
    referenceAdapter,
    trackFieldId,
    titleFieldId,
    setVocabularyAt(value: typeof createdAt) { vocabularyAt = value; }
  };
}

describe('SQLite Intake Form Program Vocabulary references', () => {
  test('blocks deletion, repoints only the current Form head, and compensates atomically', () => {
    const h = setup();
    try {
      const scope = { workspaceId, eventId };
      const publishedBytes = h.sqlite.query<{
        readonly version_json: string;
        readonly version_digest_sha256: string;
      }, [string]>(`
        SELECT version_json, version_digest_sha256 FROM intake_form_versions
         WHERE form_version_id = ?
      `).get(formVersionId);
      const before = captureRegisteredProgramReferences({
        registry: h.referenceRegistry,
        scope,
        source: h.vocabulary
      });
      expect(programReferenceUsage(before, { kind: 'track', id: sourceTrackId }))
        .toEqual({ current: 3, historicalPins: 3 });
      expect(before.contributors[0]).toMatchObject({
        guard: { id: 'program_reference:intake.forms', version: 3 }
      });
      expect(before.contributors[0]?.references.map((reference) => ({
        key: reference.referenceKey,
        mode: reference.mode,
        version: Number(reference.version)
      }))).toEqual([
        { key: `intake_form:${formId}:field:${h.trackFieldId}:exposure:${sourceTrackId}`, mode: 'current', version: 1 },
        { key: `intake_form:${formId}:rule:${ruleId}:choice:${sourceTrackId}`, mode: 'current', version: 1 },
        { key: `intake_form:${formId}:target`, mode: 'current', version: 1 },
        { key: `intake_form_version:${formVersionId}:field:${h.trackFieldId}:exposure:${sourceTrackId}`, mode: 'historical', version: 1 },
        { key: `intake_form_version:${formVersionId}:rule:${ruleId}:choice:${sourceTrackId}`, mode: 'historical', version: 1 },
        { key: `intake_form_version:${formVersionId}:target`, mode: 'historical', version: 1 }
      ]);
      expect(() => vocabularyPlan(h, {
        action: 'delete', scope, kind: 'track', id: sourceTrackId,
        expectedSetVersion: 3, expectedItemVersion: 1
      })).toThrow('delete_referenced');

      h.setVocabularyAt(mergedAt);
      const merge = vocabularyPlan(h, {
        action: 'merge', scope, kind: 'track', sourceId: sourceTrackId,
        targetId: targetTrackId, expectedSetVersion: 3,
        expectedSourceVersion: 1, expectedTargetVersion: 1
      });
      if (merge.action !== 'merge') throw new TypeError('expected_merge_plan');
      expect(merge).toMatchObject({
        action: 'merge',
        references: [{
          liveRepoints: [
            { referenceKey: `intake_form:${formId}:field:${h.trackFieldId}:exposure:${sourceTrackId}` },
            { referenceKey: `intake_form:${formId}:rule:${ruleId}:choice:${sourceTrackId}` },
            { referenceKey: `intake_form:${formId}:target` }
          ],
          historicalPins: [
            { referenceKey: `intake_form_version:${formVersionId}:field:${h.trackFieldId}:exposure:${sourceTrackId}` },
            { referenceKey: `intake_form_version:${formVersionId}:rule:${ruleId}:choice:${sourceTrackId}` },
            { referenceKey: `intake_form_version:${formVersionId}:target` }
          ]
        }]
      });

      const expectedReferenceSnapshot = applyProgramReferenceRepoints(before, merge);
      h.sqlite.exec('BEGIN IMMEDIATE;');
      h.referenceAdapter.applyRepoints({
        sqlite: h.sqlite,
        scope: h.vocabulary.readVocabulary(scope)!.scope,
        contribution: merge.references[0]!,
        attribution: { actorUserId: userId, occurredAt: mergedAt }
      });
      const directlyAppliedReferenceSnapshot = captureRegisteredProgramReferences({
        registry: h.referenceRegistry, scope, source: h.vocabulary
      });
      h.sqlite.exec('ROLLBACK;');
      expect(directlyAppliedReferenceSnapshot.contributors)
        .toEqual(expectedReferenceSnapshot.contributors);

      h.sqlite.exec(`
        CREATE TRIGGER intake_form_reference_merge_failure
        BEFORE UPDATE ON intake_form_catalogs
        BEGIN SELECT RAISE(ABORT, 'injected Form reference guard failure'); END;
      `);
      expect(() => transaction(h.sqlite, () => h.vocabulary.applyVocabularyPlan(merge)))
        .toThrow('contributor_failed');
      h.sqlite.exec('DROP TRIGGER intake_form_reference_merge_failure;');
      expect(h.vocabulary.readVocabulary(scope)).toMatchObject({
        setVersion: 3,
        tracks: [
          { id: sourceTrackId, status: 'active', version: 1 },
          { id: targetTrackId, status: 'active', version: 1 }
        ]
      });
      expect(h.intake.readFormHead(scope, formId)).toMatchObject({
        version: 2,
        definition: { target: { category: { id: sourceTrackId } } }
      });

      transaction(h.sqlite, () => h.vocabulary.applyVocabularyPlan(merge));
      expect(h.intake.readFormCatalog(scope)?.version).toBe(4);
      expect(h.intake.readFormHead(scope, formId)).toMatchObject({
        version: 3,
        updatedByUserId: userId,
        updatedAt: mergedAt,
        definition: {
          target: { category: { kind: 'track', id: targetTrackId } },
          composition: { optionExposure: { [h.trackFieldId]: [targetTrackId] } },
          rules: [{ condition: { choiceIds: [targetTrackId] } }]
        }
      });
      expect(h.intake.readFormVersion(scope, formVersionId)).toMatchObject({
        number: 1,
        targetPin: {
          kind: 'category', categoryKind: 'track',
          id: sourceTrackId, name: 'Source Track', version: 1
        },
        definition: {
          target: { category: { id: sourceTrackId } },
          rules: [{
            condition: { programVocabularyPins: [{ id: sourceTrackId }] }
          }]
        }
      });
      expect(h.intake.readFormVersion(scope, formVersionId)?.definition.fields.find(
        (field) => field.id === h.trackFieldId
      )).toMatchObject({
        options: { exposure: { items: [{ id: sourceTrackId }] } }
      });
      expect(h.sqlite.query(`
        SELECT version_json, version_digest_sha256 FROM intake_form_versions
         WHERE form_version_id = ?
      `).get(formVersionId)).toEqual(publishedBytes);
      const afterMerge = captureRegisteredProgramReferences({
        registry: h.referenceRegistry, scope, source: h.vocabulary
      });
      expect(programReferenceUsage(afterMerge, { kind: 'track', id: sourceTrackId }))
        .toEqual({ current: 0, historicalPins: 3 });
      expect(programReferenceUsage(afterMerge, { kind: 'track', id: targetTrackId }))
        .toEqual({ current: 3, historicalPins: 0 });
      expect(() => vocabularyPlan(h, {
        action: 'delete', scope, kind: 'track', id: sourceTrackId,
        expectedSetVersion: 4, expectedItemVersion: 2
      })).toThrow('delete_referenced');

      h.setVocabularyAt(compensatedAt);
      const state = h.vocabulary.readVocabulary(scope)!;
      const compensationInput: ProgramMergeCompensationInput = {
        action: 'merge_compensation', scope, kind: 'track',
        sourceId: sourceTrackId, targetId: targetTrackId,
        expectedSetVersion: state.setVersion,
        expectedSourceVersion: resolveProgramVocabularyItem(state, 'track', sourceTrackId)!.version,
        expectedTargetVersion: resolveProgramVocabularyItem(state, 'track', targetTrackId)!.version,
        restoreSource: true,
        references: [{
          contributor: INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR,
          referenceKeys: [
            `intake_form:${formId}:field:${h.trackFieldId}:exposure:${sourceTrackId}`,
            `intake_form:${formId}:rule:${ruleId}:choice:${sourceTrackId}`,
            `intake_form:${formId}:target`
          ]
        }]
      };
      const compensation = vocabularyPlan(h, compensationInput);
      h.sqlite.exec(`
        CREATE TRIGGER intake_form_reference_compensation_failure
        BEFORE UPDATE ON program_vocabulary_sets
        BEGIN SELECT RAISE(ABORT, 'injected Vocabulary set guard failure'); END;
      `);
      expect(() => transaction(h.sqlite, () => h.vocabulary.applyVocabularyPlan(compensation)))
        .toThrow('injected Vocabulary set guard failure');
      h.sqlite.exec('DROP TRIGGER intake_form_reference_compensation_failure;');
      expect(h.vocabulary.readVocabulary(scope)?.tracks.find((track) => track.id === sourceTrackId))
        .toMatchObject({ status: 'retired', version: 2 });
      expect(h.intake.readFormCatalog(scope)?.version).toBe(4);
      expect(h.intake.readFormHead(scope, formId)).toMatchObject({
        version: 3, definition: { target: { category: { id: targetTrackId } } }
      });

      transaction(h.sqlite, () => h.vocabulary.applyVocabularyPlan(compensation));
      expect(h.vocabulary.readVocabulary(scope)?.tracks.find((track) => track.id === sourceTrackId))
        .toMatchObject({ status: 'active', version: 3 });
      expect(h.intake.readFormCatalog(scope)?.version).toBe(5);
      expect(h.intake.readFormHead(scope, formId)).toMatchObject({
        version: 4,
        updatedAt: compensatedAt,
        definition: {
          target: { category: { id: sourceTrackId } },
          composition: { optionExposure: { [h.trackFieldId]: [sourceTrackId] } },
          rules: [{ condition: { choiceIds: [sourceTrackId] } }]
        }
      });
      expect(h.sqlite.query(`
        SELECT version_json, version_digest_sha256 FROM intake_form_versions
         WHERE form_version_id = ?
      `).get(formVersionId)).toEqual(publishedBytes);
      expect(h.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      h.sqlite.close();
    }
  });

  test('rejects redundant SQL-column drift instead of issuing a reference snapshot', () => {
    const corruptions = [{
      prepare(sqlite: Database) {
        sqlite.exec('DROP TRIGGER intake_form_heads_version_guard;');
        sqlite.query(`UPDATE intake_form_heads SET status = 'closed' WHERE form_id = ?`)
          .run(formId);
      }
    }, {
      prepare(sqlite: Database) {
        sqlite.exec('DROP TRIGGER intake_form_versions_no_update;');
        sqlite.query(`
          UPDATE intake_form_versions SET source_definition_version = 99
           WHERE form_version_id = ?
        `).run(formVersionId);
      }
    }];
    for (const corruption of corruptions) {
      const h = setup();
      try {
        corruption.prepare(h.sqlite);
        expect(() => captureRegisteredProgramReferences({
          registry: h.referenceRegistry,
          scope: { workspaceId, eventId },
          source: h.vocabulary
        })).toThrow('contributor_failed');
      } finally {
        h.sqlite.close();
      }
    }
  });

  test('keeps lineage slots through a merge collision, compensates exactly, then reconciles duplicates on Form revise', () => {
    const h = setup();
    try {
      const scope = { workspaceId, eventId };
      const registry = h.intake.readFieldRegistrySnapshot(scope)!;
      const beforeRevision = h.intake.readFormHead(scope, formId)!;
      const exposeBoth = planFormRevision({
        head: beforeRevision,
        registry,
        authorInput: {
          formId,
          expectedDefinitionVersion: beforeRevision.version,
          expectedRegistryVersion: registry.version,
          definition: {
            ...beforeRevision.definition,
            composition: {
              ...beforeRevision.definition.composition,
              optionExposure: { [h.trackFieldId]: [sourceTrackId, targetTrackId].sort() }
            },
            rules: beforeRevision.definition.rules.map((rule) => ({
              key: rule.key,
              condition: rule.condition.kind === 'selected_any'
                ? { ...rule.condition, choiceIds: [sourceTrackId, targetTrackId].sort() }
                : rule.condition,
              effect: rule.effect
            }))
          }
        },
        identities: identities(),
        references: h.intake,
        server: { updatedByUserId: userId, updatedAt: formOpenedAt }
      });
      transaction(h.sqlite, () => h.intake.applyFormMutation(exposeBoth));
      const beforeSlots = readSlots(h.sqlite);
      expect(beforeSlots).toHaveLength(5);
      expect(beforeSlots.every((slot) => slot.slot_version === 1)).toBe(true);

      h.setVocabularyAt(mergedAt);
      const merge = vocabularyPlan(h, {
        action: 'merge', scope, kind: 'track', sourceId: sourceTrackId,
        targetId: targetTrackId, expectedSetVersion: 3,
        expectedSourceVersion: 1, expectedTargetVersion: 1
      });
      if (merge.action !== 'merge') throw new TypeError('expected_merge_plan');
      transaction(h.sqlite, () => h.vocabulary.applyVocabularyPlan(merge));
      const collisionSlots = readSlots(h.sqlite);
      expect(collisionSlots).toHaveLength(5);
      expect(new Set(collisionSlots.map((slot) => slot.item_id))).toEqual(new Set([targetTrackId]));
      expect(collisionSlots.filter((slot) => slot.slot_key.endsWith(sourceTrackId)))
        .toMatchObject([
          { item_id: targetTrackId, slot_version: 2 },
          { item_id: targetTrackId, slot_version: 2 }
        ]);
      expect(collisionSlots.filter((slot) => slot.slot_key.endsWith(targetTrackId)))
        .toMatchObject([
          { item_id: targetTrackId, slot_version: 1 },
          { item_id: targetTrackId, slot_version: 1 }
        ]);

      h.setVocabularyAt(compensatedAt);
      const mergedState = h.vocabulary.readVocabulary(scope)!;
      const compensation = vocabularyPlan(h, {
        action: 'merge_compensation', scope, kind: 'track',
        sourceId: sourceTrackId, targetId: targetTrackId,
        expectedSetVersion: mergedState.setVersion,
        expectedSourceVersion: resolveProgramVocabularyItem(
          mergedState, 'track', sourceTrackId
        )!.version,
        expectedTargetVersion: resolveProgramVocabularyItem(
          mergedState, 'track', targetTrackId
        )!.version,
        restoreSource: true,
        references: [{
          contributor: INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR,
          referenceKeys: [
            `intake_form:${formId}:field:${h.trackFieldId}:exposure:${sourceTrackId}`,
            `intake_form:${formId}:rule:${ruleId}:choice:${sourceTrackId}`,
            `intake_form:${formId}:target`
          ]
        }]
      });
      transaction(h.sqlite, () => h.vocabulary.applyVocabularyPlan(compensation));
      const restoredSlots = readSlots(h.sqlite);
      expect(restoredSlots.filter((slot) => slot.slot_key.endsWith(sourceTrackId)))
        .toMatchObject([
          { item_id: sourceTrackId, slot_version: 3 },
          { item_id: sourceTrackId, slot_version: 3 }
        ]);
      expect(restoredSlots.filter((slot) => slot.slot_key.endsWith(targetTrackId)))
        .toEqual(collisionSlots.filter((slot) => slot.slot_key.endsWith(targetTrackId)));

      h.setVocabularyAt(mergedAgainAt);
      const restoredState = h.vocabulary.readVocabulary(scope)!;
      const mergeAgain = vocabularyPlan(h, {
        action: 'merge', scope, kind: 'track', sourceId: sourceTrackId,
        targetId: targetTrackId, expectedSetVersion: restoredState.setVersion,
        expectedSourceVersion: resolveProgramVocabularyItem(
          restoredState, 'track', sourceTrackId
        )!.version,
        expectedTargetVersion: resolveProgramVocabularyItem(
          restoredState, 'track', targetTrackId
        )!.version
      });
      transaction(h.sqlite, () => h.vocabulary.applyVocabularyPlan(mergeAgain));
      const collidedHead = h.intake.readFormHead(scope, formId)!;
      const reconcile = planFormRevision({
        head: collidedHead,
        registry: h.intake.readFieldRegistrySnapshot(scope)!,
        authorInput: {
          formId,
          expectedDefinitionVersion: collidedHead.version,
          expectedRegistryVersion: registry.version,
          definition: {
            ...collidedHead.definition,
            composition: {
              ...collidedHead.definition.composition,
              optionExposure: { [h.trackFieldId]: [targetTrackId] }
            },
            rules: collidedHead.definition.rules.map((rule) => ({
              key: rule.key,
              condition: rule.condition.kind === 'selected_any'
                ? { ...rule.condition, choiceIds: [targetTrackId] }
                : rule.condition,
              effect: rule.effect
            }))
          }
        },
        identities: identities(),
        references: h.intake,
        server: { updatedByUserId: userId, updatedAt: reconciledAt }
      });
      const immutableVersionBefore = h.intake.readFormVersion(scope, formVersionId);
      transaction(h.sqlite, () => h.intake.applyFormMutation(reconcile));
      const reconciledSlots = readSlots(h.sqlite);
      expect(reconciledSlots).toHaveLength(3);
      expect(reconciledSlots.filter((slot) => slot.slot_key.endsWith(targetTrackId)))
        .toMatchObject([
          { item_id: targetTrackId, slot_version: 1 },
          { item_id: targetTrackId, slot_version: 1 }
        ]);
      expect(h.intake.readFormVersion(scope, formVersionId)).toEqual(immutableVersionBefore);
    } finally {
      h.sqlite.close();
    }
  });

  test('rejects a redirected repoint destination before any Form write', () => {
    const h = setup();
    try {
      const scope = { workspaceId, eventId };
      const merge = vocabularyPlan(h, {
        action: 'merge', scope, kind: 'track', sourceId: sourceTrackId,
        targetId: targetTrackId, expectedSetVersion: 3,
        expectedSourceVersion: 1, expectedTargetVersion: 1
      });
      if (merge.action !== 'merge') throw new Error('Expected merge plan.');
      const contribution = merge.references[0];
      const repoint = contribution?.liveRepoints[0];
      if (!contribution || !repoint) throw new Error('Expected Form repoint.');
      const redirected: ProgramReferenceContributionPlan = {
        ...contribution,
        liveRepoints: [{
          ...repoint,
          destination: { ...repoint.destination, id: targetTrackId }
        }]
      };
      const beforeHead = h.intake.readFormHead(scope, formId);
      const beforeCatalog = h.intake.readFormCatalog(scope);
      const referenceScope = h.vocabulary.readVocabulary(scope)?.scope;
      if (!referenceScope) throw new Error('Vocabulary scope missing.');
      expect(() => transaction(h.sqlite, () => h.referenceAdapter.applyRepoints({
        sqlite: h.sqlite,
        scope: referenceScope,
        contribution: redirected,
        attribution: { actorUserId: userId, occurredAt: mergedAt }
      }))).toThrow('stale_reference');
      expect(h.intake.readFormHead(scope, formId)).toEqual(beforeHead);
      expect(h.intake.readFormCatalog(scope)).toEqual(beforeCatalog);
      expect(h.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      h.sqlite.close();
    }
  });
});

function createTrack(
  sqlite: Database,
  vocabulary: SQLiteProgramVocabularyRepository,
  trackId: string,
  name: string
): void {
  const scope = { workspaceId, eventId };
  const state = vocabulary.readVocabulary(scope)!;
  const plan = planProgramVocabularyMutation({
    state,
    referenceRegistry: vocabulary.referenceRegistry,
    referenceSource: vocabulary,
    authorInput: {
      action: 'create', scope, expectedSetVersion: state.setVersion,
      item: { kind: 'track', id: trackId, name }
    }
  });
  transaction(sqlite, () => vocabulary.applyVocabularyPlan(plan));
}

function installPublishedOpenForm(
  sqlite: Database,
  intake: SQLiteIntakeRepository,
  targetReferences: FormTargetReferenceResolver,
  trackFieldId: string,
  titleFieldId: string,
  formatFieldId: string
): void {
  const scope = { workspaceId, eventId };
  const empty = parseFormCatalogState({ scope, version: 1, heads: [] });
  const registry = intake.readFieldRegistrySnapshot(scope)!;
  const create = planFormCreation({
    catalog: empty,
    registry,
    authorInput: {
      expectedCatalogVersion: 1,
      expectedRegistryVersion: registry.version,
      definition: definition(sourceTrackId, trackFieldId, titleFieldId, formatFieldId)
    },
    identities: identities(),
    references: targetReferences,
    deadlineContribution: null,
    server: { createdByUserId: userId, createdAt: formCreatedAt }
  });
  const created = applyFormMutationPlan({
    catalog: empty, registry, plan: create, references: targetReferences
  }).catalog;
  const open = planFormLifecycleChange({
    head: create.after,
    registry,
    existingVersions: [],
    authorInput: {
      transition: 'publish_and_open', formId,
      expectedDefinitionVersion: 1,
      expectedRegistryVersion: registry.version
    },
    references: targetReferences,
    server: {
      formVersionId,
      updatedByUserId: userId,
      updatedAt: formPublishedAt
    }
  });
  applyFormMutationPlan({
    catalog: created, registry, plan: open,
    references: targetReferences, existingVersions: []
  });
  transaction(sqlite, () => {
    intake.applyFormMutation(create);
    intake.applyFormMutation(open);
  });
}

function vocabularyPlan(
  h: ReturnType<typeof setup>,
  authorInput: Parameters<typeof planProgramVocabularyMutation>[0]['authorInput']
): ProgramVocabularyMutationPlan {
  return planProgramVocabularyMutation({
    authorInput,
    state: h.vocabulary.readVocabulary({ workspaceId, eventId })!,
    referenceRegistry: h.referenceRegistry,
    referenceSource: h.vocabulary
  });
}

function transaction<Result>(sqlite: Database, work: () => Result): Result {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const result = work();
    sqlite.exec('COMMIT;');
    return result;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function readSlots(sqlite: Database) {
  return sqlite.query<{
    readonly slot_key: string;
    readonly item_id: string;
    readonly slot_version: number;
  }, [string]>(`
    SELECT slot_key, item_id, slot_version
      FROM intake_form_program_reference_slots
     WHERE form_id = ? ORDER BY slot_key COLLATE BINARY
  `).all(formId);
}
