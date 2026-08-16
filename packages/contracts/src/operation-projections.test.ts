import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { encodeCanonicalJson } from '@jooevents/kernel';
import { z } from 'zod';
import {
  createSafeSchemaManifestRef
} from './index';

describe('browser-safe operation projections', () => {
  test('derives schema refs from canonical Zod JSON with the registry digest profile', () => {
    const schema = z.strictObject({ value: z.string().trim().min(1), count: z.number().int() });
    const jsonSchema = JSON.parse(JSON.stringify(
      z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' })
    ));
    const expectedDigest = createHash('sha256')
      .update(encodeCanonicalJson(jsonSchema))
      .digest('hex');

    expect(createSafeSchemaManifestRef('schema.example.input', schema)).toEqual({
      key: 'schema.example.input',
      version: 1,
      digestSha256: expectedDigest
    });
  });

});
