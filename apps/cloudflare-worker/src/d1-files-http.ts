import type {
  InvocationEvidence,
  RegisteredOperatorHttpReadBinding
} from '@jooevents/application';
import { fileIdInputSchema } from '@jooevents/contracts/files';
import {
  openInertFileDownload,
  type FileDownloadAssetSource,
  type InertDownloadOutcome
} from '@jooevents/files/download';
import type { FileBlobStreamingStore } from '@jooevents/files/blob';
import {
  parseOperationAccessLane,
  type CurrentAuthorityResolver
} from '@jooevents/identity-access';
import { parseEventId, type Clock, type WorkspaceId } from '@jooevents/kernel';
import {
  FILE_READ_ACCESS_POLICY,
  type FilesCurrentEventSource
} from '@jooevents/files-operations';
import type { OperatorOperationEvidenceVerifier } from '@jooevents/http-operation-adapters';

const DOWNLOAD_PATH = /^\/api\/events\/current\/files\/download\/([^/]+)$/;
const readLane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: FILE_READ_ACCESS_POLICY
});

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

export function createD1FilesOperatorHttpTransport(input: {
  readonly workspaceId: WorkspaceId;
  readonly delegate: { fetch(request: Request): Response | Promise<Response> };
  readonly evidence: OperatorOperationEvidenceVerifier;
  readonly evidenceBinding: RegisteredOperatorHttpReadBinding;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: FilesCurrentEventSource;
  readonly clock: Clock;
  readonly assets: FileDownloadAssetSource;
  readonly blobs: Pick<FileBlobStreamingStore, 'provider' | 'openReadStream'>;
}) {
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const match = DOWNLOAD_PATH.exec(new URL(request.url).pathname);
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
