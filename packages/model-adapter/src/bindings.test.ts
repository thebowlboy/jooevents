import { describe, expect, test } from 'bun:test';
import {
  modelProviderIdempotencyKeyFor,
  parseModelProviderIdempotencyKey,
  parseModelRequestBinding,
  parseModelToolInputBinding,
  type ModelRequestBinding,
  type ModelProviderIdempotencyKey,
  type ModelToolInputBinding
} from '.';

describe('opaque model bindings', () => {
  test('request and tool bindings require distinct framed HMAC forms', () => {
    const request = parseModelRequestBinding(`mrb1_${'a'.repeat(64)}`);
    const tool = parseModelToolInputBinding(`mtb1_${'b'.repeat(64)}`);
    expect(request).toStartWith('mrb1_');
    expect(tool).toStartWith('mtb1_');
    expect(() => parseModelRequestBinding('a'.repeat(64))).toThrow('mrb1_');
    expect(() => parseModelToolInputBinding('b'.repeat(64))).toThrow('mtb1_');
    expect(() => parseModelRequestBinding(`mtb1_${'b'.repeat(64)}`)).toThrow('mrb1_');
    expect(() => parseModelToolInputBinding(`mrb1_${'a'.repeat(64)}`)).toThrow('mtb1_');
    expect(() => parseModelRequestBinding(`mrb1_${'A'.repeat(64)}`)).toThrow('lowercase');
    const providerWork = modelProviderIdempotencyKeyFor(request);
    expect(providerWork as string).toBe(`mpw1_${'a'.repeat(64)}`);
    expect(parseModelProviderIdempotencyKey(providerWork)).toBe(providerWork);
    expect(() => parseModelProviderIdempotencyKey(request)).toThrow('mpw1_');
  });

  test('plain strings and opposite binding kinds are not assignable', () => {
    const request = parseModelRequestBinding(`mrb1_${'c'.repeat(64)}`);
    const tool = parseModelToolInputBinding(`mtb1_${'d'.repeat(64)}`);
    const providerWork = modelProviderIdempotencyKeyFor(request);
    // @ts-expect-error A bare digest cannot become durable model request identity.
    const plainRequest: ModelRequestBinding = 'c'.repeat(64);
    // @ts-expect-error A bare digest cannot become durable model tool-input identity.
    const plainTool: ModelToolInputBinding = 'd'.repeat(64);
    // @ts-expect-error Request and tool-input binding domains are not substitutable.
    const crossedRequest: ModelRequestBinding = tool;
    // @ts-expect-error Request and tool-input binding domains are not substitutable.
    const crossedTool: ModelToolInputBinding = request;
    // @ts-expect-error Provider-work keys cannot substitute for request bindings.
    const providerAsRequest: ModelRequestBinding = providerWork;
    // @ts-expect-error Request bindings cannot substitute for provider-work keys.
    const requestAsProvider: ModelProviderIdempotencyKey = request;
    expect([plainRequest, plainTool, crossedRequest, crossedTool, providerAsRequest, requestAsProvider]).toHaveLength(6);
  });
});
