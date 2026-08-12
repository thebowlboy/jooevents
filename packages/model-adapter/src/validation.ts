import type {
  ModelAttemptRequest,
  ModelAttemptObservation,
  ModelExecutionMode,
  ModelProfileRevision,
  ModelScaffoldRevision,
  NormalizedUsage,
  ProviderCapabilities
} from './types';
import {
  modelProviderIdempotencyKeyFor,
  parseModelProviderIdempotencyKey,
  parseModelRequestBinding
} from './bindings';

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
}

export function validateNormalizedUsage(usage: NormalizedUsage): void {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new TypeError('model usage must be an object');
  }
  for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'costMicros'] as const) {
    const value = usage[field];
    if (value !== undefined) nonNegativeInteger(value, `usage.${field}`);
  }
}

export function validateModelAttemptObservationUsage(observation: ModelAttemptObservation): void {
  if ('usage' in observation && observation.usage !== undefined) validateNormalizedUsage(observation.usage);
}

function digest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
}

export function validateProfile(profile: ModelProfileRevision): void {
  if (!profile.key || !profile.adapter.key || !profile.modelId) throw new TypeError('Profile identities must be non-empty');
  positiveInteger(profile.version, 'profile.version');
  positiveInteger(profile.adapter.version, 'profile.adapter.version');
  digest(profile.digest, 'profile.digest');
  positiveInteger(profile.controls.maxOutputTokens, 'profile.controls.maxOutputTokens');
  if (profile.controls.effort !== undefined
    && !['minimal', 'low', 'medium', 'high'].includes(profile.controls.effort)) {
    throw new TypeError('profile.controls.effort must use the normalized closed vocabulary');
  }
  if (typeof profile.controls.requireStructuredOutput !== 'boolean') {
    throw new TypeError('profile.controls.requireStructuredOutput must be boolean');
  }
  positiveInteger(profile.budget.maximumAttempts, 'profile.budget.maximumAttempts');
  positiveInteger(profile.budget.maxInputTokens, 'profile.budget.maxInputTokens');
  positiveInteger(profile.budget.maxOutputTokens, 'profile.budget.maxOutputTokens');
  nonNegativeInteger(profile.budget.maxCostMicros, 'profile.budget.maxCostMicros');
  positiveInteger(profile.budget.timeoutMs, 'profile.budget.timeoutMs');
  if (profile.controls.maxOutputTokens > profile.budget.maxOutputTokens) {
    throw new TypeError('Profile output control exceeds its budget');
  }
  if (profile.controls.temperature !== undefined &&
      (!Number.isFinite(profile.controls.temperature) || profile.controls.temperature < 0 || profile.controls.temperature > 2)) {
    throw new TypeError('profile.controls.temperature must be between 0 and 2');
  }
  if (profile.providerParameterBinding) {
    if (!profile.providerParameterBinding.payload.id || !profile.providerParameterBinding.schema.key) {
      throw new TypeError('Profile provider-parameter binding identities must be non-empty');
    }
    positiveInteger(profile.providerParameterBinding.schema.version, 'profile.providerParameterBinding.schema.version');
  }
}

export function validateScaffold(scaffold: ModelScaffoldRevision): void {
  if (!scaffold.key || !scaffold.purpose || !scaffold.outputSchema.key) throw new TypeError('Scaffold identities must be non-empty');
  positiveInteger(scaffold.version, 'scaffold.version');
  positiveInteger(scaffold.outputSchema.version, 'scaffold.outputSchema.version');
  digest(scaffold.digest, 'scaffold.digest');
  const tools = new Set<string>();
  for (const tool of scaffold.allowedTools) {
    positiveInteger(tool.version, 'scaffold.allowedTools.version');
    const identity = `${tool.name}@${tool.version}`;
    if (tools.has(identity)) throw new TypeError(`Duplicate scaffold tool ${identity}`);
    tools.add(identity);
  }
}

export function resolveExecutionMode(request: ModelAttemptRequest): ModelExecutionMode {
  const mode = request.executionMode ?? request.profile.defaultExecutionMode;
  const capabilities = request.profile.capabilities;
  if (!capabilities[mode]) throw new TypeError(`Selected adapter does not support ${mode} execution`);
  return mode;
}

export function validateAttemptRequest(request: ModelAttemptRequest, capabilities: ProviderCapabilities): void {
  validateProfile(request.profile);
  validateScaffold(request.scaffold);
  if (!request.runId || !request.attemptId || !request.providerIdempotencyKey) {
    throw new TypeError('Run, attempt, and provider idempotency identities are required');
  }
  parseModelRequestBinding(request.requestBinding);
  parseModelProviderIdempotencyKey(request.providerIdempotencyKey);
  if (request.providerIdempotencyKey !== modelProviderIdempotencyKeyFor(request.requestBinding)) {
    throw new TypeError('model_provider_idempotency_key_mismatch');
  }
  if (request.profile.adapter.key === '') throw new TypeError('Adapter key is required');
  for (const key of Object.keys(capabilities) as (keyof ProviderCapabilities)[]) {
    if (request.profile.capabilities[key] && !capabilities[key]) {
      throw new TypeError(`Profile requires unsupported capability: ${key}`);
    }
  }
  const allowedTools = new Set(request.scaffold.allowedTools.map((tool) => `${tool.name}@${tool.version}`));
  for (const tool of request.tools) {
    if (!allowedTools.has(`${tool.operation.name}@${tool.operation.version}`)) {
      throw new TypeError(`Tool is not allowed by the scaffold: ${tool.operation.name}@${tool.operation.version}`);
    }
  }
  if (request.tools.length > 0 && !capabilities.tools) throw new TypeError('Selected adapter does not support tools');
  if (request.profile.controls.requireStructuredOutput && !capabilities.structuredOutput) {
    throw new TypeError('Selected adapter does not support structured output');
  }
  if (request.profile.controls.requireStructuredOutput && !request.outputJsonSchema) {
    throw new TypeError('Structured output requires an exact JSON schema');
  }
  if (!request.profile.controls.requireStructuredOutput && request.outputJsonSchema) {
    throw new TypeError('Output JSON schema is undeclared by the profile controls');
  }
  if (request.outputJsonSchema) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.outputJsonSchema.name)) {
      throw new TypeError('Output schema name is not provider-safe');
    }
    assertJsonObject(request.outputJsonSchema.schema, 'request.outputJsonSchema.schema');
  }
  resolveExecutionMode(request);
}

function assertJsonObject(value: Readonly<Record<string, unknown>> | undefined, label: string): void {
  if (value === undefined) return;
  const seen = new Set<object>();
  const visit = (entry: unknown, path: string): void => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new TypeError(`${path} is not JSON-safe`);
      return;
    }
    if (Array.isArray(entry)) {
      if (seen.has(entry)) throw new TypeError(`${path} is circular`);
      seen.add(entry);
      entry.forEach((child, index) => visit(child, `${path}[${index}]`));
      seen.delete(entry);
      return;
    }
    if (typeof entry === 'object' && Object.getPrototypeOf(entry) === Object.prototype) {
      if (seen.has(entry)) throw new TypeError(`${path} is circular`);
      seen.add(entry);
      for (const [key, child] of Object.entries(entry)) {
        if (child === undefined) throw new TypeError(`${path}.${key} is not JSON-safe`);
        visit(child, `${path}.${key}`);
      }
      seen.delete(entry);
      return;
    }
    throw new TypeError(`${path} is not JSON-safe`);
  };
  visit(value, label);
}
