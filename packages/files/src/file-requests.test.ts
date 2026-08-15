import { describe, expect, test } from 'bun:test';
import type { DeadlineReferencePinDto } from '@jooevents/contracts/deadlines';
import type { FileRequestDto, FileScopeDto } from '@jooevents/contracts/files';
import type { DeadlineReferenceResolver } from '@jooevents/deadline';
import {
  createFileRequest,
  fulfillFileRequest,
  projectFileRequestView,
  withdrawFileRequest,
  type FileRequestEngagementSource,
  type FileRequestRepository
} from './file-requests';
import { MemoryAttachments } from './attachments.test';
import { attachFileAsset } from './attachments';
import { FIXTURE_SCOPE, LATER, NOW, SPEAKER, fixtureAsset, fixtureId } from './test-fixtures';

class MemoryRequests implements FileRequestRepository {
  readonly rows = new Map<string, FileRequestDto>();
  readFileRequest(scope: FileScopeDto, requestId: string): FileRequestDto | undefined {
    const row = this.rows.get(requestId);
    return row && row.scope.eventId === scope.eventId ? row : undefined;
  }
  listFileRequestsForEngagement(
    scope: FileScopeDto,
    engagementId: string
  ): readonly FileRequestDto[] {
    return [...this.rows.values()].filter((row) =>
      row.scope.eventId === scope.eventId && row.engagementId === engagementId);
  }
  createFileRequest(request: FileRequestDto): void {
    if (this.rows.has(request.id)) throw new Error('duplicate_request');
    this.rows.set(request.id, request);
  }
  transitionFileRequest(input: {
    readonly expected: FileRequestDto;
    readonly next: FileRequestDto;
  }): void {
    const current = this.rows.get(input.expected.id);
    if (!current || current.version !== input.expected.version) throw new Error('request_drift');
    this.rows.set(input.next.id, input.next);
  }
}

const ENGAGEMENT_ID = '33333333-0000-4000-8000-000000000001';
const DEADLINE_ID = '33333333-0000-4000-8000-000000000002';

const deadlinePin: DeadlineReferencePinDto = {
  id: DEADLINE_ID,
  version: 3,
  digestSha256: 'c'.repeat(64),
  effectiveAt: '2026-09-02T03:59:59.999Z',
  displayDate: '2026-09-01',
  gracePolicy: 'soft'
};

const resolvingDeadlines: DeadlineReferenceResolver = {
  resolveCurrentDeadline: (_scope, reference) =>
    reference.deadlineId === DEADLINE_ID ? deadlinePin : undefined
};

const engagements: FileRequestEngagementSource = {
  readEngagementState: (_scope, engagementId) =>
    engagementId === ENGAGEMENT_ID ? 'confirmed' : undefined
};

const CREATED_BY = '11111111-0000-4000-8000-000000000010';

function create(requests: FileRequestRepository, overrides: {
  readonly requestId?: string;
  readonly deadlineId?: string | null;
  readonly engagementId?: string;
} = {}) {
  return createFileRequest({
    scope: FIXTURE_SCOPE,
    create: {
      requestId: overrides.requestId ?? fixtureId(),
      engagementId: overrides.engagementId ?? ENGAGEMENT_ID,
      what: 'Final slide deck',
      instructions: 'PDF export, 16:9.',
      deadlineId: overrides.deadlineId === undefined ? DEADLINE_ID : overrides.deadlineId
    },
    createdByUserId: CREATED_BY,
    requests,
    engagements,
    deadlines: resolvingDeadlines,
    now: NOW
  });
}

describe('file requests (D9, the ask loop)', () => {
  test('creates a typed ask riding an existing deadline pin and emits the fact signal', () => {
    const requests = new MemoryRequests();
    const requestId = fixtureId();
    const created = create(requests, { requestId });
    if (created.kind !== 'created') throw new Error('expected creation');
    expect(created.request).toMatchObject({
      id: requestId,
      engagementId: ENGAGEMENT_ID,
      what: 'Final slide deck',
      deadlineId: DEADLINE_ID,
      state: 'open',
      fulfillingAttachmentId: null,
      version: 1
    });
    expect(created.deadline).toEqual(deadlinePin);
    expect(created.facts).toEqual([{
      kind: 'file_request_changed',
      version: 1,
      payload: {
        action: 'create', requestId, engagementId: ENGAGEMENT_ID,
        state: 'open', version: 1, deadlineId: DEADLINE_ID
      }
    }]);
    const replay = create(requests, { requestId });
    if (replay.kind !== 'created') throw new Error('expected idempotent creation');
    expect(replay.idempotent).toBe(true);
    expect(replay.facts).toEqual([]);
  });

  test('refuses unknown engagements and unresolvable deadlines — no silent asks', () => {
    const requests = new MemoryRequests();
    expect(create(requests, { engagementId: fixtureId() }))
      .toEqual({ kind: 'refused', code: 'engagement_missing' });
    expect(create(requests, { deadlineId: fixtureId() }))
      .toEqual({ kind: 'refused', code: 'deadline_unavailable' });
    const withoutDeadline = create(requests, { deadlineId: null });
    if (withoutDeadline.kind !== 'created') throw new Error('expected creation');
    expect(withoutDeadline.deadline).toBeNull();
  });

  test('withdraw closes an open ask under a version guard', () => {
    const requests = new MemoryRequests();
    const requestId = fixtureId();
    const created = create(requests, { requestId });
    if (created.kind !== 'created') throw new Error('expected creation');
    expect(withdrawFileRequest({
      scope: FIXTURE_SCOPE,
      withdraw: { requestId, expectedVersion: 9 },
      requests, now: LATER
    })).toEqual({ kind: 'refused', code: 'stale_request' });
    const withdrawn = withdrawFileRequest({
      scope: FIXTURE_SCOPE,
      withdraw: { requestId, expectedVersion: 1 },
      requests, now: LATER
    });
    if (withdrawn.kind !== 'withdrawn') throw new Error('expected withdrawal');
    expect(withdrawn.request.state).toBe('withdrawn');
    expect(withdrawn.facts[0]?.payload.action).toBe('withdraw');
    expect(withdrawFileRequest({
      scope: FIXTURE_SCOPE,
      withdraw: { requestId, expectedVersion: 2 },
      requests, now: LATER
    })).toEqual({ kind: 'refused', code: 'request_not_open' });
  });

  test('fulfilment backlinks exactly a live attachment on the request engagement', () => {
    const requests = new MemoryRequests();
    const attachments = new MemoryAttachments();
    const requestId = fixtureId();
    const created = create(requests, { requestId });
    if (created.kind !== 'created') throw new Error('expected creation');

    const asset = fixtureAsset();
    const rightAttachment = fixtureId();
    const wrongSubjectAttachment = fixtureId();
    const attachRight = attachFileAsset({
      scope: FIXTURE_SCOPE,
      attach: {
        attachmentId: rightAttachment,
        subject: { kind: 'engagement', engagementId: ENGAGEMENT_ID },
        assetId: asset.id
      },
      actor: SPEAKER,
      attachments,
      assets: { readAsset: () => asset },
      subjects: { subjectExists: () => true },
      now: NOW
    });
    if (attachRight.kind !== 'attached') throw new Error('expected attach');
    const attachWrong = attachFileAsset({
      scope: FIXTURE_SCOPE,
      attach: {
        attachmentId: wrongSubjectAttachment,
        subject: { kind: 'session', sessionId: fixtureId() },
        assetId: asset.id
      },
      actor: SPEAKER,
      attachments,
      assets: { readAsset: () => asset },
      subjects: { subjectExists: () => true },
      now: NOW
    });
    if (attachWrong.kind !== 'attached') throw new Error('expected attach');

    expect(fulfillFileRequest({
      scope: FIXTURE_SCOPE,
      fulfill: { requestId, attachmentId: wrongSubjectAttachment, expectedVersion: 1 },
      requests, attachments, now: LATER
    })).toEqual({ kind: 'refused', code: 'attachment_subject_mismatch' });
    expect(fulfillFileRequest({
      scope: FIXTURE_SCOPE,
      fulfill: { requestId, attachmentId: fixtureId(), expectedVersion: 1 },
      requests, attachments, now: LATER
    })).toEqual({ kind: 'refused', code: 'attachment_missing' });

    const fulfilled = fulfillFileRequest({
      scope: FIXTURE_SCOPE,
      fulfill: { requestId, attachmentId: rightAttachment, expectedVersion: 1 },
      requests, attachments, now: LATER
    });
    if (fulfilled.kind !== 'fulfilled') throw new Error('expected fulfilment');
    expect(fulfilled.request).toMatchObject({
      state: 'fulfilled',
      fulfillingAttachmentId: rightAttachment,
      version: 2
    });
    expect(fulfilled.facts[0]?.payload).toMatchObject({ action: 'fulfill', state: 'fulfilled' });
  });

  test('the read view resolves the referenced deadline to its current pin like intake forms', () => {
    const requests = new MemoryRequests();
    const created = create(requests);
    if (created.kind !== 'created') throw new Error('expected creation');
    const view = projectFileRequestView({ request: created.request, deadlines: resolvingDeadlines });
    expect(view.deadline).toEqual(deadlinePin);
    const gone: DeadlineReferenceResolver = { resolveCurrentDeadline: () => undefined };
    expect(projectFileRequestView({ request: created.request, deadlines: gone }).deadline)
      .toBeNull();
  });
});
