import { describe, expect, test } from 'bun:test';
import type {
  FileAttachmentDto,
  FileAttachmentSubjectDto,
  FileScopeDto
} from '@jooevents/contracts/files';
import {
  attachFileAsset,
  attachFileLink,
  detachFileAttachment,
  subjectKey,
  type FileAttachmentRepository,
  type FileAttachmentSubjectSource
} from './attachments';
import { FIXTURE_SCOPE, LATER, NOW, OPERATOR, SPEAKER, fixtureAsset, fixtureId } from './test-fixtures';

export class MemoryAttachments implements FileAttachmentRepository {
  readonly rows = new Map<string, FileAttachmentDto>();
  readAttachment(scope: FileScopeDto, attachmentId: string): FileAttachmentDto | undefined {
    const row = this.rows.get(attachmentId);
    return row && row.scope.eventId === scope.eventId ? row : undefined;
  }
  listAttachmentsForSubject(
    scope: FileScopeDto,
    subject: FileAttachmentSubjectDto
  ): readonly FileAttachmentDto[] {
    return [...this.rows.values()].filter((row) =>
      row.scope.eventId === scope.eventId && subjectKey(row.subject) === subjectKey(subject));
  }
  countLiveAssetReferences(scope: FileScopeDto, assetId: string): number {
    return [...this.rows.values()].filter((row) =>
      row.scope.eventId === scope.eventId
      && row.state === 'attached'
      && row.content.kind === 'asset'
      && row.content.assetId === assetId).length;
  }
  createAttachment(attachment: FileAttachmentDto): void {
    if (this.rows.has(attachment.id)) throw new Error('duplicate_attachment');
    this.rows.set(attachment.id, attachment);
  }
  transitionAttachment(input: {
    readonly expected: FileAttachmentDto;
    readonly next: FileAttachmentDto;
  }): void {
    const current = this.rows.get(input.expected.id);
    if (!current || current.version !== input.expected.version) throw new Error('attachment_drift');
    this.rows.set(input.next.id, input.next);
  }
}

const allSubjects: FileAttachmentSubjectSource = { subjectExists: () => true };
const noSubjects: FileAttachmentSubjectSource = { subjectExists: () => false };
const engagementSubject: FileAttachmentSubjectDto = {
  kind: 'engagement',
  engagementId: '33333333-0000-4000-8000-000000000001'
};

describe('attachments and refcounts (D7)', () => {
  test('attaches an available asset with a receipt-bound fact and counts references', () => {
    const attachments = new MemoryAttachments();
    const asset = fixtureAsset();
    const attachmentId = fixtureId();
    const result = attachFileAsset({
      scope: FIXTURE_SCOPE,
      attach: { attachmentId, subject: engagementSubject, assetId: asset.id },
      actor: SPEAKER,
      attachments,
      assets: { readAsset: () => asset },
      subjects: allSubjects,
      now: NOW
    });
    if (result.kind !== 'attached') throw new Error('expected attach');
    expect(result.attachment).toMatchObject({
      id: attachmentId,
      subject: engagementSubject,
      content: { kind: 'asset', assetId: asset.id },
      state: 'attached',
      version: 1
    });
    expect(result.facts).toEqual([{
      kind: 'file_attachment_changed',
      version: 1,
      payload: {
        action: 'attach', attachmentId, subject: engagementSubject,
        assetId: asset.id, version: 1
      }
    }]);
    expect(attachments.countLiveAssetReferences(FIXTURE_SCOPE, asset.id)).toBe(1);

    const replay = attachFileAsset({
      scope: FIXTURE_SCOPE,
      attach: { attachmentId, subject: engagementSubject, assetId: asset.id },
      actor: SPEAKER,
      attachments,
      assets: { readAsset: () => asset },
      subjects: allSubjects,
      now: LATER
    });
    if (replay.kind !== 'attached') throw new Error('expected idempotent attach');
    expect(replay.idempotent).toBe(true);
    expect(replay.facts).toEqual([]);
  });

  test('refuses missing subjects, missing assets, and unreleased or blocked assets', () => {
    const attachments = new MemoryAttachments();
    const base = {
      scope: FIXTURE_SCOPE,
      actor: SPEAKER,
      attachments,
      subjects: allSubjects,
      now: NOW
    };
    expect(attachFileAsset({
      ...base,
      attach: { attachmentId: fixtureId(), subject: engagementSubject, assetId: fixtureId() },
      assets: { readAsset: () => undefined },
      subjects: noSubjects
    })).toEqual({ kind: 'refused', code: 'subject_missing' });
    expect(attachFileAsset({
      ...base,
      attach: { attachmentId: fixtureId(), subject: engagementSubject, assetId: fixtureId() },
      assets: { readAsset: () => undefined }
    })).toEqual({ kind: 'refused', code: 'asset_missing' });
    expect(attachFileAsset({
      ...base,
      attach: { attachmentId: fixtureId(), subject: engagementSubject, assetId: fixtureId() },
      assets: {
        readAsset: () => fixtureAsset({
          lifecycle: 'pending_scan',
          scan: { provider: 'clamav', verdict: 'pending', checkedAt: null }
        })
      }
    })).toEqual({ kind: 'refused', code: 'asset_not_available' });
    expect(attachFileAsset({
      ...base,
      attach: { attachmentId: fixtureId(), subject: engagementSubject, assetId: fixtureId() },
      assets: {
        readAsset: () => fixtureAsset({
          lifecycle: 'blocked',
          scan: { provider: 'clamav', verdict: 'blocked', checkedAt: NOW }
        })
      }
    })).toEqual({ kind: 'refused', code: 'asset_blocked' });
  });

  test('link-attach stores the typed https link verbatim with no fetch path (D6)', () => {
    const attachments = new MemoryAttachments();
    const attachmentId = fixtureId();
    const link = {
      provider: 'drive' as const,
      label: 'Rehearsal video',
      url: 'https://drive.google.com/file/d/abc/view'
    };
    const result = attachFileLink({
      scope: FIXTURE_SCOPE,
      attach: { attachmentId, subject: engagementSubject, link },
      actor: SPEAKER,
      attachments,
      subjects: allSubjects,
      now: NOW
    });
    if (result.kind !== 'attached') throw new Error('expected link attach');
    expect(result.attachment.content).toEqual({ kind: 'link', link });
    expect(result.facts[0]?.payload).toMatchObject({ action: 'link_attach', assetId: null });
    // http downgrades refuse at the schema boundary.
    expect(() => attachFileLink({
      scope: FIXTURE_SCOPE,
      attach: {
        attachmentId: fixtureId(),
        subject: engagementSubject,
        link: { ...link, url: 'http://drive.google.com/file' }
      },
      actor: SPEAKER,
      attachments,
      subjects: allSubjects,
      now: NOW
    })).toThrow();
  });

  test('detach is version-guarded compensation and drops the live refcount', () => {
    const attachments = new MemoryAttachments();
    const asset = fixtureAsset();
    const attachmentId = fixtureId();
    const attached = attachFileAsset({
      scope: FIXTURE_SCOPE,
      attach: { attachmentId, subject: engagementSubject, assetId: asset.id },
      actor: OPERATOR,
      attachments,
      assets: { readAsset: () => asset },
      subjects: allSubjects,
      now: NOW
    });
    if (attached.kind !== 'attached') throw new Error('expected attach');

    expect(detachFileAttachment({
      scope: FIXTURE_SCOPE,
      detach: { attachmentId, expectedVersion: 99 },
      attachments,
      now: LATER
    })).toEqual({ kind: 'refused', code: 'stale_attachment' });

    const detached = detachFileAttachment({
      scope: FIXTURE_SCOPE,
      detach: { attachmentId, expectedVersion: 1 },
      attachments,
      now: LATER
    });
    if (detached.kind !== 'detached') throw new Error('expected detach');
    expect(detached.attachment).toMatchObject({
      state: 'detached', version: 2, detachedAt: LATER
    });
    expect(detached.facts[0]?.payload.action).toBe('detach');
    expect(attachments.countLiveAssetReferences(FIXTURE_SCOPE, asset.id)).toBe(0);

    expect(detachFileAttachment({
      scope: FIXTURE_SCOPE,
      detach: { attachmentId, expectedVersion: 2 },
      attachments,
      now: LATER
    })).toEqual({ kind: 'refused', code: 'already_detached' });
  });
});
