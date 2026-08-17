import type {
  InvocationEvidence,
  RegisteredOperatorHttpEffectBinding,
  RegisteredOperatorHttpReadBinding
} from '@jooevents/application';
import { fileIdInputSchema, type FileUploadIntentDto } from '@jooevents/contracts/files';
import {
  openInertFileDownload,
  type FileDownloadAssetSource,
  type InertDownloadOutcome
} from '@jooevents/files/download';
import type { FileBlobStreamingStore } from '@jooevents/files/blob';
import {
  parseFileUploadIntent,
  streamFileUploadBytes,
  type StreamUploadBytesResult
} from '@jooevents/files/commands';
import {
  parseOperationAccessLane,
  type CurrentAuthorityResolver
} from '@jooevents/identity-access';
import { canonicalJsonText } from '@jooevents/kernel';
import { parseEventId, type Clock, type WorkspaceId } from '@jooevents/kernel';
import {
  FILES_COMMAND_ACCESS_POLICY,
  FILE_READ_ACCESS_POLICY,
  type FilesCurrentEventSource
} from '@jooevents/files-operations';
import type { OperatorOperationEvidenceVerifier } from '@jooevents/http-operation-adapters';
import { runD1BufferedUnitOfWork } from './d1-atomic-batch';

const DOWNLOAD_PATH = /^\/api\/events\/current\/files\/download\/([^/]+)$/;
const UPLOAD_BYTES_PATH = /^\/api\/events\/current\/files\/uploads\/([^/]+)\/bytes$/;
const MAXIMUM_UPLOAD_ATTEMPTS_PER_INTENT = 5;
const readLane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: FILE_READ_ACCESS_POLICY
});
const commandLane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: FILES_COMMAND_ACCESS_POLICY
});

type UploadAttemptTerminal = Readonly<{
  state: 'safe_refusal' | 'ambiguous_failure';
  outcomeCode: string;
}>;

interface UploadClaimStateRow {
  readonly total: number;
  readonly active: number;
  readonly pending: number;
}

function uploadFailureCode(error: unknown): string {
  const candidate = error instanceof Error ? error.name.trim() : '';
  return (candidate || 'UnknownError').slice(0, 100);
}

function responseHeaders(correlationId: string): Headers {
  return new Headers({
    'cache-control': 'private, no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-correlation-id': correlationId
  });
}

function json(body: unknown, status: number, correlationId: string): Response {
  const headers = responseHeaders(correlationId);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
}

function webStream(bytes: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = bytes[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    }
  });
}

function downloadResponse(
  outcome: InertDownloadOutcome,
  correlationId: string
): Response {
  if (outcome.kind === 'not_found') {
    return json({ kind: 'not_found' }, 404, correlationId);
  }
  if (outcome.kind === 'refused') {
    const statuses = {
      asset_blocked: 403,
      content_type_not_servable: 415,
      blob_missing: 410
    } as const;
    return json({ kind: 'refused', code: outcome.code }, statuses[outcome.code], correlationId);
  }
  const headers = responseHeaders(correlationId);
  headers.set('content-type', outcome.headers.contentType);
  headers.set('content-disposition', outcome.headers.contentDisposition);
  headers.set('content-length', String(outcome.byteSize));
  return new Response(webStream(outcome.bytes), { status: 200, headers });
}

async function* requestBodyBytes(request: Request): AsyncIterable<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      if (!(next.value instanceof Uint8Array)) throw new TypeError('files_upload_chunk_invalid');
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function uploadResponse(outcome: StreamUploadBytesResult, correlationId: string): Response {
  if (outcome.kind === 'stored') {
    return json({
      kind: 'stored',
      intent: {
        id: outcome.intent.id,
        contentType: outcome.intent.contentType,
        byteSize: outcome.intent.storedByteSize,
        sha256: outcome.intent.storedSha256
      }
    }, 200, correlationId);
  }
  const status = {
    intent_not_pending: 409,
    intent_expired: 410,
    byte_cap_exceeded: 413,
    empty_stream: 400,
    image_reencoder_unavailable: 422,
    image_decode_failed: 422,
    image_reencode_invalid: 422
  } as const;
  return json({ kind: 'refused', code: outcome.code }, status[outcome.code], correlationId);
}

async function readIntent(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
  readonly eventId: string;
  readonly intentId: string;
}): Promise<FileUploadIntentDto | undefined> {
  const row = await input.database.withSession('first-primary').prepare(
    `SELECT head_json FROM file_upload_intents
      WHERE workspace_id = ? AND event_id = ? AND id = ? LIMIT 2`
  ).bind(input.workspaceId, input.eventId, input.intentId).all<{ readonly head_json: string }>();
  if (row.results.length > 1) throw new TypeError('d1_file_upload_intent_not_unique');
  const head = row.results[0];
  if (!head) return undefined;
  const intent = parseFileUploadIntent(JSON.parse(head.head_json));
  if (intent.id !== input.intentId || intent.scope.workspaceId !== input.workspaceId
      || intent.scope.eventId !== input.eventId || canonicalJsonText(intent) !== head.head_json) {
    throw new TypeError('d1_file_upload_intent_corrupt');
  }
  return intent;
}

async function persistIntentTransition(input: {
  readonly database: D1Database;
  readonly expected: FileUploadIntentDto;
  readonly next: FileUploadIntentDto;
  readonly attemptId?: string;
  readonly finishedAtMs?: number;
}): Promise<void> {
  await runD1BufferedUnitOfWork({
    database: input.database,
    work: async (unitOfWork) => {
      unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM file_upload_intents
        WHERE workspace_id = ? AND event_id = ? AND id = ? AND head_json = ?)`, [
        input.expected.scope.workspaceId,
        input.expected.scope.eventId,
        input.expected.id,
        canonicalJsonText(input.expected)
      ]);
      if (input.attemptId) {
        unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM d1_file_upload_transfer_attempts
          WHERE attempt_id = ? AND workspace_id = ? AND event_id = ? AND intent_id = ?
            AND storage_key = ? AND state = 'claimed')`, [
          input.attemptId,
          input.expected.scope.workspaceId,
          input.expected.scope.eventId,
          input.expected.id,
          input.expected.storageKey
        ]);
      }
      unitOfWork.write(`UPDATE file_upload_intents
        SET state = ?,stored_byte_size = ?,stored_sha256 = ?,head_json = ?
        WHERE workspace_id = ? AND event_id = ? AND id = ? AND head_json = ?`, [
        input.next.state,
        input.next.storedByteSize,
        input.next.storedSha256,
        canonicalJsonText(input.next),
        input.expected.scope.workspaceId,
        input.expected.scope.eventId,
        input.expected.id,
        canonicalJsonText(input.expected)
      ]);
      if (input.attemptId) {
        if (input.finishedAtMs === undefined || input.next.storedByteSize === null
            || input.next.storedSha256 === null) {
          throw new TypeError('d1_file_upload_stored_attempt_invalid');
        }
        unitOfWork.write(`UPDATE d1_file_upload_transfer_attempts
          SET state = 'stored',stored_byte_size = ?,stored_sha256 = ?,finished_at_ms = ?
          WHERE attempt_id = ? AND state = 'claimed'`, [
          input.next.storedByteSize,
          input.next.storedSha256,
          input.finishedAtMs,
          input.attemptId
        ]);
      }
    }
  });
}

async function claimUploadAttempt(input: {
  readonly database: D1Database;
  readonly intent: FileUploadIntentDto;
  readonly attemptId: string;
  readonly startedAtMs: number;
}): Promise<'claimed' | 'active' | 'exhausted' | 'stale'> {
  try {
    await runD1BufferedUnitOfWork({
      database: input.database,
      maximumAttempts: 1,
      work: async (unitOfWork) => {
        unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM file_upload_intents
          WHERE workspace_id = ? AND event_id = ? AND id = ? AND head_json = ?
            AND state = 'pending')`, [
          input.intent.scope.workspaceId,
          input.intent.scope.eventId,
          input.intent.id,
          canonicalJsonText(input.intent)
        ]);
        unitOfWork.assertCurrent(`(SELECT count(*) FROM d1_file_upload_transfer_attempts
          WHERE workspace_id = ? AND event_id = ? AND intent_id = ?) < ?`, [
          input.intent.scope.workspaceId,
          input.intent.scope.eventId,
          input.intent.id,
          MAXIMUM_UPLOAD_ATTEMPTS_PER_INTENT
        ]);
        unitOfWork.write(`INSERT INTO d1_file_upload_transfer_attempts (
          attempt_id,workspace_id,event_id,intent_id,storage_key,state,outcome_code,
          stored_byte_size,stored_sha256,started_at_ms,finished_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'claimed', NULL, NULL, NULL, ?, NULL)`, [
          input.attemptId,
          input.intent.scope.workspaceId,
          input.intent.scope.eventId,
          input.intent.id,
          input.intent.storageKey,
          input.startedAtMs
        ]);
      }
    });
    return 'claimed';
  } catch (error) {
    const current = await input.database.withSession('first-primary').prepare(
      `SELECT
        (SELECT count(*) FROM d1_file_upload_transfer_attempts
          WHERE workspace_id = ? AND event_id = ? AND intent_id = ?) AS total,
        EXISTS (SELECT 1 FROM d1_file_upload_transfer_attempts
          WHERE workspace_id = ? AND event_id = ? AND intent_id = ?
            AND state IN ('claimed','stored','ambiguous_failure')) AS active,
        EXISTS (SELECT 1 FROM file_upload_intents
          WHERE workspace_id = ? AND event_id = ? AND id = ? AND head_json = ?
            AND state = 'pending') AS pending`
    ).bind(
      input.intent.scope.workspaceId,
      input.intent.scope.eventId,
      input.intent.id,
      input.intent.scope.workspaceId,
      input.intent.scope.eventId,
      input.intent.id,
      input.intent.scope.workspaceId,
      input.intent.scope.eventId,
      input.intent.id,
      canonicalJsonText(input.intent)
    ).first<UploadClaimStateRow>();
    if (current?.active === 1) return 'active';
    if ((current?.total ?? 0) >= MAXIMUM_UPLOAD_ATTEMPTS_PER_INTENT) return 'exhausted';
    if (current?.pending === 0) return 'stale';
    throw error;
  }
}

async function finishUploadAttempt(input: {
  readonly database: D1Database;
  readonly attemptId: string;
  readonly terminal: UploadAttemptTerminal;
  readonly finishedAtMs: number;
}): Promise<void> {
  await runD1BufferedUnitOfWork({
    database: input.database,
    maximumAttempts: 1,
    work: async (unitOfWork) => {
      unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM d1_file_upload_transfer_attempts
        WHERE attempt_id = ? AND state = 'claimed')`, [input.attemptId]);
      unitOfWork.write(`UPDATE d1_file_upload_transfer_attempts
        SET state = ?,outcome_code = ?,finished_at_ms = ?
        WHERE attempt_id = ? AND state = 'claimed'`, [
        input.terminal.state,
        input.terminal.outcomeCode,
        input.finishedAtMs,
        input.attemptId
      ]);
    }
  });
}

export function createD1FilesOperatorHttpTransport(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
  readonly delegate: { fetch(request: Request): Response | Promise<Response> };
  readonly evidence: OperatorOperationEvidenceVerifier;
  readonly evidenceBinding: RegisteredOperatorHttpReadBinding;
  readonly commandEvidenceBinding: RegisteredOperatorHttpEffectBinding;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: FilesCurrentEventSource;
  readonly clock: Clock;
  readonly assets: FileDownloadAssetSource;
  readonly blobs: FileBlobStreamingStore;
}) {
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      const uploadMatch = UPLOAD_BYTES_PATH.exec(pathname);
      if (uploadMatch) {
        const correlationId = crypto.randomUUID();
        let claimedAttemptId: string | undefined;
        let claimedStartedAtMs: number | undefined;
        if (request.method !== 'PUT') {
          const response = json({ kind: 'refused', code: 'method_not_allowed' }, 405, correlationId);
          response.headers.set('allow', 'PUT');
          return response;
        }
        try {
          // The session verifier binds CSRF checks to registered POST effects;
          // this transport changes only the method for that verification and
          // evaluates current Files authority itself before moving bytes.
          const verificationRequest = new Request(request.url, {
            method: 'POST',
            headers: request.headers
          });
          const verified = await input.evidence.verify({
            request: verificationRequest,
            correlationId,
            binding: input.commandEvidenceBinding
          });
          if (verified.kind === 'rejected') {
            return json({ kind: 'refused', code: verified.reason },
              verified.reason === 'unauthenticated' ? 401 : 403, correlationId);
          }
          const current = await input.currentEvent.resolveCurrentEvent(input.workspaceId);
          if (!current.eventId) {
            return json({ kind: 'refused', code: 'event_required' }, 409, correlationId);
          }
          const eventId = parseEventId(current.eventId);
          const scope = Object.freeze({
            workspaceId: input.workspaceId,
            eventId,
            subjects: Object.freeze([
              Object.freeze({ kind: 'workspace' as const, id: input.workspaceId }),
              Object.freeze({ kind: 'event' as const, id: eventId })
            ]),
            resolutionEvidenceIds: Object.freeze([...current.evidenceIds])
          });
          const authority = await input.currentAuthority.resolve({
            operation: { name: 'file.upload.intent', version: 1, effect: 'commit' },
            evidence: verified.evidence as InvocationEvidence,
            lane: commandLane,
            scope,
            evaluatedAt: input.clock.now()
          });
          if (authority.kind !== 'authorized') {
            return json({ kind: 'refused', code: 'forbidden' }, 403, correlationId);
          }
          const intentId = fileIdInputSchema.safeParse(uploadMatch[1] ?? '');
          if (!intentId.success) return json({ kind: 'not_found' }, 404, correlationId);
          const intent = await readIntent({
            database: input.database,
            workspaceId: input.workspaceId,
            eventId,
            intentId: intentId.data
          });
          if (!intent) return json({ kind: 'not_found' }, 404, correlationId);
          const actor = authority.authority.actor as {
            readonly kind: string;
            readonly userId?: unknown;
          };
          if (actor.kind !== 'workspace_user' || typeof actor.userId !== 'string') {
            throw new TypeError('d1_file_upload_actor_invalid');
          }
          if (intent.uploader.kind !== 'operator_user'
              || intent.uploader.userId !== actor.userId) {
            return json({ kind: 'refused', code: 'not_intent_owner' }, 403, correlationId);
          }
          const uploadNow = input.clock.now();
          if (intent.state === 'pending'
              && Date.parse(uploadNow) < Date.parse(intent.expiresAt)) {
            const attemptId = crypto.randomUUID();
            const startedAtMs = Date.parse(uploadNow);
            const claim = await claimUploadAttempt({
              database: input.database,
              intent,
              attemptId,
              startedAtMs
            });
            if (claim !== 'claimed') {
              const code = claim === 'exhausted'
                ? 'upload_attempts_exhausted'
                : claim === 'stale' ? 'intent_not_pending' : 'upload_in_progress';
              return json({ kind: 'refused', code }, 409, correlationId);
            }
            claimedAttemptId = attemptId;
            claimedStartedAtMs = startedAtMs;
          }
          let transition: { readonly expected: FileUploadIntentDto;
            readonly next: FileUploadIntentDto } | undefined;
          const outcome = await streamFileUploadBytes({
            intents: Object.freeze({
              readIntent: () => intent,
              createIntent: () => { throw new TypeError('d1_file_upload_create_unavailable'); },
              transitionIntent: (change: {
                readonly expected: FileUploadIntentDto;
                readonly next: FileUploadIntentDto;
              }) => { transition = change; }
            }),
            intent,
            bytes: requestBodyBytes(request),
            blobs: input.blobs,
            now: uploadNow
          });
          if (transition) {
            await persistIntentTransition({
              database: input.database,
              ...transition,
              ...(claimedAttemptId
                ? {
                    attemptId: claimedAttemptId,
                    finishedAtMs: Math.max(claimedStartedAtMs!, Date.now())
                  }
                : {})
            });
          } else if (claimedAttemptId && outcome.kind === 'refused') {
            await finishUploadAttempt({
              database: input.database,
              attemptId: claimedAttemptId,
              terminal: { state: 'safe_refusal', outcomeCode: outcome.code },
              finishedAtMs: Math.max(claimedStartedAtMs!, Date.now())
            });
          }
          return uploadResponse(outcome, correlationId);
        } catch (error) {
          if (claimedAttemptId) {
            try {
              await finishUploadAttempt({
                database: input.database,
                attemptId: claimedAttemptId,
                terminal: {
                  state: 'ambiguous_failure',
                  outcomeCode: uploadFailureCode(error)
                },
                finishedAtMs: Math.max(claimedStartedAtMs!, Date.now())
              });
            } catch {
              // Leaving the attempt claimed is the fail-closed outcome: the
              // immutable storage key cannot be reused after uncertain R2 I/O.
            }
          }
          console.error(JSON.stringify({
            event: 'cloudflare.files.upload_failed',
            correlationId,
            errorName: error instanceof Error ? error.name : 'UnknownError'
          }));
          return json({ kind: 'refused', code: 'internal_error', retryable: true },
            500, correlationId);
        }
      }
      const match = DOWNLOAD_PATH.exec(pathname);
      if (!match) return input.delegate.fetch(request);
      const correlationId = crypto.randomUUID();
      if (request.method !== 'GET') {
        const response = json({ kind: 'refused', code: 'method_not_allowed' }, 405, correlationId);
        response.headers.set('allow', 'GET');
        return response;
      }
      try {
        const verified = await input.evidence.verify({
          request,
          correlationId,
          binding: input.evidenceBinding
        });
        if (verified.kind === 'rejected') {
          return json(
            { kind: 'refused', code: verified.reason },
            verified.reason === 'unauthenticated' ? 401 : 403,
            correlationId
          );
        }
        const current = await input.currentEvent.resolveCurrentEvent(input.workspaceId);
        if (!current.eventId) {
          return json({ kind: 'refused', code: 'event_required' }, 409, correlationId);
        }
        const eventId = parseEventId(current.eventId);
        const scope = Object.freeze({
          workspaceId: input.workspaceId,
          eventId,
          subjects: Object.freeze([
            Object.freeze({ kind: 'workspace' as const, id: input.workspaceId }),
            Object.freeze({ kind: 'event' as const, id: eventId })
          ]),
          resolutionEvidenceIds: Object.freeze([...current.evidenceIds])
        });
        const authority = await input.currentAuthority.resolve({
          operation: { name: 'file.overview.read', version: 1, effect: 'read' },
          evidence: verified.evidence as InvocationEvidence,
          lane: readLane,
          scope,
          evaluatedAt: input.clock.now()
        });
        if (authority.kind !== 'authorized') {
          return json({ kind: 'refused', code: 'forbidden' }, 403, correlationId);
        }
        const assetId = fileIdInputSchema.safeParse(match[1] ?? '');
        if (!assetId.success) {
          return json({ kind: 'refused', code: 'invalid_request' }, 400, correlationId);
        }
        return downloadResponse(await openInertFileDownload({
          assets: input.assets,
          blobs: input.blobs,
          scope: { workspaceId: input.workspaceId, eventId },
          assetId: assetId.data
        }), correlationId);
      } catch (error) {
        console.error(JSON.stringify({
          event: 'cloudflare.files.download_failed',
          correlationId,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        }));
        return json({ kind: 'refused', code: 'internal_error', retryable: true }, 500, correlationId);
      }
    }
  });
}
