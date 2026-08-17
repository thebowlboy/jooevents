import type { Database } from 'bun:sqlite';
import {
  acceleventsExportConfigurationSchema,
  programReleaseSchema,
  type AcceleventsExportConfigSaveInput,
  type AcceleventsExportConfiguration,
  type ProgramReleaseDto
} from '@jooevents/contracts';
import { canonicalJsonText, parseEventId, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import type {
  AcceleventsApprovedSpeakerProfile,
  AcceleventsExportSource
} from '@jooevents/program-export';
import type { SQLiteIntakeRepository } from './intake';
import { SQLiteEventSettingsRepository } from './event-settings';

export type SQLiteAcceleventsExportErrorCode =
  | 'transaction_required'
  | 'scope_missing'
  | 'configuration_changed'
  | 'configuration_corrupt'
  | 'release_missing'
  | 'profile_corrupt';

export class SQLiteAcceleventsExportError extends Error {
  constructor(readonly code: SQLiteAcceleventsExportErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteAcceleventsExportError';
  }
}

interface ConfigurationRow {
  readonly id: string;
  readonly event_id: string;
  readonly selected_release_id: string | null;
  readonly session_type: 'IN_PERSON' | 'VIRTUAL' | 'HYBRID' | null;
  readonly format_mappings_json: string;
  readonly speaker_names_json: string;
  readonly room_bindings_json: string;
  readonly primary_speakers_json: string;
  readonly version: number;
  readonly updated_at_ms: number;
}

interface ReleaseRow { readonly release_json: string }
interface EngagementSubmissionRow { readonly submission_id: string }
interface LastGeneratedRow { readonly recorded_at: string }

function envelope(items: readonly unknown[]): string {
  return canonicalJsonText({ schemaVersion: 1, items });
}

function envelopeItems(value: string): unknown {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || (parsed as { readonly schemaVersion?: unknown }).schemaVersion !== 1
      || !Array.isArray((parsed as { readonly items?: unknown }).items)) {
    throw new TypeError('accelevents_export_configuration_envelope_invalid');
  }
  return (parsed as { readonly items: readonly unknown[] }).items;
}

function scopeExists(sqlite: Database, workspaceId: string, eventId: string): boolean {
  return sqlite.query<{ readonly event_id: string }, [string, string]>(`
    SELECT event_id FROM event_spine_scope_roots
     WHERE workspace_id = ? AND event_id = ? LIMIT 2
  `).all(workspaceId, eventId).length === 1;
}

export class SQLiteAcceleventsExportRepository {
  readonly #settings: SQLiteEventSettingsRepository;

  constructor(
    private readonly sqlite: Database,
    private readonly intake: Pick<SQLiteIntakeRepository, 'readSubmissionContact'>
  ) {
    this.#settings = new SQLiteEventSettingsRepository(sqlite);
  }

  readConfiguration(scopeInput: { readonly workspaceId: string; readonly eventId: string }): AcceleventsExportConfiguration {
    const workspaceId = parseWorkspaceId(scopeInput.workspaceId);
    const eventId = parseEventId(scopeInput.eventId);
    if (!scopeExists(this.sqlite, workspaceId, eventId)) {
      throw new SQLiteAcceleventsExportError('scope_missing');
    }
    const row = this.sqlite.query<ConfigurationRow, [string, string]>(`
      SELECT id, event_id, selected_release_id, session_type,
             format_mappings_json, speaker_names_json, room_bindings_json,
             primary_speakers_json, version, updated_at_ms
        FROM accelevents_export_configuration
       WHERE workspace_id = ? AND event_id = ? LIMIT 2
    `).get(workspaceId, eventId);
    if (!row) return acceleventsExportConfigurationSchema.parse({
      schemaVersion: 1,
      eventId,
      version: 0,
      selectedReleaseId: null,
      sessionType: null,
      formatMappings: [],
      speakerNames: [],
      roomBindings: [],
      primarySpeakers: [],
      updatedAt: null
    });
    try {
      return acceleventsExportConfigurationSchema.parse({
        schemaVersion: 1,
        eventId: row.event_id,
        version: row.version,
        selectedReleaseId: row.selected_release_id,
        sessionType: row.session_type,
        formatMappings: envelopeItems(row.format_mappings_json),
        speakerNames: envelopeItems(row.speaker_names_json),
        roomBindings: envelopeItems(row.room_bindings_json),
        primarySpeakers: envelopeItems(row.primary_speakers_json),
        updatedAt: new Date(row.updated_at_ms).toISOString()
      });
    } catch (error) {
      throw new SQLiteAcceleventsExportError('configuration_corrupt', error);
    }
  }

  saveConfiguration(input: {
    readonly scope: { readonly workspaceId: string; readonly eventId: string };
    readonly request: AcceleventsExportConfigSaveInput;
    readonly configurationId: string;
    readonly actorUserId: string;
    readonly updatedAt: string;
  }): AcceleventsExportConfiguration {
    if (!this.sqlite.inTransaction) throw new SQLiteAcceleventsExportError('transaction_required');
    const workspaceId = parseWorkspaceId(input.scope.workspaceId);
    const eventId = parseEventId(input.scope.eventId);
    const actorUserId = parseUserId(input.actorUserId);
    if (input.request.eventId !== eventId || !scopeExists(this.sqlite, workspaceId, eventId)) {
      throw new SQLiteAcceleventsExportError('scope_missing');
    }
    const payload = {
      selectedReleaseId: input.request.selectedReleaseId,
      sessionType: input.request.sessionType,
      formatMappings: [...input.request.formatMappings].sort((a, b) => a.formatId.localeCompare(b.formatId)),
      speakerNames: [...input.request.speakerNames].sort((a, b) => a.personId.localeCompare(b.personId)),
      roomBindings: [...input.request.roomBindings].sort((a, b) => a.roomId.localeCompare(b.roomId)),
      primarySpeakers: [...input.request.primarySpeakers].sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId))
    };
    const updatedAtMs = Date.parse(input.updatedAt);
    const changed = input.request.expectedVersion === 0
      ? this.sqlite.query<never, [
          string, string, string, string | null, string | null,
          string, string, string, string, number, string, string, string
        ]>(`
          INSERT INTO accelevents_export_configuration (
            id, workspace_id, event_id, selected_release_id, session_type,
            format_mappings_json, speaker_names_json, room_bindings_json,
            primary_speakers_json, updated_at_ms, updated_by_user_id
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM accelevents_export_configuration
              WHERE workspace_id = ? AND event_id = ?
           )
        `).run(
          input.configurationId, workspaceId, eventId, payload.selectedReleaseId,
          payload.sessionType, envelope(payload.formatMappings),
          envelope(payload.speakerNames), envelope(payload.roomBindings),
          envelope(payload.primarySpeakers), updatedAtMs, actorUserId,
          workspaceId, eventId
        )
      : this.sqlite.query<never, [
          string | null, string | null, string, string, string, string,
          number, number, string, string, string, number
        ]>(`
          UPDATE accelevents_export_configuration
             SET selected_release_id = ?, session_type = ?, format_mappings_json = ?,
                 speaker_names_json = ?, room_bindings_json = ?, primary_speakers_json = ?,
                 version = ?, updated_at_ms = ?, updated_by_user_id = ?
           WHERE workspace_id = ? AND event_id = ? AND version = ?
        `).run(
          payload.selectedReleaseId, payload.sessionType,
          envelope(payload.formatMappings), envelope(payload.speakerNames),
          envelope(payload.roomBindings), envelope(payload.primarySpeakers),
          input.request.expectedVersion + 1, updatedAtMs, actorUserId,
          workspaceId, eventId, input.request.expectedVersion
        );
    if (changed.changes !== 1) throw new SQLiteAcceleventsExportError('configuration_changed');
    return this.readConfiguration({ workspaceId, eventId });
  }

  listProgramReleases(scopeInput: { readonly workspaceId: string; readonly eventId: string }): readonly ProgramReleaseDto[] {
    const workspaceId = parseWorkspaceId(scopeInput.workspaceId);
    const eventId = parseEventId(scopeInput.eventId);
    const rows = this.sqlite.query<ReleaseRow, [string, string]>(`
      SELECT release_json FROM program_releases
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY number DESC
    `).all(workspaceId, eventId);
    try {
      return Object.freeze(rows.map((row) => programReleaseSchema.parse(JSON.parse(row.release_json))));
    } catch (error) {
      throw new SQLiteAcceleventsExportError('release_missing', error);
    }
  }

  readSource(scopeInput: { readonly workspaceId: string; readonly eventId: string }): AcceleventsExportSource {
    const workspaceId = parseWorkspaceId(scopeInput.workspaceId);
    const eventId = parseEventId(scopeInput.eventId);
    const settings = this.#settings.readCurrentEventSettings(workspaceId);
    if (!settings || settings.eventId !== eventId) {
      throw new SQLiteAcceleventsExportError('scope_missing');
    }
    const releases = this.listProgramReleases({ workspaceId, eventId });
    const configuration = this.readConfiguration({ workspaceId, eventId });
    const selected = releases.find((release) =>
      release.id === (configuration.selectedReleaseId ?? releases[0]?.id)
    );
    const profiles = selected ? this.#readProfiles({ workspaceId, eventId }, selected) : [];
    return Object.freeze({
      event: Object.freeze({
        id: eventId,
        name: settings.name,
        timezone: settings.timezone,
        startDate: settings.startDate,
        endDate: settings.endDate
      }),
      releases,
      profiles,
      configuration,
      lastGenerated: selected ? this.#readLastGenerated(eventId, selected.number) : null
    });
  }

  #readLastGenerated(eventId: string, releaseNumber: number): { readonly at: string; readonly releaseNumber: number } | null {
    const row = this.sqlite.query<LastGeneratedRow, [string]>(`
      SELECT json_extract(CAST(canonical_record_bytes AS TEXT), '$.recordedAt') AS recorded_at
        FROM _trial_read_immutable_audits
       WHERE json_extract(CAST(canonical_record_bytes AS TEXT), '$.operation.name')
               = 'program.export.accelevents.package.read'
         AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.scope.eventId') = ?
         AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.disposition') = 'authorized'
         AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.resultSummary.kind') = 'success'
       ORDER BY recorded_at DESC
       LIMIT 1
    `).get(eventId);
    return row ? Object.freeze({ at: row.recorded_at, releaseNumber }) : null;
  }

  #readProfiles(
    scope: { readonly workspaceId: string; readonly eventId: string },
    release: ProgramReleaseDto
  ): readonly AcceleventsApprovedSpeakerProfile[] {
    const personIds = [...new Set(release.sessions.flatMap((session) =>
      session.participants.map((participant) => participant.personId)
    ))].sort();
    return Object.freeze(personIds.map((personId) => {
      const submissions = this.sqlite.query<EngagementSubmissionRow, [string, string, string]>(`
        SELECT DISTINCT submission_id
          FROM engagement_heads
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
           AND submission_id IS NOT NULL AND state = 'confirmed'
         ORDER BY submission_id
      `).all(scope.workspaceId, scope.eventId, personId);
      const contacts = submissions.flatMap((row) => {
        const contact = this.intake.readSubmissionContact(scope, row.submission_id);
        return contact?.personId === personId ? [contact.email] : [];
      });
      const byNormalized = new Map<string, string>();
      for (const email of contacts) {
        const trimmed = email.trim();
        byNormalized.set(trimmed.toLocaleLowerCase('en-US'), trimmed);
      }
      const emails = [...byNormalized.values()];
      if (emails.length > 1) return Object.freeze({ personId });
      return Object.freeze({ personId, ...(emails[0] ? { email: emails[0] } : {}) });
    }));
  }
}
