import type { Database } from 'bun:sqlite';
import {
  createClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles
} from '@jooevents/application';
import type { SynchronousClassifiedPayloadStore } from
  '@jooevents/application/synchronous-classified-payload-store';
import { createHash } from 'node:crypto';
import { createPayloadRef, parseInstant, parsePayloadRefId } from '@jooevents/kernel';

export const CALENDAR_NOTICE_ARTIFACT_PURPOSE = 'calendar_notice_artifact' as const;

const profiles: ClassifiedPayloadProfiles = Object.freeze({
  classification: createClassifiedPayloadProfileRef(
    'classification', 'classification.communication-calendar', 1
  ),
  schema: createClassifiedPayloadProfileRef('schema', 'schema.calendar-itip', 1),
  content: createClassifiedPayloadProfileRef('content', 'content.calendar-itip', 1),
  integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
  descriptorAuth: createClassifiedPayloadProfileRef(
    'descriptor_auth', 'descriptor-auth.calendar-itip', 1
  )
});

function scopeBinding(input: {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly generationId: string;
  readonly method: 'REQUEST' | 'CANCEL';
}): string {
  return `calendar-notice:${input.workspaceId}:${input.eventId}:${input.generationId}:${input.method}`;
}

function binding(selectedScope: string) {
  return Object.freeze({ profiles, scopeBinding: selectedScope, contentType: 'text/calendar' });
}

export interface StoredCalendarNoticeArtifact {
  readonly contentBytesRef: string;
  readonly filename: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly method: 'REQUEST' | 'CANCEL';
}

/** Immutable encrypted byte store and provider resolver over the existing payload table. */
export class SQLiteCalendarNoticeArtifactStore {
  constructor(
    private readonly sqlite: Database,
    private readonly classified: SynchronousClassifiedPayloadStore
  ) {}

  put(input: {
    readonly payloadRefId: string;
    readonly workspaceId: string;
    readonly eventId: string;
    readonly generationId: string;
    readonly method: 'REQUEST' | 'CANCEL';
    readonly bytes: Uint8Array;
    readonly createdAt: string;
  }): StoredCalendarNoticeArtifact {
    const payloadRefId = parsePayloadRefId(input.payloadRefId);
    const selectedScope = scopeBinding(input);
    this.classified.put({
      payloadRefId,
      binding: binding(selectedScope),
      purpose: CALENDAR_NOTICE_ARTIFACT_PURPOSE,
      bytes: input.bytes,
      createdAt: parseInstant(input.createdAt)
    });
    return Object.freeze({
      contentBytesRef: payloadRefId,
      filename: input.method === 'REQUEST' ? 'calendar-update.ics' : 'calendar-cancellation.ics',
      byteLength: input.bytes.byteLength,
      contentSha256: createHash('sha256').update(input.bytes).digest('hex'),
      method: input.method
    });
  }

  resolveContentBytes(contentBytesRef: string): Uint8Array {
    const payloadRefId = parsePayloadRefId(contentBytesRef);
    const rows = this.sqlite.query<{
      scope_binding: string; purpose: string; content_type: string;
      classification_profile_key: string; classification_profile_version: number;
      schema_profile_key: string; schema_profile_version: number;
      content_profile_key: string; content_profile_version: number;
      integrity_profile_key: string; integrity_profile_version: number;
      descriptor_auth_profile_key: string; descriptor_auth_profile_version: number;
    }, [string]>(`
      SELECT scope_binding,purpose,content_type,
             classification_profile_key,classification_profile_version,
             schema_profile_key,schema_profile_version,content_profile_key,content_profile_version,
             integrity_profile_key,integrity_profile_version,
             descriptor_auth_profile_key,descriptor_auth_profile_version
        FROM classified_payload_records WHERE payload_ref_id=? LIMIT 2
    `).all(payloadRefId);
    const row = rows[0];
    if (rows.length !== 1 || row === undefined
        || row.purpose !== CALENDAR_NOTICE_ARTIFACT_PURPOSE
        || row.content_type !== 'text/calendar'
        || !row.scope_binding.startsWith('calendar-notice:')
        || row.classification_profile_key !== profiles.classification.key
        || row.classification_profile_version !== profiles.classification.version
        || row.schema_profile_key !== profiles.schema.key
        || row.schema_profile_version !== profiles.schema.version
        || row.content_profile_key !== profiles.content.key
        || row.content_profile_version !== profiles.content.version
        || row.integrity_profile_key !== profiles.integrity.key
        || row.integrity_profile_version !== profiles.integrity.version
        || row.descriptor_auth_profile_key !== profiles.descriptorAuth.key
        || row.descriptor_auth_profile_version !== profiles.descriptorAuth.version) {
      throw new TypeError('calendar_notice_artifact_ref_invalid');
    }
    return this.classified.read({
      payloadRef: createPayloadRef(payloadRefId),
      expectedBinding: binding(row.scope_binding),
      purpose: CALENDAR_NOTICE_ARTIFACT_PURPOSE
    });
  }
}
