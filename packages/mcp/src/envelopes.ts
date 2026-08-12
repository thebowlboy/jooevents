import {
  effectfulOperationResultSchema,
  operationTransportErrorSchema,
  readOperationResultSchema,
  type SafeSchemaManifestRef
} from '@jooevents/contracts';
import { canonicalJsonText, canonicalJsonValue, type CanonicalJson } from '@jooevents/kernel';
import { findMcpTool } from './registry';
import type {
  McpInvocationEnvelope,
  McpSchemaParser,
  McpToolCall,
  McpToolDefinition,
  McpToolRegistry,
  McpToolResultEnvelope
} from './types';

export class McpEnvelopeError extends Error {
  constructor(
    readonly code:
      | 'malformed_call'
      | 'unknown_tool'
      | 'schema_reference_mismatch'
      | 'invalid_arguments'
      | 'idempotency_key_required'
      | 'idempotency_key_forbidden'
      | 'invalid_result'
      | 'invocation_mismatch',
    message: string
  ) {
    super(message);
    this.name = 'McpEnvelopeError';
  }
}

function sameSchema(left: SafeSchemaManifestRef, right: SafeSchemaManifestRef): boolean {
  return left.key === right.key
    && left.version === right.version
    && left.digestSha256 === right.digestSha256;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function parseCall(input: unknown): McpToolCall {
  let canonical: CanonicalJson;
  try {
    canonical = canonicalJsonValue(input);
  } catch {
    throw new McpEnvelopeError('malformed_call', 'MCP tool call must be JSON data.');
  }
  if (canonical === null || typeof canonical !== 'object' || Array.isArray(canonical)) {
    throw new McpEnvelopeError('malformed_call', 'MCP tool call must be an object.');
  }
  const call = canonical as Record<string, CanonicalJson>;
  const allowed = new Set(['toolName', 'arguments', 'idempotencyKey']);
  if (Object.keys(call).some((key) => !allowed.has(key)) || !Object.hasOwn(call, 'arguments')) {
    throw new McpEnvelopeError(
      'malformed_call',
      'MCP tool call contains an unknown selector or is missing arguments.'
    );
  }
  if (typeof call.toolName !== 'string' || call.toolName.length === 0) {
    throw new McpEnvelopeError('malformed_call', 'MCP tool call requires a tool name.');
  }
  if (call.idempotencyKey !== undefined && typeof call.idempotencyKey !== 'string') {
    throw new McpEnvelopeError('malformed_call', 'MCP idempotency key must be a string.');
  }
  return call as unknown as McpToolCall;
}

function parseWithSchema(parser: McpSchemaParser, value: unknown, code: 'invalid_arguments' | 'invalid_result'): CanonicalJson {
  try {
    return deepFreeze(canonicalJsonValue(parser.parse(value)));
  } catch {
    throw new McpEnvelopeError(code, code === 'invalid_arguments'
      ? 'Tool arguments did not satisfy the registered input schema.'
      : 'Operation result did not satisfy the registered result schema.');
  }
}

function assertParserReference(parser: McpSchemaParser, reference: SafeSchemaManifestRef): void {
  if (!sameSchema(parser.reference, reference)) {
    throw new McpEnvelopeError(
      'schema_reference_mismatch',
      'Schema parser does not match the tool registry reference.'
    );
  }
}

function assertIdempotencyKey(value: string): void {
  if (
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new McpEnvelopeError('malformed_call', 'MCP idempotency key is not bounded safe text.');
  }
}

export function mapMcpToolCallToInvocation(
  registry: McpToolRegistry,
  input: unknown,
  inputParser: McpSchemaParser
): McpInvocationEnvelope {
  const call = parseCall(input);
  const tool = findMcpTool(registry, call.toolName);
  if (tool === undefined) {
    throw new McpEnvelopeError('unknown_tool', 'MCP tool is not enabled.');
  }
  assertParserReference(inputParser, tool.inputSchema);
  const businessInput = parseWithSchema(inputParser, call.arguments, 'invalid_arguments');
  const common = {
    surface: 'external_mcp' as const,
    toolName: tool.name,
    operation: tool.contract.operation,
    inputSchema: tool.inputSchema,
    resultSchema: tool.outputSchema,
    businessInput
  };
  if (tool.contract.effect === 'read') {
    if (call.idempotencyKey !== undefined) {
      throw new McpEnvelopeError(
        'idempotency_key_forbidden',
        'Read tools do not accept an idempotency key.'
      );
    }
    return Object.freeze({
      ...common,
      effect: 'read',
      idempotency: Object.freeze({ required: false })
    });
  }
  if (call.idempotencyKey === undefined) {
    throw new McpEnvelopeError(
      'idempotency_key_required',
      'Effectful MCP tools require an idempotency key.'
    );
  }
  assertIdempotencyKey(call.idempotencyKey);
  const idempotency = tool.contract.idempotency;
  if (!idempotency.required) {
    throw new McpEnvelopeError('invocation_mismatch', 'Effectful tool lacks idempotency metadata.');
  }
  return Object.freeze({
    ...common,
    effect: tool.contract.effect,
    idempotency: Object.freeze({
      required: true,
      key: call.idempotencyKey,
      keySource: idempotency.keySource,
      credentialVerifierProfile: idempotency.credentialVerifierProfile,
      requestHashProfile: idempotency.requestHashProfile
    })
  });
}

function assertInvocationMatchesTool(
  invocation: McpInvocationEnvelope,
  tool: McpToolDefinition
): void {
  if (
    invocation.surface !== 'external_mcp' ||
    invocation.operation.name !== tool.contract.operation.name ||
    invocation.operation.version !== tool.contract.operation.version ||
    invocation.effect !== tool.contract.effect ||
    !sameSchema(invocation.resultSchema, tool.outputSchema)
  ) {
    throw new McpEnvelopeError('invocation_mismatch', 'Invocation does not match the enabled tool.');
  }
}

function toolResultEnvelope(
  structuredContent: { readonly [key: string]: CanonicalJson },
  isError: boolean
): McpToolResultEnvelope {
  return Object.freeze({
    isError,
    content: Object.freeze([
      Object.freeze({ type: 'text' as const, text: canonicalJsonText(structuredContent) })
    ]) as readonly [{ readonly type: 'text'; readonly text: string }],
    structuredContent
  });
}

export function mapOperationResultToMcp(
  registry: McpToolRegistry,
  invocation: McpInvocationEnvelope,
  result: unknown,
  resultParser: McpSchemaParser
): McpToolResultEnvelope {
  const tool = findMcpTool(registry, invocation.toolName);
  if (tool === undefined) throw new McpEnvelopeError('unknown_tool', 'MCP tool is not enabled.');
  assertInvocationMatchesTool(invocation, tool);
  assertParserReference(resultParser, tool.outputSchema);
  let raw: CanonicalJson;
  try {
    raw = deepFreeze(canonicalJsonValue(result));
  } catch {
    throw new McpEnvelopeError('invalid_result', 'Operation result is not JSON data.');
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const transport = operationTransportErrorSchema.safeParse(raw);
    if (transport.success) {
      return toolResultEnvelope(raw as { readonly [key: string]: CanonicalJson }, true);
    }
  }

  const parsed = parseWithSchema(resultParser, result, 'invalid_result');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpEnvelopeError('invalid_result', 'Operation result must be a structured envelope.');
  }

  const operation = tool.contract.effect === 'read'
    ? readOperationResultSchema.safeParse(parsed)
    : effectfulOperationResultSchema.safeParse(parsed);
  if (!operation.success) {
    throw new McpEnvelopeError('invalid_result', 'Result is not a closed operation envelope.');
  }
  const effectResult = tool.contract.effect === 'read'
    ? undefined
    : effectfulOperationResultSchema.safeParse(parsed);
  if (effectResult?.success && 'receipt' in effectResult.data) {
    if (
      effectResult.data.receipt.operationName !== tool.contract.operation.name ||
      effectResult.data.receipt.operationVersion !== tool.contract.operation.version
    ) {
      throw new McpEnvelopeError('invocation_mismatch', 'Result receipt belongs to another operation.');
    }
  }

  const structuredContent = parsed as { readonly [key: string]: CanonicalJson };
  return toolResultEnvelope(structuredContent, false);
}
