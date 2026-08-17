import { OperationInputError } from '@jooevents/application';
import { canonicalJsonText } from '@jooevents/kernel';

interface RegisteredQueryInputSchema {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false };
}

/** Decodes a bounded query against the operation registry's captured schema. */
export interface SchemaAwareQueryInputDecoder {
  decode(search: URLSearchParams): Readonly<Record<string, unknown>>;
}

const MAX_QUERY_KEYS = 64;
const MAX_QUERY_VALUES = 256;
const MAX_QUERY_VALUE_BYTES = 16_384;
const MAX_QUERY_BYTES = 64 * 1024;
const MAX_CANDIDATES = 32_768;
const encoder = new TextEncoder();

function inputError(): OperationInputError {
  return new OperationInputError();
}

function canonicalNumber(text: string): number | undefined {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) && JSON.stringify(value) === text ? value : undefined;
}

function candidateKey(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(['string', value]);
  if (typeof value === 'number') return JSON.stringify(['number', value]);
  if (typeof value === 'boolean') return JSON.stringify(['boolean', value]);
  if (Array.isArray(value)) return JSON.stringify(['array', value.map(candidateKey)]);
  throw new TypeError('Query candidate is not a supported scalar or scalar array.');
}

function deduplicate(values: readonly unknown[]): readonly unknown[] {
  const unique = new Map<string, unknown>();
  for (const value of values) unique.set(candidateKey(value), value);
  return [...unique.values()];
}

function scalarCandidates(text: string): readonly unknown[] {
  const candidates: unknown[] = [text];
  const number = canonicalNumber(text);
  if (number !== undefined) candidates.push(number);
  if (text === 'true') candidates.push(true);
  if (text === 'false') candidates.push(false);
  if (text === 'null') candidates.push(null);
  return candidates;
}

function arrayCandidates(values: readonly string[]): readonly unknown[] {
  let candidates: readonly (readonly unknown[])[] = [[]];
  for (const value of values) {
    const items = scalarCandidates(value);
    if (candidates.length * items.length > MAX_CANDIDATES) throw inputError();
    candidates = candidates.flatMap((candidate) =>
      items.map((item) => [...candidate, item])
    );
  }
  return deduplicate(candidates);
}

function valueCandidates(values: readonly string[]): readonly unknown[] {
  return values.length === 1
    ? deduplicate([
        ...scalarCandidates(values[0] as string),
        ...arrayCandidates(values)
      ])
    : arrayCandidates(values);
}

function extendCandidate(
  candidate: Readonly<Record<string, unknown>>,
  key: string,
  value: unknown
): Readonly<Record<string, unknown>> {
  const extended = Object.create(null) as Record<string, unknown>;
  for (const [existingKey, existingValue] of Object.entries(candidate)) {
    extended[existingKey] = existingValue;
  }
  extended[key] = value;
  return extended;
}

function rawQuery(search: URLSearchParams): ReadonlyMap<string, readonly string[]> {
  const valuesByKey = new Map<string, string[]>();
  let valueCount = 0;
  let byteCount = 0;

  for (const [key, value] of search.entries()) {
    valueCount += 1;
    if (valueCount > MAX_QUERY_VALUES) throw inputError();

    const keyBytes = encoder.encode(key).byteLength;
    const valueBytes = encoder.encode(value).byteLength;
    if (valueBytes > MAX_QUERY_VALUE_BYTES) throw inputError();
    byteCount += keyBytes + valueBytes;
    if (byteCount > MAX_QUERY_BYTES) throw inputError();

    const values = valuesByKey.get(key);
    if (values) {
      values.push(value);
    } else {
      if (valuesByKey.size >= MAX_QUERY_KEYS) throw inputError();
      valuesByKey.set(key, [value]);
    }
  }
  return valuesByKey;
}

export function createSchemaAwareQueryInputDecoder(
  schema: RegisteredQueryInputSchema
): SchemaAwareQueryInputDecoder {
  if (!schema || typeof schema.safeParse !== 'function') {
    throw new TypeError('Registered read input has no captured parser.');
  }

  return Object.freeze({
    decode(search: URLSearchParams): Readonly<Record<string, unknown>> {
      const raw = rawQuery(search);
      let candidates: readonly Readonly<Record<string, unknown>>[] = [
        Object.create(null) as Record<string, unknown>
      ];

      for (const key of [...raw.keys()].sort()) {
        const interpretations = valueCandidates(raw.get(key) as readonly string[]);
        if (candidates.length * interpretations.length > MAX_CANDIDATES) throw inputError();
        candidates = candidates.flatMap((candidate) =>
          interpretations.map((interpretation) =>
            extendCandidate(candidate, key, interpretation)
          )
        );
      }

      const valid = new Map<string, Readonly<Record<string, unknown>>>();
      for (const candidate of candidates) {
        const parsed = schema.safeParse(candidate);
        if (!parsed.success) continue;
        let key: string;
        try {
          key = canonicalJsonText(parsed.data);
        } catch (error) {
          throw new TypeError('Registered read input produced non-canonical parsed data.', {
            cause: error
          });
        }
        if (!valid.has(key)) valid.set(key, candidate);
        if (valid.size > 1) throw inputError();
      }

      if (valid.size !== 1) throw inputError();
      return valid.values().next().value as Readonly<Record<string, unknown>>;
    }
  });
}
