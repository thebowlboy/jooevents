import {
  AUTONOMY_DISPOSITIONS,
  safeOperationManifestBodySchema,
  safeOperationManifestSchema,
  type SafeOperationManifest,
  type SafeOperationManifestBody,
  type SafeOperationManifestEntry,
  type SafePublicOperationBinding,
  type SafeSchemaManifestRef,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { canonicalJsonText, canonicalJsonValue } from '@jooevents/kernel';
import type {
  McpRegistryActivation,
  McpToolDefinition,
  McpToolRegistry,
  McpToolRegistryBody,
  WithheldMcpTool
} from './types';

export interface McpRegistryValidationIssue {
  readonly code:
    | 'malformed_manifest'
    | 'manifest_digest_mismatch'
    | 'duplicate_operation'
    | 'duplicate_binding'
    | 'duplicate_tool'
    | 'schema_conflict'
    | 'invalid_lifecycle'
    | 'invalid_idempotency'
    | 'invalid_lane'
    | 'invalid_activation'
    | 'hidden_operation';
  readonly operationName?: string;
  readonly operationVersion?: number;
  readonly detail: string;
}

export class McpRegistryValidationError extends Error {
  constructor(readonly issues: readonly McpRegistryValidationIssue[]) {
    super(`MCP registry validation failed with ${issues.length} issue(s)`);
    this.name = 'McpRegistryValidationError';
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bindingIdentity(binding: SafePublicOperationBinding): string {
  if (binding.protocol === 'tool') return `${binding.surface}\u0000${binding.toolName}`;
  return `${binding.surface}\u0000${binding.method}\u0000${binding.path}`;
}

function normalizeEntry(entry: SafeOperationManifestEntry): SafeOperationManifestEntry {
  const dispositions = new Set(entry.autonomy.supportedDispositions);
  return {
    ...entry,
    autonomy: {
      ...entry.autonomy,
      policy: { ...entry.autonomy.policy },
      supportedDispositions: AUTONOMY_DISPOSITIONS.filter((disposition) => dispositions.has(disposition)),
      triggerDispositions: { ...entry.autonomy.triggerDispositions }
    },
    consequenceTags: [...entry.consequenceTags].sort(compareText),
    outcomes: [...entry.outcomes].sort(
      (left, right) => compareText(left.class, right.class) || compareText(left.kind, right.kind)
    ),
    enabledBindings: [...entry.enabledBindings].sort((left, right) =>
      compareText(bindingIdentity(left), bindingIdentity(right))
    )
  };
}

export function normalizeSafeOperationManifestBody(
  body: SafeOperationManifestBody
): SafeOperationManifestBody {
  return safeOperationManifestBodySchema.parse({
    schemaVersion: 1,
    operations: body.operations
      .map(normalizeEntry)
      .sort(
        (left, right) =>
          compareText(left.name, right.name) || left.version - right.version
      )
  });
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJsonText(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function digestSafeOperationManifestBody(
  body: SafeOperationManifestBody
): Promise<string> {
  return sha256(normalizeSafeOperationManifestBody(body));
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function schemaIdentity(reference: SafeSchemaManifestRef): string {
  return `${reference.key}\u0000${reference.version}`;
}

function operationIdentity(operation: Pick<SafeOperationManifestEntry, 'name' | 'version'>): string {
  return `${operation.name}\u0000${operation.version}`;
}

function sameOperation(
  left: { readonly name: string; readonly version: number },
  right: { readonly operationName: string; readonly operationVersion: number }
): boolean {
  return left.name === right.operationName && left.version === right.operationVersion;
}

function collectSchemaRefs(operation: SafeOperationManifestEntry): readonly SafeSchemaManifestRef[] {
  const references: SafeSchemaManifestRef[] = [operation.inputSchema];
  for (const outcome of operation.outcomes) references.push(outcome.detailSchema);
  for (const binding of operation.enabledBindings) {
    references.push(binding.resultSchema);
    if (binding.protocol === 'http') {
      if (binding.browserResumption.kind === 'safe_inline') {
        references.push(binding.browserResumption.inputSchema);
      } else if (binding.browserResumption.kind === 'server_ref') {
        references.push(binding.browserResumption.referenceSchema);
      }
    }
  }
  return references;
}

function pushOperationIssue(
  issues: McpRegistryValidationIssue[],
  operation: SafeOperationManifestEntry,
  code: McpRegistryValidationIssue['code'],
  detail: string
): void {
  issues.push({
    code,
    operationName: operation.name,
    operationVersion: operation.version,
    detail
  });
}

function validateManifest(manifest: SafeOperationManifest): McpRegistryValidationIssue[] {
  const issues: McpRegistryValidationIssue[] = [];
  const operations = new Map<string, SafeOperationManifestEntry>();
  const activeNames = new Set<string>();
  const toolOwners = new Map<string, string>();
  const schemas = new Map<string, string>();

  for (const operation of manifest.operations) {
    const identity = operationIdentity(operation);
    if (operations.has(identity)) {
      pushOperationIssue(issues, operation, 'duplicate_operation', 'Operation name/version is duplicated.');
    } else {
      operations.set(identity, operation);
    }
    if (operation.enabledBindings.length === 0) {
      pushOperationIssue(
        issues,
        operation,
        'hidden_operation',
        'A safe manifest entry must have an enabled public binding.'
      );
    }

    const bindingSurfaces = new Set<string>();
    const outcomeKeys = new Set<string>();
    const tags = new Set<string>();
    for (const tag of operation.consequenceTags) {
      if (tags.has(tag)) {
        pushOperationIssue(issues, operation, 'invalid_lane', 'Consequence tags must be unique.');
      }
      tags.add(tag);
    }
    for (const outcome of operation.outcomes) {
      const outcomeKey = `${outcome.class}\u0000${outcome.kind}`;
      if (outcomeKeys.has(outcomeKey)) {
        pushOperationIssue(issues, operation, 'invalid_lane', 'Outcome declarations must be unique.');
      }
      outcomeKeys.add(outcomeKey);
    }
    for (const binding of operation.enabledBindings) {
      if (bindingSurfaces.has(binding.surface)) {
        pushOperationIssue(
          issues,
          operation,
          'duplicate_binding',
          'An operation may have at most one binding per public surface.'
        );
      }
      bindingSurfaces.add(binding.surface);
      if (binding.surface === 'external_mcp') {
        const owner = toolOwners.get(binding.toolName);
        if (owner !== undefined && owner !== identity) {
          pushOperationIssue(issues, operation, 'duplicate_tool', 'MCP tool name is already owned.');
        } else {
          toolOwners.set(binding.toolName, identity);
        }
      }
    }

    for (const reference of collectSchemaRefs(operation)) {
      const key = schemaIdentity(reference);
      const knownDigest = schemas.get(key);
      if (knownDigest !== undefined && knownDigest !== reference.digestSha256) {
        pushOperationIssue(
          issues,
          operation,
          'schema_conflict',
          'One schema key/version cites multiple digests.'
        );
      } else {
        schemas.set(key, reference.digestSha256);
      }
    }

    if (operation.effect === 'read') {
      if (operation.idempotency.required || operation.concurrency.kind !== 'read_snapshot') {
        pushOperationIssue(
          issues,
          operation,
          'invalid_idempotency',
          'Read operations require read-snapshot concurrency and no caller idempotency key.'
        );
      }
    } else if (!operation.idempotency.required || operation.concurrency.kind !== 'registered') {
      pushOperationIssue(
        issues,
        operation,
        'invalid_idempotency',
        'Draft and commit operations require registered concurrency and versioned idempotency metadata.'
      );
    }

    if (operation.lifecycle.status === 'active') {
      if (activeNames.has(operation.name)) {
        pushOperationIssue(
          issues,
          operation,
          'invalid_lifecycle',
          'An operation name may have only one active version.'
        );
      }
      activeNames.add(operation.name);
    }
    if (
      operation.lifecycle.status === 'replay_only' &&
      operation.enabledBindings.some((binding) => binding.surface === 'external_mcp')
    ) {
      pushOperationIssue(
        issues,
        operation,
        'invalid_lifecycle',
        'Replay-only operations cannot expose an MCP tool.'
      );
    }
  }

  for (const operation of manifest.operations) {
    if (operation.lifecycle.status !== 'deprecated') continue;
    if (sameOperation(operation, operation.lifecycle.replacement)) {
      pushOperationIssue(
        issues,
        operation,
        'invalid_lifecycle',
        'A deprecated operation cannot replace itself.'
      );
      continue;
    }
    const replacementIdentity = `${operation.lifecycle.replacement.operationName}\u0000${operation.lifecycle.replacement.operationVersion}`;
    if (!operations.has(replacementIdentity)) {
      pushOperationIssue(
        issues,
        operation,
        'invalid_lifecycle',
        'A deprecated operation must cite a retained replacement.'
      );
    }
  }
  return issues;
}

function toolFrom(
  operation: SafeOperationManifestEntry,
  binding: Extract<SafePublicOperationBinding, { readonly surface: 'external_mcp' }>
): McpToolDefinition {
  return {
    name: binding.toolName,
    description: operation.summary,
    inputSchema: operation.inputSchema,
    outputSchema: binding.resultSchema,
    annotations: {
      readOnlyHint: operation.effect === 'read',
      destructiveHint: operation.effect === 'commit',
      idempotentHint: true,
      openWorldHint: operation.effect === 'commit'
    },
    contract: {
      operation: { name: operation.name, version: operation.version },
      effect: operation.effect,
      maxRisk: operation.maxRisk,
      autonomy: operation.autonomy,
      consequenceTags: operation.consequenceTags,
      lifecycle: operation.lifecycle,
      idempotency: operation.idempotency
    }
  };
}

function compareTools(left: McpToolDefinition, right: McpToolDefinition): number {
  return compareText(left.name, right.name)
    || compareText(left.contract.operation.name, right.contract.operation.name)
    || left.contract.operation.version - right.contract.operation.version;
}

function compareWithheld(left: WithheldMcpTool, right: WithheldMcpTool): number {
  return compareText(left.name, right.name)
    || compareText(left.operation.name, right.operation.name)
    || left.operation.version - right.operation.version;
}

export async function createMcpToolRegistry(
  input: unknown,
  activation: McpRegistryActivation = {}
): Promise<McpToolRegistry> {
  const parsed = safeOperationManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new McpRegistryValidationError([
      { code: 'malformed_manifest', detail: 'Input is not a safe operation manifest.' }
    ]);
  }
  const receivedManifest = parsed.data;
  const normalizedBody = normalizeSafeOperationManifestBody({
    schemaVersion: 1,
    operations: receivedManifest.operations
  });
  const expectedManifestDigest = await digestSafeOperationManifestBody(normalizedBody);
  if (expectedManifestDigest !== receivedManifest.registryDigestSha256) {
    throw new McpRegistryValidationError([
      { code: 'manifest_digest_mismatch', detail: 'Safe operation manifest digest does not match.' }
    ]);
  }
  const manifest: SafeOperationManifest = {
    ...normalizedBody,
    registryDigestSha256: receivedManifest.registryDigestSha256
  };
  const issues = validateManifest(manifest);
  if (issues.length > 0) throw new McpRegistryValidationError(deepFreeze(issues));

  if (
    activation === null ||
    typeof activation !== 'object' ||
    Array.isArray(activation) ||
    Object.keys(activation).some((key) => key !== 'enableCommitTools') ||
    (Object.hasOwn(activation, 'enableCommitTools') && typeof activation.enableCommitTools !== 'boolean')
  ) {
    throw new McpRegistryValidationError([
      { code: 'invalid_activation', detail: 'MCP registry activation is malformed.' }
    ]);
  }
  const commitToolsEnabled = activation.enableCommitTools === true;
  const tools: McpToolDefinition[] = [];
  const withheldTools: WithheldMcpTool[] = [];
  for (const operation of manifest.operations) {
    const binding = operation.enabledBindings.find(
      (candidate): candidate is Extract<SafePublicOperationBinding, { readonly surface: 'external_mcp' }> =>
        candidate.surface === 'external_mcp'
    );
    if (binding === undefined) continue;
    if (operation.effect === 'commit' && !commitToolsEnabled) {
      withheldTools.push({
        name: binding.toolName,
        operation: { name: operation.name, version: operation.version },
        reason: 'commit_activation_required'
      });
      continue;
    }
    tools.push(toolFrom(operation, binding));
  }
  tools.sort(compareTools);
  withheldTools.sort(compareWithheld);

  const body: McpToolRegistryBody = {
    schemaVersion: 1,
    sourceOperationRegistryDigestSha256: manifest.registryDigestSha256,
    activation: { commitToolsEnabled },
    tools,
    withheldTools
  };
  canonicalJsonValue(body);
  const registryDigestSha256 = await sha256(body);
  return deepFreeze({ ...body, registryDigestSha256 });
}

export function findMcpTool(
  registry: McpToolRegistry,
  toolName: string
): McpToolDefinition | undefined {
  return registry.tools.find((tool) => tool.name === toolName);
}
