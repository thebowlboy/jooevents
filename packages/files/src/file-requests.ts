import type { DeadlineReferencePinDto, DeadlineScopeDto } from '@jooevents/contracts/deadlines';
import type { DeadlineReferenceResolver } from '@jooevents/deadline';
import {
  fileRequestCreateInputSchema,
  fileRequestFulfillInputSchema,
  fileRequestWithdrawInputSchema,
  type FileRequestChangedFactPayload,
  type FileRequestCreateInput,
  type FileRequestDto,
  type FileRequestFulfillInput,
  type FileRequestWithdrawInput,
  type FileScopeDto
} from '@jooevents/contracts/files';
import type { FileAttachmentRepository } from './attachments';
import { deepFreeze, parseFileRequest, type FilesFact } from './model';

/**
 * D9: the ask loop. A file request is a typed ask (what, from which
 * engagement, by when) that projects into the portal and the signals rail. Its
 * "by when" is a reference into the existing deadline catalog resolved through
 * the deadline machinery's own resolver — file requests never grow private
 * deadline physics — and every state change emits the same fact envelope the
 * deadline domain emits, which is what the signals rail consumes.
 */
export interface FileRequestRepository {
  readFileRequest(scope: FileScopeDto, requestId: string): FileRequestDto | undefined;
  listFileRequestsForEngagement(
    scope: FileScopeDto,
    engagementId: string
  ): readonly FileRequestDto[];
  createFileRequest(request: FileRequestDto): void;
  transitionFileRequest(input: {
    readonly expected: FileRequestDto;
    readonly next: FileRequestDto;
  }): void;
}

export interface FileRequestEngagementSource {
  readEngagementState(
    scope: FileScopeDto,
    engagementId: string
  ): 'invited' | 'confirmed' | 'declined' | 'cancelled' | undefined;
}

export type FileRequestCreateResult =
  | {
      readonly kind: 'created';
      readonly request: FileRequestDto;
      readonly deadline: DeadlineReferencePinDto | null;
      readonly idempotent: boolean;
      readonly facts: readonly FilesFact<FileRequestChangedFactPayload>[];
    }
  | {
      readonly kind: 'refused';
      readonly code:
        | 'request_id_collision'
        | 'engagement_missing'
        | 'engagement_cancelled'
        | 'deadline_unavailable';
    };

export function createFileRequest(input: {
  readonly scope: FileScopeDto;
  readonly create: FileRequestCreateInput;
  readonly createdByUserId: string;
  readonly requests: FileRequestRepository;
  readonly engagements: FileRequestEngagementSource;
  readonly deadlines: DeadlineReferenceResolver;
  readonly now: string;
}): FileRequestCreateResult {
  const create = fileRequestCreateInputSchema.parse(input.create);
  const existing = input.requests.readFileRequest(input.scope, create.requestId);
  if (existing) {
    const identical = existing.engagementId === create.engagementId
      && existing.what === create.what
      && existing.instructions === create.instructions
      && existing.deadlineId === create.deadlineId
      && existing.state === 'open';
    if (!identical) return deepFreeze({ kind: 'refused', code: 'request_id_collision' });
    const deadline = existing.deadlineId === null
      ? null
      : resolveDeadline(input.deadlines, input.scope, existing.deadlineId);
    return deepFreeze({
      kind: 'created', request: existing, deadline: deadline ?? null,
      idempotent: true, facts: []
    });
  }
  const engagementState = input.engagements.readEngagementState(
    input.scope, create.engagementId
  );
  if (engagementState === undefined) {
    return deepFreeze({ kind: 'refused', code: 'engagement_missing' });
  }
  if (engagementState === 'cancelled') {
    return deepFreeze({ kind: 'refused', code: 'engagement_cancelled' });
  }
  let deadline: DeadlineReferencePinDto | null = null;
  if (create.deadlineId !== null) {
    const pin = resolveDeadline(input.deadlines, input.scope, create.deadlineId);
    if (!pin) return deepFreeze({ kind: 'refused', code: 'deadline_unavailable' });
    deadline = pin;
  }
  const request = parseFileRequest({
    schemaVersion: 1,
    id: create.requestId,
    scope: input.scope,
    engagementId: create.engagementId,
    what: create.what,
    instructions: create.instructions,
    deadlineId: create.deadlineId,
    state: 'open',
    fulfillingAttachmentId: null,
    createdByUserId: input.createdByUserId,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now
  });
  input.requests.createFileRequest(request);
  return deepFreeze({
    kind: 'created',
    request,
    deadline,
    idempotent: false,
    facts: [requestFact('create', request)]
  });
}

export type FileRequestWithdrawResult =
  | {
      readonly kind: 'withdrawn';
      readonly request: FileRequestDto;
      readonly facts: readonly FilesFact<FileRequestChangedFactPayload>[];
    }
  | {
      readonly kind: 'refused';
      readonly code: 'request_missing' | 'request_not_open' | 'stale_request';
    };

export function withdrawFileRequest(input: {
  readonly scope: FileScopeDto;
  readonly withdraw: FileRequestWithdrawInput;
  readonly requests: FileRequestRepository;
  readonly now: string;
}): FileRequestWithdrawResult {
  const withdraw = fileRequestWithdrawInputSchema.parse(input.withdraw);
  const current = input.requests.readFileRequest(input.scope, withdraw.requestId);
  if (!current) return deepFreeze({ kind: 'refused', code: 'request_missing' });
  if (current.state !== 'open') {
    return deepFreeze({ kind: 'refused', code: 'request_not_open' });
  }
  if (current.version !== withdraw.expectedVersion) {
    return deepFreeze({ kind: 'refused', code: 'stale_request' });
  }
  const next = parseFileRequest({
    ...current,
    state: 'withdrawn',
    version: current.version + 1,
    updatedAt: input.now
  });
  input.requests.transitionFileRequest({ expected: current, next });
  return deepFreeze({
    kind: 'withdrawn',
    request: next,
    facts: [requestFact('withdraw', next)]
  });
}

export type FileRequestFulfillResult =
  | {
      readonly kind: 'fulfilled';
      readonly request: FileRequestDto;
      readonly facts: readonly FilesFact<FileRequestChangedFactPayload>[];
    }
  | {
      readonly kind: 'refused';
      readonly code:
        | 'request_missing'
        | 'request_not_open'
        | 'stale_request'
        | 'attachment_missing'
        | 'attachment_detached'
        | 'attachment_subject_mismatch';
    };

/**
 * Fulfillment backlinks the exact attachment that satisfied the ask. The
 * attachment must be live and attached to the request's own engagement — a
 * portal speaker can only ever fulfil with material on their engagement.
 */
export function fulfillFileRequest(input: {
  readonly scope: FileScopeDto;
  readonly fulfill: FileRequestFulfillInput;
  readonly requests: FileRequestRepository;
  readonly attachments: Pick<FileAttachmentRepository, 'readAttachment'>;
  readonly now: string;
}): FileRequestFulfillResult {
  const fulfill = fileRequestFulfillInputSchema.parse(input.fulfill);
  const current = input.requests.readFileRequest(input.scope, fulfill.requestId);
  if (!current) return deepFreeze({ kind: 'refused', code: 'request_missing' });
  if (current.state !== 'open') {
    return deepFreeze({ kind: 'refused', code: 'request_not_open' });
  }
  if (current.version !== fulfill.expectedVersion) {
    return deepFreeze({ kind: 'refused', code: 'stale_request' });
  }
  const attachment = input.attachments.readAttachment(input.scope, fulfill.attachmentId);
  if (!attachment) return deepFreeze({ kind: 'refused', code: 'attachment_missing' });
  if (attachment.state !== 'attached') {
    return deepFreeze({ kind: 'refused', code: 'attachment_detached' });
  }
  if (attachment.subject.kind !== 'engagement'
      || attachment.subject.engagementId !== current.engagementId) {
    return deepFreeze({ kind: 'refused', code: 'attachment_subject_mismatch' });
  }
  const next = parseFileRequest({
    ...current,
    state: 'fulfilled',
    fulfillingAttachmentId: fulfill.attachmentId,
    version: current.version + 1,
    updatedAt: input.now
  });
  input.requests.transitionFileRequest({ expected: current, next });
  return deepFreeze({
    kind: 'fulfilled',
    request: next,
    facts: [requestFact('fulfill', next)]
  });
}

export interface FileRequestView {
  readonly request: FileRequestDto;
  /** Current pin of the referenced deadline; null when none or no longer active. */
  readonly deadline: DeadlineReferencePinDto | null;
}

/** Read-side join used by both the organizer overview and the portal projection. */
export function projectFileRequestView(input: {
  readonly request: FileRequestDto;
  readonly deadlines: DeadlineReferenceResolver;
}): FileRequestView {
  const deadline = input.request.deadlineId === null
    ? null
    : resolveDeadline(input.deadlines, input.request.scope, input.request.deadlineId) ?? null;
  return deepFreeze({ request: input.request, deadline });
}

function resolveDeadline(
  deadlines: DeadlineReferenceResolver,
  scope: FileScopeDto,
  deadlineId: string
): DeadlineReferencePinDto | undefined {
  const deadlineScope: DeadlineScopeDto = {
    workspaceId: scope.workspaceId,
    eventId: scope.eventId
  };
  return deadlines.resolveCurrentDeadline(deadlineScope, { deadlineId });
}

function requestFact(
  action: FileRequestChangedFactPayload['action'],
  request: FileRequestDto
): FilesFact<FileRequestChangedFactPayload> {
  return deepFreeze({
    kind: 'file_request_changed',
    version: 1 as const,
    payload: {
      action,
      requestId: request.id,
      engagementId: request.engagementId,
      state: request.state,
      version: request.version,
      deadlineId: request.deadlineId
    }
  });
}
