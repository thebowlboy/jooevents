import { acceleventsExportArtifactReadInputSchema } from '@jooevents/contracts';
import { Hono, type Context } from 'hono';
import type { ReturnTypeOrPromise } from './types';

export type AcceleventsExportDownloadKind = 'locations' | 'package';

export interface AcceleventsExportDownloadRuntime {
  download(input: {
    readonly kind: AcceleventsExportDownloadKind;
    readonly request: Request;
    readonly releaseId: string;
    readonly correlationId: string;
  }): ReturnTypeOrPromise<Response>;
}

export function createAcceleventsExportDownloadHttpAdapter(runtime: AcceleventsExportDownloadRuntime) {
  const app = new Hono();
  const route = (kind: AcceleventsExportDownloadKind) => async (context: Context) => {
    const parsed = acceleventsExportArtifactReadInputSchema.safeParse({
      releaseId: context.req.query('releaseId')
    });
    if (!parsed.success) {
      return context.json({
        code: 'invalid_request',
        message: 'Choose a released program before downloading this export.',
        retryable: false,
        correlationId: context.get('correlationId' as never) as string
      }, 400);
    }
    return runtime.download({
      kind,
      request: context.req.raw,
      releaseId: parsed.data.releaseId,
      correlationId: context.get('correlationId' as never) as string
    });
  };
  app.get('/api/events/current/integrations/accelevents/locations.csv', route('locations'));
  app.get('/api/events/current/integrations/accelevents/package.zip', route('package'));
  return app;
}
