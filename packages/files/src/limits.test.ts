import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FILE_UPLOAD_LIMITS,
  FILE_UPLOAD_LIMIT_ENV_KEYS,
  FileUploadLimitsConfigurationError,
  admitFileUpload,
  parseFileUploadLimits
} from './limits';
import { OPERATOR, SPEAKER } from './test-fixtures';

describe('file upload limits (D4)', () => {
  test('carries the decided defaults as a configurable object', () => {
    expect(DEFAULT_FILE_UPLOAD_LIMITS).toEqual({
      maxUploadBytesSpeaker: 100 * 1024 * 1024,
      maxUploadBytesOrganizer: 250 * 1024 * 1024,
      maxTotalBytesPerSpeakerPerEvent: 1024 * 1024 * 1024
    });
    expect(parseFileUploadLimits({})).toEqual(DEFAULT_FILE_UPLOAD_LIMITS);
  });

  test('env overrides each key independently and refuses invalid values loudly', () => {
    expect(parseFileUploadLimits({
      [FILE_UPLOAD_LIMIT_ENV_KEYS.maxUploadBytesSpeaker]: '1048576'
    })).toEqual({
      ...DEFAULT_FILE_UPLOAD_LIMITS,
      maxUploadBytesSpeaker: 1048576
    });
    for (const raw of ['0', '-1', '1.5', 'lots', '', '100MB']) {
      expect(() => parseFileUploadLimits({
        [FILE_UPLOAD_LIMIT_ENV_KEYS.maxUploadBytesOrganizer]: raw
      })).toThrow(FileUploadLimitsConfigurationError);
    }
  });

  test('gates the type list, refuses video toward link-attach, and applies lane caps', () => {
    const base = {
      limits: DEFAULT_FILE_UPLOAD_LIMITS,
      currentUploaderEventBytes: 0
    };
    expect(admitFileUpload({
      ...base, uploader: SPEAKER, contentType: 'application/pdf', declaredByteSize: 1024
    })).toEqual({ kind: 'admitted', maximumByteSize: 100 * 1024 * 1024 });
    expect(admitFileUpload({
      ...base, uploader: OPERATOR, contentType: 'application/pdf', declaredByteSize: 1024
    })).toEqual({ kind: 'admitted', maximumByteSize: 250 * 1024 * 1024 });
    expect(admitFileUpload({
      ...base, uploader: SPEAKER, contentType: 'video/mp4', declaredByteSize: 1024
    })).toEqual({ kind: 'refused', code: 'video_refused_use_link' });
    expect(admitFileUpload({
      ...base, uploader: SPEAKER, contentType: 'text/html', declaredByteSize: 1024
    })).toEqual({ kind: 'refused', code: 'content_type_refused' });
    expect(admitFileUpload({
      ...base, uploader: SPEAKER, contentType: 'application/pdf',
      declaredByteSize: 100 * 1024 * 1024 + 1
    })).toEqual({ kind: 'refused', code: 'file_too_large' });
    expect(admitFileUpload({
      ...base, uploader: OPERATOR, contentType: 'application/pdf',
      declaredByteSize: 100 * 1024 * 1024 + 1
    })).toEqual({ kind: 'admitted', maximumByteSize: 250 * 1024 * 1024 });
  });

  test('the 1GB per-speaker-per-event quota bites only on the participant lane', () => {
    const nearQuota = 1024 * 1024 * 1024 - 100;
    expect(admitFileUpload({
      limits: DEFAULT_FILE_UPLOAD_LIMITS, uploader: SPEAKER,
      contentType: 'application/pdf', declaredByteSize: 200,
      currentUploaderEventBytes: nearQuota
    })).toEqual({ kind: 'refused', code: 'event_quota_exceeded' });
    expect(admitFileUpload({
      limits: DEFAULT_FILE_UPLOAD_LIMITS, uploader: SPEAKER,
      contentType: 'application/pdf', declaredByteSize: 100,
      currentUploaderEventBytes: nearQuota
    })).toEqual({ kind: 'admitted', maximumByteSize: 100 * 1024 * 1024 });
    expect(admitFileUpload({
      limits: DEFAULT_FILE_UPLOAD_LIMITS, uploader: OPERATOR,
      contentType: 'application/pdf', declaredByteSize: 1024,
      currentUploaderEventBytes: Number.MAX_SAFE_INTEGER - 1
    })).toEqual({ kind: 'admitted', maximumByteSize: 250 * 1024 * 1024 });
  });
});
