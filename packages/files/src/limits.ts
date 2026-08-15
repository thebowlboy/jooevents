import {
  fileUploadLimitsSchema,
  type FileUploadLimitsDto,
  type FileUploaderPrincipalDto
} from '@jooevents/contracts/files';
import { deepFreeze, isAllowedFileContentType } from './model';

/**
 * D4 defaults. These are defaults for a configurable limits object, never a
 * hardcode: installs override per key through the env-shaped configuration,
 * and a dashboard surface may own them later without changing this seam.
 */
export const DEFAULT_FILE_UPLOAD_LIMITS: FileUploadLimitsDto = Object.freeze({
  maxUploadBytesSpeaker: 100 * 1024 * 1024,
  maxUploadBytesOrganizer: 250 * 1024 * 1024,
  maxTotalBytesPerSpeakerPerEvent: 1024 * 1024 * 1024
});

export const FILE_UPLOAD_LIMIT_ENV_KEYS = Object.freeze({
  maxUploadBytesSpeaker: 'JOOEVENTS_FILES_MAX_UPLOAD_BYTES_SPEAKER',
  maxUploadBytesOrganizer: 'JOOEVENTS_FILES_MAX_UPLOAD_BYTES_ORGANIZER',
  maxTotalBytesPerSpeakerPerEvent: 'JOOEVENTS_FILES_MAX_TOTAL_BYTES_PER_SPEAKER_EVENT'
} as const);

export class FileUploadLimitsConfigurationError extends TypeError {
  constructor(readonly envKey: string, readonly rawValue: string) {
    super(`file_upload_limit_invalid:${envKey}`);
    this.name = 'FileUploadLimitsConfigurationError';
  }
}

/**
 * Reads the D4 limits from env-shaped configuration. A missing key uses the
 * default; a present-but-invalid key is a refusal, never a silent fallback.
 */
export function parseFileUploadLimits(
  env: Readonly<Record<string, string | undefined>>
): FileUploadLimitsDto {
  const resolved: Record<string, number> = {};
  for (const [field, envKey] of Object.entries(FILE_UPLOAD_LIMIT_ENV_KEYS)) {
    const raw = env[envKey];
    if (raw === undefined) {
      resolved[field] = DEFAULT_FILE_UPLOAD_LIMITS[field as keyof FileUploadLimitsDto];
      continue;
    }
    const parsed = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new FileUploadLimitsConfigurationError(envKey, raw);
    }
    resolved[field] = parsed;
  }
  return deepFreeze(fileUploadLimitsSchema.parse(resolved));
}

export type UploadAdmission =
  | { readonly kind: 'admitted'; readonly maximumByteSize: number }
  | { readonly kind: 'refused'; readonly code: UploadAdmissionRefusalCode };

export type UploadAdmissionRefusalCode =
  | 'content_type_refused'
  | 'video_refused_use_link'
  | 'file_too_large'
  | 'event_quota_exceeded';

/**
 * The D4 cap + D3 type gate, evaluated at intent registration. The speaker
 * per-event quota bites only for the participant lane; operators carry the
 * larger per-file cap and no event quota in v1.
 */
export function admitFileUpload(input: {
  readonly limits: FileUploadLimitsDto;
  readonly uploader: FileUploaderPrincipalDto;
  readonly contentType: string;
  readonly declaredByteSize: number;
  /** Total stored bytes this participant already owns in this event. */
  readonly currentUploaderEventBytes: number;
}): UploadAdmission {
  const limits = fileUploadLimitsSchema.parse(input.limits);
  if (!Number.isSafeInteger(input.declaredByteSize) || input.declaredByteSize <= 0) {
    return Object.freeze({ kind: 'refused', code: 'file_too_large' });
  }
  if (!isAllowedFileContentType(input.contentType)) {
    return Object.freeze({
      kind: 'refused',
      code: input.contentType.startsWith('video/')
        ? 'video_refused_use_link'
        : 'content_type_refused'
    });
  }
  const perFileCap = input.uploader.kind === 'participant'
    ? limits.maxUploadBytesSpeaker
    : limits.maxUploadBytesOrganizer;
  if (input.declaredByteSize > perFileCap) {
    return Object.freeze({ kind: 'refused', code: 'file_too_large' });
  }
  if (input.uploader.kind === 'participant') {
    if (!Number.isSafeInteger(input.currentUploaderEventBytes)
        || input.currentUploaderEventBytes < 0) {
      throw new TypeError('file_upload_usage_invalid');
    }
    if (input.currentUploaderEventBytes + input.declaredByteSize
        > limits.maxTotalBytesPerSpeakerPerEvent) {
      return Object.freeze({ kind: 'refused', code: 'event_quota_exceeded' });
    }
  }
  return Object.freeze({ kind: 'admitted', maximumByteSize: perFileCap });
}
