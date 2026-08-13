import { createHash } from 'node:crypto';
import { structuredOutcomeSchema, type StructuredOutcome } from '@jooevents/contracts';
import { canonicalJsonValue, encodeCanonicalJson, type CanonicalJson } from '@jooevents/kernel';
import { z, type ZodType } from 'zod';
import {
  beginValidatedChangesetApply,
  beginValidatedChangesetPreparation,
  completeValidatedChangesetApply,
  completeValidatedChangesetPreparation,
  spendValidatedChangesetCommit
} from './commit-authorization';
import type {
  ChangesetSchemaRef,
  CompensationLineage,
  FrozenChangesetOperation,
  GuardRef,
  RiskTier,
  ValidatedChangesetCommit,
  VersionRef
} from './engine';

const readPortBrand: unique symbol = Symbol('ChangesetReadPortKey');
const validationPortBrand: unique symbol = Symbol('ChangesetValidationPortKey');
const transactionPortBrand: unique symbol = Symbol('ChangesetTransactionPortKey');
const preparedCommitBrand: unique symbol = Symbol('PreparedChangesetCommit');
const stableKey = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const sha256 = /^[a-f0-9]{64}$/;

export interface ChangesetReadPortKey<Port> {
  readonly key: string;
  readonly version: number;
  readonly [readPortBrand]: (_port: Port) => Port;
}

export interface ChangesetTransactionPortKey<Port> {
  readonly key: string;
  readonly version: number;
  readonly [transactionPortBrand]: (_port: Port) => Port;
}

export interface ChangesetValidationPortKey<Port> {
  readonly key: string;
  readonly version: number;
  readonly [validationPortBrand]: (_port: Port) => Port;
}

export function defineChangesetReadPort<Port>(key: string, version: number): ChangesetReadPortKey<Port> {
  validateKeyVersion(key, version, 'read port');
  return Object.freeze({ key, version }) as ChangesetReadPortKey<Port>;
}

export function defineChangesetValidationPort<Port>(key: string, version: number): ChangesetValidationPortKey<Port> {
  validateKeyVersion(key, version, 'validation port');
  return Object.freeze({ key, version }) as ChangesetValidationPortKey<Port>;
}

export function defineChangesetTransactionPort<Port>(key: string, version: number): ChangesetTransactionPortKey<Port> {
  validateKeyVersion(key, version, 'transaction port');
  return Object.freeze({ key, version }) as ChangesetTransactionPortKey<Port>;
}

export interface ChangesetPlanningSnapshot {
  getPort<Port>(key: ChangesetReadPortKey<Port>): Port;
}

export interface ChangesetValidation {
  getPort<Port>(key: ChangesetValidationPortKey<Port>): Port;
}

export interface ChangesetTransaction {
  getPort<Port>(key: ChangesetTransactionPortKey<Port>): Port;
}

/**
 * Executor-owned access to both phases of one database transaction. Operation
 * definitions never receive this combined capability: validation gets only its
 * read-only view and apply gets only its mutation view.
 */
export interface ChangesetCommitTransaction {
  getPort<Port>(key: ChangesetValidationPortKey<Port>): Port;
  getPort<Port>(key: ChangesetTransactionPortKey<Port>): Port;
}

export interface RegisteredChangesetSchema<Output = unknown> {
  readonly reference: ChangesetSchemaRef;
  readonly jsonSchema: CanonicalJson;
  readonly schema: ZodType<Output>;
}

export function defineChangesetSchema<Output>(input: {
  readonly key: string;
  readonly version: number;
  readonly schema: ZodType<Output>;
}): RegisteredChangesetSchema<Output> {
  validateKeyVersion(input.key, input.version, 'schema');
  // Zod attaches a non-enumerable Standard Schema implementation to its JSON
  // Schema object. Only the enumerable JSON representation is part of the public
  // schema identity; executable metadata stays in the server registry.
  const jsonSchema = canonicalJsonValue(JSON.parse(JSON.stringify(z.toJSONSchema(input.schema))));
  return Object.freeze({
    reference: Object.freeze({
      key: input.key,
      version: input.version,
      digestSha256: digest(jsonSchema)
    }),
    jsonSchema: deepFreeze(jsonSchema),
    schema: input.schema
  });
}

export interface PlannedChangesetOperation<Plan> {
  readonly plan: Plan;
  readonly aggregateRefs: readonly VersionRef[];
  readonly guardRefs: readonly GuardRef[];
  readonly riskTier: RiskTier;
  readonly consequences: readonly string[];
}

export type ChangesetValidationResult<Validated> =
  | { readonly kind: 'ready'; readonly validated: Validated }
  | { readonly kind: 'outcome'; readonly outcome: StructuredOutcome };

export interface ChangesetApplyContribution<Result> {
  readonly result: Result;
  readonly facts: readonly { readonly kind: string; readonly version: number; readonly payload: CanonicalJson }[];
  readonly effects: readonly { readonly kind: string; readonly version: number; readonly payload: CanonicalJson }[];
}

export type CompensationDerivation<AuthorInput> =
  | { readonly kind: 'exact'; readonly authorInput: AuthorInput }
  | { readonly kind: 'semantic'; readonly authorInput: AuthorInput; readonly noteKey: string }
  | { readonly kind: 'partial'; readonly authorInput: AuthorInput; readonly conflicts: readonly string[] }
  | { readonly kind: 'blocked'; readonly reasonKey: string }
  | {
      readonly kind: 'irreversible';
      readonly remediationKey: string;
      readonly authorInput?: AuthorInput;
    };

export interface ChangesetOperationDefinition<AuthorInput, Plan, Diff, Validated, Result> {
  readonly kind: string;
  readonly version: number;
  readonly schemas: {
    readonly authorInput: ChangesetSchemaRef;
    readonly plan: ChangesetSchemaRef;
    readonly diff: ChangesetSchemaRef;
    readonly result: ChangesetSchemaRef;
  };
  readonly readPorts: readonly ChangesetReadPortKey<any>[];
  readonly validationPorts: readonly ChangesetValidationPortKey<any>[];
  readonly transactionPorts: readonly ChangesetTransactionPortKey<any>[];
  readonly allowedAggregateKinds: readonly string[];
  readonly allowedGuardKinds: readonly string[];
  readonly allowedRisks: readonly RiskTier[];
  readonly allowedConsequences: readonly string[];
  readonly allowedOutcomes: readonly {
    readonly class: StructuredOutcome['class'];
    readonly kind: string;
    readonly retryable: boolean;
    readonly detailSchema: ChangesetSchemaRef;
  }[];
  readonly allowedFacts: readonly { readonly kind: string; readonly version: number }[];
  readonly allowedEffects: readonly { readonly kind: string; readonly version: number }[];
  plan(input: AuthorInput, snapshot: ChangesetPlanningSnapshot): PlannedChangesetOperation<Plan> | Promise<PlannedChangesetOperation<Plan>>;
  projectDiff(plan: Plan): {
    readonly diff: Diff;
    readonly representedConsequences: readonly string[];
  };
  validateWithin(plan: Plan, validation: ChangesetValidation): ChangesetValidationResult<Validated> | Promise<ChangesetValidationResult<Validated>>;
  applyWithin(validated: Validated, transaction: ChangesetTransaction): ChangesetApplyContribution<Result> | Promise<ChangesetApplyContribution<Result>>;
  deriveCompensation(
    plan: Plan,
    snapshot: ChangesetPlanningSnapshot
  ): CompensationDerivation<AuthorInput> | Promise<CompensationDerivation<AuthorInput>>;
}

type AnyDefinition = ChangesetOperationDefinition<any, any, any, any, any>;

export interface ChangesetDefinitionRegistrySource {
  readonly schemas: readonly RegisteredChangesetSchema[];
  readonly definitions: readonly AnyDefinition[];
}

export interface ChangesetDefinitionRegistry {
  readonly registryDigestSha256: string;
  get(kind: string, version: number): AnyDefinition | undefined;
  getSchema(reference: ChangesetSchemaRef): RegisteredChangesetSchema | undefined;
}

export interface ChangesetDefinitionIssue {
  readonly code: string;
  readonly detail: string;
}

export class ChangesetDefinitionValidationError extends Error {
  readonly issues: readonly ChangesetDefinitionIssue[];

  constructor(issues: readonly ChangesetDefinitionIssue[]) {
    super(`Changeset definition registry failed with ${issues.length} issue(s).`);
    this.name = 'ChangesetDefinitionValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function definitionKey(kind: string, version: number): string {
  return `${kind}@${version}`;
}

function schemaKey(reference: Pick<ChangesetSchemaRef, 'key' | 'version'>): string {
  return `${reference.key}@${reference.version}`;
}

function portKey(port: { readonly key: string; readonly version: number }): string {
  return `${port.key}@${port.version}`;
}

function validateKeyVersion(key: string, version: number, label: string): void {
  if (!stableKey.test(key) || !Number.isSafeInteger(version) || version <= 0) {
    throw new TypeError(`${label} must have a stable key and positive version`);
  }
}

function sameSchema(left: ChangesetSchemaRef, right: ChangesetSchemaRef): boolean {
  return left.key === right.key && left.version === right.version && left.digestSha256 === right.digestSha256;
}

function uniqueStrings(values: readonly string[]): boolean {
  return values.length === new Set(values).size && values.every((value) => stableKey.test(value));
}

function uniqueRefs(values: readonly { readonly key: string; readonly version: number }[]): boolean {
  return values.length === new Set(values.map(portKey)).size;
}

export function createChangesetDefinitionRegistry(source: ChangesetDefinitionRegistrySource): ChangesetDefinitionRegistry {
  const issues: ChangesetDefinitionIssue[] = [];
  const schemas = new Map<string, RegisteredChangesetSchema>();
  const definitions = new Map<string, AnyDefinition>();

  for (const schema of source.schemas) {
    try {
      validateKeyVersion(schema.reference.key, schema.reference.version, 'schema');
    } catch (error) {
      issues.push({ code: 'invalid_schema', detail: error instanceof Error ? error.message : 'Invalid schema.' });
      continue;
    }
    const key = schemaKey(schema.reference);
    if (schemas.has(key)) {
      issues.push({ code: 'duplicate_schema', detail: `Schema ${key} is duplicated.` });
      continue;
    }
    if (!sha256.test(schema.reference.digestSha256) || digest(schema.jsonSchema) !== schema.reference.digestSha256) {
      issues.push({ code: 'schema_digest_mismatch', detail: `Schema ${key} digest does not match its JSON schema.` });
    }
    schemas.set(key, schema);
  }

  const resolveSchema = (reference: ChangesetSchemaRef, usage: string): RegisteredChangesetSchema | undefined => {
    const schema = schemas.get(schemaKey(reference));
    if (!schema || !sameSchema(schema.reference, reference)) {
      issues.push({ code: 'missing_schema', detail: `${usage} references a missing or mismatched schema ${schemaKey(reference)}.` });
      return undefined;
    }
    return schema;
  };

  for (const definition of source.definitions) {
    try {
      validateKeyVersion(definition.kind, definition.version, 'operation definition');
    } catch (error) {
      issues.push({ code: 'invalid_definition', detail: error instanceof Error ? error.message : 'Invalid definition.' });
      continue;
    }
    const key = definitionKey(definition.kind, definition.version);
    if (definitions.has(key)) {
      issues.push({ code: 'duplicate_definition', detail: `Definition ${key} is duplicated.` });
      continue;
    }
    resolveSchema(definition.schemas.authorInput, `${key} author input`);
    resolveSchema(definition.schemas.plan, `${key} plan`);
    resolveSchema(definition.schemas.diff, `${key} diff`);
    resolveSchema(definition.schemas.result, `${key} result`);
    for (const outcome of definition.allowedOutcomes) {
      resolveSchema(outcome.detailSchema, `${key} outcome ${outcome.class}:${outcome.kind}`);
    }
    if (!uniqueRefs(definition.readPorts) || !uniqueRefs(definition.validationPorts) ||
        !uniqueRefs(definition.transactionPorts)) {
      issues.push({ code: 'duplicate_port', detail: `${key} has duplicate read, validation, or transaction ports.` });
    }
    if (!uniqueStrings(definition.allowedAggregateKinds) || !uniqueStrings(definition.allowedGuardKinds) ||
        !uniqueStrings(definition.allowedConsequences) || !uniqueStrings(definition.allowedRisks)) {
      issues.push({ code: 'invalid_allowlist', detail: `${key} has an invalid or duplicate allowlist.` });
    }
    if (definition.allowedRisks.length === 0) {
      issues.push({ code: 'missing_risk', detail: `${key} declares no permitted risk tier.` });
    }
    if (new Set(definition.allowedOutcomes.map((outcome) => `${outcome.class}:${outcome.kind}`)).size !== definition.allowedOutcomes.length ||
        new Set(definition.allowedFacts.map((fact) => definitionKey(fact.kind, fact.version))).size !== definition.allowedFacts.length ||
        new Set(definition.allowedEffects.map((effect) => definitionKey(effect.kind, effect.version))).size !== definition.allowedEffects.length) {
      issues.push({ code: 'duplicate_declaration', detail: `${key} duplicates an outcome, fact, or effect declaration.` });
    }
    definitions.set(key, definition);
  }

  if (issues.length > 0) throw new ChangesetDefinitionValidationError(issues);

  const manifest = {
    schemas: [...schemas.values()].map((schema) => schema.reference)
      .sort((left, right) => schemaKey(left).localeCompare(schemaKey(right))),
    definitions: [...definitions.values()].map((definition) => ({
      kind: definition.kind,
      version: definition.version,
      schemas: definition.schemas,
      readPorts: definition.readPorts.map(({ key, version }) => ({ key, version })).sort((left, right) => portKey(left).localeCompare(portKey(right))),
      validationPorts: definition.validationPorts.map(({ key, version }) => ({ key, version })).sort((left, right) => portKey(left).localeCompare(portKey(right))),
      transactionPorts: definition.transactionPorts.map(({ key, version }) => ({ key, version })).sort((left, right) => portKey(left).localeCompare(portKey(right))),
      allowedAggregateKinds: [...definition.allowedAggregateKinds].sort(),
      allowedGuardKinds: [...definition.allowedGuardKinds].sort(),
      allowedRisks: [...definition.allowedRisks].sort(),
      allowedConsequences: [...definition.allowedConsequences].sort(),
      allowedOutcomes: [...definition.allowedOutcomes].sort((left, right) => `${left.class}:${left.kind}`.localeCompare(`${right.class}:${right.kind}`)),
      allowedFacts: [...definition.allowedFacts].sort((left, right) => definitionKey(left.kind, left.version).localeCompare(definitionKey(right.kind, right.version))),
      allowedEffects: [...definition.allowedEffects].sort((left, right) => definitionKey(left.kind, left.version).localeCompare(definitionKey(right.kind, right.version)))
    })).sort((left, right) => definitionKey(left.kind, left.version).localeCompare(definitionKey(right.kind, right.version)))
  };
  const registryDigestSha256 = digest(manifest);
  return Object.freeze({
    registryDigestSha256,
    get(kind: string, version: number) {
      return definitions.get(definitionKey(kind, version));
    },
    getSchema(reference: ChangesetSchemaRef) {
      const found = schemas.get(schemaKey(reference));
      return found && sameSchema(found.reference, reference) ? found : undefined;
    }
  });
}

function declaredKind(values: readonly { readonly kind: string; readonly version: number }[], kind: string, version: number): boolean {
  return values.some((value) => value.kind === kind && value.version === version);
}

function aggregateKind(id: string): string {
  const separator = id.indexOf(':');
  return separator > 0 ? id.slice(0, separator) : id;
}

interface PlanChangesetOperationInput {
  readonly registry: ChangesetDefinitionRegistry;
  readonly kind: string;
  readonly version: number;
  readonly authorInput: unknown;
  readonly dependencyGroup: string;
  readonly snapshot: ChangesetPlanningSnapshot;
  readonly compensationLineage?: CompensationLineage;
}

function planningContext(input: PlanChangesetOperationInput): {
  readonly definition: AnyDefinition;
  readonly author: unknown;
  readonly snapshot: ChangesetPlanningSnapshot;
} {
  const definition = input.registry.get(input.kind, input.version);
  if (!definition) throw new TypeError('unknown_changeset_operation');
  const authorSchema = input.registry.getSchema(definition.schemas.authorInput);
  const planSchema = input.registry.getSchema(definition.schemas.plan);
  const diffSchema = input.registry.getSchema(definition.schemas.diff);
  if (!authorSchema || !planSchema || !diffSchema) throw new TypeError('changeset_registry_incomplete');
  const author = authorSchema.schema.parse(input.authorInput);
  const allowedReadPorts = new Set(definition.readPorts.map(portKey));
  const restrictedSnapshot: ChangesetPlanningSnapshot = Object.freeze({
    getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
      if (!allowedReadPorts.has(portKey(key))) throw new TypeError('undeclared_changeset_read_port');
      return input.snapshot.getPort(key);
    }
  });
  return { definition, author, snapshot: restrictedSnapshot };
}

function freezePlannedOperation(
  input: PlanChangesetOperationInput,
  definition: AnyDefinition,
  planned: PlannedChangesetOperation<unknown>
): FrozenChangesetOperation {
  const planSchema = input.registry.getSchema(definition.schemas.plan);
  const diffSchema = input.registry.getSchema(definition.schemas.diff);
  if (!planSchema || !diffSchema) throw new TypeError('changeset_registry_incomplete');
  const parsedPlan = planSchema.schema.parse(planned.plan);
  const projected = definition.projectDiff(parsedPlan);
  if (projected && typeof (projected as { then?: unknown }).then === 'function') {
    throw new TypeError('changeset_diff_projection_must_be_synchronous');
  }
  const parsedDiff = diffSchema.schema.parse(projected.diff);
  if (!definition.allowedRisks.includes(planned.riskTier)) throw new TypeError('undeclared_changeset_risk');
  if (new Set(planned.consequences).size !== planned.consequences.length ||
      planned.consequences.some((value) => !definition.allowedConsequences.includes(value))) {
    throw new TypeError('undeclared_changeset_consequence');
  }
  const representedConsequences = [...projected.representedConsequences];
  if (new Set(representedConsequences).size !== representedConsequences.length ||
      representedConsequences.length !== planned.consequences.length ||
      representedConsequences.some((value) => !planned.consequences.includes(value))) {
    throw new TypeError('changeset_diff_omits_consequence');
  }
  for (const aggregate of planned.aggregateRefs) {
    if (!definition.allowedAggregateKinds.includes(aggregateKind(aggregate.id))) throw new TypeError('undeclared_changeset_aggregate');
  }
  for (const guard of planned.guardRefs) {
    if (!definition.allowedGuardKinds.includes(aggregateKind(guard.id))) throw new TypeError('undeclared_changeset_guard');
  }
  return deepFreeze({
    kind: definition.kind,
    version: definition.version,
    riskTier: planned.riskTier,
    dependencyGroup: input.dependencyGroup,
    planSchema: { ...definition.schemas.plan },
    diffSchema: { ...definition.schemas.diff },
    resultSchema: { ...definition.schemas.result },
    aggregateRefs: planned.aggregateRefs.map((reference) => ({ ...reference })),
    guardRefs: planned.guardRefs.map((reference) => ({ ...reference })),
    plan: canonicalJsonValue(parsedPlan),
    safeDiff: canonicalJsonValue(parsedDiff),
    consequences: [...planned.consequences],
    ...(input.compensationLineage === undefined
      ? {}
      : { compensationLineage: { ...input.compensationLineage } })
  });
}

export async function planChangesetOperation(
  input: PlanChangesetOperationInput
): Promise<FrozenChangesetOperation> {
  const context = planningContext(input);
  const planned = await context.definition.plan(context.author, context.snapshot);
  return freezePlannedOperation(input, context.definition, planned);
}

/** Synchronous planning for transaction-local single-unit-of-work handlers. */
export function planChangesetOperationSynchronous(
  input: PlanChangesetOperationInput
): FrozenChangesetOperation {
  const context = planningContext(input);
  const planned = context.definition.plan(context.author, context.snapshot);
  if (planned && typeof planned === 'object' && 'then' in planned
    && typeof (planned as { readonly then?: unknown }).then === 'function') {
    throw new TypeError('async_changeset_planning_forbidden_in_single_unit_of_work');
  }
  return freezePlannedOperation(
    input,
    context.definition,
    planned as PlannedChangesetOperation<unknown>
  );
}

interface PreparedEntry {
  readonly definition: AnyDefinition;
  readonly validated: unknown;
  readonly transaction: ChangesetTransaction;
  readonly resultSchema: RegisteredChangesetSchema;
}

export interface PreparedChangesetCommit {
  readonly [preparedCommitBrand]: true;
}

interface PreparedChangesetCommitState {
  readonly authorization: ValidatedChangesetCommit;
  readonly entries: readonly PreparedEntry[];
}

const preparedChangesetCommits = new WeakMap<object, PreparedChangesetCommitState>();

export type PrepareChangesetCommitResult =
  | { readonly kind: 'ready'; readonly prepared: PreparedChangesetCommit }
  | { readonly kind: 'outcome'; readonly outcome: StructuredOutcome };

export async function prepareChangesetCommit(input: {
  readonly registry: ChangesetDefinitionRegistry;
  readonly authorization: ValidatedChangesetCommit;
  readonly transaction: ChangesetCommitTransaction;
}): Promise<PrepareChangesetCommitResult> {
  const validatedCommit = beginValidatedChangesetPreparation(input.authorization);
  if (!validatedCommit) throw new TypeError('invalid_validated_changeset_commit');
  try {
    const entries: PreparedEntry[] = [];
    for (const operation of validatedCommit.revision.operations) {
      const definition = input.registry.get(operation.kind, operation.version);
      if (!definition || !sameSchema(definition.schemas.plan, operation.planSchema) ||
          !sameSchema(definition.schemas.diff, operation.diffSchema) ||
          !sameSchema(definition.schemas.result, operation.resultSchema)) {
        throw new TypeError('changeset_definition_changed');
      }
      const planSchema = input.registry.getSchema(operation.planSchema);
      const resultSchema = input.registry.getSchema(operation.resultSchema);
      if (!planSchema || !resultSchema) throw new TypeError('changeset_plan_schema_missing');
      const plan = planSchema.schema.parse(operation.plan);
      const allowedValidationPorts = new Set(definition.validationPorts);
      const restrictedValidation: ChangesetValidation = Object.freeze({
        getPort<Port>(key: ChangesetValidationPortKey<Port>): Port {
          if (!allowedValidationPorts.has(key)) throw new TypeError('undeclared_changeset_validation_port');
          return input.transaction.getPort(key);
        }
      });
      const allowedTransactionPorts = new Set(definition.transactionPorts.map(portKey));
      const restrictedTransaction: ChangesetTransaction = Object.freeze({
        getPort<Port>(key: ChangesetTransactionPortKey<Port>): Port {
          if (!allowedTransactionPorts.has(portKey(key))) throw new TypeError('undeclared_changeset_transaction_port');
          return input.transaction.getPort(key);
        }
      });
      const validation = await definition.validateWithin(plan, restrictedValidation);
      if (validation.kind === 'outcome') {
        const outcome = structuredOutcomeSchema.parse(validation.outcome);
        const declaration = definition.allowedOutcomes.find((declared) => declared.class === outcome.class && declared.kind === outcome.kind);
        const detailSchema = declaration ? input.registry.getSchema(declaration.detailSchema) : undefined;
        if (!declaration || declaration.retryable !== outcome.retryable ||
            declaration.detailSchema.version !== outcome.detailSchemaVersion || !detailSchema ||
            !detailSchema.schema.safeParse(outcome.detail).success) {
          throw new TypeError('undeclared_changeset_outcome');
        }
        spendValidatedChangesetCommit(input.authorization);
        return { kind: 'outcome', outcome };
      }
      const detachedValidated = deepFreeze(structuredClone(validation.validated));
      entries.push({ definition, validated: detachedValidated, transaction: restrictedTransaction, resultSchema });
    }
    if (!completeValidatedChangesetPreparation(input.authorization)) {
      throw new TypeError('invalid_validated_changeset_commit');
    }
    const prepared: PreparedChangesetCommit = Object.freeze({
      [preparedCommitBrand]: true as const
    });
    preparedChangesetCommits.set(prepared, {
      authorization: input.authorization,
      entries: Object.freeze(entries)
    });
    return { kind: 'ready', prepared };
  } catch (error) {
    spendValidatedChangesetCommit(input.authorization);
    throw error;
  }
}

/**
 * Synchronous counterpart for capability-limited in-transaction operation phases.
 * It fails closed when any registered validator crosses an asynchronous boundary.
 */
export function prepareChangesetCommitSynchronous(input: {
  readonly registry: ChangesetDefinitionRegistry;
  readonly authorization: ValidatedChangesetCommit;
  readonly transaction: ChangesetCommitTransaction;
}): PrepareChangesetCommitResult {
  const validatedCommit = beginValidatedChangesetPreparation(input.authorization);
  if (!validatedCommit) throw new TypeError('invalid_validated_changeset_commit');
  try {
    const entries: PreparedEntry[] = [];
    for (const operation of validatedCommit.revision.operations) {
      const definition = input.registry.get(operation.kind, operation.version);
      if (!definition || !sameSchema(definition.schemas.plan, operation.planSchema)
        || !sameSchema(definition.schemas.diff, operation.diffSchema)
        || !sameSchema(definition.schemas.result, operation.resultSchema)) {
        throw new TypeError('changeset_definition_changed');
      }
      const planSchema = input.registry.getSchema(operation.planSchema);
      const resultSchema = input.registry.getSchema(operation.resultSchema);
      if (!planSchema || !resultSchema) throw new TypeError('changeset_plan_schema_missing');
      const plan = planSchema.schema.parse(operation.plan);
      const allowedValidationPorts = new Set(definition.validationPorts);
      const restrictedValidation: ChangesetValidation = Object.freeze({
        getPort<Port>(key: ChangesetValidationPortKey<Port>): Port {
          if (!allowedValidationPorts.has(key)) throw new TypeError('undeclared_changeset_validation_port');
          return input.transaction.getPort(key);
        }
      });
      const allowedTransactionPorts = new Set(definition.transactionPorts.map(portKey));
      const restrictedTransaction: ChangesetTransaction = Object.freeze({
        getPort<Port>(key: ChangesetTransactionPortKey<Port>): Port {
          if (!allowedTransactionPorts.has(portKey(key))) throw new TypeError('undeclared_changeset_transaction_port');
          return input.transaction.getPort(key);
        }
      });
      const validation = definition.validateWithin(plan, restrictedValidation);
      if (validation && typeof validation === 'object' && 'then' in validation
        && typeof (validation as { readonly then?: unknown }).then === 'function') {
        throw new TypeError('async_changeset_validation_forbidden_in_single_unit_of_work');
      }
      const synchronousValidation = validation as Exclude<typeof validation, Promise<unknown>>;
      if (synchronousValidation.kind === 'outcome') {
        const outcome = structuredOutcomeSchema.parse(synchronousValidation.outcome);
        const declaration = definition.allowedOutcomes.find(
          (declared) => declared.class === outcome.class && declared.kind === outcome.kind
        );
        const detailSchema = declaration ? input.registry.getSchema(declaration.detailSchema) : undefined;
        if (!declaration || declaration.retryable !== outcome.retryable
          || declaration.detailSchema.version !== outcome.detailSchemaVersion || !detailSchema
          || !detailSchema.schema.safeParse(outcome.detail).success) {
          throw new TypeError('undeclared_changeset_outcome');
        }
        spendValidatedChangesetCommit(input.authorization);
        return { kind: 'outcome', outcome };
      }
      const detachedValidated = deepFreeze(structuredClone(synchronousValidation.validated));
      entries.push({ definition, validated: detachedValidated, transaction: restrictedTransaction, resultSchema });
    }
    if (!completeValidatedChangesetPreparation(input.authorization)) {
      throw new TypeError('invalid_validated_changeset_commit');
    }
    const prepared: PreparedChangesetCommit = Object.freeze({
      [preparedCommitBrand]: true as const
    });
    preparedChangesetCommits.set(prepared, {
      authorization: input.authorization,
      entries: Object.freeze(entries)
    });
    return { kind: 'ready', prepared };
  } catch (error) {
    spendValidatedChangesetCommit(input.authorization);
    throw error;
  }
}

export async function applyPreparedChangeset(
  prepared: PreparedChangesetCommit
): Promise<readonly ChangesetApplyContribution<unknown>[]> {
  const state = preparedChangesetCommits.get(prepared);
  if (!state || prepared[preparedCommitBrand] !== true) throw new TypeError('invalid_prepared_changeset');
  preparedChangesetCommits.delete(prepared);
  if (!beginValidatedChangesetApply(state.authorization)) throw new TypeError('invalid_prepared_changeset');
  try {
    const contributions: ChangesetApplyContribution<unknown>[] = [];
    for (const entry of state.entries) {
      const contribution = await entry.definition.applyWithin(entry.validated, entry.transaction);
      const parsedResult = entry.resultSchema.schema.parse(contribution.result);
      // Parse and re-check all emitted evidence while the caller can still roll back.
      for (const fact of contribution.facts) {
        if (!declaredKind(entry.definition.allowedFacts, fact.kind, fact.version)) throw new TypeError('undeclared_changeset_fact');
        canonicalJsonValue(fact.payload);
      }
      for (const effect of contribution.effects) {
        if (!declaredKind(entry.definition.allowedEffects, effect.kind, effect.version)) throw new TypeError('undeclared_changeset_effect');
        canonicalJsonValue(effect.payload);
      }
      contributions.push(deepFreeze({
        result: parsedResult,
        facts: contribution.facts.map((fact) => ({ ...fact, payload: canonicalJsonValue(fact.payload) })),
        effects: contribution.effects.map((effect) => ({ ...effect, payload: canonicalJsonValue(effect.payload) }))
      }));
    }
    if (!completeValidatedChangesetApply(state.authorization)) throw new TypeError('invalid_prepared_changeset');
    return Object.freeze(contributions);
  } catch (error) {
    spendValidatedChangesetCommit(state.authorization);
    throw error;
  }
}

/**
 * Synchronous counterpart for a transaction that forbids asynchronous domain
 * contributors. It fails closed before acknowledging an asynchronous contribution.
 */
export function applyPreparedChangesetSynchronous(
  prepared: PreparedChangesetCommit
): readonly ChangesetApplyContribution<unknown>[] {
  const state = preparedChangesetCommits.get(prepared);
  if (!state || prepared[preparedCommitBrand] !== true) throw new TypeError('invalid_prepared_changeset');
  preparedChangesetCommits.delete(prepared);
  if (!beginValidatedChangesetApply(state.authorization)) throw new TypeError('invalid_prepared_changeset');
  try {
    const contributions: ChangesetApplyContribution<unknown>[] = [];
    for (const entry of state.entries) {
      const contribution = entry.definition.applyWithin(entry.validated, entry.transaction);
      if (contribution && typeof contribution === 'object' && 'then' in contribution
        && typeof (contribution as { readonly then?: unknown }).then === 'function') {
        throw new TypeError('async_changeset_apply_forbidden_in_single_unit_of_work');
      }
      const synchronousContribution = contribution as Exclude<typeof contribution, Promise<unknown>>;
      const parsedResult = entry.resultSchema.schema.parse(synchronousContribution.result);
      for (const fact of synchronousContribution.facts) {
        if (!declaredKind(entry.definition.allowedFacts, fact.kind, fact.version)) throw new TypeError('undeclared_changeset_fact');
        canonicalJsonValue(fact.payload);
      }
      for (const effect of synchronousContribution.effects) {
        if (!declaredKind(entry.definition.allowedEffects, effect.kind, effect.version)) throw new TypeError('undeclared_changeset_effect');
        canonicalJsonValue(effect.payload);
      }
      contributions.push(deepFreeze({
        result: parsedResult,
        facts: synchronousContribution.facts.map((fact) => ({ ...fact, payload: canonicalJsonValue(fact.payload) })),
        effects: synchronousContribution.effects.map((effect) => ({ ...effect, payload: canonicalJsonValue(effect.payload) }))
      }));
    }
    if (!completeValidatedChangesetApply(state.authorization)) throw new TypeError('invalid_prepared_changeset');
    return Object.freeze(contributions);
  } catch (error) {
    spendValidatedChangesetCommit(state.authorization);
    throw error;
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
