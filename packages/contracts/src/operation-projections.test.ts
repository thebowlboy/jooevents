import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { encodeCanonicalJson } from '@jooevents/kernel';
import { z } from 'zod';
import {
  changesetRevisionSelectorSchema,
  committedChangesetDataSchema,
  intakeFormDraftDataSchema,
  createSafeSchemaManifestRef,
  rebuildChangesetInputSchema
} from './index';

const id = () => crypto.randomUUID();
const digest = 'a'.repeat(64);

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

  test('keeps changeset selectors scope-free, strict, and canonical', () => {
    const selector = {
      changesetId: id(),
      revisionId: id(),
      revisionDigest: digest
    };

    expect(changesetRevisionSelectorSchema.safeParse(selector).success).toBe(true);
    expect(changesetRevisionSelectorSchema.safeParse({
      ...selector,
      workspaceId: id()
    }).success).toBe(false);
    expect(changesetRevisionSelectorSchema.safeParse({
      ...selector,
      changesetId: selector.changesetId.toUpperCase()
    }).success).toBe(false);
  });

  test('requires rebuild groups to be canonical and commits to advance once', () => {
    const rebuild = {
      changesetId: id(),
      expectedHeadVersion: 2,
      sourceRevisionId: id(),
      sourceRevisionDigest: digest,
      groups: ['content', 'lifecycle']
    };
    expect(rebuildChangesetInputSchema.safeParse(rebuild).success).toBe(true);
    expect(rebuildChangesetInputSchema.safeParse({
      ...rebuild,
      groups: ['lifecycle', 'content']
    }).success).toBe(false);
    expect(rebuildChangesetInputSchema.safeParse({
      ...rebuild,
      groups: ['content', 'content']
    }).success).toBe(false);

    const committed = {
      schemaVersion: 1,
      action: 'commit',
      changesetId: id(),
      expectedHeadVersion: 2,
      committedHeadVersion: 3,
      revisionId: id(),
      revisionDigest: digest
    };
    expect(committedChangesetDataSchema.safeParse(committed).success).toBe(true);
    expect(committedChangesetDataSchema.safeParse({
      ...committed,
      committedHeadVersion: 4
    }).success).toBe(false);
  });

  test('binds a Form draft action to its deterministic safe diff', () => {
    const head = {
      id: id(),
      version: 1,
      status: 'draft',
      currentPublishedVersionId: null,
      definition: {
        kind: 'cfp',
        name: 'Call for proposals',
        target: { kind: 'general_pool' },
        availability: { kind: 'evergreen' },
        confirmation: 'Thank you.',
        composition: { excludedFieldIds: [], requiredOverrides: {}, optionExposure: {} },
        rules: []
      }
    };
    const draft = {
      schemaVersion: 1,
      action: 'create',
      changesetId: id(),
      headVersion: 1,
      status: 'draft',
      revision: { id: id(), number: 1, digestSha256: digest },
      riskTier: 'normal',
      approvalPolicy: {
        reference: { key: 'intake.form.default', version: 1 },
        definitionDigestSha256: digest,
        requirement: 'none'
      },
      safeDiff: { action: 'create', before: null, after: head }
    };

    expect(intakeFormDraftDataSchema.safeParse(draft).success).toBe(true);
    expect(intakeFormDraftDataSchema.safeParse({
      ...draft,
      action: 'revise'
    }).success).toBe(false);
    expect(intakeFormDraftDataSchema.safeParse({
      ...draft,
      actorUserId: id()
    }).success).toBe(false);
  });
});
