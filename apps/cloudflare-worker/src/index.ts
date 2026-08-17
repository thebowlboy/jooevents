import { SQLITE_E2_S8_RELEASE_FLOOR } from '@jooevents/persistence/release-floor-contract';
import { parseWorkspaceId } from '@jooevents/kernel';
import {
  CloudflareAuthConfigurationError,
  cloudflareAuthRuntimeEnabled,
  type CloudflareAuthBindings
} from './auth-config';
import { createConfiguredCloudflareAuthRuntime } from './auth-runtime';
import {
  cloudflareApplicationRuntimeEnabled,
  createConfiguredD1ApplicationRuntime
} from './d1-application-runtime';
import { dispatchD1OutboundEmailWake } from './d1-outbound-email-queue';
import { dispatchD1FilesCleanupWake } from './d1-files-cleanup';

export type CloudflareApplicationEnvironment = Omit<
  Env,
  | 'JOOEVENTS_AUTH_RUNTIME_ENABLED'
  | 'JOOEVENTS_APPLICATION_RUNTIME_ENABLED'
  | 'JOOEVENTS_FILES_MAX_UPLOAD_BYTES_SPEAKER'
  | 'JOOEVENTS_FILES_MAX_UPLOAD_BYTES_ORGANIZER'
  | 'JOOEVENTS_FILES_MAX_TOTAL_BYTES_PER_SPEAKER_EVENT'
  | 'JOOEVENTS_MAIL_FROM_ADDRESS'
  | 'JOOEVENTS_MAIL_FROM_NAME'
>
  & CloudflareAuthBindings
  & {
    readonly JOOEVENTS_MAIL_FROM_ADDRESS?: string;
    readonly JOOEVENTS_MAIL_FROM_NAME?: string;
    readonly JOOEVENTS_MAIL_REPLY_TO?: string;
  };

export interface CloudflareWakeMessage {
  readonly version: 1;
  readonly kind: 'maintenance.wake';
  readonly scheduledAtMs: number;
}

interface TerminalReceiptRow {
  readonly migration_id: string;
  readonly schema_epoch: number;
  readonly sequence: number;
  readonly result_fingerprint: string;
}

interface ReceiptCountRow { readonly count: number }
interface RuntimeInfrastructureCountRow { readonly count: number }
interface DatabaseMetadataRow {
  readonly database_class: string;
  readonly database_id: string;
}

export function isCloudflareWakeMessage(value: unknown): value is CloudflareWakeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CloudflareWakeMessage>;
  return candidate.version === 1
    && candidate.kind === 'maintenance.wake'
    && Number.isSafeInteger(candidate.scheduledAtMs)
    && (candidate.scheduledAtMs ?? -1) >= 0;
}

function json(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    }
  });
}

function protectedAssetResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function healthResponse(environment: CloudflareApplicationEnvironment): Promise<Response> {
  const correlationId = crypto.randomUUID();
  try {
    const terminal = await environment.DB.prepare(`
      SELECT migration_id,schema_epoch,sequence,result_fingerprint
        FROM schema_migrations
       ORDER BY schema_epoch DESC,sequence DESC
       LIMIT 1
    `).first<TerminalReceiptRow>();
    const receiptCount = await environment.DB.prepare(
      'SELECT count(*) AS count FROM schema_migrations'
    ).first<ReceiptCountRow>();
    const metadata = await environment.DB.prepare(`
      SELECT database_class,database_id
        FROM database_instance_metadata
       WHERE singleton_key = 1
    `).first<DatabaseMetadataRow>();
    const runtimeInfrastructure = await environment.DB.prepare(`
      SELECT count(*) AS count
        FROM sqlite_master
       WHERE (type = 'table' AND name = 'd1_operation_batch_guards')
          OR (type = 'trigger' AND name = 'd1_operation_batch_guard_abort')
    `).first<RuntimeInfrastructureCountRow>();
    await environment.FILES.list({ limit: 1 });
    const emailBindingConfigured = typeof environment.EMAIL.send === 'function';

    const floor = SQLITE_E2_S8_RELEASE_FLOOR;
    const adaptersReady = environment.JOOEVENTS_D1_RELEASE_FLOOR === floor.releaseFloorId
      && terminal?.migration_id === floor.terminalMigration.migrationId
      && terminal.schema_epoch === floor.terminalMigration.schemaEpoch
      && terminal.sequence === floor.terminalMigration.sequence
      && terminal.result_fingerprint === floor.expectedApplicationFingerprint
      && receiptCount?.count === floor.terminalMigration.sequence
      && metadata?.database_class === 'frozen_release'
      && /^[0-9a-f]{32}$/.test(metadata.database_id)
      && runtimeInfrastructure?.count === 2;

    return json({
      status: adaptersReady ? 'adapter_foundation_ready' : 'adapter_foundation_invalid',
      ready: false,
      applicationRuntimeReady: false,
      adapters: {
        d1: adaptersReady,
        d1BufferedUnitOfWork: runtimeInfrastructure?.count === 2,
        r2: true,
        queues: true,
        cron: true,
        emailBinding: emailBindingConfigured,
        authActivationRequested: cloudflareAuthRuntimeEnabled(environment),
        applicationActivationRequested: cloudflareApplicationRuntimeEnabled(environment)
      },
      releaseFloor: floor.releaseFloorId,
      environment: environment.JOOEVENTS_DEPLOYMENT_ENVIRONMENT,
      correlationId
    }, 503);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'cloudflare.health.failed',
      correlationId,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    }));
    return json({
      status: 'adapter_foundation_unavailable',
      ready: false,
      applicationRuntimeReady: false,
      correlationId
    }, 503);
  }
}

function isReservedApplicationPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
    || pathname === '/mcp' || pathname.startsWith('/mcp/')
    || pathname === '/webhooks' || pathname.startsWith('/webhooks/')
    || pathname === '/.well-known' || pathname.startsWith('/.well-known/')
    || pathname === '/embed' || pathname.startsWith('/embed/');
}

export async function handleRequest(
  request: Request,
  environment: CloudflareApplicationEnvironment
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health') return healthResponse(environment);
  if (isConfiguredAuthPath(url.pathname) && cloudflareAuthRuntimeEnabled(environment)) {
    try {
      return await createConfiguredCloudflareAuthRuntime(environment).fetch(request);
    } catch (error) {
      const correlationId = crypto.randomUUID();
      console.error(JSON.stringify({
        event: 'cloudflare.auth.configuration_refused',
        correlationId,
        issueCodes: error instanceof CloudflareAuthConfigurationError ? error.issues : ['unknown']
      }));
      return json({
        code: 'cloudflare_auth_configuration_invalid',
        message: 'Authentication is not available yet.',
        correlationId
      }, 503);
    }
  }
  if (isConfiguredApplicationPath(url.pathname)
      && cloudflareApplicationRuntimeEnabled(environment)) {
    try {
      return await (await createConfiguredD1ApplicationRuntime(environment)).fetch(request);
    } catch (error) {
      const correlationId = crypto.randomUUID();
      console.error(JSON.stringify({
        event: 'cloudflare.application.configuration_refused',
        correlationId,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      }));
      return json({
        code: 'cloudflare_application_configuration_invalid',
        message: 'The application runtime is not available yet.',
        correlationId
      }, 503);
    }
  }
  if (isReservedApplicationPath(url.pathname)) {
    return json({
      code: 'cloudflare_application_runtime_not_ready',
      message: 'This production adapter is not accepting application traffic yet.'
    }, 503);
  }
  return protectedAssetResponse(await environment.ASSETS.fetch(request));
}

function isConfiguredApplicationPath(pathname: string): boolean {
  return pathname === '/api/v1/openapi.json'
    || pathname === '/api/v1/llms.txt'
    || pathname === '/api/operations/manifest'
    || pathname === '/api/workspace/history'
    || pathname === '/api/workspace/shell-summary'
    || pathname === '/api/workspace/overview'
    || pathname === '/api/workspace/api-keys'
    || pathname === '/api/workspace/api-keys/create'
    || pathname === '/api/workspace/api-keys/rotate'
    || pathname === '/api/workspace/api-keys/revoke'
    || pathname === '/api/workspace/team'
    || pathname === '/api/workspace/team/invitations'
    || pathname === '/api/workspace/team/role-changes'
    || pathname === '/api/workspace/team/removals'
    || pathname === '/api/communications/provider-connection'
    || pathname === '/api/communications/email-readiness'
    || pathname === '/api/communications/sender-identity'
    || pathname === '/api/events/current/communications/purposes'
    || pathname === '/api/events/current/communications/purposes/detail'
    || pathname === '/api/events/current/communications/templates'
    || pathname === '/api/events/current/communications/templates/detail'
    || pathname === '/api/events/current/communications/drafts'
    || pathname === '/api/events/current/communications/drafts/detail'
    || pathname === '/api/events/current/communications/drafts/create'
    || pathname === '/api/events/current/communications/drafts/revise'
    || pathname === '/api/events/current/communications/drafts/discard'
    || pathname === '/api/events/current/communications/authoring-payloads'
    || pathname === '/api/events/current/communications/audiences/options'
    || pathname === '/api/events/current/communications/deliveries/history'
    || pathname === '/api/events/current'
    || pathname === '/api/events/current/files'
    || pathname.startsWith('/api/events/current/files/')
    || pathname === '/api/events/current/settings'
    || pathname === '/api/events/current/program-vocabulary'
    || pathname.startsWith('/api/events/current/program-vocabulary/')
    || pathname === '/api/events/current/schedule/placements'
    || pathname === '/api/events/current/sessions'
    || pathname === '/api/events/current/field-registry'
    || pathname.startsWith('/api/events/current/field-registry/')
    || pathname === '/api/events/current/deadlines'
    || pathname === '/api/events/current/deadlines/current'
    || pathname === '/api/events/current/tasks'
    || pathname === '/api/events/current/template-artifacts'
    || pathname.startsWith('/api/events/current/template-artifacts/')
    || pathname === '/api/events'
    || pathname === '/api/events/select';
}

function isConfiguredAuthPath(pathname: string): boolean {
  return pathname === '/api/auth' || pathname.startsWith('/api/auth/')
    || pathname === '/api/entry/google/start'
    || pathname === '/api/entry/sign-out'
    || pathname === '/api/me/access-context';
}

export async function handleQueue(
  batch: MessageBatch<unknown>,
  environment: CloudflareApplicationEnvironment
): Promise<void> {
  for (const message of batch.messages) {
    if (!isCloudflareWakeMessage(message.body)) {
      console.error(JSON.stringify({
        event: 'cloudflare.queue.message_refused',
        messageId: message.id,
        attempts: message.attempts
      }));
      message.retry({ delaySeconds: 30 });
      continue;
    }
    if (!cloudflareApplicationRuntimeEnabled(environment)) {
      console.log(JSON.stringify({
        event: 'cloudflare.queue.maintenance_wake_inactive',
        messageId: message.id,
        scheduledAtMs: message.body.scheduledAtMs
      }));
      message.ack();
      continue;
    }
    try {
      const workspaceId = parseWorkspaceId(environment.JOOEVENTS_WORKSPACE_ID);
      const [email, files] = await Promise.all([
        dispatchD1OutboundEmailWake(environment),
        dispatchD1FilesCleanupWake(environment, {
          workspaceId,
          nowMs: message.body.scheduledAtMs
        })
      ]);
      console.log(JSON.stringify({
        event: 'cloudflare.queue.maintenance_wake',
        messageId: message.id,
        scheduledAtMs: message.body.scheduledAtMs,
        emailConsidered: email.considered,
        emailDispatched: email.dispatched.length,
        emailSkipped: email.skipped,
        expiredFileIntents: files.expiredIntents,
        orphanFileAssets: files.orphanAssets,
        reconciledFileObjects: files.reconciledObjects,
        faults: email.faults.length + files.faults.length
      }));
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        event: 'cloudflare.queue.maintenance_wake_failed',
        messageId: message.id,
        attempts: message.attempts,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      }));
      message.retry({ delaySeconds: 30 });
    }
  }
}

export async function handleScheduled(
  controller: ScheduledController,
  environment: Env
): Promise<void> {
  await environment.JOBS.send({
    version: 1,
    kind: 'maintenance.wake',
    scheduledAtMs: controller.scheduledTime
  } satisfies CloudflareWakeMessage, { contentType: 'json' });
}

export default {
  fetch: handleRequest,
  queue: handleQueue,
  scheduled: handleScheduled
} satisfies ExportedHandler<Env, unknown>;
