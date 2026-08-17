import type { FileAssetDto, FileUploadIntentDto } from '@jooevents/contracts/files';
import { parseFileAsset, parseFileUploadIntent } from '@jooevents/files/commands';
import { canonicalJsonText, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import type { D1ApplicationRuntimeEnvironment } from './d1-application-runtime';
import { runD1BufferedUnitOfWork } from './d1-atomic-batch';
import { createR2FileBlobStore } from './r2-file-blob-store';

const MAXIMUM_ROWS_PER_WAKE = 100;
const MAXIMUM_R2_KEYS_PER_WAKE = 1_000;
const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

interface HeadRow { readonly head_json: string }
interface CountRow { readonly count: number }

export interface D1FilesCleanupWakeResult {
  readonly expiredIntents: number;
  readonly orphanAssets: number;
  readonly reconciledObjects: number;
  readonly faults: readonly Readonly<{
    kind: 'intent' | 'asset' | 'object';
    id: string;
    errorName: string;
  }>[];
}

function parseHead<Value>(
  row: HeadRow,
  parser: (value: unknown) => Value,
  label: string
): Value {
  try {
    const value = parser(JSON.parse(row.head_json));
    if (canonicalJsonText(value) !== row.head_json) throw new TypeError();
    return value;
  } catch (error) {
    throw new TypeError(`d1_files_cleanup_${label}_corrupt`, { cause: error });
  }
}

async function transitionExpiredIntent(
  database: D1Database,
  intent: FileUploadIntentDto
): Promise<void> {
  const next = parseFileUploadIntent({ ...intent, state: 'discarded' });
  await runD1BufferedUnitOfWork({
    database,
    work: async (unitOfWork) => {
      unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM file_upload_intents
        WHERE workspace_id = ? AND event_id = ? AND id = ? AND head_json = ?
          AND state IN ('pending','stored'))`, [
        intent.scope.workspaceId, intent.scope.eventId, intent.id, canonicalJsonText(intent)
      ]);
      unitOfWork.write(`UPDATE file_upload_intents
        SET state = 'discarded',head_json = ?
        WHERE workspace_id = ? AND event_id = ? AND id = ? AND head_json = ?`, [
        canonicalJsonText(next), intent.scope.workspaceId, intent.scope.eventId,
        intent.id, canonicalJsonText(intent)
      ]);
    }
  });
}

async function deleteOrphanAssetRecord(
  database: D1Database,
  asset: FileAssetDto
): Promise<void> {
  await runD1BufferedUnitOfWork({
    database,
    work: async (unitOfWork) => {
      unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM file_assets asset
        WHERE asset.workspace_id = ? AND asset.event_id = ? AND asset.id = ?
          AND asset.head_json = ? AND asset.lifecycle <> 'blocked'
          AND NOT EXISTS (SELECT 1 FROM file_attachments attachment
            WHERE attachment.workspace_id = asset.workspace_id
              AND attachment.event_id = asset.event_id
              AND attachment.asset_id = asset.id))`, [
        asset.scope.workspaceId, asset.scope.eventId, asset.id, canonicalJsonText(asset)
      ]);
      unitOfWork.write(`DELETE FROM file_assets
        WHERE workspace_id = ? AND event_id = ? AND id = ? AND head_json = ?
          AND NOT EXISTS (SELECT 1 FROM file_attachments attachment
            WHERE attachment.workspace_id = file_assets.workspace_id
              AND attachment.event_id = file_assets.event_id
              AND attachment.asset_id = file_assets.id)`, [
        asset.scope.workspaceId, asset.scope.eventId, asset.id, canonicalJsonText(asset)
      ]);
    }
  });
}

async function objectIsReferenced(
  database: D1Database,
  workspaceId: WorkspaceId,
  storageKey: string
): Promise<boolean> {
  const row = await database.withSession('first-primary').prepare(`SELECT (
    (SELECT count(*) FROM file_assets
      WHERE workspace_id = ? AND storage_key = ?)
    + (SELECT count(*) FROM file_upload_intents
      WHERE workspace_id = ? AND storage_key = ? AND state IN ('pending','stored','confirmed'))
  ) AS count`).bind(workspaceId, storageKey, workspaceId, storageKey).first<CountRow>();
  return (row?.count ?? 0) > 0;
}

/**
 * Bounded Files maintenance lane. SQL terminalizes before R2 deletion, while
 * the final R2 reconciliation pass makes a crash-stranded object discoverable
 * on the next wake without ever deleting a key still referenced by a pending
 * intent or retained asset.
 */
export async function dispatchD1FilesCleanupWake(
  environment: D1ApplicationRuntimeEnvironment,
  input: { readonly workspaceId: WorkspaceId; readonly nowMs?: number }
): Promise<D1FilesCleanupWakeResult> {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('d1_files_cleanup_now_invalid');
  const session = environment.DB.withSession('first-primary');
  const [intentRows, assetRows] = await session.batch([
    session.prepare(`SELECT head_json FROM file_upload_intents
      WHERE workspace_id = ? AND state IN ('pending','stored') AND expires_at_ms <= ?
      ORDER BY expires_at_ms,id COLLATE BINARY LIMIT ?`)
      .bind(workspaceId, nowMs, MAXIMUM_ROWS_PER_WAKE),
    session.prepare(`SELECT asset.head_json FROM file_assets asset
      WHERE asset.workspace_id = ? AND asset.created_at_ms <= ?
        AND asset.lifecycle <> 'blocked'
        AND NOT EXISTS (SELECT 1 FROM file_attachments attachment
          WHERE attachment.workspace_id = asset.workspace_id
            AND attachment.event_id = asset.event_id
            AND attachment.asset_id = asset.id)
      ORDER BY asset.created_at_ms,asset.id COLLATE BINARY LIMIT ?`)
      .bind(workspaceId, nowMs - ORPHAN_GRACE_MS, MAXIMUM_ROWS_PER_WAKE)
  ]);
  const intents = (intentRows as D1Result<HeadRow>).results.map((row) =>
    parseHead(row, parseFileUploadIntent, 'intent'));
  const assets = (assetRows as D1Result<HeadRow>).results.map((row) =>
    parseHead(row, parseFileAsset, 'asset'));
  const blobs = createR2FileBlobStore({ bucket: environment.FILES });
  const faults: Array<{
    kind: 'intent' | 'asset' | 'object'; id: string; errorName: string;
  }> = [];
  let expiredIntents = 0;
  let orphanAssets = 0;
  let reconciledObjects = 0;

  for (const intent of intents) {
    try {
      await transitionExpiredIntent(environment.DB, intent);
      if (intent.state === 'stored') await blobs.deleteObject(intent.storageKey);
      expiredIntents += 1;
    } catch (error) {
      faults.push({
        kind: 'intent', id: intent.id,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      });
    }
  }
  for (const asset of assets) {
    try {
      await deleteOrphanAssetRecord(environment.DB, asset);
      await blobs.deleteObject(asset.storageKey);
      orphanAssets += 1;
    } catch (error) {
      faults.push({
        kind: 'asset', id: asset.id,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      });
    }
  }

  const listed = await environment.FILES.list({
    prefix: `files/${workspaceId}/`,
    limit: MAXIMUM_R2_KEYS_PER_WAKE
  });
  for (const object of listed.objects) {
    try {
      if (!await objectIsReferenced(environment.DB, workspaceId, object.key)) {
        await environment.FILES.delete(object.key);
        reconciledObjects += 1;
      }
    } catch (error) {
      faults.push({
        kind: 'object', id: object.key,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      });
    }
  }
  return Object.freeze({
    expiredIntents,
    orphanAssets,
    reconciledObjects,
    faults: Object.freeze(faults.map((fault) => Object.freeze(fault)))
  });
}
