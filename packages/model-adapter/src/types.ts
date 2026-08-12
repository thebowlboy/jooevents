import type {
  AgentRunId,
  AggregateVersion,
  AuthorityCitationId,
  ModelAttemptId,
  ModelToolCallId,
  OperationReceiptId,
  PayloadRef,
  UtcInstant
} from '@jooevents/kernel';
import type {
  ModelProviderIdempotencyKey,
  ModelRequestBinding,
  ModelToolInputBinding
} from './bindings';

export type ModelExecutionMode = 'batch' | 'fast';
export type ModelMessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface ModelDefinitionRef {
  readonly key: string;
  readonly version: number;
}

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string;
  readonly toolCallId?: string;
}

export interface ModelToolDefinition {
  readonly operation: { readonly name: string; readonly version: number };
  readonly description: string;
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
}

export interface ModelOutputJsonSchema {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly strict: true;
}

export interface NormalizedModelControls {
  readonly effort?: 'minimal' | 'low' | 'medium' | 'high';
  readonly maxOutputTokens: number;
  readonly requireStructuredOutput: boolean;
  readonly temperature?: number;
}

export interface ModelBudget {
  readonly maximumAttempts: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostMicros: number;
  readonly timeoutMs: number;
}

export interface ModelProfileRevision {
  readonly key: string;
  readonly version: number;
  readonly digest: string;
  readonly adapter: ModelDefinitionRef;
  readonly modelId: string;
  readonly controls: NormalizedModelControls;
  readonly defaultExecutionMode: ModelExecutionMode;
  readonly budget: ModelBudget;
  readonly capabilities: ProviderCapabilities;
  readonly providerParameterBinding?: {
    readonly payload: PayloadRef;
    readonly schema: ModelDefinitionRef;
  };
}

export interface ModelScaffoldRevision {
  readonly key: string;
  readonly version: number;
  readonly digest: string;
  readonly purpose: string;
  readonly outputSchema: ModelDefinitionRef;
  readonly allowedTools: readonly { readonly name: string; readonly version: number }[];
}

export interface ProviderCapabilities {
  readonly structuredOutput: boolean;
  readonly tools: boolean;
  readonly batch: boolean;
  readonly fast: boolean;
  readonly lookup: boolean;
  readonly cancellation: boolean;
  readonly idempotency: boolean;
}

export interface ModelAttemptRequest {
  readonly runId: AgentRunId;
  readonly attemptId: ModelAttemptId;
  readonly requestBinding: ModelRequestBinding;
  readonly profile: ModelProfileRevision;
  readonly scaffold: ModelScaffoldRevision;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly outputJsonSchema?: ModelOutputJsonSchema;
  readonly executionMode?: ModelExecutionMode;
  readonly providerIdempotencyKey: ModelProviderIdempotencyKey;
}

export interface NormalizedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly costMicros?: number;
}

export interface SafeProviderEvidence {
  readonly adapter: ModelDefinitionRef;
  readonly providerRequestId?: string;
  readonly idempotencySupported: boolean;
  readonly executionMode?: ModelExecutionMode;
  readonly resolvedControls?: Readonly<Record<string, string | number | boolean>>;
}

export interface ModelToolRequest {
  readonly callId: string;
  readonly operation: { readonly name: string; readonly version: number };
  readonly input: unknown;
}

export type ModelAttemptObservation<Output = unknown> =
  | {
      readonly kind: 'succeeded';
      readonly output: Output;
      readonly usage: NormalizedUsage;
      readonly evidence: SafeProviderEvidence;
    }
  | {
      readonly kind: 'tool_requests';
      readonly requests: readonly ModelToolRequest[];
      readonly usage: NormalizedUsage;
      readonly evidence: SafeProviderEvidence;
    }
  | {
      readonly kind: 'schema_invalid';
      readonly rawOutputRef: PayloadRef;
      readonly usage: NormalizedUsage;
      readonly safeCode: string;
      readonly evidence: SafeProviderEvidence;
    }
  | {
      readonly kind: 'known_failure';
      readonly safeCode: string;
      readonly retryability: 'never' | 'policy';
      readonly usage?: NormalizedUsage;
      readonly evidence?: SafeProviderEvidence;
    }
  | {
      readonly kind: 'acceptance_unknown';
      readonly evidence: SafeProviderEvidence;
      readonly recovery: 'lookup' | 'idempotent_reuse' | 'manual';
    }
  | {
      readonly kind: 'cancelled';
      readonly usage?: NormalizedUsage;
      readonly evidence?: SafeProviderEvidence;
    };

export type ModelLookupObservation<Output = unknown> =
  | ModelAttemptObservation<Output>
  | { readonly kind: 'pending'; readonly evidence: SafeProviderEvidence }
  | { readonly kind: 'not_found' };

export type ModelCancelObservation =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'too_late' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unsupported' };

export interface ModelProviderAdapter {
  readonly ref: ModelDefinitionRef;
  describeCapabilities(): ProviderCapabilities;
  execute(request: ModelAttemptRequest): Promise<ModelAttemptObservation>;
  lookup(evidence: SafeProviderEvidence, frozenRequest: ModelAttemptRequest): Promise<ModelLookupObservation>;
  cancel(evidence: SafeProviderEvidence): Promise<ModelCancelObservation>;
}

export type ModelRunState =
  | 'queued'
  | 'running'
  | 'waiting_for_tool'
  | 'reconciling'
  | 'cancel_requested'
  | 'attention'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'exhausted';

export interface ModelUsageLedger {
  readonly attemptsObserved: number;
  readonly reportedInputTokens: number;
  readonly reportedOutputTokens: number;
  readonly reportedCachedInputTokens: number;
  readonly reportedCostMicros: number;
  readonly missing: readonly ('inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'costMicros')[];
}

export interface ModelRunRecord {
  readonly id: AgentRunId;
  readonly version: AggregateVersion;
  readonly state: ModelRunState;
  readonly profile: ModelDefinitionRef & { readonly digest: string };
  readonly profileAdapter: ModelDefinitionRef;
  readonly scaffold: ModelDefinitionRef & { readonly digest: string };
  readonly sourceOperation: { readonly name: string; readonly version: number; readonly receiptId: OperationReceiptId };
  readonly scopeKey: string;
  readonly authorityCitationId: AuthorityCitationId;
  readonly classifiedInputRefs: readonly PayloadRef[];
  readonly requestedOutputSchema: ModelDefinitionRef;
  readonly budget: ModelBudget;
  readonly usage: ModelUsageLedger;
  readonly attemptsStarted: number;
  readonly reservedCostMicros: number;
  readonly activeAttempt?: { readonly id: ModelAttemptId; readonly fence: number };
  readonly pendingIntervention?: {
    readonly sourceAttemptId: ModelAttemptId;
    readonly reason: 'provider_failure' | 'schema_invalid' | 'acceptance_unknown' | 'budget_exhausted';
    readonly providerRetryability?: 'never' | 'policy';
    readonly providerRecovery?: 'lookup' | 'idempotent_reuse' | 'manual';
    readonly providerIdempotencySupported?: boolean;
    readonly requiredRetryRequestBinding?: ModelRequestBinding;
  };
  readonly lastInterventionEvidenceId?: string;
  readonly retryAllowance?: {
    readonly evidenceId: string;
    readonly sourceAttemptId: ModelAttemptId;
    readonly maximumCostReservationMicros: number;
    readonly acceptsUnknownUsage: boolean;
    readonly requiredRequestBinding?: ModelRequestBinding;
  };
  readonly lastCancellationResult?: {
    readonly attemptId: ModelAttemptId;
    readonly fence: number;
    readonly outcome: ModelCancelObservation['kind'];
    readonly observedAt: UtcInstant;
  };
  readonly resultRef?: PayloadRef;
  readonly safeFailureCode?: string;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface ModelAttemptRecord {
  readonly id: ModelAttemptId;
  readonly runId: AgentRunId;
  readonly number: number;
  readonly fence: number;
  readonly requestBinding: ModelRequestBinding;
  readonly adapter: ModelDefinitionRef;
  readonly costReservationMicros: number;
  readonly executionMode: ModelExecutionMode;
  readonly state: 'started' | 'succeeded' | 'tool_requests' | 'schema_invalid' | 'known_failure' | 'acceptance_unknown' | 'cancelled';
  readonly evidence?: SafeProviderEvidence;
  readonly usage?: NormalizedUsage;
  readonly requestedTools?: readonly {
    readonly providerCallId: string;
    readonly operation: { readonly name: string; readonly version: number };
  }[];
  readonly startedAt: UtcInstant;
  readonly finishedAt?: UtcInstant;
}

export interface ModelToolCallRecord {
  readonly id: ModelToolCallId;
  readonly runId: AgentRunId;
  readonly attemptId: ModelAttemptId;
  readonly sequence: number;
  readonly providerCallId: string;
  readonly operation: { readonly name: string; readonly version: number };
  readonly inputRef: PayloadRef;
  readonly inputBinding: ModelToolInputBinding;
  readonly operationReceiptId?: OperationReceiptId;
}
