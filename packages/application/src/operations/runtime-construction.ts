import { createEffectInvocationBuilder, createEffectOperationExecutor } from './effect-executor';
import { createReadOperationExecutor } from './executor';
import type {
  DirectOperationFeatureContributor,
  EffectInvocationBuilderOptions,
  EffectUnitOfWorkPort,
  OperationRegistry,
  ReadOperationExecutorOptions
} from './types';
import type { ApplicationOperationRuntime } from './runtime';

export interface TrustedRuntimeConstructionInput {
  readonly registry: OperationRegistry;
  readonly read: ReadOperationExecutorOptions;
  readonly unitOfWork: EffectUnitOfWorkPort;
  readonly effectBuilder?: EffectInvocationBuilderOptions;
  readonly newOperationLogId?: () => string;
  readonly directFeatureContributor?: DirectOperationFeatureContributor;
}

const trustedApplicationOperationRuntimes = new WeakSet<object>();

/** Package-private constructor shared by ordinary and isolated conformance compilation. */
export function createTrustedApplicationOperationRuntime(
  input: TrustedRuntimeConstructionInput
): ApplicationOperationRuntime {
  const runtime = Object.freeze({
    registry: input.registry,
    readExecutor: createReadOperationExecutor(input.registry, input.read),
    effectBuilder: createEffectInvocationBuilder(input.registry, input.effectBuilder),
    effectExecutor: createEffectOperationExecutor({
      registry: input.registry,
      unitOfWork: input.unitOfWork,
      ...(input.newOperationLogId ? { newOperationLogId: input.newOperationLogId } : {}),
      ...(input.directFeatureContributor
        ? { directFeatureContributor: input.directFeatureContributor }
        : {})
    })
  });
  trustedApplicationOperationRuntimes.add(runtime);
  return runtime;
}

export function isTrustedApplicationOperationRuntime(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && trustedApplicationOperationRuntimes.has(value);
}
