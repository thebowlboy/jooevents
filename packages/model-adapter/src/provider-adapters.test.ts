import { describe, expect, test } from 'bun:test';
import {
  createPayloadRef,
  parseAgentRunId,
  parseModelAttemptId,
  parsePayloadRefId
} from '@jooevents/kernel';
import {
  AnthropicModelAdapter,
  OpenAIModelAdapter,
  modelProviderIdempotencyKeyFor,
  parseModelRequestBinding,
  buildAnthropicRequest,
  buildOpenAIRequest,
  type AnthropicTransport,
  type ClassifiedModelOutputSink,
  type ClassifiedProviderParameterSource,
  type ModelAttemptRequest,
  type ModelProfileRevision,
  type OpenAITransport
} from '.';

const digest = 'a'.repeat(64);
const runId = parseAgentRunId('01890f47-9abc-7def-8123-456789abc111');
const firstAttemptId = parseModelAttemptId('01890f47-9abc-7def-8123-456789abc112');
const secondAttemptId = parseModelAttemptId('01890f47-9abc-7def-8123-456789abc113');
const invalidOutputRef = createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abc114'));

function profile(adapter: 'anthropic_messages' | 'openai_responses', withProviderParameters = false): ModelProfileRevision {
  return {
    key: `${adapter}_profile`,
    version: 1,
    digest,
    adapter: { key: adapter, version: 1 },
    modelId: `${adapter}-model-from-profile`,
    controls: { effort: 'medium', maxOutputTokens: 1000, requireStructuredOutput: true },
    defaultExecutionMode: 'batch',
    budget: { maximumAttempts: 3, maxInputTokens: 10_000, maxOutputTokens: 2000, maxCostMicros: 1000, timeoutMs: 10_000 },
    capabilities: { structuredOutput: true, tools: true, batch: true, fast: true, lookup: true, cancellation: true, idempotency: true },
    ...(withProviderParameters ? {
      providerParameterBinding: {
        payload: createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abc101')),
        schema: { key: `${adapter}_parameters`, version: 1 }
      }
    } : {})
  };
}

function request(adapter: 'anthropic_messages' | 'openai_responses', withProviderParameters = false): ModelAttemptRequest {
  return {
    runId,
    attemptId: firstAttemptId,
    requestBinding: parseModelRequestBinding(`mrb1_${digest}`),
    profile: profile(adapter, withProviderParameters),
    scaffold: {
      key: 'event_description',
      version: 1,
      digest: 'b'.repeat(64),
      purpose: 'event_description',
      outputSchema: { key: 'event_description_output', version: 1 },
      allowedTools: [{ name: 'program.read', version: 1 }]
    },
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
    tools: [{ operation: { name: 'program.read', version: 1 }, description: 'Read program', inputJsonSchema: { type: 'object' } }],
    outputJsonSchema: { name: 'event_description', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }, strict: true },
    providerIdempotencyKey: modelProviderIdempotencyKeyFor(parseModelRequestBinding(`mrb1_${digest}`))
  };
}

const sink: ClassifiedModelOutputSink = {
  async putInvalidOutput() { return invalidOutputRef; }
};

const validator = {
  validate(_schema: NonNullable<ModelAttemptRequest['outputJsonSchema']>, value: unknown) {
    return Boolean(value && typeof value === 'object' && typeof (value as { title?: unknown }).title === 'string');
  }
};

describe('provider request translation', () => {
  test('Anthropic maps normalized messages, strict tools, structured output and profile model', () => {
    const body = buildAnthropicRequest(request('anthropic_messages'));
    expect(body.model).toBe('anthropic_messages-model-from-profile');
    expect(body.max_tokens).toBe(1000);
    expect(body.system).toEqual([{ type: 'text', text: 'system' }]);
    expect(body.output_config).toEqual({
      effort: 'medium',
      format: { type: 'json_schema', schema: request('anthropic_messages').outputJsonSchema!.schema }
    });
    expect((body.tools as { strict: boolean }[])[0]?.strict).toBe(true);
  });

  test('Anthropic explicitly maps the normalized minimum effort to its lowest native level', () => {
    const base = request('anthropic_messages');
    const body = buildAnthropicRequest({
      ...base,
      profile: {
        ...base.profile,
        controls: { ...base.profile.controls, effort: 'minimal' }
      }
    });
    expect(body.output_config).toMatchObject({ effort: 'low' });
  });

  test('OpenAI maps normalized input, function tools, reasoning and structured output', () => {
    const body = buildOpenAIRequest(request('openai_responses'));
    expect(body.model).toBe('openai_responses-model-from-profile');
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect((body.tools as { strict: boolean }[])[0]?.strict).toBe(true);
    expect((body.text as { format: { type: string } }).format.type).toBe('json_schema');
  });

  test('specialized parameters are passed unchanged only when present and cannot collide', () => {
    const absent = buildOpenAIRequest(request('openai_responses'));
    expect('custom_native_flag' in absent).toBe(false);
    const value = { nested: ['verbatim', 3] };
    const present = buildOpenAIRequest(request('openai_responses'), { custom_native_flag: value });
    expect(present.custom_native_flag).toBe(value);
    expect(() => buildOpenAIRequest(request('openai_responses'), { model: 'override' })).toThrow('collides');
    expect(() => buildAnthropicRequest(request('anthropic_messages'), { api_key: 'secret' })).toThrow('credential');
  });

  test('only the selected adapter resolves an explicitly present classified native parameter object', async () => {
    let loads = 0;
    const parameterSource: ClassifiedProviderParameterSource = {
      async loadProviderParameters({ adapter }) {
        loads += 1;
        expect(adapter).toEqual({ key: 'openai_responses', version: 1 });
        return { custom_native_flag: { preserved: true } };
      }
    };
    let body: Readonly<Record<string, unknown>> | undefined;
    const transport: OpenAITransport = {
      async execute(input) {
        body = input.body;
        return { kind: 'response', response: { id: 'resp_params', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"title":"Event"}' }] }] } };
      },
      async lookup() { return { kind: 'not_found' }; },
      async cancel() { return { kind: 'unsupported' }; }
    };
    const adapter = new OpenAIModelAdapter(transport, sink, validator, parameterSource);
    await adapter.execute(request('openai_responses'));
    expect(loads).toBe(0);
    await adapter.execute({ ...request('openai_responses', true), attemptId: secondAttemptId });
    expect(loads).toBe(1);
    expect(body?.custom_native_flag).toEqual({ preserved: true });
  });
});

describe('shared normalized observations', () => {
  test('Anthropic batch success normalizes JSON, usage and safe evidence', async () => {
    let sent: Parameters<AnthropicTransport['execute']>[0] | undefined;
    const transport: AnthropicTransport = {
      async execute(input) {
        sent = input;
        return { kind: 'message', response: { id: 'msg_1', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"title":"Event"}' }], usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 } } };
      },
      async lookup() { return { kind: 'not_found' }; },
      async cancel() { return { kind: 'unsupported' }; }
    };
    const observation = await new AnthropicModelAdapter(transport, sink, validator).execute(request('anthropic_messages'));
    expect(sent?.mode).toBe('batch');
    expect(observation).toMatchObject({
      kind: 'succeeded',
      output: { title: 'Event' },
      usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 },
      evidence: {
        providerRequestId: 'msg_1',
        executionMode: 'batch',
        resolvedControls: {
          max_tokens: 1000,
          structured_output: true,
          'output_config.effort': 'medium'
        }
      }
    });
    if (observation.kind === 'succeeded') expect(Object.isFrozen(observation.evidence.resolvedControls)).toBe(true);
  });

  test('OpenAI explicit fast tool call maps back to the registered application operation', async () => {
    const transport: OpenAITransport = {
      async execute() {
        const wireName = (buildOpenAIRequest(request('openai_responses')).tools as { name: string }[])[0]!.name;
        return { kind: 'response', response: { id: 'resp_1', status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name: wireName, arguments: '{"scope":"current"}' }], usage: { input_tokens: 7, output_tokens: 2 } } };
      },
      async lookup() { return { kind: 'not_found' }; },
      async cancel() { return { kind: 'unsupported' }; }
    };
    const observation = await new OpenAIModelAdapter(transport, sink, validator).execute({ ...request('openai_responses'), executionMode: 'fast' });
    expect(observation).toMatchObject({
      kind: 'tool_requests',
      requests: [{ callId: 'call_1', operation: { name: 'program.read', version: 1 }, input: { scope: 'current' } }],
      evidence: {
        executionMode: 'fast',
        resolvedControls: {
          max_output_tokens: 1000,
          structured_output: true,
          'reasoning.effort': 'medium'
        }
      }
    });
  });

  test('malformed structured output is adopted through the classified sink', async () => {
    const transport: OpenAITransport = {
      async execute() { return { kind: 'response', response: { id: 'resp_bad', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not-json' }] }] } }; },
      async lookup() { return { kind: 'not_found' }; },
      async cancel() { return { kind: 'unsupported' }; }
    };
    expect(await new OpenAIModelAdapter(transport, sink, validator).execute(request('openai_responses'))).toMatchObject({ kind: 'schema_invalid', rawOutputRef: invalidOutputRef, safeCode: 'model_output_schema_invalid' });
  });

  test('well-formed JSON that misses the registered output schema is classified as invalid', async () => {
    const transport: OpenAITransport = {
      async execute() { return { kind: 'response', response: { id: 'resp_wrong_shape', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"wrong":true}' }] }] } }; },
      async lookup() { return { kind: 'not_found' }; },
      async cancel() { return { kind: 'unsupported' }; }
    };
    expect(await new OpenAIModelAdapter(transport, sink, validator).execute(request('openai_responses'))).toMatchObject({
      kind: 'schema_invalid',
      safeCode: 'model_output_schema_invalid'
    });
  });

  test('unsafe usage from success, failure, and cancellation transports is rejected at the normalized boundary', async () => {
    const invalidAnthropic: AnthropicTransport = {
      async execute() {
        return {
          kind: 'message',
          response: {
            id: 'msg_invalid_usage',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: '{"title":"Event"}' }],
            usage: { input_tokens: -1 }
          }
        };
      },
      async lookup() { return { kind: 'not_found' }; },
      async cancel() { return { kind: 'unsupported' }; }
    };
    await expect(new AnthropicModelAdapter(invalidAnthropic, sink, validator).execute(request('anthropic_messages')))
      .rejects.toThrow('usage.inputTokens must be a non-negative safe integer');

    for (const observation of [
      { kind: 'known_failure' as const, safeCode: 'provider_busy', retryability: 'policy' as const, usage: { costMicros: 1.5 } },
      { kind: 'cancelled' as const, usage: { outputTokens: Number.MAX_SAFE_INTEGER + 1 } }
    ]) {
      const invalidOpenAI: OpenAITransport = {
        async execute() { return observation; },
        async lookup() { return { kind: 'not_found' }; },
        async cancel() { return { kind: 'unsupported' }; }
      };
      await expect(new OpenAIModelAdapter(invalidOpenAI, sink, validator).execute(request('openai_responses')))
        .rejects.toThrow('non-negative safe integer');
    }
  });

  test('Anthropic output-limit and unrecognized stop reasons cannot become terminal success', async () => {
    for (const [stopReason, safeCode] of [
      ['max_tokens', 'provider_output_limit'],
      ['future_unrecognized_reason', 'provider_finish_reason_unrecognized'],
      [null, 'provider_finish_reason_unrecognized']
    ] as const) {
      const transport: AnthropicTransport = {
        async execute() {
          return {
            kind: 'message',
            response: {
              id: 'msg_bounded_stop',
              stop_reason: stopReason,
              content: [{ type: 'text', text: '{"title":"looks complete but is not trusted"}' }],
              usage: { input_tokens: 2, output_tokens: 3 }
            }
          };
        },
        async lookup() { return { kind: 'not_found' }; },
        async cancel() { return { kind: 'unsupported' }; }
      };
      expect(await new AnthropicModelAdapter(transport, sink, validator).execute(request('anthropic_messages')))
        .toMatchObject({ kind: 'known_failure', safeCode });
    }
  });

  test('provider error details are mapped to closed codes and never copied into safe outcomes', async () => {
    const rawErrorCanary = 'secret-provider-error-canary';
    const transport: OpenAITransport = {
      async execute() {
        return {
          kind: 'response',
          response: {
            id: 'resp_closed_error',
            status: 'failed',
            output: [],
            error: { code: rawErrorCanary }
          }
        };
      },
      async lookup() { return { kind: 'not_found' }; },
      async cancel() { return { kind: 'unsupported' }; }
    };
    const observation = await new OpenAIModelAdapter(transport, sink, validator).execute(request('openai_responses'));
    expect(observation).toMatchObject({ kind: 'known_failure', safeCode: 'provider_failure' });
    expect(JSON.stringify(observation)).not.toContain(rawErrorCanary);

    const directTransport: OpenAITransport = {
      async execute() {
        return { kind: 'known_failure', safeCode: rawErrorCanary, retryability: 'never' };
      },
      async lookup() { return { kind: 'not_found' }; },
      async cancel() { return { kind: 'unsupported' }; }
    };
    const direct = await new OpenAIModelAdapter(directTransport, sink, validator).execute(request('openai_responses'));
    expect(direct).toMatchObject({ kind: 'known_failure', safeCode: 'provider_failure' });
    expect(JSON.stringify(direct)).not.toContain(rawErrorCanary);
  });

  test('unsafe provider request and tool-call identifiers fail closed without echoing them', async () => {
    const invalidRequestId = 'resp\nclassified-canary';
    const requestIdTransport: OpenAITransport = {
      async execute() {
        return {
          kind: 'response',
          response: { id: invalidRequestId, status: 'completed', output: [] }
        };
      },
      async lookup() { return { kind: 'not_found' }; },
      async cancel() { return { kind: 'unsupported' }; }
    };
    await expect(new OpenAIModelAdapter(requestIdTransport, sink, validator).execute(request('openai_responses')))
      .rejects.toThrow('invalid_provider_request_id');

    const invalidToolId = 'call\nclassified-canary';
    const toolIdTransport: OpenAITransport = {
      async execute() {
        const wireName = (buildOpenAIRequest(request('openai_responses')).tools as { name: string }[])[0]!.name;
        return {
          kind: 'response',
          response: {
            id: 'resp_safe',
            status: 'completed',
            output: [{ type: 'function_call', call_id: invalidToolId, name: wireName, arguments: '{}' }]
          }
        };
      },
      async lookup() { return { kind: 'not_found' }; },
      async cancel() { return { kind: 'unsupported' }; }
    };
    await expect(new OpenAIModelAdapter(toolIdTransport, sink, validator).execute(request('openai_responses')))
      .rejects.toThrow('invalid_provider_tool_call_id');

    const malformedInputTransport: OpenAITransport = {
      async execute() {
        const wireName = (buildOpenAIRequest(request('openai_responses')).tools as { name: string }[])[0]!.name;
        return {
          kind: 'response',
          response: {
            id: 'resp_safe_malformed',
            status: 'completed',
            output: [{ type: 'function_call', call_id: 'call_safe_but_private', name: wireName, arguments: '{' }]
          }
        };
      },
      async lookup() { return { kind: 'not_found' }; },
      async cancel() { return { kind: 'unsupported' }; }
    };
    const malformed = await new OpenAIModelAdapter(malformedInputTransport, sink, validator).execute(request('openai_responses'));
    expect(malformed).toMatchObject({ kind: 'known_failure', safeCode: 'provider_tool_input_invalid' });
    expect(JSON.stringify(malformed)).not.toContain('call_safe_but_private');
  });

  test('unknown runtime provider statuses fail closed instead of falling through as completed work', async () => {
    const transport: OpenAITransport = {
      async execute() {
        return {
          kind: 'response',
          response: {
            id: 'resp_unknown_status',
            status: 'future_status' as never,
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"title":"Event"}' }] }]
          }
        };
      },
      async lookup() { return { kind: 'not_found' }; },
      async cancel() { return { kind: 'unsupported' }; }
    };
    expect(await new OpenAIModelAdapter(transport, sink, validator).execute(request('openai_responses')))
      .toMatchObject({ kind: 'known_failure', safeCode: 'provider_status_unrecognized', retryability: 'never' });
  });
});
