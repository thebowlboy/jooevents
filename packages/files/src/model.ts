import {
  FILE_CONTENT_TYPES,
  FILE_IMAGE_CONTENT_TYPES,
  fileAssetSchema,
  fileAttachmentSchema,
  fileDisplayFilenameSchema,
  fileRequestSchema,
  fileUploadIntentSchema,
  resourceShareSchema,
  type FileAssetDto,
  type FileAttachmentDto,
  type FileContentType,
  type FileRequestDto,
  type FileScopeDto,
  type FileUploadIntentDto,
  type ResourceShareDto
} from '@jooevents/contracts/files';

export type FilesValidationErrorCode =
  | 'invalid_file_asset'
  | 'invalid_file_attachment'
  | 'invalid_file_upload_intent'
  | 'invalid_resource_share'
  | 'invalid_file_request'
  | 'invalid_display_filename';

export class FilesValidationError extends TypeError {
  constructor(readonly code: FilesValidationErrorCode) {
    super(code);
    this.name = 'FilesValidationError';
  }
}

const ALLOWED = new Set<string>(FILE_CONTENT_TYPES);
const IMAGES = new Set<string>(FILE_IMAGE_CONTENT_TYPES);

export function isAllowedFileContentType(value: string): value is FileContentType {
  return ALLOWED.has(value);
}

export function isImageFileContentType(value: string): boolean {
  return IMAGES.has(value);
}

export function sameFileScope(left: FileScopeDto, right: FileScopeDto): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Produces a presentation-only filename from arbitrary caller input. The result
 * never selects a storage path; storage keys are minted independently. Refuses
 * (rather than inventing content) when nothing displayable remains.
 */
export function sanitizeDisplayFilename(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 400) {
    throw new FilesValidationError('invalid_display_filename');
  }
  const lastSegment = raw.normalize('NFC').split(/[/\\]/u).at(-1) ?? '';
  const cleaned = lastSegment
    .replace(/[\u0000-\u001f\u007f:]/gu, "")
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^\.+/u, '')
    .replace(/\.+$/u, '');
  const bounded = cleaned.length > 200
    ? boundedWithExtension(cleaned)
    : cleaned;
  const parsed = fileDisplayFilenameSchema.safeParse(bounded);
  if (!parsed.success) throw new FilesValidationError('invalid_display_filename');
  return parsed.data;
}

function boundedWithExtension(value: string): string {
  const dot = value.lastIndexOf('.');
  if (dot > 0 && value.length - dot <= 16) {
    const extension = value.slice(dot);
    return `${value.slice(0, 200 - extension.length)}${extension}`;
  }
  return value.slice(0, 200);
}

export function parseFileAsset(value: unknown): FileAssetDto {
  return parseSchema(fileAssetSchema, value, 'invalid_file_asset');
}

export function parseFileAttachment(value: unknown): FileAttachmentDto {
  return parseSchema(fileAttachmentSchema, value, 'invalid_file_attachment');
}

export function parseFileUploadIntent(value: unknown): FileUploadIntentDto {
  return parseSchema(fileUploadIntentSchema, value, 'invalid_file_upload_intent');
}

export function parseResourceShare(value: unknown): ResourceShareDto {
  return parseSchema(resourceShareSchema, value, 'invalid_resource_share');
}

export function parseFileRequest(value: unknown): FileRequestDto {
  return parseSchema(fileRequestSchema, value, 'invalid_file_request');
}

function parseSchema<Output>(
  schema: {
    readonly safeParse: (value: unknown) =>
      | { success: true; data: Output }
      | { success: false };
  },
  value: unknown,
  code: FilesValidationErrorCode
): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new FilesValidationError(code);
  return deepFreeze(parsed.data);
}

export function deepFreeze<Value>(value: Value): Value {
  if (value !== null
      && typeof value === 'object'
      && !ArrayBuffer.isView(value)
      && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** The `{ kind, version, payload }` fact envelope every files command emits. */
export interface FilesFact<Payload> {
  readonly kind: string;
  readonly version: 1;
  readonly payload: Payload;
}

/** Mirror of `ChangesetApplyContribution`: result plus receipt-bound facts. */
export interface FilesAppliedContribution<Result, FactPayload> {
  readonly result: Result;
  readonly facts: readonly FilesFact<FactPayload>[];
  readonly effects: readonly never[];
}
