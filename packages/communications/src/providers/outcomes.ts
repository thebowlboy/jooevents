import {
  computeSafeEvidenceDigestSha256,
  registeredSafeEvidenceCodeSchema,
  registeredSafeEvidenceEnumValueSchema,
  registeredSafeEvidenceFactKeySchema,
  safeEvidenceSchema,
  type RegisteredSafeEvidenceCode,
  type RegisteredSafeEvidenceEnumValue,
  type RegisteredSafeEvidenceFact,
  type RegisteredSafeEvidenceFactKey,
  type SafeEvidence
} from '@jooevents/contracts';

export type SafeEvidenceFactDefinition = Readonly<{
  key: RegisteredSafeEvidenceFactKey;
  schemaVersion: number;
}> & (
  | {
      valueKind: 'enum';
      allowedValues: ReadonlySet<RegisteredSafeEvidenceEnumValue>;
    }
  | { valueKind: 'integer'; minimum: number; maximum: number }
  | { valueKind: 'boolean' }
);

export type SafeEvidenceCodeDefinition = Readonly<{
  code: RegisteredSafeEvidenceCode;
  allowedFactKeys: ReadonlySet<RegisteredSafeEvidenceFactKey>;
}>;

export interface SafeEvidenceCatalog {
  assertRegistered(
    code: RegisteredSafeEvidenceCode,
    facts: readonly RegisteredSafeEvidenceFact[]
  ): void;
}

export type SafeEvidenceFactDefinitionInput = Readonly<{
  key: string;
  schemaVersion: number;
}> & (
  | { valueKind: 'enum'; allowedValues: readonly string[] }
  | { valueKind: 'integer'; minimum: number; maximum: number }
  | { valueKind: 'boolean' }
);

export type SafeEvidenceCodeDefinitionInput = Readonly<{
  code: string;
  allowedFactKeys: readonly string[];
}>;

export class ProviderContractError extends Error {
  public constructor(
    public readonly code:
      | 'invalid_contract'
      | 'invalid_evidence'
      | 'invalid_prepared_submission'
      | 'unknown_adapter'
      | 'ambiguous_verifier',
    message: string
  ) {
    super(message);
    this.name = 'ProviderContractError';
  }
}

function fail(code: ProviderContractError['code'], message: string): never {
  throw new ProviderContractError(code, message);
}

function sortedUnique(values: readonly string[], label: string): readonly string[] {
  const canonical = [...values].sort();
  if (canonical.some((value, index) => index > 0 && canonical[index - 1] === value)) {
    fail('invalid_contract', `${label} must be unique`);
  }
  return Object.freeze(canonical);
}

/** Builds an immutable closed catalog. Only registered codes and facts cross a port. */
export function createSafeEvidenceCatalog(input: Readonly<{
  facts: readonly SafeEvidenceFactDefinitionInput[];
  codes: readonly SafeEvidenceCodeDefinitionInput[];
}>): SafeEvidenceCatalog {
  const facts = new Map<RegisteredSafeEvidenceFactKey, SafeEvidenceFactDefinition>();
  for (const definition of input.facts) {
    const key = registeredSafeEvidenceFactKeySchema.parse(definition.key);
    if (!Number.isSafeInteger(definition.schemaVersion) || definition.schemaVersion <= 0) {
      fail('invalid_contract', 'safe-evidence fact schema version must be positive');
    }
    if (facts.has(key)) fail('invalid_contract', 'safe-evidence fact keys must be unique');
    if (definition.valueKind === 'enum') {
      const values = sortedUnique(definition.allowedValues, 'safe-evidence enum values')
        .map((value) => registeredSafeEvidenceEnumValueSchema.parse(value));
      if (values.length === 0) {
        fail('invalid_contract', 'safe-evidence enum facts need at least one value');
      }
      facts.set(key, Object.freeze({
        key,
        schemaVersion: definition.schemaVersion,
        valueKind: 'enum',
        allowedValues: new Set(values)
      }));
    } else if (definition.valueKind === 'integer') {
      if (
        !Number.isSafeInteger(definition.minimum)
        || !Number.isSafeInteger(definition.maximum)
        || definition.minimum > definition.maximum
      ) {
        fail('invalid_contract', 'safe-evidence integer bounds must be safe and ordered');
      }
      facts.set(key, Object.freeze({ ...definition, key }));
    } else {
      facts.set(key, Object.freeze({ ...definition, key }));
    }
  }

  const codes = new Map<RegisteredSafeEvidenceCode, SafeEvidenceCodeDefinition>();
  for (const definition of input.codes) {
    const code = registeredSafeEvidenceCodeSchema.parse(definition.code);
    if (codes.has(code)) fail('invalid_contract', 'safe-evidence codes must be unique');
    const allowedFactKeys = sortedUnique(
      definition.allowedFactKeys,
      'safe-evidence code fact keys'
    ).map((value) => registeredSafeEvidenceFactKeySchema.parse(value));
    for (const key of allowedFactKeys) {
      if (!facts.has(key)) {
        fail('invalid_contract', 'safe-evidence code references an unknown fact key');
      }
    }
    codes.set(code, Object.freeze({ code, allowedFactKeys: new Set(allowedFactKeys) }));
  }
  return Object.freeze({
    assertRegistered(
      codeValue: RegisteredSafeEvidenceCode,
      evidenceFacts: readonly RegisteredSafeEvidenceFact[]
    ): void {
      const code = codes.get(codeValue);
      if (code === undefined) fail('invalid_evidence', 'safe-evidence code is not registered');
      for (const fact of evidenceFacts) {
        if (!code.allowedFactKeys.has(fact.factKey)) {
          fail('invalid_evidence', 'safe-evidence code does not allow the supplied fact');
        }
        const definition = facts.get(fact.factKey);
        if (definition === undefined) {
          fail('invalid_evidence', 'safe-evidence fact is not registered');
        }
        validateFact(fact, definition);
      }
    }
  });
}

function validateFact(
  fact: RegisteredSafeEvidenceFact,
  definition: SafeEvidenceFactDefinition
): void {
  if (fact.factSchemaVersion !== definition.schemaVersion) {
    fail('invalid_evidence', 'safe-evidence fact schema version is not registered');
  }
  if (fact.valueKind !== definition.valueKind) {
    fail('invalid_evidence', 'safe-evidence fact value kind is not registered');
  }
  if (fact.valueKind === 'enum' && definition.valueKind === 'enum') {
    if (!definition.allowedValues.has(fact.enumValue)) {
      fail('invalid_evidence', 'safe-evidence enum value is not registered');
    }
  } else if (fact.valueKind === 'integer' && definition.valueKind === 'integer') {
    if (fact.integerValue < definition.minimum || fact.integerValue > definition.maximum) {
      fail('invalid_evidence', 'safe-evidence integer is outside registered bounds');
    }
  }
}

/** Parses, digest-checks, and catalog-checks evidence without allowing free text. */
export function validateSafeEvidence(
  value: unknown,
  catalog: SafeEvidenceCatalog
): SafeEvidence {
  const evidence = safeEvidenceSchema.parse(value);
  catalog.assertRegistered(evidence.registeredCode, evidence.registeredFacts);
  return deepFreeze(evidence);
}

/** Creates canonical evidence from registered fields only. */
export function createSafeEvidence(
  catalog: SafeEvidenceCatalog,
  input: Readonly<{
    code: string;
    correlationId: string;
    facts?: readonly RegisteredSafeEvidenceFact[];
  }>
): SafeEvidence {
  const registeredCode = registeredSafeEvidenceCodeSchema.parse(input.code);
  const registeredFacts = [...(input.facts ?? [])].sort((left, right) =>
    left.factKey < right.factKey ? -1 : left.factKey > right.factKey ? 1 : 0
  );
  const body = {
    contractVersion: 1 as const,
    schemaKey: 'je.communication.provider-safe-evidence' as const,
    schemaVersion: 1 as const,
    registeredCode,
    correlationId: input.correlationId,
    registeredFacts
  };
  return validateSafeEvidence({
    ...body,
    canonicalDigestSha256: computeSafeEvidenceDigestSha256(body)
  }, catalog);
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
