import { describe, expect, test } from 'bun:test';
import { OperationInputError } from '@jooevents/application';
import { z } from 'zod';
import { createSchemaAwareQueryInputDecoder } from './schema-aware-query-input';

function decode(schema: z.ZodType, query: string): Readonly<Record<string, unknown>> {
  return createSchemaAwareQueryInputDecoder(schema).decode(new URLSearchParams(query));
}

function expectInvalid(run: () => unknown): void {
  expect(run).toThrow(OperationInputError);
}

describe('schema-aware GET query input decoder', () => {
  test('selects canonical numeric, boolean, and null scalars without changing strings', () => {
    const schema = z.strictObject({
      integer: z.number().int(),
      number: z.number(),
      enabled: z.boolean(),
      cleared: z.null(),
      numericText: z.string(),
      booleanText: z.string(),
      nullText: z.string()
    });

    expect(decode(schema,
      'integer=12&number=1.5&enabled=false&cleared=null&numericText=12&booleanText=false&nullText=null'
    )).toEqual({
      integer: 12,
      number: 1.5,
      enabled: false,
      cleared: null,
      numericText: '12',
      booleanText: 'false',
      nullText: 'null'
    });
  });

  test('preserves one-element and repeated scalar arrays', () => {
    const schema = z.strictObject({
      one: z.array(z.string()).length(1),
      strings: z.array(z.string()).length(2),
      integers: z.array(z.number().int()).length(2),
      flags: z.array(z.boolean()).length(2),
      nulls: z.array(z.null()).length(1)
    });

    expect(decode(schema,
      'one=solo&strings=first&strings=second&integers=1&integers=2&flags=true&flags=false&nulls=null'
    )).toEqual({
      one: ['solo'],
      strings: ['first', 'second'],
      integers: [1, 2],
      flags: [true, false],
      nulls: [null]
    });
  });

  test('refuses duplicate scalar values and noncanonical scalar spellings', () => {
    const schema = z.strictObject({
      integer: z.number().int(),
      enabled: z.boolean(),
      cleared: z.null()
    });

    expectInvalid(() => decode(schema, 'integer=1&integer=2&enabled=true&cleared=null'));
    for (const query of [
      'integer=01&enabled=true&cleared=null',
      'integer=+1&enabled=true&cleared=null',
      'integer=1.0&enabled=true&cleared=null',
      'integer=1&enabled=True&cleared=null',
      'integer=1&enabled=true&cleared=NULL'
    ]) expectInvalid(() => decode(schema, query));
  });

  test('fails closed when distinct raw candidates produce distinct valid parsed results', () => {
    const scalarUnion = z.strictObject({ value: z.union([z.literal('1'), z.literal(1)]) });
    const arrayUnion = z.strictObject({ values: z.array(z.union([z.literal('1'), z.literal(1)])) });

    expectInvalid(() => decode(scalarUnion, 'value=1'));
    expectInvalid(() => decode(arrayUnion, 'values=1'));
  });

  test('deduplicates candidates only when their parsed semantic result is identical', () => {
    const schema = z.strictObject({
      limit: z.union([
        z.literal('1').transform(() => 1),
        z.literal(1)
      ])
    });

    // The raw string candidate is retained, leaving the executor to perform the
    // authoritative parse/transform once more.
    expect(decode(schema, 'limit=1')).toEqual({ limit: '1' });
  });

  test('rejects unknown keys and bounded-query overflows before application execution', () => {
    const schema = z.strictObject({ value: z.string().optional() });
    expectInvalid(() => decode(schema, 'unknown=value'));

    const tooManyKeys = new URLSearchParams();
    for (let index = 0; index < 65; index += 1) tooManyKeys.append(`k${index}`, 'v');
    expectInvalid(() => createSchemaAwareQueryInputDecoder(z.record(z.string(), z.string()))
      .decode(tooManyKeys));

    const tooManyValues = new URLSearchParams();
    for (let index = 0; index < 257; index += 1) tooManyValues.append('value', 'v');
    expectInvalid(() => createSchemaAwareQueryInputDecoder(z.strictObject({ value: z.array(z.string()) }))
      .decode(tooManyValues));

    expectInvalid(() => decode(schema, `value=${'x'.repeat(16_385)}`));

    const ambiguousFields = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `value${index}`,
        z.union([z.string(), z.number(), z.array(z.string()), z.array(z.number())])
      ])
    ) as Record<string, z.ZodType>;
    const expansion = new URLSearchParams(
      Array.from({ length: 8 }, (_, index) => [`value${index}`, '1'])
    );
    expectInvalid(() => createSchemaAwareQueryInputDecoder(z.strictObject(ambiguousFields))
      .decode(expansion));
  });
});
