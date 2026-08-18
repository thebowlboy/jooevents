import type { Database } from 'bun:sqlite';
import type {
  SignalDefinitionDto,
  SignalObservationDto,
  SignalObservationRetractionDto,
  SignalScopeDto
} from '@jooevents/contracts/signals';
import { canonicalJsonText } from '@jooevents/kernel';
import {
  parseSignalDefinition,
  parseSignalObservation,
  parseSignalObservationRetraction,
  parseSignalScope,
  type SignalTransactionRepository
} from '@jooevents/signals';

type DefinitionRow = {
  readonly workspace_id: string;
  readonly event_id: string;
  readonly key: string;
  readonly version: number;
  readonly label: string;
  readonly short_label: string | null;
  readonly description: string;
  readonly subjects_json: string;
  readonly family: 'quality' | 'draw' | 'integrity' | 'logistics';
  readonly value_kind: 'unit_score' | 'scale' | 'count' | 'label' | 'flag' | 'ref' | 'json';
  readonly direction: 'higher_is_better' | 'higher_is_worse' | 'neutral';
  readonly display_json: string;
  readonly visibility: 'organizer' | 'chair' | 'reviewer';
  readonly allowed_provenance_json: string;
  readonly write_caps_json: string | null;
  readonly policy_eligible: 0 | 1;
  readonly created_by_kind: 'system_seed' | 'workspace_user' | 'agent_action';
  readonly created_by_user_id: string | null;
  readonly created_at_ms: number;
  readonly status: 'active' | 'retired';
  readonly shown: 0 | 1;
  readonly position: number;
};

type ObservationRow = {
  readonly id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly subject_kind: 'submission' | 'person' | 'engagement';
  readonly subject_id: string;
  readonly definition_key: string;
  readonly definition_version: number;
  readonly value_json: string;
  readonly rationale: string | null;
  readonly provenance_kind: 'heuristic' | 'agent' | 'human' | 'import';
  readonly actor_reviewer_id: string | null;
  readonly actor_user_id: string | null;
  readonly review_plan_id: string | null;
  readonly computed_at_ms: number;
  readonly supersedes_id: string | null;
  readonly input_versions_json: string;
};

const DEFINITION_SELECT = `
  SELECT revision.*, head.status, head.shown, head.position
    FROM signal_definition_heads head
    JOIN signal_definition_revisions revision
      ON revision.workspace_id=head.workspace_id
     AND revision.event_id=head.event_id
     AND revision.key=head.key
     AND revision.version=head.current_version
`;

export class SQLiteSignalRepository implements SignalTransactionRepository {
  constructor(private readonly sqlite: Database) {}

  listDefinitions(scopeInput: SignalScopeDto): readonly SignalDefinitionDto[] {
    const scope = parseSignalScope(scopeInput);
    return Object.freeze(this.sqlite.query<DefinitionRow, [string, string]>(`
      ${DEFINITION_SELECT}
       WHERE head.workspace_id=? AND head.event_id=?
       ORDER BY head.position, head.key COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId).map(definitionFromRow));
  }

  readDefinition(scopeInput: SignalScopeDto, key: string): SignalDefinitionDto | undefined {
    const scope = parseSignalScope(scopeInput);
    const row = this.sqlite.query<DefinitionRow, [string, string, string]>(`
      ${DEFINITION_SELECT}
       WHERE head.workspace_id=? AND head.event_id=? AND head.key=?
    `).get(scope.workspaceId, scope.eventId, key);
    return row ? definitionFromRow(row) : undefined;
  }

  readObservation(
    scopeInput: SignalScopeDto,
    observationId: string
  ): SignalObservationDto | undefined {
    const scope = parseSignalScope(scopeInput);
    const row = this.sqlite.query<ObservationRow, [string, string, string]>(`
      SELECT * FROM signal_observations
       WHERE workspace_id=? AND event_id=? AND id=?
    `).get(scope.workspaceId, scope.eventId, observationId);
    return row ? observationFromRow(row) : undefined;
  }

  readCurrentHumanFlag(input: {
    readonly scope: SignalScopeDto;
    readonly definitionKey: string;
    readonly subjectId: string;
    readonly actorReviewerId: string;
    readonly reviewPlanId: string;
  }): SignalObservationDto | undefined {
    const scope = parseSignalScope(input.scope);
    const row = this.sqlite.query<ObservationRow, [string, string, string, string, string, string]>(`
      SELECT observation.*
        FROM signal_observations observation
        LEFT JOIN signal_observation_retractions retraction
          ON retraction.workspace_id=observation.workspace_id
         AND retraction.event_id=observation.event_id
         AND retraction.observation_id=observation.id
       WHERE observation.workspace_id=? AND observation.event_id=?
         AND observation.definition_key=?
         AND observation.subject_kind='submission' AND observation.subject_id=?
         AND observation.provenance_kind='human'
         AND observation.actor_reviewer_id=? AND observation.review_plan_id=?
         AND retraction.observation_id IS NULL
       ORDER BY observation.computed_at_ms DESC, observation.id DESC
       LIMIT 1
    `).get(
      scope.workspaceId, scope.eventId, input.definitionKey, input.subjectId,
      input.actorReviewerId, input.reviewPlanId
    );
    return row ? observationFromRow(row) : undefined;
  }

  listCurrentHumanFlags(input: {
    readonly scope: SignalScopeDto;
    readonly definitionKey?: string;
    readonly actorReviewerId: string;
    readonly reviewPlanId?: string;
  }): readonly SignalObservationDto[] {
    const scope = parseSignalScope(input.scope);
    const keyClause = input.definitionKey === undefined ? '' : 'AND observation.definition_key=?';
    const planClause = input.reviewPlanId === undefined ? '' : 'AND observation.review_plan_id=?';
    const parameters = [
      scope.workspaceId, scope.eventId, input.actorReviewerId,
      ...(input.definitionKey === undefined ? [] : [input.definitionKey]),
      ...(input.reviewPlanId === undefined ? [] : [input.reviewPlanId])
    ];
    const rows = this.sqlite.query<ObservationRow, string[]>(`
      SELECT observation.*
        FROM signal_observations observation
        LEFT JOIN signal_observation_retractions retraction
          ON retraction.workspace_id=observation.workspace_id
         AND retraction.event_id=observation.event_id
         AND retraction.observation_id=observation.id
       WHERE observation.workspace_id=? AND observation.event_id=?
         AND observation.provenance_kind='human'
         AND observation.actor_reviewer_id=?
         ${keyClause}
         ${planClause}
         AND retraction.observation_id IS NULL
       ORDER BY observation.subject_id, observation.definition_key,
                observation.computed_at_ms DESC, observation.id DESC
    `).all(...parameters);
    const current = new Map<string, SignalObservationDto>();
    for (const row of rows) {
      const observation = observationFromRow(row);
      const identity = `${observation.subject.kind}:${observation.subject.id}:${observation.definitionKey}`;
      if (!current.has(identity)) current.set(identity, observation);
    }
    return Object.freeze([...current.values()].sort((left, right) =>
      compareText(left.subject.id, right.subject.id)
      || compareText(left.definitionKey, right.definitionKey)
      || compareText(left.id, right.id)
    ));
  }

  insertObservation(observationInput: SignalObservationDto): void {
    const observation = parseSignalObservation(observationInput);
    const provenance = observation.provenance;
    this.sqlite.query(`
      INSERT INTO signal_observations (
        id, workspace_id, event_id, subject_kind, subject_id,
        definition_key, definition_version, value_json, rationale,
        provenance_kind, actor_reviewer_id, actor_user_id, review_plan_id,
        computed_at_ms, supersedes_id, input_versions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.id, observation.workspaceId, observation.eventId,
      observation.subject.kind, observation.subject.id,
      observation.definitionKey, observation.definitionVersion,
      canonicalJsonText(observation.value), observation.rationale ?? null,
      provenance.kind,
      provenance.kind === 'human' ? provenance.actorReviewerId : null,
      provenance.kind === 'human' ? provenance.actorUserId : null,
      provenance.kind === 'human' ? provenance.reviewPlanId : null,
      Date.parse(observation.computedAt), observation.supersedesId ?? null,
      canonicalJsonText(observation.inputVersions)
    );
  }

  insertRetraction(retractionInput: SignalObservationRetractionDto): void {
    const retraction = parseSignalObservationRetraction(retractionInput);
    this.sqlite.query(`
      INSERT INTO signal_observation_retractions (
        workspace_id, event_id, observation_id, reason,
        retracted_by_user_id, retracted_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      retraction.workspaceId, retraction.eventId, retraction.observationId,
      retraction.reason, retraction.retractedByUserId, Date.parse(retraction.retractedAt)
    );
  }
}

function definitionFromRow(row: DefinitionRow): SignalDefinitionDto {
  return parseSignalDefinition({
    schemaVersion: 1,
    workspaceId: row.workspace_id,
    eventId: row.event_id,
    key: row.key,
    version: row.version,
    label: row.label,
    ...(row.short_label === null ? {} : { shortLabel: row.short_label }),
    description: row.description,
    subjects: JSON.parse(row.subjects_json),
    family: row.family,
    valueKind: row.value_kind,
    direction: row.direction,
    display: JSON.parse(row.display_json),
    visibility: row.visibility,
    allowedProvenance: JSON.parse(row.allowed_provenance_json),
    ...(row.write_caps_json === null ? {} : { writeCaps: JSON.parse(row.write_caps_json) }),
    policyEligible: row.policy_eligible === 1,
    createdBy: row.created_by_kind === 'system_seed'
      ? { kind: 'system_seed' }
      : row.created_by_kind === 'workspace_user'
        ? { kind: 'workspace_user', userId: row.created_by_user_id }
        : {
            kind: 'agent_action',
            ...(row.created_by_user_id === null ? {} : { userId: row.created_by_user_id })
          },
    createdAt: new Date(row.created_at_ms).toISOString(),
    status: row.status,
    shown: row.shown === 1,
    position: row.position
  });
}

function observationFromRow(row: ObservationRow): SignalObservationDto {
  return parseSignalObservation({
    schemaVersion: 1,
    id: row.id,
    workspaceId: row.workspace_id,
    eventId: row.event_id,
    subject: { kind: row.subject_kind, id: row.subject_id },
    definitionKey: row.definition_key,
    definitionVersion: row.definition_version,
    value: JSON.parse(row.value_json),
    ...(row.rationale === null ? {} : { rationale: row.rationale }),
    provenance: row.provenance_kind === 'human'
      ? {
          kind: 'human',
          actorReviewerId: row.actor_reviewer_id,
          actorUserId: row.actor_user_id,
          reviewPlanId: row.review_plan_id
        }
      : { kind: row.provenance_kind },
    computedAt: new Date(row.computed_at_ms).toISOString(),
    ...(row.supersedes_id === null ? {} : { supersedesId: row.supersedes_id }),
    inputVersions: JSON.parse(row.input_versions_json)
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
