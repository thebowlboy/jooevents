import type { FilesOrganizerReadPort } from '@jooevents/files-operations';
import type { FileDownloadAssetSource } from '@jooevents/files/download';
import {
  fileAssetSchema,
  fileAttachmentSchema,
  fileRequestSchema,
  organizerFileOverviewSchema,
  resourceShareSchema,
  type FileScopeDto
} from '@jooevents/contracts/files';
import {
  canonicalJsonText,
  parseEventId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';

interface ScopeRootRow { readonly event_id: string }
interface AttachmentRow {
  readonly attachment_json: string;
  readonly asset_json: string | null;
}
interface HeadRow { readonly head_json: string }

/** Exact asset metadata source for the separately authorized inert-download transport. */
export function createD1FileDownloadAssetSource(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
}): FileDownloadAssetSource {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async readAssetForDownload(requestedScope: FileScopeDto, assetId: string) {
      const scope = Object.freeze({
        workspaceId: parseWorkspaceId(requestedScope.workspaceId),
        eventId: parseEventId(requestedScope.eventId)
      });
      if (scope.workspaceId !== workspaceId) {
        throw new TypeError('d1_file_download_workspace_mismatch');
      }
      const result = await input.database.withSession('first-primary').prepare(
        `SELECT head_json FROM file_assets
          WHERE workspace_id = ? AND event_id = ? AND id = ? LIMIT 2`
      ).bind(scope.workspaceId, scope.eventId, assetId).all<HeadRow>();
      if (result.results.length > 1) throw new D1FilesReadError('data_corrupt');
      const row = result.results[0];
      if (!row) return undefined;
      try {
        const asset = fileAssetSchema.parse(json(row.head_json));
        if (asset.id !== assetId
            || asset.scope.workspaceId !== scope.workspaceId
            || asset.scope.eventId !== scope.eventId
            || canonicalJsonText(asset) !== row.head_json) {
          throw new D1FilesReadError('data_corrupt');
        }
        return asset;
      } catch (error) {
        if (error instanceof D1FilesReadError) throw error;
        throw new D1FilesReadError('data_corrupt', { cause: error });
      }
    }
  });
}

export class D1FilesReadError extends Error {
  readonly name = 'D1FilesReadError';

  constructor(
    readonly code: 'scope_corrupt' | 'data_corrupt' | 'result_too_large',
    options?: ErrorOptions
  ) {
    super(code, options);
  }
}

function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new D1FilesReadError('data_corrupt', { cause: error });
  }
}

/** Reads the current organizer Files projection from one primary-consistent D1 batch. */
export function createD1FilesOrganizerReadPort(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
}): FilesOrganizerReadPort {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async readOrganizerFileOverview(requestedScope: FileScopeDto) {
      const scope = Object.freeze({
        workspaceId: parseWorkspaceId(requestedScope.workspaceId),
        eventId: parseEventId(requestedScope.eventId)
      });
      if (scope.workspaceId !== workspaceId) {
        throw new TypeError('d1_files_workspace_mismatch');
      }
      const session = input.database.withSession('first-primary');
      const [rootResult, attachmentResult, shareResult, requestResult] =
        await session.batch([
          session.prepare(`SELECT event_id FROM event_spine_scope_roots
            WHERE workspace_id = ? AND event_id = ? LIMIT 2`)
            .bind(scope.workspaceId, scope.eventId),
          session.prepare(`SELECT attachment.head_json AS attachment_json,
              asset.head_json AS asset_json
            FROM file_attachments attachment
            LEFT JOIN file_assets asset
              ON asset.workspace_id = attachment.workspace_id
             AND asset.event_id = attachment.event_id
             AND asset.id = attachment.asset_id
            WHERE attachment.workspace_id = ? AND attachment.event_id = ?
            ORDER BY attachment.attached_at_ms,attachment.id COLLATE BINARY
            LIMIT 10001`)
            .bind(scope.workspaceId, scope.eventId),
          session.prepare(`SELECT head_json FROM resource_shares
            WHERE workspace_id = ? AND event_id = ?
            ORDER BY created_at_ms,id COLLATE BINARY
            LIMIT 1001`)
            .bind(scope.workspaceId, scope.eventId),
          session.prepare(`SELECT head_json FROM file_requests
            WHERE workspace_id = ? AND event_id = ?
            ORDER BY created_at_ms,id COLLATE BINARY
            LIMIT 10001`)
            .bind(scope.workspaceId, scope.eventId)
        ]);
      const roots = (rootResult as D1Result<ScopeRootRow>).results;
      if (roots.length > 1) throw new D1FilesReadError('scope_corrupt');
      if (roots.length === 0) return undefined;
      const attachmentRows = (attachmentResult as D1Result<AttachmentRow>).results;
      const shareRows = (shareResult as D1Result<HeadRow>).results;
      const requestRows = (requestResult as D1Result<HeadRow>).results;
      if (attachmentRows.length > 10_000 || shareRows.length > 1_000
          || requestRows.length > 10_000) {
        throw new D1FilesReadError('result_too_large');
      }
      try {
        return organizerFileOverviewSchema.parse({
          schemaVersion: 1,
          scope,
          attachments: attachmentRows.map((row) => {
            const attachment = fileAttachmentSchema.parse(json(row.attachment_json));
            const asset = row.asset_json === null
              ? null
              : fileAssetSchema.parse(json(row.asset_json));
            return Object.freeze({ attachment, asset });
          }),
          shares: shareRows.map((row) => resourceShareSchema.parse(json(row.head_json))),
          requests: requestRows.map((row) => fileRequestSchema.parse(json(row.head_json)))
        });
      } catch (error) {
        if (error instanceof D1FilesReadError) throw error;
        throw new D1FilesReadError('data_corrupt', { cause: error });
      }
    }
  });
}
