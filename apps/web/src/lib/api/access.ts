import { accessContextSchema, type AccessContext } from '@jooevents/contracts';
import { requestJson, type ApiResult } from './client';

export function getAccessContext(options: { readonly signal?: AbortSignal } = {}): Promise<ApiResult<AccessContext>> {
  return requestJson({ path: '/api/me/access-context', schema: accessContextSchema, ...(options.signal ? { signal: options.signal } : {}) });
}
