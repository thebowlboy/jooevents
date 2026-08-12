import type { Brand } from '@jooevents/kernel';

export type ModelRequestBinding = Brand<string, 'ModelRequestBinding'>;
export type ModelToolInputBinding = Brand<string, 'ModelToolInputBinding'>;
export type ModelProviderIdempotencyKey = Brand<string, 'ModelProviderIdempotencyKey'>;

const requestBindingPattern = /^mrb1_[a-f0-9]{64}$/;
const toolInputBindingPattern = /^mtb1_[a-f0-9]{64}$/;
const providerIdempotencyKeyPattern = /^mpw1_[a-f0-9]{64}$/;

export function parseModelRequestBinding(value: unknown): ModelRequestBinding {
  if (typeof value !== 'string' || !requestBindingPattern.test(value)) {
    throw new TypeError('model request binding must use mrb1_ plus 64 lowercase hexadecimal HMAC characters');
  }
  return value as ModelRequestBinding;
}

export function parseModelToolInputBinding(value: unknown): ModelToolInputBinding {
  if (typeof value !== 'string' || !toolInputBindingPattern.test(value)) {
    throw new TypeError('model tool input binding must use mtb1_ plus 64 lowercase hexadecimal HMAC characters');
  }
  return value as ModelToolInputBinding;
}

export function parseModelProviderIdempotencyKey(value: unknown): ModelProviderIdempotencyKey {
  if (typeof value !== 'string' || !providerIdempotencyKeyPattern.test(value)) {
    throw new TypeError('model provider idempotency key must use mpw1_ plus 64 lowercase hexadecimal HMAC characters');
  }
  return value as ModelProviderIdempotencyKey;
}

export function modelProviderIdempotencyKeyFor(binding: ModelRequestBinding): ModelProviderIdempotencyKey {
  const verified = parseModelRequestBinding(binding);
  return parseModelProviderIdempotencyKey(`mpw1_${verified.slice(5)}`);
}
