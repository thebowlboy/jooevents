import { createOperationRegistry } from './registry';
import {
  createTrustedApplicationOperationRuntime,
  isTrustedApplicationOperationRuntime
} from './runtime-construction';
import type {
  EffectInvocationBuilder,
  EffectInvocationBuilderOptions,
  EffectOperationExecutor,
  EffectUnitOfWorkPort,
  DirectOperationFeatureContributor,
  OperationRegistry,
  OperationRegistrySource,
  ReadOperationExecutor,
  ReadOperationExecutorOptions
} from './types';

export interface ApplicationOperationRuntime {
  readonly registry: OperationRegistry;
  readonly readExecutor: ReadOperationExecutor;
  readonly effectBuilder: EffectInvocationBuilder;
  readonly effectExecutor: EffectOperationExecutor;
}

export interface OperationRegistryModule {
  readonly id: string;
  readonly source: OperationRegistrySource;
}

export interface CreateApplicationOperationRuntimeInput {
  readonly source: OperationRegistrySource;
  readonly read: ReadOperationExecutorOptions;
  readonly unitOfWork: EffectUnitOfWorkPort;
  readonly effectBuilder?: EffectInvocationBuilderOptions;
  readonly newOperationLogId?: () => string;
  readonly directFeatureContributor?: DirectOperationFeatureContributor;
}

const moduleIdPattern = /^[a-z][a-z0-9.-]{0,127}$/;
function concat<Value>(
  modules: readonly OperationRegistryModule[],
  select: (source: OperationRegistrySource) => readonly Value[] | undefined
): readonly Value[] {
  return Object.freeze(modules.flatMap((module) => [...(select(module.source) ?? [])]));
}

/** Joins independently owned operation catalogs without giving any catalog activation authority. */
export function composeOperationRegistryModules(
  candidates: readonly OperationRegistryModule[]
): OperationRegistrySource {
  const modules = [...candidates].sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const module of modules) {
    if (!moduleIdPattern.test(module.id)) throw new TypeError('Invalid operation registry module ID.');
    if (ids.has(module.id)) throw new TypeError(`Duplicate operation registry module ID: ${module.id}`);
    ids.add(module.id);
  }

  return Object.freeze({
    autonomyPolicies: concat(modules, (source) => source.autonomyPolicies),
    schemas: concat(modules, (source) => source.schemas),
    contextBuilders: concat(modules, (source) => source.contextBuilders),
    readCapabilities: concat(modules, (source) => source.readCapabilities),
    handlers: concat(modules, (source) => source.handlers),
    projections: concat(modules, (source) => source.projections),
    readOperationalTraceTargets: concat(modules, (source) => source.readOperationalTraceTargets),
    operationAuditTargets: concat(modules, (source) => source.operationAuditTargets),
    operationAuditRecordProfiles: concat(modules, (source) => source.operationAuditRecordProfiles),
    operations: concat(modules, (source) => source.operations),
    effectContextBuilders: concat(modules, (source) => source.effectContextBuilders),
    effectHandlers: concat(modules, (source) => source.effectHandlers),
    effectOperations: concat(modules, (source) => source.effectOperations),
    effectExecutionFamilies: concat(modules, (source) => source.effectExecutionFamilies),
    effectPhases: concat(modules, (source) => source.effectPhases),
    terminalizationResolvers: concat(modules, (source) => source.terminalizationResolvers),
    riskResolvers: concat(modules, (source) => source.riskResolvers),
    autonomyEvidenceResolvers: concat(modules, (source) => source.autonomyEvidenceResolvers),
    renewedApprovalResolvers: concat(modules, (source) => source.renewedApprovalResolvers),
    autonomyPreflights: concat(modules, (source) => source.autonomyPreflights)
  });
}

/** Compiles one exact registry and binds every executor to that same immutable view. */
export async function createApplicationOperationRuntime(
  input: CreateApplicationOperationRuntimeInput
): Promise<ApplicationOperationRuntime> {
  const registry = await createOperationRegistry(input.source);
  return createTrustedApplicationOperationRuntime({
    registry,
    read: input.read,
    unitOfWork: input.unitOfWork,
    ...(input.effectBuilder ? { effectBuilder: input.effectBuilder } : {}),
    ...(input.newOperationLogId ? { newOperationLogId: input.newOperationLogId } : {}),
    ...(input.directFeatureContributor
      ? { directFeatureContributor: input.directFeatureContributor }
      : {})
  });
}

/** Proves this exact runtime and all four of its components were compiled together. */
export function assertApplicationOperationRuntime(
  value: unknown
): asserts value is ApplicationOperationRuntime {
  if (!isTrustedApplicationOperationRuntime(value)) {
    throw new TypeError('Untrusted application operation runtime.');
  }
}
