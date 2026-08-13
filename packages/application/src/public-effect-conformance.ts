import {
  createEffectInvocationContextBuilder,
  type EffectInvocationContextBuilderOptions
} from './operations/invocation-context';
import {
  createTrustedApplicationOperationRuntime
} from './operations/runtime-construction';
import type { ApplicationOperationRuntime } from './operations/runtime';
import { createOperationRegistry } from './operations/registry';
import type {
  EffectContextBuilderRegistration,
  EffectInvocationBuilderOptions,
  EffectUnitOfWorkPort,
  OperationRegistry,
  OperationRegistrySource,
  ReadOperationExecutorOptions
} from './operations/types';
import { issuePublicEffectConformanceActivation } from './operations/public-effect-conformance-activation';

/**
 * Explicit isolated composition boundary for verifying continuation-backed public
 * effects. Importing the ordinary application entry point does not activate them.
 */
export interface PublicEffectConformanceBoundary {
  createContextBuilder(options: EffectInvocationContextBuilderOptions): EffectContextBuilderRegistration;
  createRegistry(source: OperationRegistrySource): Promise<OperationRegistry>;
  createRuntime(input: PublicEffectConformanceRuntimeInput): Promise<ApplicationOperationRuntime>;
}

export interface PublicEffectConformanceRuntimeInput {
  readonly source: OperationRegistrySource;
  readonly read: ReadOperationExecutorOptions;
  readonly unitOfWork: EffectUnitOfWorkPort;
  readonly effectBuilder?: EffectInvocationBuilderOptions;
  readonly newReceiptId?: () => string;
}

export function createPublicEffectConformanceBoundary(): PublicEffectConformanceBoundary {
  const activation = issuePublicEffectConformanceActivation();
  return Object.freeze({
    createContextBuilder(options: EffectInvocationContextBuilderOptions) {
      return createEffectInvocationContextBuilder(options, activation);
    },
    createRegistry(source: OperationRegistrySource) {
      return createOperationRegistry(source, activation);
    },
    async createRuntime(input: PublicEffectConformanceRuntimeInput) {
      const registry = await createOperationRegistry(input.source, activation);
      return createTrustedApplicationOperationRuntime({
        registry,
        read: input.read,
        unitOfWork: input.unitOfWork,
        ...(input.effectBuilder ? { effectBuilder: input.effectBuilder } : {}),
        ...(input.newReceiptId ? { newReceiptId: input.newReceiptId } : {})
      });
    }
  });
}
