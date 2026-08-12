import { createHash } from 'node:crypto';
import type {
  ModelAttemptObservation,
  ModelAttemptRequest,
  ModelCancelObservation,
  ModelLookupObservation,
  ModelProviderAdapter,
  ModelToolRequest,
  NormalizedUsage,
  ProviderCapabilities,
  SafeProviderEvidence,
  ModelDefinitionRef
} from './types';
import {
  resolveExecutionMode,
  validateAttemptRequest,
  validateModelAttemptObservationUsage,
  validateNormalizedUsage
} from './validation';

export interface ClassifiedModelOutputSink {
  putInvalidOutput(input: {
    readonly adapter: ModelDefinitionRef;
    readonly runId: string;
    readonly attemptId: string;
    readonly rawText: string;
  }): Promise<import('@jooevents/kernel').PayloadRef>;
}

export interface ClassifiedProviderParameterSource {
  loadProviderParameters(input: {
    readonly payload: import('@jooevents/kernel').PayloadRef;
    readonly schema: import('./types').ModelDefinitionRef;
    readonly adapter: import('./types').ModelDefinitionRef;
  }): Promise<Readonly<Record<string, unknown>>>;
}

export interface ModelStructuredOutputValidator {
  validate(schema: import('./types').ModelOutputJsonSchema, value: unknown): boolean;
}

type TransportKnownFailure = {
  readonly kind: 'known_failure';
  readonly safeCode: string;
  readonly retryability: 'never' | 'policy';
  readonly providerRequestId?: string;
  readonly usage?: NormalizedUsage;
};

type TransportAcceptanceUnknown = {
  readonly kind: 'acceptance_unknown';
  readonly providerRequestId?: string;
  readonly recovery: 'lookup' | 'idempotent_reuse' | 'manual';
};

type TransportCancelled = { readonly kind: 'cancelled'; readonly providerRequestId?: string; readonly usage?: NormalizedUsage };

export type AnthropicNativeRequest = Readonly<Record<string, unknown>> & {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
};

export interface AnthropicMessageResponse {
  readonly id: string;
  readonly content: readonly (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  )[];
  readonly stop_reason: string | null;
  readonly usage: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
}

export type AnthropicTransportObservation =
  | { readonly kind: 'message'; readonly response: AnthropicMessageResponse }
  | TransportKnownFailure
  | TransportAcceptanceUnknown
  | TransportCancelled;

export interface AnthropicTransport {
  execute(input: {
    readonly mode: 'batch' | 'fast';
    readonly idempotencyKey: string;
    readonly body: AnthropicNativeRequest;
  }): Promise<AnthropicTransportObservation>;
  lookup(providerRequestId: string): Promise<AnthropicTransportObservation | { readonly kind: 'pending' } | { readonly kind: 'not_found' }>;
  cancel(providerRequestId: string): Promise<ModelCancelObservation>;
}

export type OpenAINativeRequest = Readonly<Record<string, unknown>> & {
  readonly model: string;
  readonly input: readonly Readonly<Record<string, unknown>>[];
};

export interface OpenAIResponse {
  readonly id: string;
  readonly status: 'completed' | 'failed' | 'incomplete' | 'cancelled' | 'queued' | 'in_progress';
  readonly output: readonly (
    | { readonly type: 'message'; readonly content: readonly ({ readonly type: 'output_text'; readonly text: string } | { readonly type: 'refusal'; readonly refusal: string })[] }
    | { readonly type: 'function_call'; readonly call_id: string; readonly name: string; readonly arguments: string }
  )[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number };
  };
  readonly error?: { readonly code?: string } | null;
  readonly incomplete_details?: { readonly reason?: string } | null;
}

export type OpenAITransportObservation =
  | { readonly kind: 'response'; readonly response: OpenAIResponse }
  | TransportKnownFailure
  | TransportAcceptanceUnknown
  | TransportCancelled;

export interface OpenAITransport {
  execute(input: {
    readonly mode: 'batch' | 'fast';
    readonly idempotencyKey: string;
    readonly body: OpenAINativeRequest;
  }): Promise<OpenAITransportObservation>;
  lookup(providerRequestId: string): Promise<OpenAITransportObservation | { readonly kind: 'pending' } | { readonly kind: 'not_found' }>;
  cancel(providerRequestId: string): Promise<ModelCancelObservation>;
}

const anthropicCapabilities: ProviderCapabilities = {
  structuredOutput: true,
  tools: true,
  batch: true,
  fast: true,
  lookup: true,
  cancellation: true,
  idempotency: true
};

const openAICapabilities: ProviderCapabilities = {
  structuredOutput: true,
  tools: true,
  batch: true,
  fast: true,
  lookup: true,
  cancellation: true,
  idempotency: true
};

export class AnthropicModelAdapter implements ModelProviderAdapter {
  readonly ref: ModelDefinitionRef = { key: 'anthropic_messages', version: 1 };

  constructor(
    private readonly transport: AnthropicTransport,
    private readonly outputSink: ClassifiedModelOutputSink,
    private readonly outputValidator: ModelStructuredOutputValidator,
    private readonly parameterSource?: ClassifiedProviderParameterSource
  ) {}

  describeCapabilities(): ProviderCapabilities {
    return anthropicCapabilities;
  }

  async execute(request: ModelAttemptRequest): Promise<ModelAttemptObservation> {
    validateAdapterRequest(request, this.ref, anthropicCapabilities);
    const mode = resolveExecutionMode(request);
    const providerParameters = await loadProviderParameters(request, this.ref, this.parameterSource);
    const observation = await this.transport.execute({
      mode,
      idempotencyKey: request.providerIdempotencyKey,
      body: buildAnthropicRequest(request, providerParameters)
    });
    return normalizeAnthropicObservation(observation, request, this.ref, mode, this.outputSink, this.outputValidator);
  }

  async lookup(evidence: SafeProviderEvidence, frozenRequest: ModelAttemptRequest): Promise<ModelLookupObservation> {
    if (!sameRef(evidence.adapter, this.ref) || !evidence.providerRequestId) return { kind: 'not_found' };
    const observation = await this.transport.lookup(evidence.providerRequestId);
    if (observation.kind === 'pending' || observation.kind === 'not_found') return observation.kind === 'pending' ? { kind: 'pending', evidence } : observation;
    return normalizeAnthropicObservation(observation, frozenRequest, this.ref, evidence.executionMode ?? 'batch', this.outputSink, this.outputValidator);
  }

  async cancel(evidence: SafeProviderEvidence): Promise<ModelCancelObservation> {
    if (!sameRef(evidence.adapter, this.ref) || !evidence.providerRequestId) return { kind: 'unknown' };
    return this.transport.cancel(evidence.providerRequestId);
  }
}

export class OpenAIModelAdapter implements ModelProviderAdapter {
  readonly ref: ModelDefinitionRef = { key: 'openai_responses', version: 1 };

  constructor(
    private readonly transport: OpenAITransport,
    private readonly outputSink: ClassifiedModelOutputSink,
    private readonly outputValidator: ModelStructuredOutputValidator,
    private readonly parameterSource?: ClassifiedProviderParameterSource
  ) {}

  describeCapabilities(): ProviderCapabilities {
    return openAICapabilities;
  }

  async execute(request: ModelAttemptRequest): Promise<ModelAttemptObservation> {
    validateAdapterRequest(request, this.ref, openAICapabilities);
    const mode = resolveExecutionMode(request);
    const providerParameters = await loadProviderParameters(request, this.ref, this.parameterSource);
    const observation = await this.transport.execute({
      mode,
      idempotencyKey: request.providerIdempotencyKey,
      body: buildOpenAIRequest(request, providerParameters)
    });
    return normalizeOpenAIObservation(observation, request, this.ref, mode, this.outputSink, this.outputValidator);
  }

  async lookup(evidence: SafeProviderEvidence, frozenRequest: ModelAttemptRequest): Promise<ModelLookupObservation> {
    if (!sameRef(evidence.adapter, this.ref) || !evidence.providerRequestId) return { kind: 'not_found' };
    const observation = await this.transport.lookup(evidence.providerRequestId);
    if (observation.kind === 'pending' || observation.kind === 'not_found') return observation.kind === 'pending' ? { kind: 'pending', evidence } : observation;
    return normalizeOpenAIObservation(observation, frozenRequest, this.ref, evidence.executionMode ?? 'batch', this.outputSink, this.outputValidator);
  }

  async cancel(evidence: SafeProviderEvidence): Promise<ModelCancelObservation> {
    if (!sameRef(evidence.adapter, this.ref) || !evidence.providerRequestId) return { kind: 'unknown' };
    return this.transport.cancel(evidence.providerRequestId);
  }
}

export function buildAnthropicRequest(
  request: ModelAttemptRequest,
  providerParameters?: Readonly<Record<string, unknown>>
): AnthropicNativeRequest {
  const system = request.messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => ({ type: 'text', text: message.content }));
  const messages = request.messages
    .filter((message) => message.role !== 'system' && message.role !== 'developer')
    .map((message) => message.role === 'tool'
      ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: required(message.toolCallId, 'toolCallId'), content: message.content }] }
      : { role: message.role, content: [{ type: 'text', text: message.content }] });
  const toolMap = wireToolMap(request);
  const outputConfig = {
    ...(request.profile.controls.effort === undefined
      ? {}
      : { effort: request.profile.controls.effort === 'minimal' ? 'low' : request.profile.controls.effort }),
    ...(request.outputJsonSchema === undefined ? {} : {
      format: { type: 'json_schema', schema: request.outputJsonSchema.schema }
    })
  };
  const base: Record<string, unknown> = {
    model: request.profile.modelId,
    max_tokens: request.profile.controls.maxOutputTokens,
    messages,
    ...(system.length === 0 ? {} : { system }),
    ...(request.tools.length === 0 ? {} : {
      tools: request.tools.map((tool) => ({
        name: toolMap.byOperation.get(operationKey(tool.operation))!,
        description: tool.description,
        input_schema: tool.inputJsonSchema,
        strict: true
      }))
    }),
    ...(request.profile.controls.temperature === undefined ? {} : { temperature: request.profile.controls.temperature }),
    ...(Object.keys(outputConfig).length === 0 ? {} : { output_config: outputConfig })
  };
  return mergeProviderParameters(base, providerParameters, new Set(Object.keys(base))) as AnthropicNativeRequest;
}

export function buildOpenAIRequest(
  request: ModelAttemptRequest,
  providerParameters?: Readonly<Record<string, unknown>>
): OpenAINativeRequest {
  const toolMap = wireToolMap(request);
  const base: Record<string, unknown> = {
    model: request.profile.modelId,
    input: request.messages.map((message) => message.role === 'tool'
      ? { type: 'function_call_output', call_id: required(message.toolCallId, 'toolCallId'), output: message.content }
      : { role: message.role, content: [{ type: 'input_text', text: message.content }] }),
    max_output_tokens: request.profile.controls.maxOutputTokens,
    store: false,
    ...(request.tools.length === 0 ? {} : {
      tools: request.tools.map((tool) => ({
        type: 'function',
        name: toolMap.byOperation.get(operationKey(tool.operation))!,
        description: tool.description,
        parameters: tool.inputJsonSchema,
        strict: true
      }))
    }),
    ...(request.profile.controls.effort === undefined ? {} : { reasoning: { effort: request.profile.controls.effort } }),
    ...(request.profile.controls.temperature === undefined ? {} : { temperature: request.profile.controls.temperature }),
    ...(request.outputJsonSchema === undefined ? {} : {
      text: {
        format: {
          type: 'json_schema',
          name: request.outputJsonSchema.name,
          schema: request.outputJsonSchema.schema,
          strict: true
        }
      }
    })
  };
  return mergeProviderParameters(base, providerParameters, new Set(Object.keys(base))) as OpenAINativeRequest;
}

async function loadProviderParameters(
  request: ModelAttemptRequest,
  adapter: ModelDefinitionRef,
  source: ClassifiedProviderParameterSource | undefined
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const binding = request.profile.providerParameterBinding;
  if (!binding) return undefined;
  if (!source) throw new TypeError('A classified provider-parameter source is required by the selected profile');
  const value = await source.loadProviderParameters({
    payload: binding.payload,
    schema: binding.schema,
    adapter
  });
  return value;
}

function validateAdapterRequest(request: ModelAttemptRequest, ref: ModelDefinitionRef, capabilities: ProviderCapabilities): void {
  validateAttemptRequest(request, capabilities);
  if (!sameRef(request.profile.adapter, ref)) throw new TypeError(`Profile adapter does not match ${ref.key}`);
}

function mergeProviderParameters(
  base: Record<string, unknown>,
  providerParameters: Readonly<Record<string, unknown>> | undefined,
  reserved: ReadonlySet<string>
): Readonly<Record<string, unknown>> {
  if (providerParameters === undefined) return Object.freeze(base);
  for (const key of Object.keys(providerParameters)) {
    if (reserved.has(key) || /^(authorization|headers?|api[_-]?key)$/i.test(key)) {
      throw new TypeError(`Provider parameter collides with a normalized or credential field: ${key}`);
    }
  }
  return Object.freeze({ ...base, ...providerParameters });
}

function wireToolMap(request: ModelAttemptRequest): {
  readonly byOperation: ReadonlyMap<string, string>;
  readonly byWire: ReadonlyMap<string, { readonly name: string; readonly version: number }>;
} {
  const byOperation = new Map<string, string>();
  const byWire = new Map<string, { readonly name: string; readonly version: number }>();
  for (const tool of request.tools) {
    const key = operationKey(tool.operation);
    const wire = `jo_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
    byOperation.set(key, wire);
    byWire.set(wire, tool.operation);
  }
  return { byOperation, byWire };
}

async function normalizeAnthropicObservation(
  observation: AnthropicTransportObservation,
  request: ModelAttemptRequest,
  ref: ModelDefinitionRef,
  mode: 'batch' | 'fast',
  sink: ClassifiedModelOutputSink,
  validator: ModelStructuredOutputValidator
): Promise<ModelAttemptObservation> {
  if (observation.kind !== 'message') {
    return normalizeTransportNonSuccess(observation, request, ref, mode);
  }
  const evidence = providerEvidence(ref, observation.response.id, mode, request);
  const usage: NormalizedUsage = {
    ...(observation.response.usage.input_tokens === undefined ? {} : { inputTokens: observation.response.usage.input_tokens }),
    ...(observation.response.usage.output_tokens === undefined ? {} : { outputTokens: observation.response.usage.output_tokens }),
    ...(observation.response.usage.cache_read_input_tokens === undefined ? {} : { cachedInputTokens: observation.response.usage.cache_read_input_tokens })
  };
  validateNormalizedUsage(usage);
  const toolMap = wireToolMap(request).byWire;
  const toolRequests = observation.response.content.filter((block): block is Extract<AnthropicMessageResponse['content'][number], { type: 'tool_use' }> => block.type === 'tool_use');
  if (toolRequests.length > 0) {
    if (observation.response.stop_reason !== 'tool_use') {
      return knownProviderFailure('provider_finish_reason_invalid', 'never', evidence, usage);
    }
    return { kind: 'tool_requests', requests: toolRequests.map((block) => toolRequest(block.id, block.name, block.input, toolMap)), usage, evidence };
  }
  switch (observation.response.stop_reason) {
    case 'end_turn':
    case 'stop_sequence':
      break;
    case 'max_tokens':
      return knownProviderFailure('provider_output_limit', 'policy', evidence, usage);
    case 'refusal':
      return knownProviderFailure('provider_refusal', 'never', evidence, usage);
    case 'pause_turn':
      return { kind: 'acceptance_unknown', evidence, recovery: 'lookup' };
    case 'model_context_window_exceeded':
      return knownProviderFailure('provider_context_limit', 'never', evidence, usage);
    default:
      return knownProviderFailure('provider_finish_reason_unrecognized', 'never', evidence, usage);
  }
  const text = observation.response.content.filter((block): block is Extract<AnthropicMessageResponse['content'][number], { type: 'text' }> => block.type === 'text').map((block) => block.text).join('');
  return normalizeTextOutput(text, request, usage, evidence, sink, validator);
}

async function normalizeOpenAIObservation(
  observation: OpenAITransportObservation,
  request: ModelAttemptRequest,
  ref: ModelDefinitionRef,
  mode: 'batch' | 'fast',
  sink: ClassifiedModelOutputSink,
  validator: ModelStructuredOutputValidator
): Promise<ModelAttemptObservation> {
  if (observation.kind !== 'response') return normalizeTransportNonSuccess(observation, request, ref, mode);
  const response = observation.response;
  const evidence = providerEvidence(ref, response.id, mode, request);
  const usage: NormalizedUsage = {
    ...(response.usage?.input_tokens === undefined ? {} : { inputTokens: response.usage.input_tokens }),
    ...(response.usage?.output_tokens === undefined ? {} : { outputTokens: response.usage.output_tokens }),
    ...(response.usage?.input_tokens_details?.cached_tokens === undefined ? {} : { cachedInputTokens: response.usage.input_tokens_details.cached_tokens })
  };
  validateNormalizedUsage(usage);
  if (response.status === 'queued' || response.status === 'in_progress') return { kind: 'acceptance_unknown', evidence, recovery: 'lookup' };
  if (response.status === 'cancelled') {
    return { kind: 'cancelled', ...(response.usage === undefined ? {} : { usage }), evidence };
  }
  if (response.status === 'failed' || response.status === 'incomplete') {
    return knownProviderFailure(
      normalizeTransportFailureCode(response.error?.code ?? response.incomplete_details?.reason),
      'policy',
      evidence,
      response.usage === undefined ? undefined : usage
    );
  }
  if (response.status !== 'completed') {
    return knownProviderFailure('provider_status_unrecognized', 'never', evidence, response.usage === undefined ? undefined : usage);
  }
  const toolMap = wireToolMap(request).byWire;
  const calls = response.output.filter((item): item is Extract<OpenAIResponse['output'][number], { type: 'function_call' }> => item.type === 'function_call');
  if (calls.length > 0) {
    const requests: ModelToolRequest[] = [];
    for (const call of calls) {
      let input: unknown;
      try { input = JSON.parse(call.arguments); } catch { return malformedToolInput(call.call_id, evidence); }
      requests.push(toolRequest(call.call_id, call.name, input, toolMap));
    }
    return { kind: 'tool_requests', requests, usage, evidence };
  }
  const refusal = response.output.flatMap((item) => item.type === 'message' ? item.content : []).find((content) => content.type === 'refusal');
  if (refusal?.type === 'refusal') return { kind: 'known_failure', safeCode: 'provider_refusal', retryability: 'never', usage, evidence };
  const text = response.output.flatMap((item) => item.type === 'message' ? item.content : []).filter((content): content is { readonly type: 'output_text'; readonly text: string } => content.type === 'output_text').map((content) => content.text).join('');
  return normalizeTextOutput(text, request, usage, evidence, sink, validator);
}

async function normalizeTextOutput(
  text: string,
  request: ModelAttemptRequest,
  usage: NormalizedUsage,
  evidence: SafeProviderEvidence,
  sink: ClassifiedModelOutputSink,
  validator: ModelStructuredOutputValidator
): Promise<ModelAttemptObservation> {
  if (!request.profile.controls.requireStructuredOutput) return { kind: 'succeeded', output: text, usage, evidence };
  try {
    const parsed = JSON.parse(text);
    if (!request.outputJsonSchema || !validator.validate(request.outputJsonSchema, parsed)) {
      throw new TypeError('structured output did not match its registered schema');
    }
    return { kind: 'succeeded', output: parsed, usage, evidence };
  } catch {
    const rawOutputRef = await sink.putInvalidOutput({ adapter: evidence.adapter, runId: request.runId, attemptId: request.attemptId, rawText: text });
    return { kind: 'schema_invalid', rawOutputRef, usage, safeCode: 'model_output_schema_invalid', evidence };
  }
}

function normalizeTransportNonSuccess(
  observation: TransportKnownFailure | TransportAcceptanceUnknown | TransportCancelled,
  request: ModelAttemptRequest,
  ref: ModelDefinitionRef,
  mode: 'batch' | 'fast'
): ModelAttemptObservation {
  if (!observation || typeof observation !== 'object') throw new TypeError('invalid_provider_transport_observation');
  const evidence = providerEvidence(ref, observation.providerRequestId, mode, request);
  if (observation.kind === 'known_failure') {
    if (observation.retryability !== 'never' && observation.retryability !== 'policy') {
      throw new TypeError('invalid_provider_retryability');
    }
    const normalized: ModelAttemptObservation = {
      kind: 'known_failure',
      safeCode: normalizeTransportFailureCode(observation.safeCode),
      retryability: observation.retryability,
      ...(observation.usage === undefined ? {} : { usage: observation.usage }),
      evidence
    };
    validateModelAttemptObservationUsage(normalized);
    return normalized;
  }
  if (observation.kind === 'acceptance_unknown') {
    if (observation.recovery !== 'lookup' && observation.recovery !== 'idempotent_reuse' && observation.recovery !== 'manual') {
      throw new TypeError('invalid_provider_recovery');
    }
    return { kind: 'acceptance_unknown', evidence, recovery: observation.recovery };
  }
  if (observation.kind !== 'cancelled') throw new TypeError('invalid_provider_transport_observation');
  const normalized: ModelAttemptObservation = {
    kind: 'cancelled',
    ...(observation.usage === undefined ? {} : { usage: observation.usage }),
    evidence
  };
  validateModelAttemptObservationUsage(normalized);
  return normalized;
}

function providerEvidence(
  ref: ModelDefinitionRef,
  providerRequestId: string | undefined,
  mode: 'batch' | 'fast',
  request: ModelAttemptRequest
): SafeProviderEvidence {
  const controls = request.profile.controls;
  const resolvedControls: Readonly<Record<string, string | number | boolean>> = Object.freeze(
    ref.key === 'anthropic_messages'
      ? {
          max_tokens: controls.maxOutputTokens,
          structured_output: controls.requireStructuredOutput,
          ...(controls.effort === undefined ? {} : {
            'output_config.effort': controls.effort === 'minimal' ? 'low' : controls.effort
          }),
          ...(controls.temperature === undefined ? {} : { temperature: controls.temperature })
        }
      : {
          max_output_tokens: controls.maxOutputTokens,
          structured_output: controls.requireStructuredOutput,
          ...(controls.effort === undefined ? {} : { 'reasoning.effort': controls.effort }),
          ...(controls.temperature === undefined ? {} : { temperature: controls.temperature })
        }
  );
  return {
    adapter: ref,
    ...(providerRequestId === undefined ? {} : { providerRequestId: safeProviderOpaqueId(providerRequestId, 'provider_request_id') }),
    idempotencySupported: true,
    executionMode: mode,
    resolvedControls
  };
}

function toolRequest(
  callId: string,
  wireName: string,
  input: unknown,
  map: ReadonlyMap<string, { readonly name: string; readonly version: number }>
): ModelToolRequest {
  const operation = map.get(wireName);
  if (!operation) throw new TypeError('Provider returned an undeclared tool name');
  return { callId: safeProviderOpaqueId(callId, 'provider_tool_call_id'), operation, input };
}

function malformedToolInput(_callId: string, evidence: SafeProviderEvidence): ModelAttemptObservation {
  return { kind: 'known_failure', safeCode: 'provider_tool_input_invalid', retryability: 'never', evidence };
}

function safeProviderOpaqueId(value: unknown, kind: 'provider_request_id' | 'provider_tool_call_id'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/.test(value)) {
    throw new TypeError(`invalid_${kind}`);
  }
  return value;
}

function normalizeTransportFailureCode(value: unknown): string {
  switch (value) {
    case 'provider_busy':
    case 'overloaded':
    case 'overloaded_error':
      return 'provider_overloaded';
    case 'provider_timeout':
    case 'timeout':
    case 'request_timeout':
      return 'provider_timeout';
    case 'provider_unavailable':
    case 'service_unavailable':
    case 'server_error':
    case 'internal_error':
      return 'provider_unavailable';
    case 'provider_rate_limited':
    case 'rate_limit_error':
    case 'rate_limit_exceeded':
      return 'provider_rate_limited';
    case 'provider_refusal':
    case 'content_filter':
      return 'provider_refusal';
    case 'provider_output_limit':
    case 'max_output_tokens':
      return 'provider_output_limit';
    case 'provider_context_limit':
    case 'context_length_exceeded':
      return 'provider_context_limit';
    case 'provider_invalid_request':
    case 'invalid_request_error':
      return 'provider_invalid_request';
    case 'provider_configuration_error':
    case 'authentication_error':
    case 'permission_error':
      return 'provider_configuration_error';
    case 'provider_incomplete':
      return 'provider_incomplete';
    default:
      return 'provider_failure';
  }
}

function knownProviderFailure(
  safeCode: string,
  retryability: 'never' | 'policy',
  evidence: SafeProviderEvidence,
  usage?: NormalizedUsage
): ModelAttemptObservation {
  return {
    kind: 'known_failure',
    safeCode,
    retryability,
    ...(usage === undefined ? {} : { usage }),
    evidence
  };
}

function operationKey(operation: { readonly name: string; readonly version: number }): string {
  return `${operation.name}@${operation.version}`;
}

function sameRef(a: ModelDefinitionRef, b: ModelDefinitionRef): boolean {
  return a.key === b.key && a.version === b.version;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new TypeError(`${label} is required`);
  return value;
}
