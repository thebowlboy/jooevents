import { describe, expect, test } from 'bun:test';
import {
  FILE_CONTENT_TYPES,
  FILE_IMAGE_CONTENT_TYPES,
  INERT_DOWNLOAD_FORBIDDEN_CONTENT_TYPES,
  fileAssetSchema,
  fileAttachmentSchema,
  fileContentTypeSchema,
  fileDisplayFilenameSchema,
  fileLinkSchema,
  fileRequestSchema,
  fileUploadIntentSchema,
  fileUploadLimitsSchema,
  resourceShareSchema
} from './files';

const uuid = (last: string) => `019c1df7-86b5-769b-bba4-5f7097bfa${last}`;
const scope = { workspaceId: uuid('001'), eventId: uuid('002') };
const NOW = '2026-08-15T10:00:00.000Z';

const asset = {
  schemaVersion: 1,
  id: uuid('101'),
  scope,
  uploader: { kind: 'participant', participantIdentityId: uuid('102') },
  purpose: 'engagement_material',
  displayFilename: 'deck.pdf',
  contentType: 'application/pdf',
  byteSize: 1024,
  sha256: 'a'.repeat(64),
  storageProvider: 'filesystem',
  storageKey: `files/${scope.workspaceId}/${scope.eventId}/${uuid('103')}`,
  lifecycle: 'available',
  scan: { provider: 'none', verdict: 'released', checkedAt: NOW },
  version: 1,
  createdAt: NOW,
  updatedAt: NOW
};

describe('files contracts', () => {
  test('the D3 allowlist is closed and never intersects the inert-serving forbidden set', () => {
    expect(FILE_CONTENT_TYPES).toHaveLength(7);
    for (const forbidden of INERT_DOWNLOAD_FORBIDDEN_CONTENT_TYPES) {
      expect(FILE_CONTENT_TYPES as readonly string[]).not.toContain(forbidden);
    }
    for (const image of FILE_IMAGE_CONTENT_TYPES) {
      expect(FILE_CONTENT_TYPES as readonly string[]).toContain(image);
    }
    expect(fileContentTypeSchema.safeParse('text/html').success).toBe(false);
    expect(fileContentTypeSchema.safeParse('video/mp4').success).toBe(false);
  });

  test('display filenames refuse path shapes and control characters', () => {
    expect(fileDisplayFilenameSchema.safeParse('deck v2.pdf').success).toBe(true);
    expect(fileDisplayFilenameSchema.safeParse('a/b.pdf').success).toBe(false);
    expect(fileDisplayFilenameSchema.safeParse('a\\b.pdf').success).toBe(false);
    expect(fileDisplayFilenameSchema.safeParse('.hidden').success).toBe(false);
    expect(fileDisplayFilenameSchema.safeParse(' padded.pdf').success).toBe(false);
  });

  test('asset lifecycle and scan verdict cohere', () => {
    expect(fileAssetSchema.safeParse(asset).success).toBe(true);
    expect(fileAssetSchema.safeParse({
      ...asset, lifecycle: 'blocked'
    }).success).toBe(false);
    expect(fileAssetSchema.safeParse({
      ...asset, scan: { provider: 'clamav', verdict: 'pending', checkedAt: null }
    }).success).toBe(false);
  });

  test('upload intents pair stream evidence with their state', () => {
    const intent = {
      schemaVersion: 1,
      id: uuid('201'),
      scope,
      uploader: { kind: 'operator_user', userId: uuid('202') },
      purpose: 'resource_share_material',
      displayFilename: 'template.pptx',
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      declaredByteSize: 100,
      maximumByteSize: 1000,
      storageProvider: 'filesystem',
      storageKey: 'files/a/b/c',
      state: 'pending',
      storedByteSize: null,
      storedSha256: null,
      createdAt: NOW,
      expiresAt: NOW
    };
    expect(fileUploadIntentSchema.safeParse(intent).success).toBe(true);
    expect(fileUploadIntentSchema.safeParse({
      ...intent, state: 'stored'
    }).success).toBe(false);
    expect(fileUploadIntentSchema.safeParse({
      ...intent, state: 'stored', storedByteSize: 90, storedSha256: 'b'.repeat(64)
    }).success).toBe(true);
    expect(fileUploadIntentSchema.safeParse({
      ...intent, storedByteSize: 90
    }).success).toBe(false);
  });

  test('link attachments are https-only typed links; attach/detach states cohere', () => {
    expect(fileLinkSchema.safeParse({
      provider: 'drive', label: 'Video', url: 'https://drive.google.com/x'
    }).success).toBe(true);
    expect(fileLinkSchema.safeParse({
      provider: 'url', label: 'Video', url: 'http://example.com'
    }).success).toBe(false);
    const attachment = {
      schemaVersion: 1,
      id: uuid('301'),
      scope,
      subject: { kind: 'engagement', engagementId: uuid('302') },
      content: { kind: 'asset', assetId: uuid('303') },
      attachedBy: { kind: 'participant', participantIdentityId: uuid('304') },
      state: 'attached',
      version: 1,
      attachedAt: NOW,
      detachedAt: null
    };
    expect(fileAttachmentSchema.safeParse(attachment).success).toBe(true);
    expect(fileAttachmentSchema.safeParse({
      ...attachment, state: 'detached'
    }).success).toBe(false);
    expect(fileAttachmentSchema.safeParse({
      ...attachment, state: 'detached', version: 2, detachedAt: NOW
    }).success).toBe(true);
  });

  test('shares and requests pin their terminal-state evidence', () => {
    const share = {
      schemaVersion: 1,
      id: uuid('401'),
      scope,
      title: 'AV guide',
      audience: { kind: 'all_confirmed' },
      createdByUserId: uuid('402'),
      state: 'active',
      version: 1,
      createdAt: NOW,
      revokedAt: null
    };
    expect(resourceShareSchema.safeParse(share).success).toBe(true);
    expect(resourceShareSchema.safeParse({ ...share, state: 'revoked' }).success).toBe(false);
    const request = {
      schemaVersion: 1,
      id: uuid('501'),
      scope,
      engagementId: uuid('502'),
      what: 'Final deck',
      instructions: null,
      deadlineId: null,
      state: 'open',
      fulfillingAttachmentId: null,
      createdByUserId: uuid('503'),
      version: 1,
      createdAt: NOW,
      updatedAt: NOW
    };
    expect(fileRequestSchema.safeParse(request).success).toBe(true);
    expect(fileRequestSchema.safeParse({ ...request, state: 'fulfilled' }).success).toBe(false);
    expect(fileRequestSchema.safeParse({
      ...request, state: 'fulfilled', fulfillingAttachmentId: uuid('504')
    }).success).toBe(true);
  });

  test('the D4 limits object is fully typed and positive', () => {
    expect(fileUploadLimitsSchema.safeParse({
      maxUploadBytesSpeaker: 100 * 1024 * 1024,
      maxUploadBytesOrganizer: 250 * 1024 * 1024,
      maxTotalBytesPerSpeakerPerEvent: 1024 * 1024 * 1024
    }).success).toBe(true);
    expect(fileUploadLimitsSchema.safeParse({
      maxUploadBytesSpeaker: 0,
      maxUploadBytesOrganizer: 1,
      maxTotalBytesPerSpeakerPerEvent: 1
    }).success).toBe(false);
  });
});
