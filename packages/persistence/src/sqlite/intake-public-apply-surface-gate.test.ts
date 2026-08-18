import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createPublicMutationContinuationBoundary } from '@jooevents/application/public-mutation-continuation';
import type { FormDefinitionHeadDto, ReleaseScopeDto } from '@jooevents/contracts';
import {
  INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES,
  createApplySurfaceGatedContinuationPolicySource,
  createOffUnlessConfiguredPublicIntakeBootstrapVerifier
} from '@jooevents/intake-operations';
import {
  parseAuditEventId,
  parseCeremonyEvidenceId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId
} from '@jooevents/kernel';
import { isStyleSetPlan, isSurfacePublishPlan, planReleaseMutation } from '@jooevents/release';
import { installEventSpineSchema } from './event-spine';
import {
  createSQLiteIntakePublicApplySurfaceGate,
  intakePublicApplySurfaceCeremonyPinSource
} from './intake-public-apply-surface-gate';
import { createIntakePublicCeremonyGatedDirectory } from './intake-public-ceremony';
import {
  installSQLitePublicMutationContinuationTrial,
  SQLitePublicMutationContinuationTrial
} from './public-mutation-continuation-trial';
import {
  installReleaseSchema,
  SQLiteReleaseRepository,
  type SQLiteReleaseUpstreamSources
} from './release';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c2ea1-86b5-769b-bba4-000000000002');
const userId = '019c2ea1-86b5-769b-bba4-000000000003';
const formId = '019c2ea1-86b5-769b-bba4-000000000004';
const formVersion1 = '019c2ea1-86b5-769b-bba4-000000000005';
const formVersion2 = '019c2ea1-86b5-769b-bba4-000000000006';
const now = '2026-08-14T08:00:00.000Z';
const scope: ReleaseScopeDto = { workspaceId, eventId };
const themeArtifactId = '019c2ea1-86b5-769b-bba4-000000000007';
const applyArtifactId = '019c2ea1-86b5-769b-bba4-000000000008';
const templateRevisionId = '019c2ea1-86b5-769b-bba4-000000000009';
const templateDigest = 'd'.repeat(64);
const templatePin = (artifactId: string) => ({
  artifactId, revisionId: templateRevisionId, revisionNumber: 1, digestSha256: templateDigest
});
const themeRecipe = {
  name: 'Warm default', canvas: '#faf8f5', surface: '#ffffff',
  text: '#2a2522', action: '#b05a4f', radius: 6, controlHeight: 36
};

let ordinal = 0x9000;
function uuid(): string {
  ordinal += 1;
  return `019c2ea1-86b5-769b-bba4-${ordinal.toString(16).padStart(12, '0')}`;
}

interface FormControls {
  status: FormDefinitionHeadDto['status'];
  currentPublishedVersionId: string | null;
  present: boolean;
}

function fixture() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
  `);
  installEventSpineSchema(sqlite);
  installReleaseSchema(sqlite);
  installSQLitePublicMutationContinuationTrial(sqlite);
  sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Workspace', 'active', 1, 1, 1)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Operator', 1, 1, 1)
  `).run(userId);
  sqlite.query(`
    INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, null)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
  `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query('INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)')
    .run(workspaceId, eventId);

  const forms: FormControls = {
    status: 'open',
    currentPublishedVersionId: formVersion1,
    present: true
  };
  const never = (): never => {
    throw new TypeError('intake_public_apply_gate_test_unexpected_upstream_read');
  };
  const sources: SQLiteReleaseUpstreamSources = {
    sessions: { readSessionCatalog: never },
    schedule: { readSchedule: never },
    engagements: { readEngagementSnapshot: never },
    lineups: { readSpeakerLineupSnapshot: never },
    vocabulary: { readVocabulary: never },
    eventSettings: { readEventSettings: never },
    names: { readParticipantDisplayName: never },
    forms: {
      readCurrentPublishedFormVersionId: (_scope, requestedFormId) =>
        requestedFormId === formId && forms.currentPublishedVersionId !== null
          ? forms.currentPublishedVersionId
          : undefined
    },
    templates: {
      readPinnedArtifact: (_scope, pin) => {
        if (pin.revisionId !== templateRevisionId || pin.revisionNumber !== 1
            || pin.digestSha256 !== templateDigest) return undefined;
        if (pin.artifactId === themeArtifactId) return {
          kind: 'theme' as const, recipe: themeRecipe, markText: 'JE'
        };
        return pin.artifactId === applyArtifactId ? {
          kind: 'surface' as const, surfaceKind: 'application-form' as const,
          name: 'Apply', purpose: 'Application.', blocks: [], usedBy: []
        } : undefined;
      }
    }
  };
  const repository = new SQLiteReleaseRepository(sqlite, sources);
  const gate = createSQLiteIntakePublicApplySurfaceGate({
    sqlite,
    workspaceId,
    eventId,
    forms: {
      readFormHead(requestedScope, requestedFormId) {
        if (!forms.present || requestedFormId !== formId
            || requestedScope.workspaceId !== workspaceId
            || requestedScope.eventId !== eventId) return undefined;
        return {
          id: formId,
          version: 2,
          status: forms.status,
          currentPublishedVersionId: forms.currentPublishedVersionId
        } as FormDefinitionHeadDto;
      }
    }
  });
  return Object.freeze({ sqlite, repository, gate, forms });
}

type Fixture = ReturnType<typeof fixture>;

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

function publishStyleSet(context: Fixture): string {
  const plan = planReleaseMutation({
    planningInput: {
      action: 'style_set_publish',
      scope,
      actorUserId: userId,
      occurredAt: now,
      releaseId: uuid(),
      sourceTemplateRevision: templatePin(themeArtifactId),
      recipe: themeRecipe,
      expectedCurrentStyleSetNumber: null
    },
    port: context.repository
  });
  if (!isStyleSetPlan(plan)) throw new Error('wrong plan');
  transaction(context.sqlite, () => context.repository.applyReleasePlan(plan));
  return plan.release.id;
}

function publishApplySurface(context: Fixture, input: {
  readonly styleSetReleaseId: string;
  readonly formVersionId: string;
  readonly expectedSurfaceHeadVersion: number | null;
}): string {
  const plan = planReleaseMutation({
    planningInput: {
      action: 'surface_publish',
      scope,
      actorUserId: userId,
      occurredAt: now,
      releaseId: uuid(),
      kind: 'apply',
      sourceTemplateRevision: templatePin(applyArtifactId),
      manifest: { schemaVersion: 1, heading: null, intro: null },
      styleSetReleaseId: input.styleSetReleaseId,
      formRef: { formId, formVersionId: input.formVersionId },
      expectedSurfaceHeadVersion: input.expectedSurfaceHeadVersion
    },
    port: context.repository
  });
  if (!isSurfacePublishPlan(plan)) throw new Error('wrong plan');
  transaction(context.sqlite, () => context.repository.applyReleasePlan(plan));
  return plan.release.id;
}

function rollbackApplySurface(context: Fixture, input: {
  readonly targetReleaseId: string;
  readonly expectedSurfaceHeadVersion: number;
}): void {
  const plan = planReleaseMutation({
    planningInput: {
      action: 'surface_rollback',
      scope,
      actorUserId: userId,
      occurredAt: now,
      kind: 'apply',
      targetReleaseId: input.targetReleaseId,
      expectedSurfaceHeadVersion: input.expectedSurfaceHeadVersion
    },
    port: context.repository
  });
  transaction(context.sqlite, () => context.repository.applyReleasePlan(plan));
}

describe('SQLite public apply-surface gate', () => {
  test('refuses before any apply surface release is published', () => {
    const context = fixture();
    expect(context.gate.resolveApplySurface())
      .toEqual({ kind: 'refused', reason: 'no_published_apply_surface' });
  });

  test('pins the active release form exactly, marks close, and refuses republish drift', () => {
    const context = fixture();
    const styleSet = publishStyleSet(context);
    const release1 = publishApplySurface(context, {
      styleSetReleaseId: styleSet, formVersionId: formVersion1, expectedSurfaceHeadVersion: null
    });

    expect(context.gate.resolveApplySurface()).toEqual({
      kind: 'pinned',
      pin: {
        workspaceId, eventId, formId,
        formVersionId: formVersion1,
        surfaceReleaseId: release1,
        surfaceHeadVersion: 1,
        evidenceIds: [
          `apply-surface:${release1}`,
          'apply-surface-head:1',
          `intake-form:${formId}#2`
        ]
      }
    });

    context.forms.status = 'closed';
    expect(context.gate.resolveApplySurface()).toEqual({
      kind: 'closed',
      pin: {
        workspaceId, eventId, formId,
        formVersionId: formVersion1,
        surfaceReleaseId: release1,
        surfaceHeadVersion: 1,
        evidenceIds: [
          `apply-surface:${release1}`,
          'apply-surface-head:1',
          `intake-form:${formId}#2`
        ]
      }
    });

    context.forms.currentPublishedVersionId = formVersion2;
    expect(context.gate.resolveApplySurface())
      .toEqual({ kind: 'refused', reason: 'apply_form_version_superseded' });

    context.forms.currentPublishedVersionId = formVersion1;
    context.forms.status = 'draft';
    expect(context.gate.resolveApplySurface())
      .toEqual({ kind: 'refused', reason: 'no_published_apply_surface' });

    context.forms.status = 'open';

    context.forms.currentPublishedVersionId = formVersion2;
    expect(context.gate.resolveApplySurface())
      .toEqual({ kind: 'refused', reason: 'apply_form_version_superseded' });

    context.forms.present = false;
    expect(context.gate.resolveApplySurface())
      .toEqual({ kind: 'refused', reason: 'no_published_apply_surface' });
  });

  test('a rolled-back surface head stops serving the newer pin without touching release rows', () => {
    const context = fixture();
    const styleSet = publishStyleSet(context);
    const release1 = publishApplySurface(context, {
      styleSetReleaseId: styleSet, formVersionId: formVersion1, expectedSurfaceHeadVersion: null
    });
    context.forms.currentPublishedVersionId = formVersion2;
    const release2 = publishApplySurface(context, {
      styleSetReleaseId: styleSet, formVersionId: formVersion2, expectedSurfaceHeadVersion: 1
    });
    const pinned = context.gate.resolveApplySurface();
    expect(pinned).toMatchObject({
      kind: 'pinned',
      pin: { formVersionId: formVersion2, surfaceReleaseId: release2, surfaceHeadVersion: 2 }
    });

    rollbackApplySurface(context, { targetReleaseId: release1, expectedSurfaceHeadVersion: 2 });
    expect(context.gate.resolveApplySurface())
      .toEqual({ kind: 'refused', reason: 'apply_form_version_superseded' });
  });

  test('the gated ceremony serves a surface published after boot and stops the moment it rolls back', async () => {
    const context = fixture();
    const binding = Object.freeze({ key: 'intake.public-apply', version: parseContractVersion(1) });
    const keyProfile = (key: string, fill: number) => Object.freeze({
      reference: Object.freeze({ key, version: parseContractVersion(1) }),
      keyBytes: new Uint8Array(32).fill(fill)
    });
    let audit = 0x100;
    let ceremony = 0x200;
    let entropy = 0x30;
    const clock = Object.freeze({ now: () => parseInstant(now) });
    const store = new SQLitePublicMutationContinuationTrial(context.sqlite, {
      clock,
      newAuditEventId: () => parseAuditEventId(uuid()),
      newCompletionReference: () => `pcr_${String(audit++).padStart(24, '0')}`
    });
    const boundary = createPublicMutationContinuationBoundary({
      binding,
      policies: createApplySurfaceGatedContinuationPolicySource({
        gate: context.gate,
        binding,
        security: {
          lifetimeMs: 300_000,
          ...INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES,
          continuationProfiles: [keyProfile('intake.public-continuation', 1)],
          principalPartitionProfile: keyProfile('intake.public-partition', 2),
          bootstrapReplayProfile: keyProfile('intake.public-bootstrap-replay', 3)
        }
      }),
      bootstrapVerifiers: {
        resolve: () => createOffUnlessConfiguredPublicIntakeBootstrapVerifier()
      },
      store,
      clock,
      newActionAnchorId: () => uuid(),
      newCeremonyEvidenceId: () => parseCeremonyEvidenceId(uuid()),
      newAuditEventId: () => parseAuditEventId(uuid()),
      randomBytes: (size) => new Uint8Array(size).fill((ceremony + entropy++) % 251)
    });
    const directory = createIntakePublicCeremonyGatedDirectory({
      pin: intakePublicApplySurfaceCeremonyPinSource(context.gate),
      boundary,
      completion: { resume: () => undefined, complete: () => { throw new TypeError('unused'); } }
    });

    // Before any apply surface release exists, the same directory refuses.
    const protocolEvidence = { schemaVersion: 1, bootstrap: 'a'.repeat(48), origin: null };
    expect(await directory.mint({ formId, protocolEvidence })).toEqual({ kind: 'unavailable' });

    const styleSet = publishStyleSet(context);
    const release1 = publishApplySurface(context, {
      styleSetReleaseId: styleSet, formVersionId: formVersion1, expectedSurfaceHeadVersion: null
    });
    context.forms.currentPublishedVersionId = formVersion2;
    const release2 = publishApplySurface(context, {
      styleSetReleaseId: styleSet, formVersionId: formVersion2, expectedSurfaceHeadVersion: 1
    });
    expect(release2).not.toBe(release1);

    const minted = await directory.mint({ formId, protocolEvidence });
    if (minted.kind !== 'issued') throw new TypeError('expected issued continuation');
    const admitted = directory.admit({ formId, continuation: minted.continuation });
    expect(admitted.kind).toBe('ready');
    if (admitted.kind !== 'ready') throw new TypeError('expected admitted ceremony');
    expect(directory.resolveCurrent(admitted.evidence.ceremonyEvidenceId)).toMatchObject({
      formId, formVersionId: formVersion2
    });

    rollbackApplySurface(context, { targetReleaseId: release1, expectedSurfaceHeadVersion: 2 });

    expect(await directory.mint({
      formId,
      protocolEvidence: { ...protocolEvidence, bootstrap: 'b'.repeat(48) }
    })).toEqual({ kind: 'unavailable' });
    expect(directory.admit({ formId, continuation: minted.continuation }))
      .toEqual({ kind: 'stopped', reason: 'not_available' });
    expect(directory.resolveCurrent(admitted.evidence.ceremonyEvidenceId)).toBeUndefined();
    expect(directory.openForEffect(admitted.evidence.ceremonyEvidenceId)).toBeUndefined();
  });
});
