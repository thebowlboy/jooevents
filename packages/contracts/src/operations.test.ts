import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createReadOperationResultSchema,
  operationEffectSchema,
  operationHttpIdempotencyKeySchema,
  operationTransportErrorCodeSchema,
  safeOperationAutonomySchema,
  safeOperationManifestSchema,
  structuredOutcomeSchema
} from './operations';

const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';
const receiptId = '018f0f47-7a86-7d36-8a25-9f86589c7a4e';
const digestSha256 = 'a'.repeat(64);
const dataSchema = z.strictObject({ greeting: z.string() });

const outcome = {
  class: 'access_denied',
  kind: 'workspace.inactive',
  retryable: false,
  subjects: [],
  detail: { reason: 'inactive' },
  detailSchemaVersion: 1
} as const;

describe('operation result contracts', () => {
  test('effect and outcome vocabularies are closed', () => {
    expect(operationEffectSchema.safeParse('read').success).toBe(true);
    expect(operationEffectSchema.safeParse('send').success).toBe(false);
    expect(structuredOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(structuredOutcomeSchema.safeParse({ ...outcome, class: 'unknown' }).success).toBe(false);
    expect(structuredOutcomeSchema.safeParse({ ...outcome, internal: true }).success).toBe(false);
    expect(structuredOutcomeSchema.safeParse({ ...outcome, detail: { invalid: BigInt(1) } }).success).toBe(false);
  });

  test('read results cannot carry mutation receipts', () => {
    const schema = createReadOperationResultSchema(dataSchema);
    expect(schema.safeParse({ kind: 'success', data: { greeting: 'hello' }, correlationId }).success).toBe(true);
    expect(schema.safeParse({
      kind: 'success',
      data: { greeting: 'hello' },
      correlationId,
      receipt: { id: receiptId, operationName: 'greeting.read', operationVersion: 1 }
    }).success).toBe(false);
  });

  test('effectful terminal results require a receipt and nonterminal outcomes forbid one', () => {
    const schema = createEffectfulOperationResultSchema(dataSchema);
    const receipt = { id: receiptId, operationName: 'greeting.create', operationVersion: 1 };
    expect(schema.safeParse({ kind: 'success', data: { greeting: 'hello' }, correlationId, receipt }).success).toBe(true);
    expect(schema.safeParse({ kind: 'outcome', outcome, correlationId, terminal: true }).success).toBe(false);
    expect(schema.safeParse({ kind: 'outcome', outcome, correlationId, terminal: false, receipt }).success).toBe(false);
  });
});

test('external transports can report rate limiting without weakening other errors', () => {
  expect(operationTransportErrorCodeSchema.safeParse('rate_limited').success).toBe(true);
  expect(operationTransportErrorCodeSchema.safeParse('quota_guess').success).toBe(false);
});

test('effectful HTTP idempotency keys use one bounded non-joinable wire shape', () => {
  expect(operationHttpIdempotencyKeySchema.safeParse('browser-action_01').success).toBe(true);
  expect(operationHttpIdempotencyKeySchema.safeParse('x'.repeat(256)).success).toBe(true);
  for (const value of ['', 'x'.repeat(257), 'contains space', 'first,second', 'line\nbreak']) {
    expect(operationHttpIdempotencyKeySchema.safeParse(value).success).toBe(false);
  }
});

test('safe autonomy metadata uses one closed intervention vocabulary', () => {
  const policy = {
    policy: { key: 'autonomy.greeting_read', version: 1 },
    riskFloor: 'low',
    unattendedRiskCeiling: 'normal',
    requiresSeparateApproval: false,
    supportedDispositions: ['proceed', 'renewed_approval', 'block'],
    triggerDispositions: {
      authority_lost: 'block',
      unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval',
      known_retryable_failure: 'block',
      ambiguous_external_effect: 'block',
      stale_plan: 'block',
      compensation_required: 'block',
      terminal_failure: 'block'
    }
  } as const;
  expect(safeOperationAutonomySchema.safeParse(policy).success).toBe(true);
  expect(safeOperationAutonomySchema.safeParse({
    ...policy,
    triggerDispositions: { ...policy.triggerDispositions, ambiguous_external_effect: 'retry_anyway' }
  }).success).toBe(false);
  expect(safeOperationAutonomySchema.safeParse({ ...policy, runtimeEvaluator: 'internal' }).success).toBe(false);
});

test('the safe manifest is JSON-only and rejects executable or internal fields', () => {
  const schemaRef = { key: 'schema.greeting.input', version: 1, digestSha256 };
  const manifest = {
    schemaVersion: 1,
    registryDigestSha256: 'b'.repeat(64),
    operations: [{
      name: 'greeting.read',
      version: 1,
      lifecycle: { status: 'active' },
      summary: 'Read a greeting.',
      effect: 'read',
      maxRisk: 'low',
      autonomy: {
        policy: { key: 'autonomy.greeting_read', version: 1 },
        riskFloor: 'low',
        unattendedRiskCeiling: 'low',
        requiresSeparateApproval: false,
        supportedDispositions: ['proceed', 'renewed_approval', 'block'],
        triggerDispositions: {
          authority_lost: 'block',
          unattended_bounds_exceeded: 'renewed_approval',
          approval_required: 'renewed_approval',
          known_retryable_failure: 'block',
          ambiguous_external_effect: 'block',
          stale_plan: 'block',
          compensation_required: 'block',
          terminal_failure: 'block'
        }
      },
      consequenceTags: [],
      inputSchema: schemaRef,
      idempotency: { required: false },
      concurrency: { kind: 'read_snapshot' },
      outcomes: [],
      enabledBindings: [{
        surface: 'operator_http',
        protocol: 'http',
        method: 'GET',
        path: '/api/test/greeting',
        input: 'query',
        resultSchema: { ...schemaRef, key: 'schema.greeting.result' },
        browserResumption: { kind: 'none' }
      }]
    }]
  };

  const parsed = safeOperationManifestSchema.parse(manifest);
  expect(z.json().safeParse(parsed).success).toBe(true);
  for (const path of ['/api/./test', '/api/test/../other', '/api/test//other']) {
    expect(safeOperationManifestSchema.safeParse({
      ...manifest,
      operations: [{
        ...manifest.operations[0],
        enabledBindings: [{ ...manifest.operations[0]!.enabledBindings[0]!, path }]
      }]
    }).success).toBe(false);
  }
  const { autonomy: _autonomy, ...withoutAutonomy } = manifest.operations[0]!;
  expect(safeOperationManifestSchema.safeParse({
    ...manifest,
    operations: [withoutAutonomy]
  }).success).toBe(false);
  expect(safeOperationManifestSchema.safeParse({
    ...manifest,
    operations: [{ ...manifest.operations[0], handler: () => 'secret' }]
  }).success).toBe(false);
});
