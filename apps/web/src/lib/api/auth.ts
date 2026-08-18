import { z } from 'zod';
import { requestJson, type ApiResult } from './client';

const redirectSchema = z.object({ url: z.url() });
const signedOutSchema = z.object({ signedOut: z.literal(true) });

export async function startExternalSignIn(input: { readonly provider: 'google'; readonly returnTo: string }): Promise<ApiResult<{ readonly redirecting: true }>> {
  const result = await requestJson({ path: '/api/entry/google/start', schema: redirectSchema, method: 'POST', body: input });
  if (result.kind === 'error') return result;
  window.location.assign(result.data.url);
  return { kind: 'success', data: { redirecting: true }, ...(result.correlationId ? { correlationId: result.correlationId } : {}) };
}

export async function startReviewOrganizerSignIn(): Promise<ApiResult<{ readonly redirecting: true }>> {
  const result = await requestJson({
    path: '/api/entry/review-organizer',
    schema: z.object({ url: z.url() }),
    method: 'POST'
  });
  if (result.kind === 'error') return result;
  window.location.assign(result.data.url);
  return { kind: 'success', data: { redirecting: true } };
}

export async function signOut(): Promise<ApiResult<{ readonly signedOut: true }>> {
  return requestJson({ path: '/api/entry/sign-out', schema: signedOutSchema, method: 'POST', body: {} });
}
