import type {
  EffectInvocationBuilder,
  EffectOperationExecutor
} from '@jooevents/application';
import { attachDirectOperationFeatureContext } from '@jooevents/application';
import type { AirtableControlledOperationPort, AirtableInboundOperationResult, AirtableInboundSubject } from './inbound-control';

const TASK_MUTATION = Object.freeze({ name: 'task.mutation', version: 1 });
const ENGAGEMENT_CHANGE = Object.freeze({ name: 'engagement.change', version: 1 });

export interface AirtableDeletionReviewOperation {
  request(input: Readonly<{
    subject: AirtableInboundSubject;
    idempotencyKey: string;
  }>): Promise<AirtableInboundOperationResult>;
}

function result(value: Awaited<ReturnType<EffectOperationExecutor['execute']>>): AirtableInboundOperationResult {
  if (value.kind === 'success') {
    return { kind: 'applied', operationReceiptId: value.receipt.id };
  }
  if (value.outcome.retryable) {
    return { kind: 'retry', code: value.outcome.kind, retryAfterMs: 5_000 };
  }
  return {
    kind: value.outcome.class === 'stale_revision' ? 'already_current' : 'refused',
    ...(value.terminal ? { operationReceiptId: value.receipt.id } : {}),
    ...(value.outcome.class === 'stale_revision' ? {} : { code: value.outcome.kind })
  } as AirtableInboundOperationResult;
}

/**
 * Binds the finite Airtable methods to the ordinary registered operation executor.
 * The caller supplies verified-inbox evidence; Airtable values never select names.
 */
export class RegisteredOperationAirtableInboundPort implements AirtableControlledOperationPort {
  constructor(private readonly input: Readonly<{
    builder: EffectInvocationBuilder;
    executor: EffectOperationExecutor;
    verifiedInboxEvidence: unknown;
    deletionReview: AirtableDeletionReviewOperation;
    newCorrelationId(): string;
  }>) {}

  private async execute(
    operation: Readonly<{ name: string; version: number }>,
    businessInput: unknown,
    idempotencyKey: string,
    featureContext: unknown
  ) {
    const invocation = await this.input.builder.build({
      operationName: operation.name, operationVersion: operation.version,
      surface: 'provider_ingress', correlationId: this.input.newCorrelationId(),
      businessInput, verifiedEvidence: this.input.verifiedInboxEvidence,
      rawIdempotencyKey: idempotencyKey
    });
    if (featureContext !== undefined) attachDirectOperationFeatureContext(invocation, featureContext);
    const resolved = result(await this.input.executor.execute(invocation));
    return resolved.kind === 'applied'
      ? Object.freeze({ ...resolved, boundaryRecorded: true })
      : resolved;
  }

  setTaskAssignmentStatus(input: Parameters<AirtableControlledOperationPort['setTaskAssignmentStatus']>[0]) {
    return this.execute(TASK_MUTATION, {
      action: input.status === 'complete' ? 'accept_fulfillment' : 'restore_assignment',
      assignmentId: input.assignmentId, expectedVersion: input.expectedVersion
    }, input.idempotencyKey, input.featureContext);
  }

  setEngagementCancellationRequest(input: Parameters<AirtableControlledOperationPort['setEngagementCancellationRequest']>[0]) {
    return this.execute(ENGAGEMENT_CHANGE, input.requested ? {
      action: 'request_cancellation', engagementId: input.engagementId,
      expectedEngagementVersion: input.expectedVersion, requestedBy: 'organizer',
      ...(input.note ? { note: input.note } : {})
    } : {
      action: 'withdraw_cancellation', engagementId: input.engagementId,
      expectedEngagementVersion: input.expectedVersion
    }, input.idempotencyKey, input.featureContext);
  }

  requestRecordDeletionReview(input: Parameters<AirtableControlledOperationPort['requestRecordDeletionReview']>[0]) {
    return this.input.deletionReview.request(input);
  }
}
