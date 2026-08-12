import { describe, expect, test } from 'bun:test';
import { canonicalJsonValue } from '@jooevents/kernel';
import {
  McpRegistryValidationError,
  createMcpToolRegistry
} from './registry';
import {
  completeManifest,
  externalMcpBinding,
  manifestFixture,
  operationFixture
} from './test-fixtures';

describe('MCP tool registry', () => {
  test('is order-independent, JSON-only, and withholds commit by default', async () => {
    const manifest = await completeManifest();
    const reversed = {
      ...manifest,
      operations: [...manifest.operations].reverse().map((operation) => ({
        ...operation,
        autonomy: {
          ...operation.autonomy,
          supportedDispositions: [...operation.autonomy.supportedDispositions].reverse()
        }
      }))
    };
    const first = await createMcpToolRegistry(manifest);
    const second = await createMcpToolRegistry(reversed);

    expect(first.registryDigestSha256).toBe(second.registryDigestSha256);
    expect(first.sourceOperationRegistryDigestSha256).toBe(manifest.registryDigestSha256);
    expect(first.tools.map((tool) => tool.name)).toEqual(['event_draft', 'event_read']);
    expect(first.withheldTools).toEqual([
      {
        name: 'event_commit',
        operation: { name: 'event.commit', version: 1 },
        reason: 'commit_activation_required'
      }
    ]);
    expect(first.tools[0]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(first.tools[1]?.annotations.readOnlyHint).toBe(true);
    expect(first.tools[1]?.contract.autonomy.policy).toEqual({ key: 'autonomy.event.read', version: 1 });
    expect(first.tools[1]?.contract.autonomy.riskFloor).toBe('low');
    expect(first.tools[1]?.contract.autonomy.supportedDispositions).toContain('proceed');
    expect(first.tools[1]?.contract.autonomy.supportedDispositions).toContain('reconcile');
    expect(first.tools[1]?.contract.autonomy.supportedDispositions).toContain('renewed_approval');
    expect(JSON.stringify(first.tools)).not.toContain('runtimeEvaluator');
    expect(JSON.stringify(first.tools)).not.toContain('accessLanes');
    expect(() => canonicalJsonValue(first)).not.toThrow();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.tools)).toBe(true);

    const activated = await createMcpToolRegistry(manifest, { enableCommitTools: true });
    expect(activated.tools.map((tool) => tool.name)).toEqual([
      'event_commit',
      'event_draft',
      'event_read'
    ]);
    expect(activated.withheldTools).toHaveLength(0);
    expect(activated.tools[0]?.annotations.destructiveHint).toBe(true);
    await expect(createMcpToolRegistry(manifest, { enableCommitTools: 'yes' } as never))
      .rejects.toMatchObject({ issues: [{ code: 'invalid_activation' }] });
  });

  test('rejects digest drift, duplicate operations, tools, and schema identities', async () => {
    const manifest = await completeManifest();
    await expect(createMcpToolRegistry({
      ...manifest,
      operations: manifest.operations.map((operation, index) =>
        index === 0 ? { ...operation, summary: 'Tampered summary.' } : operation
      )
    })).rejects.toMatchObject({ issues: [{ code: 'manifest_digest_mismatch' }] });

    const duplicate = operationFixture({ name: 'duplicate.read', toolName: 'duplicate_read' });
    await expect(createMcpToolRegistry(await manifestFixture([duplicate, duplicate])))
      .rejects.toBeInstanceOf(McpRegistryValidationError);

    const firstOwner = operationFixture({ name: 'first.read', toolName: 'shared_tool' });
    const secondOwner = operationFixture({ name: 'second.read', toolName: 'shared_tool' });
    await expect(createMcpToolRegistry(await manifestFixture([firstOwner, secondOwner])))
      .rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: 'duplicate_tool' })]) });

    const conflictingSchema = operationFixture({
      name: 'schema.conflict',
      bindings: [{
        ...externalMcpBinding('schema_conflict', 'schema.schema.conflict.input'),
        resultSchema: {
          key: 'schema.schema.conflict.input',
          version: 1,
          digestSha256: 'b'.repeat(64)
        }
      }]
    });
    await expect(createMcpToolRegistry(await manifestFixture([conflictingSchema])))
      .rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: 'schema_conflict' })]) });
  });

  test('enforces effect lane idempotency and lifecycle metadata', async () => {
    const draft = operationFixture({ name: 'draft.invalid', toolName: 'draft_invalid', effect: 'draft' });
    const invalidDraft = {
      ...draft,
      idempotency: { required: false as const }
    };
    await expect(createMcpToolRegistry(await manifestFixture([invalidDraft])))
      .rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_idempotency' })]) });

    const active = operationFixture({ name: 'record.read', version: 2, toolName: 'record_read' });
    const deprecated = operationFixture({
      name: 'record.read',
      version: 1,
      toolName: 'record_read_v1',
      lifecycle: {
        status: 'deprecated',
        sunsetAt: '2027-01-01T00:00:00Z',
        replacement: { operationName: 'record.read', operationVersion: 2 }
      }
    });
    const registry = await createMcpToolRegistry(await manifestFixture([active, deprecated]));
    expect(registry.tools.find((tool) => tool.name === 'record_read_v1')?.contract.lifecycle)
      .toEqual(deprecated.lifecycle);

    const missingReplacement = operationFixture({
      name: 'old.read',
      toolName: 'old_read',
      lifecycle: {
        status: 'deprecated',
        sunsetAt: '2027-01-01T00:00:00Z',
        replacement: { operationName: 'missing.read', operationVersion: 1 }
      }
    });
    await expect(createMcpToolRegistry(await manifestFixture([missingReplacement])))
      .rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_lifecycle' })]) });

    const replayOnly = operationFixture({
      name: 'replay.read',
      toolName: 'replay_read',
      lifecycle: { status: 'replay_only' }
    });
    await expect(createMcpToolRegistry(await manifestFixture([replayOnly])))
      .rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_lifecycle' })]) });
  });

  test('rejects hidden entries and malformed/internal manifest material', async () => {
    const hidden = operationFixture({ name: 'internal.hidden', bindings: [] });
    await expect(createMcpToolRegistry(await manifestFixture([hidden])))
      .rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: 'hidden_operation' })]) });

    const manifest = await completeManifest();
    await expect(createMcpToolRegistry({
      ...manifest,
      operations: [{ ...manifest.operations[0], handler: 'internal.handler' }, ...manifest.operations.slice(1)]
    })).rejects.toMatchObject({ issues: [{ code: 'malformed_manifest' }] });

    await expect(createMcpToolRegistry({
      ...manifest,
      operations: [{
        ...manifest.operations[0],
        autonomy: { ...manifest.operations[0]!.autonomy, runtimeEvaluator: 'internal.evaluator' }
      }, ...manifest.operations.slice(1)]
    })).rejects.toMatchObject({ issues: [{ code: 'malformed_manifest' }] });

    await expect(createMcpToolRegistry({
      ...manifest,
      operations: [{
        ...manifest.operations[0],
        enabledBindings: [{
          surface: 'application_job',
          protocol: 'tool',
          toolName: 'internal_job',
          resultSchema: manifest.operations[0]!.inputSchema
        }]
      }, ...manifest.operations.slice(1)]
    })).rejects.toMatchObject({ issues: [{ code: 'malformed_manifest' }] });
  });
});
