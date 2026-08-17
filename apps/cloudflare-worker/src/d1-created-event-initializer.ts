import {
  createInitialEventSettingsCompanion,
  type Event
} from '@jooevents/event';
import {
  createCanonicalFieldRegistryBaseline,
  fieldRegistryStateDigest,
  type CanonicalFieldRegistryBaselineIds
} from '@jooevents/field-registry';
import { canonicalJsonText } from '@jooevents/kernel';
import {
  createInitialTemplateArtifact,
  starterTemplateArtifacts
} from '@jooevents/template-authoring';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import type { D1CreatedEventInitializer } from './d1-event-domain';

export interface D1CreatedEventInitializerIds extends CanonicalFieldRegistryBaselineIds {}

/** Buffers the runtime-neutral Event companions into the caller's Event-create batch. */
export function createD1CreatedEventInitializer(input: {
  readonly ids: D1CreatedEventInitializerIds;
}): D1CreatedEventInitializer {
  if (typeof input.ids.newFieldId !== 'function' || typeof input.ids.newChoiceId !== 'function') {
    throw new TypeError('d1_created_event_initializer_ids_invalid');
  }
  const ids = Object.freeze({
    newFieldId: input.ids.newFieldId.bind(input.ids),
    newChoiceId: input.ids.newChoiceId.bind(input.ids)
  });
  return Object.freeze({
    initializeCreatedEvent({
      unitOfWork,
      event
    }: Readonly<{ unitOfWork: D1BufferedUnitOfWork; event: Event }>): void {
      const createdAtMs = Date.parse(event.createdAt);
      unitOfWork.write(`INSERT INTO events (id,workspace_id,name,created_at,updated_at)
        VALUES (?,?,?,?,?)`, [
        event.id,
        event.workspaceId,
        event.name,
        createdAtMs,
        createdAtMs
      ]);

      const fieldRegistry = createCanonicalFieldRegistryBaseline({
        scope: { workspaceId: event.workspaceId, eventId: event.id },
        ids
      });
      const fieldRegistryDigest = fieldRegistryStateDigest(fieldRegistry);
      unitOfWork.write(`INSERT INTO field_registry_aggregates (
        workspace_id,event_id,registry_version,state_json,
        state_digest_sha256,baseline_digest_sha256
      ) VALUES (?,?,?,?,?,?)`, [
        event.workspaceId,
        event.id,
        fieldRegistry.version,
        canonicalJsonText(fieldRegistry),
        fieldRegistryDigest,
        fieldRegistryDigest
      ]);

      const settings = createInitialEventSettingsCompanion(event);
      unitOfWork.write(`INSERT INTO event_settings_companions (
        workspace_id,event_id,event_version,location,venue_note,
        day_start,day_end,slot_minutes
      ) VALUES (?,?,?,?,?,?,?,?)`, [
        settings.workspaceId,
        settings.eventId,
        settings.eventVersion,
        settings.location,
        settings.venueNote,
        settings.dayStart,
        settings.dayEnd,
        settings.slotMinutes
      ]);

      for (const seed of starterTemplateArtifacts({
        scope: { workspaceId: event.workspaceId, eventId: event.id },
        eventName: event.name
      })) {
        const snapshot = createInitialTemplateArtifact({
          scope: { workspaceId: event.workspaceId, eventId: event.id },
          artifactId: seed.artifactId,
          revisionId: seed.revisionId,
          document: seed.document,
          createdByUserId: event.createdByUserId,
          createdAt: event.createdAt
        });
        unitOfWork.write(`INSERT INTO template_artifact_heads (
          workspace_id,event_id,artifact_id,artifact_kind,current_revision_id,
          current_revision_number,version
        ) VALUES (?,?,?,?,?,?,?)`, [
          event.workspaceId,
          event.id,
          snapshot.head.artifactId,
          snapshot.head.artifactKind,
          snapshot.head.currentRevisionId,
          snapshot.head.currentRevisionNumber,
          snapshot.head.version
        ]);
        unitOfWork.write(`INSERT INTO template_artifact_revisions (
          workspace_id,event_id,artifact_id,revision_id,revision_number,
          predecessor_revision_id,predecessor_digest_sha256,artifact_kind,
          revision_json,digest_sha256,created_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
          event.workspaceId,
          event.id,
          snapshot.current.artifactId,
          snapshot.current.revisionId,
          snapshot.current.number,
          null,
          null,
          snapshot.current.document.kind,
          JSON.stringify(snapshot.current),
          snapshot.current.digestSha256,
          createdAtMs
        ]);
      }
    }
  });
}
