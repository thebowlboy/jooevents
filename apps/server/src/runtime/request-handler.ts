import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { classifyRoutePath } from '@jooevents/contracts/route-namespaces';
import type { LiveBuildIdentity } from '@jooevents/contracts/live-build-identity';
import { parseFileUploadLimits } from '@jooevents/files';
import { protectBackendNotFoundResponse } from '../http/backend-not-found';
import {
  denyAllHtmlSecurityHeaders,
  isHtmlResponseContentType,
  resolveHtmlSecurityHeaders,
  type EmbedFramingPolicySource
} from '../http/embed-security';

export type WebFetchHandler = (request: Request) => Response | Promise<Response>;

export class StaticBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaticBuildError';
  }
}

interface StaticBuild {
  readonly root: string;
  readonly indexPath: string;
  readonly allowedFiles?: ReadonlyMap<string, LiveBuildIdentity['files'][number]>;
}

interface StaticFile {
  readonly path: string;
  readonly descriptor?: LiveBuildIdentity['files'][number];
}

function staysInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function validateStaticBuild(
  buildDirectory: string,
  identity?: LiveBuildIdentity
): StaticBuild {
  let root: string;
  try {
    const rootStat = lstatSync(buildDirectory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('not a direct directory');
    root = realpathSync(buildDirectory);
  } catch {
    throw new StaticBuildError('The production web build directory must be an existing direct directory.');
  }

  const indexPath = resolve(root, 'index.html');
  try {
    const indexStat = lstatSync(indexPath);
    if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.nlink !== 1) throw new Error('not a direct file');
    if (realpathSync(indexPath) !== indexPath || !staysInside(root, indexPath)) throw new Error('outside build root');
  } catch {
    throw new StaticBuildError('The production web build must contain a direct index.html file.');
  }

  const allowedFiles = identity
    ? new Map(identity.files.map((file) => [file.path, file] as const))
    : undefined;
  if (allowedFiles && !allowedFiles.has('index.html')) {
    throw new StaticBuildError('The production web build identity must include index.html.');
  }

  return { root, indexPath, ...(allowedFiles ? { allowedFiles } : {}) };
}

async function resolveStaticFile(build: StaticBuild, pathname: string): Promise<StaticFile | undefined> {
  const segments = pathname.split('/').slice(1);
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }
  const relativePath = segments.join('/');
  const descriptor = build.allowedFiles?.get(relativePath);
  if (build.allowedFiles && !descriptor) return undefined;

  let cursor = build.root;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    if (!staysInside(build.root, cursor)) return undefined;

    try {
      const observed = await lstat(cursor);
      if (observed.isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
  }

  try {
    const observed = await lstat(cursor);
    if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1) return undefined;
    const canonical = await realpath(cursor);
    return canonical === cursor && staysInside(build.root, canonical)
      ? { path: canonical, ...(descriptor ? { descriptor } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

function acceptsHtmlNavigation(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const fetchMode = request.headers.get('sec-fetch-mode');
  if (fetchMode && fetchMode !== 'navigate') return false;
  return request.headers.get('accept')?.split(',').some((part) => part.trim().split(';', 1)[0]?.toLowerCase() === 'text/html') ?? false;
}

function staticCacheControl(pathname: string, isFallback: boolean): string {
  if (isFallback || pathname === '/index.html') return 'no-store, max-age=0';
  if (pathname.startsWith('/_app/immutable/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=0, must-revalidate';
}

async function staticResponse(
  request: Request,
  file: StaticFile,
  pathname: string,
  isFallback: boolean,
  security: Readonly<Record<string, string>>
): Promise<Response> {
  const source = Bun.file(file.path);
  const headers = new Headers({
    'cache-control': staticCacheControl(pathname, isFallback),
    'content-length': String(source.size),
    'content-type': source.type || 'application/octet-stream',
    'x-content-type-options': 'nosniff'
  });
  if (isHtmlResponseContentType(headers.get('content-type'))) {
    for (const [name, value] of Object.entries(security)) headers.set(name, value);
  }
  if (!file.descriptor) {
    return new Response(request.method === 'HEAD' ? null : source, { status: 200, headers });
  }

  const bytes = await readFile(file.path);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== file.descriptor.bytes || digest !== file.descriptor.sha256) {
    return new Response('Application files changed after startup.', {
      status: 503,
      headers: {
        'cache-control': 'no-store, max-age=0',
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff'
      }
    });
  }
  headers.set('content-length', String(bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

function safePlainNotFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: {
      'cache-control': 'no-store, max-age=0',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff'
    }
  });
}

function invalidPathResponse(): Response {
  return Response.json(
    { code: 'invalid_request_path', message: 'The request path was not valid.', retryable: false },
    {
      status: 400,
      headers: {
        'cache-control': 'no-store, max-age=0',
        'x-content-type-options': 'nosniff'
      }
    }
  );
}

/**
 * Composes one-origin production routing without teaching the backend app about files.
 * Reserved namespaces always reach the backend; only HTML navigations may use the SPA shell.
 */
export function createProductionRequestHandler(input: {
  readonly backend: WebFetchHandler;
  readonly buildDirectory: string;
  readonly buildIdentity?: LiveBuildIdentity;
  readonly embedFraming?: EmbedFramingPolicySource;
}): WebFetchHandler {
  const build = validateStaticBuild(input.buildDirectory, input.buildIdentity);

  return async (request) => {
    const classification = classifyRoutePath(new URL(request.url).pathname);
    if (classification.kind === 'invalid') return invalidPathResponse();

    if (classification.kind === 'backend') {
      return protectBackendNotFoundResponse(await input.backend(request));
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      // Every served HTML document carries an explicit framing policy:
      // `/embed/<kind>` serves the surface's stored allowlist (empty or
      // unresolvable framing denies), and all other HTML is `'none'` — which
      // also closes the production no-CSP gap when no policy source is wired.
      const security = input.embedFraming
        ? await resolveHtmlSecurityHeaders({
            pathname: classification.pathname,
            framing: input.embedFraming
          })
        : denyAllHtmlSecurityHeaders();
      const staticPath = await resolveStaticFile(build, classification.pathname);
      if (staticPath) {
        return staticResponse(request, staticPath, classification.pathname, false, security);
      }
      if (acceptsHtmlNavigation(request)) {
        const indexDescriptor = build.allowedFiles?.get('index.html');
        return staticResponse(request, {
          path: build.indexPath,
          ...(indexDescriptor ? { descriptor: indexDescriptor } : {})
        }, classification.pathname, true, security);
      }
    }

    return safePlainNotFound();
  };
}

export type BunRuntimeMode = 'development' | 'production';

export interface BunListenerConfiguration {
  readonly mode: BunRuntimeMode;
  readonly hostname: '127.0.0.1' | '0.0.0.0';
  readonly port: number;
  readonly development: boolean;
  readonly maxRequestBodySize: number;
}

export function resolveBunListenerConfiguration(
  environment: Record<string, string | undefined>
): BunListenerConfiguration {
  const mode: BunRuntimeMode = environment.NODE_ENV === 'production' ? 'production' : 'development';
  const rawPort = environment.JOOEVENTS_INTERNAL_HTTP_PORT;
  const port = rawPort ? Number(rawPort) : mode === 'production' ? 5176 : 5177;
  const rawHostname = environment.JOOEVENTS_INTERNAL_HTTP_HOST ?? '127.0.0.1';
  const fileLimits = parseFileUploadLimits(environment);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('JOOEVENTS_INTERNAL_HTTP_PORT must be a valid TCP port');
  }
  if (rawHostname !== '127.0.0.1' && rawHostname !== '0.0.0.0') {
    throw new Error('JOOEVENTS_INTERNAL_HTTP_HOST must be 127.0.0.1 or 0.0.0.0');
  }

  return {
    mode,
    hostname: rawHostname,
    port,
    development: mode !== 'production',
    maxRequestBodySize: Math.max(
      fileLimits.maxUploadBytesOrganizer,
      fileLimits.maxUploadBytesSpeaker
    )
  };
}

export function createRuntimeRequestHandler(input: {
  readonly mode: BunRuntimeMode;
  readonly backend: WebFetchHandler;
  readonly buildDirectory: string;
  readonly buildIdentity?: LiveBuildIdentity;
  readonly embedFraming?: EmbedFramingPolicySource;
}): WebFetchHandler {
  return input.mode === 'production'
    ? createProductionRequestHandler({
        backend: input.backend,
        buildDirectory: input.buildDirectory,
        ...(input.buildIdentity ? { buildIdentity: input.buildIdentity } : {}),
        ...(input.embedFraming ? { embedFraming: input.embedFraming } : {})
      })
    : input.backend;
}
