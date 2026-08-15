import type {
  FileAssetDto,
  FileScopeDto,
  FileUploadIntentDto,
  FileUploaderPrincipalDto
} from '@jooevents/contracts/files';

let counter = 0;

/** Deterministic canonical UUIDv4-shaped ids for fixtures. */
export function fixtureId(label?: string): string {
  counter += 1;
  const tail = counter.toString(16).padStart(12, '0');
  const head = (label ? hash(label) : counter).toString(16).padStart(8, '0').slice(0, 8);
  return `${head}-0000-4000-8000-${tail}`;
}

function hash(value: string): number {
  let result = 7;
  for (const char of value) result = (result * 31 + char.codePointAt(0)!) >>> 0;
  return result;
}

export const FIXTURE_SCOPE: FileScopeDto = Object.freeze({
  workspaceId: '11111111-0000-4000-8000-000000000001',
  eventId: '11111111-0000-4000-8000-000000000002'
});

export const OTHER_SCOPE: FileScopeDto = Object.freeze({
  workspaceId: '11111111-0000-4000-8000-000000000001',
  eventId: '11111111-0000-4000-8000-000000000003'
});

export const OPERATOR: FileUploaderPrincipalDto = Object.freeze({
  kind: 'operator_user',
  userId: '11111111-0000-4000-8000-000000000010'
});

export const SPEAKER: FileUploaderPrincipalDto = Object.freeze({
  kind: 'participant',
  participantIdentityId: '11111111-0000-4000-8000-000000000011'
});

export const NOW = '2026-08-15T10:00:00.000Z';
export const LATER = '2026-08-15T11:00:00.000Z';

export function fixtureAsset(overrides: Partial<FileAssetDto> = {}): FileAssetDto {
  return {
    schemaVersion: 1,
    id: fixtureId(),
    scope: FIXTURE_SCOPE,
    uploader: SPEAKER,
    purpose: 'engagement_material',
    displayFilename: 'deck.pdf',
    contentType: 'application/pdf',
    byteSize: 1024,
    sha256: 'a'.repeat(64),
    storageProvider: 'filesystem',
    storageKey: `files/${FIXTURE_SCOPE.workspaceId}/${FIXTURE_SCOPE.eventId}/${fixtureId()}`,
    lifecycle: 'available',
    scan: { provider: 'none', verdict: 'released', checkedAt: NOW },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

export function fixtureIntent(overrides: Partial<FileUploadIntentDto> = {}): FileUploadIntentDto {
  return {
    schemaVersion: 1,
    id: fixtureId(),
    scope: FIXTURE_SCOPE,
    uploader: SPEAKER,
    purpose: 'engagement_material',
    displayFilename: 'deck.pdf',
    contentType: 'application/pdf',
    declaredByteSize: 1024,
    maximumByteSize: 4096,
    storageProvider: 'filesystem',
    storageKey: `files/${FIXTURE_SCOPE.workspaceId}/${FIXTURE_SCOPE.eventId}/${fixtureId()}`,
    state: 'pending',
    storedByteSize: null,
    storedSha256: null,
    createdAt: NOW,
    expiresAt: NOW,
    ...overrides
  };
}

export async function* chunked(bytes: Uint8Array, chunkSize = 7): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
  }
}
