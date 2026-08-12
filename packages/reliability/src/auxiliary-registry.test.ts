import { describe, expect, test } from 'bun:test';
import { parseContractVersion } from '@jooevents/kernel';
import {
  RELIABILITY_AUXILIARY_KINDS,
  ReliabilityAuxiliaryExecutionError,
  ReliabilityAuxiliaryRegistryError,
  buildReliabilityAuxiliaryRegistry,
  executeReliabilityAuxiliary,
  reliabilityCapabilityRef,
  resolveReliabilityAuxiliaryDefinition,
  sealReliabilityAuxiliaryDefinition,
  type ReliabilityAuxiliaryDefinition,
  type ReliabilityAuxiliaryImplementation,
  type ReliabilityAuxiliaryKind,
  type ReliabilityAuxiliaryMode,
  type ReliabilityReadCapabilityView,
  type ReliabilityRuntimeCapability,
  type ReliabilitySchemaRegistration,
  type ReliabilityTransactionCapabilityView
} from './auxiliary-registry';
import {
  definitionRef,
  parseCanonicalSha256,
  parseDefinitionKey,
  schemaRef,
  type DefinitionRef,
  type ReliabilityDefinition
} from './definitions';
import { buildReliabilityRegistry, type ReliabilityRegistry } from './registry';
import { completeCatalog } from './test-fixtures';

const INPUT_SCHEMA_DIGEST = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const OUTPUT_SCHEMA_DIGEST = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const IMPLEMENTATION_DIGEST = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const CAPABILITY_DIGEST = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

const inputSchema = schemaRef('schema.reliability.auxiliary.input', 1, INPUT_SCHEMA_DIGEST);
const outputSchema = schemaRef('schema.reliability.auxiliary.output', 1, OUTPUT_SCHEMA_DIGEST);

function citedRefs(definition: ReliabilityDefinition): readonly DefinitionRef[] {
  switch (definition.kind) {
    case 'domain_fact':
      return [
        definition.subjectIdentity,
        definition.scope,
        definition.causalParent,
        definition.consumerCompatibility,
        definition.redaction
      ];
    case 'effect':
      return [definition.reducer, definition.authorityCitation, definition.retry, definition.cancellation];
    case 'consumer':
      return [
        definition.inputProjection,
        definition.authorityCitation,
        definition.backoff,
        definition.replay,
        definition.removal
      ];
    case 'job':
      return [
        definition.source,
        definition.scopeCausation,
        definition.inputProjection,
        definition.authorityCitation,
        definition.backoff,
        definition.cancellation
      ];
    case 'activity_projection':
      return [
        definition.viewerAuthorization,
        definition.redaction,
        definition.destination,
        definition.projector
      ];
  }
}

function modeFor(kind: ReliabilityAuxiliaryKind): ReliabilityAuxiliaryMode {
  if (kind === 'reducer') return 'transaction_reducer';
  if (kind === 'viewer_authorization') return 'read_only';
  return 'pure_total';
}

async function auxiliaryDefinitions(
  reliability: ReliabilityRegistry
): Promise<readonly ReliabilityAuxiliaryDefinition[]> {
  const refs = new Map<string, DefinitionRef<ReliabilityAuxiliaryKind>>();
  for (const definition of reliability.definitions) {
    for (const ref of citedRefs(definition)) {
      if (!RELIABILITY_AUXILIARY_KINDS.includes(ref.kind as ReliabilityAuxiliaryKind)) continue;
      refs.set(`${ref.kind}:${ref.key}@${ref.version}`, ref as DefinitionRef<ReliabilityAuxiliaryKind>);
    }
  }
  return Promise.all([...refs.values()].map((ref) => {
    const mode = modeFor(ref.kind);
    const capabilities = mode === 'read_only'
      ? [reliabilityCapabilityRef('read_capability', `read.${ref.key}`, 1, CAPABILITY_DIGEST)]
      : mode === 'transaction_reducer'
        ? [reliabilityCapabilityRef('transaction_capability', `transaction.${ref.key}`, 1, CAPABILITY_DIGEST)]
        : [];
    return sealReliabilityAuxiliaryDefinition({
      kind: ref.kind,
      key: ref.key,
      version: ref.version,
      mode,
      inputSchema,
      outputSchema,
      implementation: definitionRef(
        'reliability_implementation',
        `implementation.${ref.kind}.${ref.key}`,
        ref.version
      ),
      implementationDigestSha256: parseCanonicalSha256(IMPLEMENTATION_DIGEST),
      capabilities
    });
  }));
}

function schemaRegistrations(): readonly ReliabilitySchemaRegistration[] {
  const parser = (value: unknown) => {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && typeof (value as { readonly value?: unknown }).value === 'string'
    ) {
      return { success: true as const, data: { value: (value as { readonly value: string }).value } };
    }
    return { success: false as const };
  };
  return [
    { reference: inputSchema, safeParse: parser },
    { reference: outputSchema, safeParse: parser }
  ];
}

function implementations(
  definitions: readonly ReliabilityAuxiliaryDefinition[],
  overrides: ReadonlyMap<string, (input: unknown) => unknown> = new Map()
): readonly ReliabilityAuxiliaryImplementation[] {
  return definitions.map((definition) => {
    const identity = `${definition.kind}:${definition.key}@${definition.version}`;
    const override = overrides.get(identity);
    if (definition.mode === 'pure_total') {
      return {
        reference: definition.implementation,
        canonicalImplementationDigestSha256: definition.implementationDigestSha256,
        mode: 'pure_total' as const,
        execute: override ?? ((value: unknown) => value)
      };
    }
    if (definition.mode === 'read_only') {
      return {
        reference: definition.implementation,
        canonicalImplementationDigestSha256: definition.implementationDigestSha256,
        mode: 'read_only' as const,
        execute: (value: unknown, capabilities: ReliabilityReadCapabilityView) => {
          capabilities.get(definition.capabilities[0] as never);
          return override ? override(value) : value;
        }
      };
    }
    return {
      reference: definition.implementation,
      canonicalImplementationDigestSha256: definition.implementationDigestSha256,
      mode: 'transaction_reducer' as const,
      execute: (value: unknown, capabilities: ReliabilityTransactionCapabilityView) => {
        capabilities.get(definition.capabilities[0] as never);
        return override ? override(value) : value;
      }
    };
  });
}

async function fixture() {
  const reliability = await buildReliabilityRegistry(await completeCatalog());
  const definitions = await auxiliaryDefinitions(reliability);
  const schemas = schemaRegistrations();
  const registeredImplementations = implementations(definitions);
  return { reliability, definitions, schemas, registeredImplementations };
}

describe('reliability auxiliary registry', () => {
  test('closes every cited auxiliary reference with deterministic retained metadata', async () => {
    const input = await fixture();
    const forward = await buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions: input.definitions,
      schemas: input.schemas,
      implementations: input.registeredImplementations
    });
    const reverse = await buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions: [...input.definitions].reverse(),
      schemas: [...input.schemas].reverse(),
      implementations: [...input.registeredImplementations].reverse()
    });

    expect(forward.catalogDigestSha256).toBe(reverse.catalogDigestSha256);
    expect(forward.reliabilityCatalogDigestSha256).toBe(input.reliability.catalogDigestSha256);
    expect(forward.definitions.length).toBe(input.definitions.length);
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.definitions)).toBe(true);
    const inputProjection = definitionRef('input_projection', 'message.job.input', 1);
    expect(resolveReliabilityAuxiliaryDefinition(forward, inputProjection)?.mode).toBe('pure_total');
  });

  test('validates schemas and executes pure transforms without any capability channel', async () => {
    const input = await fixture();
    const registry = await buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions: input.definitions,
      schemas: input.schemas,
      implementations: input.registeredImplementations
    });
    const ref = definitionRef('input_projection', 'message.job.input', 1);
    const result = await executeReliabilityAuxiliary(registry, ref, { value: 'canonical' });

    expect(result).toEqual({ value: 'canonical' });
    expect(Object.isFrozen(result)).toBe(true);
    await expect(executeReliabilityAuxiliary(registry, ref, { wrong: true })).rejects.toMatchObject({
      code: 'invalid_input'
    });
    await expect(executeReliabilityAuxiliary(registry, ref, { value: 'x' }, [{
      reference: reliabilityCapabilityRef('read_capability', 'read.forbidden', 1, CAPABILITY_DIGEST),
      value: Object.freeze({})
    }])).rejects.toMatchObject({ code: 'capability_mismatch' });
  });

  test('lends read and transaction implementations only their exact declared ports', async () => {
    const input = await fixture();
    const registry = await buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions: input.definitions,
      schemas: input.schemas,
      implementations: input.registeredImplementations
    });
    for (const kind of ['viewer_authorization', 'reducer'] as const) {
      const definition = input.definitions.find((candidate) => candidate.kind === kind);
      expect(definition).toBeDefined();
      const capability = definition?.capabilities[0];
      expect(capability).toBeDefined();
      const runtime: ReliabilityRuntimeCapability = {
        reference: capability as NonNullable<typeof capability>,
        value: Object.freeze({ marker: kind })
      };
      const result = await executeReliabilityAuxiliary(
        registry,
        definitionRef(kind, definition?.key as string, definition?.version as number),
        { value: kind },
        [runtime]
      );
      expect(result).toEqual({ value: kind });

      await expect(executeReliabilityAuxiliary(
        registry,
        definitionRef(kind, definition?.key as string, definition?.version as number),
        { value: kind },
        [{ ...runtime, reference: { ...runtime.reference, canonicalContractDigestSha256: parseCanonicalSha256(IMPLEMENTATION_DIGEST) } }]
      )).rejects.toMatchObject({ code: 'capability_mismatch' });
    }
  });

  test('rejects missing, orphaned, and digest-mutated auxiliary definitions', async () => {
    const input = await fixture();
    await expect(buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions: input.definitions.slice(1),
      schemas: input.schemas,
      implementations: input.registeredImplementations.slice(1)
    })).rejects.toMatchObject({ code: 'unknown_reference' });

    const cited = input.definitions[0] as ReliabilityAuxiliaryDefinition;
    const { canonicalDigestSha256: _citedDigest, ...citedDraft } = cited;
    const orphan = await sealReliabilityAuxiliaryDefinition({
      ...citedDraft,
      kind: 'input_projection',
      key: parseDefinitionKey('orphan.projection'),
      version: parseContractVersion(1),
      implementation: definitionRef('reliability_implementation', 'implementation.orphan.projection', 1),
      capabilities: [],
      mode: 'pure_total'
    });
    await expect(buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions: [...input.definitions, orphan],
      schemas: input.schemas,
      implementations: [...input.registeredImplementations, implementations([orphan])[0] as ReliabilityAuxiliaryImplementation]
    })).rejects.toMatchObject({ code: 'orphan_definition' });

    const mutated = { ...cited, implementationDigestSha256: parseCanonicalSha256(CAPABILITY_DIGEST) };
    await expect(buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions: [mutated, ...input.definitions.slice(1)],
      schemas: input.schemas,
      implementations: input.registeredImplementations
    })).rejects.toMatchObject({ code: 'digest_mismatch' });
  });

  test('rejects a definition whose execution mode or port kind crosses its family boundary', async () => {
    const input = await fixture();
    const redaction = input.definitions.find((definition) => definition.kind === 'redaction') as ReliabilityAuxiliaryDefinition;
    const { canonicalDigestSha256: _redactionDigest, ...redactionDraft } = redaction;
    await expect(sealReliabilityAuxiliaryDefinition({
      ...redactionDraft,
      mode: 'transaction_reducer',
      capabilities: [reliabilityCapabilityRef(
        'transaction_capability',
        'transaction.redaction.forbidden',
        1,
        CAPABILITY_DIGEST
      )]
    })).rejects.toMatchObject({ code: 'invalid_definition' });

    const viewer = input.definitions.find(
      (definition) => definition.kind === 'viewer_authorization'
    ) as ReliabilityAuxiliaryDefinition;
    const { canonicalDigestSha256: _viewerDigest, ...viewerDraft } = viewer;
    await expect(sealReliabilityAuxiliaryDefinition({
      ...viewerDraft,
      capabilities: [reliabilityCapabilityRef(
        'transaction_capability',
        'transaction.viewer.forbidden',
        1,
        CAPABILITY_DIGEST
      )]
    })).rejects.toMatchObject({ code: 'invalid_definition' });
  });

  test('rejects schema and implementation substitution at composition', async () => {
    const input = await fixture();
    await expect(buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions: input.definitions,
      schemas: input.schemas.slice(0, 1),
      implementations: input.registeredImplementations
    })).rejects.toMatchObject({ code: 'missing_schema' });

    const [first, ...remaining] = input.registeredImplementations;
    expect(first).toBeDefined();
    await expect(buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions: input.definitions,
      schemas: input.schemas,
      implementations: [{
        ...first as ReliabilityAuxiliaryImplementation,
        canonicalImplementationDigestSha256: parseCanonicalSha256(CAPABILITY_DIGEST)
      }, ...remaining]
    })).rejects.toMatchObject({ code: 'implementation_mismatch' });
  });

  test('permits an exact retained implementation to serve compatible definition owners', async () => {
    const input = await fixture();
    const pureOwners = input.definitions.filter((definition) => definition.mode === 'pure_total');
    const first = pureOwners[0] as ReliabilityAuxiliaryDefinition;
    const second = pureOwners[1] as ReliabilityAuxiliaryDefinition;
    const { canonicalDigestSha256: _secondDigest, ...secondDraft } = second;
    const sharedSecond = await sealReliabilityAuxiliaryDefinition({
      ...secondDraft,
      implementation: first.implementation,
      implementationDigestSha256: first.implementationDigestSha256
    });
    const definitions = input.definitions.map((definition) => (
      definition.kind === second.kind && definition.key === second.key && definition.version === second.version
        ? sharedSecond
        : definition
    ));
    const byImplementation = new Map<string, ReliabilityAuxiliaryImplementation>();
    for (const registration of implementations(definitions)) {
      const identity = `${registration.reference.key}@${registration.reference.version}`;
      if (!byImplementation.has(identity)) byImplementation.set(identity, registration);
    }
    const registry = await buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions,
      schemas: input.schemas,
      implementations: [...byImplementation.values()]
    });

    expect(registry.definitions).toHaveLength(input.definitions.length);
    expect(resolveReliabilityAuxiliaryDefinition(
      registry,
      definitionRef(second.kind, second.key, second.version)
    )?.implementation).toEqual(first.implementation);
  });

  test('detaches callable registrations even when their methods live on prototypes', async () => {
    const input = await fixture();
    const target = input.definitions.find(
      (definition) => definition.kind === 'input_projection'
    ) as ReliabilityAuxiliaryDefinition;
    class PrototypeSchema implements ReliabilitySchemaRegistration {
      constructor(
        readonly reference: ReliabilitySchemaRegistration['reference'],
        private readonly delegate: ReliabilitySchemaRegistration
      ) {}
      safeParse(value: unknown) { return this.delegate.safeParse(value); }
    }
    class PrototypePureImplementation {
      readonly reference = target.implementation;
      readonly canonicalImplementationDigestSha256 = target.implementationDigestSha256;
      readonly mode = 'pure_total' as const;
      execute(value: unknown) { return value; }
    }
    const registeredImplementations = input.registeredImplementations.map((registration) => (
      registration.reference.key === target.implementation.key
        && registration.reference.version === target.implementation.version
        ? new PrototypePureImplementation()
        : registration
    ));
    const registry = await buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions: input.definitions,
      schemas: input.schemas.map((schema) => new PrototypeSchema(schema.reference, schema)),
      implementations: registeredImplementations
    });

    expect(await executeReliabilityAuxiliary(
      registry,
      definitionRef(target.kind, target.key, target.version),
      { value: 'prototype' }
    )).toEqual({ value: 'prototype' });
  });

  test('fails a pure implementation that returns a promise or an invalid output', async () => {
    const input = await fixture();
    const target = input.definitions.find((definition) => definition.kind === 'input_projection');
    expect(target).toBeDefined();
    const identity = `${target?.kind}:${target?.key}@${target?.version}`;

    const asyncRegistry = await buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions: input.definitions,
      schemas: input.schemas,
      implementations: implementations(input.definitions, new Map([[identity, async (value: unknown) => value]]))
    });
    await expect(executeReliabilityAuxiliary(
      asyncRegistry,
      definitionRef('input_projection', target?.key as string, target?.version as number),
      { value: 'x' }
    )).rejects.toBeInstanceOf(ReliabilityAuxiliaryExecutionError);
    await expect(executeReliabilityAuxiliary(
      asyncRegistry,
      definitionRef('input_projection', target?.key as string, target?.version as number),
      { value: 'x' }
    )).rejects.toMatchObject({ code: 'async_pure_implementation' });

    const invalidRegistry = await buildReliabilityAuxiliaryRegistry({
      reliability: input.reliability,
      definitions: input.definitions,
      schemas: input.schemas,
      implementations: implementations(input.definitions, new Map([[identity, () => ({ wrong: true })]]))
    });
    await expect(executeReliabilityAuxiliary(
      invalidRegistry,
      definitionRef('input_projection', target?.key as string, target?.version as number),
      { value: 'x' }
    )).rejects.toMatchObject({ code: 'invalid_output' });
  });
});
