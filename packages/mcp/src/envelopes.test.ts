import { describe, expect, test } from 'bun:test';
import type { SafeSchemaManifestRef } from '@jooevents/contracts';
import {
  McpEnvelopeError,
  mapMcpToolCallToInvocation,
  mapOperationResultToMcp
} from './envelopes';
import { createMcpToolRegistry, findMcpTool } from './registry';
import { completeManifest, schemaRef } from './test-fixtures';
import type { McpSchemaParser } from './types';

const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';
const receiptId = '018f0f47-7a86-7d36-8a25-9f86589c7a4e';

function parser(reference: SafeSchemaManifestRef, parse: (value: unknown) => unknown): McpSchemaParser {
  return { reference, parse };
}

function objectParser(reference: SafeSchemaManifestRef): McpSchemaParser {
  return parser(reference, (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
    return value;
  });
}

describe('MCP invocation envelopes', () => {
  test('selects operation and schemas exclusively from the enabled tool registry', async () => {
    const registry = await createMcpToolRegistry(await completeManifest());
    const tool = findMcpTool(registry, 'event_read')!;
    const invocation = mapMcpToolCallToInvocation(
      registry,
      { toolName: 'event_read', arguments: { eventId: 'event-1' } },
      objectParser(tool.inputSchema)
    );

    expect(invocation.operation).toEqual({ name: 'event.read', version: 1 });
    expect(invocation.inputSchema).toEqual(tool.inputSchema);
    expect(invocation.resultSchema).toEqual(tool.outputSchema);
    expect(invocation.businessInput).toEqual({ eventId: 'event-1' });
    expect(invocation.idempotency).toEqual({ required: false });

    expect(() => mapMcpToolCallToInvocation(
      registry,
      {
        toolName: 'event_read',
        arguments: {},
        operationName: 'event.commit'
      },
      objectParser(tool.inputSchema)
    )).toThrow(/unknown selector/);
    expect(() => mapMcpToolCallToInvocation(
      registry,
      { toolName: 'http_visible', arguments: {} },
      objectParser(tool.inputSchema)
    )).toThrow(/not enabled/);
    expect(() => mapMcpToolCallToInvocation(
      registry,
      { toolName: 'event_commit', arguments: {}, idempotencyKey: 'commit-1' },
      objectParser(tool.inputSchema)
    )).toThrow(/not enabled/);
  });

  test('requires exact input schema refs and effectful idempotency metadata', async () => {
    const registry = await createMcpToolRegistry(await completeManifest());
    const draft = findMcpTool(registry, 'event_draft')!;
    expect(() => mapMcpToolCallToInvocation(
      registry,
      { toolName: 'event_draft', arguments: {} },
      objectParser(draft.inputSchema)
    )).toThrow(/require an idempotency key/);

    const invocation = mapMcpToolCallToInvocation(
      registry,
      { toolName: 'event_draft', arguments: { title: 'Draft' }, idempotencyKey: 'draft-001' },
      objectParser(draft.inputSchema)
    );
    expect(invocation.effect).toBe('draft');
    expect(invocation.idempotency).toMatchObject({ required: true, key: 'draft-001' });

    expect(() => mapMcpToolCallToInvocation(
      registry,
      { toolName: 'event_draft', arguments: {}, idempotencyKey: 'draft-002' },
      objectParser(schemaRef('schema.wrong.input'))
    )).toThrow(/does not match/);
    expect(() => mapMcpToolCallToInvocation(
      registry,
      { toolName: 'event_read', arguments: {}, idempotencyKey: 'not-allowed' },
      objectParser(findMcpTool(registry, 'event_read')!.inputSchema)
    )).toThrow(/do not accept/);
  });
});

describe('MCP result envelopes', () => {
  test('maps only a schema-validated closed result without transport selector metadata', async () => {
    const registry = await createMcpToolRegistry(await completeManifest());
    const tool = findMcpTool(registry, 'event_read')!;
    const invocation = mapMcpToolCallToInvocation(
      registry,
      { toolName: tool.name, arguments: {} },
      objectParser(tool.inputSchema)
    );
    const result = {
      kind: 'success',
      data: { event: 'Conference' },
      correlationId
    };
    const mapped = mapOperationResultToMcp(
      registry,
      invocation,
      result,
      objectParser(tool.outputSchema)
    );

    expect(mapped.isError).toBe(false);
    expect(mapped.structuredContent).toEqual(result);
    expect(JSON.parse(mapped.content[0].text)).toEqual(result);
    expect(Object.keys(mapped).sort()).toEqual(['content', 'isError', 'structuredContent']);

    const error = {
      kind: 'transport_error',
      code: 'internal_error',
      retryable: false,
      correlationId
    };
    expect(mapOperationResultToMcp(
      registry,
      invocation,
      error,
      parser(tool.outputSchema, () => { throw new TypeError('operation schema is not transport schema'); })
    ).isError).toBe(true);
  });

  test('rejects mismatched result schemas, malformed envelopes, and foreign receipts', async () => {
    const registry = await createMcpToolRegistry(await completeManifest());
    const draft = findMcpTool(registry, 'event_draft')!;
    const invocation = mapMcpToolCallToInvocation(
      registry,
      { toolName: draft.name, arguments: {}, idempotencyKey: 'draft-003' },
      objectParser(draft.inputSchema)
    );
    const success = {
      kind: 'success',
      data: { changesetId: 'change-1' },
      receipt: {
        id: receiptId,
        operationName: 'other.operation',
        operationVersion: 1
      },
      correlationId
    };
    expect(() => mapOperationResultToMcp(
      registry,
      invocation,
      success,
      objectParser(draft.outputSchema)
    )).toThrow(/another operation/);

    expect(() => mapOperationResultToMcp(
      registry,
      invocation,
      { arbitrary: true },
      objectParser(draft.outputSchema)
    )).toThrow(/closed operation envelope/);

    expect(() => mapOperationResultToMcp(
      registry,
      invocation,
      success,
      objectParser(schemaRef('schema.wrong.result'))
    )).toThrow(/does not match/);
    expect(() => {
      throw new McpEnvelopeError('unknown_tool', 'proof');
    }).toThrow(McpEnvelopeError);
  });
});
