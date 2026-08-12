import {
  AUTONOMY_DISPOSITIONS,
  safeOperationManifestBodySchema,
  type OperationLifecycle,
  type SafeOperationManifest,
  type SafeOperationManifestEntry,
  type SafePublicOperationBinding,
  type SafeSchemaManifestRef
} from '@jooevents/contracts';
import { digestSafeOperationManifestBody } from './registry';

const DIGESTS = {
  a: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  b: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  c: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
} as const;

export function schemaRef(
  key: string,
  version = 1,
  digestSha256: string = DIGESTS.a
): SafeSchemaManifestRef {
  return { key, version, digestSha256 };
}

export function externalMcpBinding(
  toolName: string,
  resultKey: string
): Extract<SafePublicOperationBinding, { readonly surface: 'external_mcp' }> {
  return {
    surface: 'external_mcp',
    protocol: 'tool',
    toolName,
    resultSchema: schemaRef(resultKey, 1, DIGESTS.b)
  };
}

export function operatorHttpBinding(
  path: string,
  resultKey: string
): Extract<SafePublicOperationBinding, { readonly surface: 'operator_http' }> {
  return {
    surface: 'operator_http',
    protocol: 'http',
    method: 'GET',
    path,
    input: 'query',
    resultSchema: schemaRef(resultKey, 1, DIGESTS.b),
    browserResumption: { kind: 'none' }
  };
}

interface OperationFixtureOptions {
  readonly name: string;
  readonly version?: number;
  readonly toolName?: string;
  readonly effect?: 'read' | 'draft' | 'commit';
  readonly maxRisk?: 'low' | 'normal' | 'consequential';
  readonly lifecycle?: OperationLifecycle;
  readonly bindings?: readonly SafePublicOperationBinding[];
}

export function operationFixture(options: OperationFixtureOptions): SafeOperationManifestEntry {
  const version = options.version ?? 1;
  const effect = options.effect ?? 'read';
  const bindings = options.bindings ?? [
    externalMcpBinding(options.toolName ?? options.name.replaceAll('.', '_'), `schema.${options.name}.result`)
  ];
  return {
    name: options.name,
    version,
    lifecycle: options.lifecycle ?? { status: 'active' },
    summary: `Operate ${options.name}.`,
    effect,
    maxRisk: options.maxRisk ?? (effect === 'read' ? 'low' : effect === 'draft' ? 'normal' : 'consequential'),
    autonomy: {
      policy: { key: `autonomy.${options.name}`, version: 1 },
      riskFloor: effect === 'read' ? 'low' : effect === 'draft' ? 'normal' : 'consequential',
      unattendedRiskCeiling: effect === 'read' ? 'low' : effect === 'draft' ? 'normal' : 'consequential',
      requiresSeparateApproval: effect === 'commit',
      supportedDispositions: [...AUTONOMY_DISPOSITIONS],
      triggerDispositions: {
        authority_lost: 'block',
        unattended_bounds_exceeded: 'renewed_approval',
        approval_required: 'renewed_approval',
        known_retryable_failure: 'safe_retry',
        ambiguous_external_effect: 'reconcile',
        stale_plan: 'replan',
        compensation_required: 'compensate',
        terminal_failure: 'attention'
      }
    },
    consequenceTags: effect === 'commit' ? ['external_effect'] : [],
    inputSchema: schemaRef(`schema.${options.name}.input`),
    idempotency: effect === 'read'
      ? { required: false }
      : {
          required: true,
          keySource: { key: 'idempotency.external_mcp', version: 1 },
          credentialVerifierProfile: { key: 'idempotency.hmac.external_mcp', version: 1 },
          requestHashProfile: { key: 'request_hash.canonical_json', version: 1 }
        },
    concurrency: effect === 'read'
      ? { kind: 'read_snapshot' }
      : { kind: 'registered', definition: { key: 'concurrency.aggregate', version: 1 } },
    outcomes: [],
    enabledBindings: [...bindings]
  };
}

export async function manifestFixture(
  operations: readonly SafeOperationManifestEntry[]
): Promise<SafeOperationManifest> {
  const body = safeOperationManifestBodySchema.parse({ schemaVersion: 1, operations });
  return {
    ...body,
    registryDigestSha256: await digestSafeOperationManifestBody(body)
  };
}

export async function completeManifest(): Promise<SafeOperationManifest> {
  return manifestFixture([
    operationFixture({ name: 'event.read', toolName: 'event_read' }),
    operationFixture({ name: 'event.draft', toolName: 'event_draft', effect: 'draft' }),
    operationFixture({
      name: 'event.commit',
      toolName: 'event_commit',
      effect: 'commit',
      maxRisk: 'consequential'
    }),
    operationFixture({
      name: 'http.visible',
      bindings: [operatorHttpBinding('/api/test/http-visible', 'schema.http.visible.result')]
    })
  ]);
}
