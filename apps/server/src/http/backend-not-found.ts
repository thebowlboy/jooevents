export const backendRouteNotFoundPayload = {
  code: 'route_not_found',
  message: 'The requested backend route does not exist.',
  retryable: false
} as const;

export function backendRouteNotFoundResponse(correlationId?: string): Response {
  return Response.json(
    {
      ...backendRouteNotFoundPayload,
      ...(correlationId ? { correlationId } : {})
    },
    {
      status: 404,
      headers: {
        'cache-control': 'no-store, max-age=0',
        'x-content-type-options': 'nosniff',
        ...(correlationId ? { 'x-correlation-id': correlationId } : {})
      }
    }
  );
}

export function protectBackendNotFoundResponse(response: Response, fallbackCorrelationId?: string): Response {
  if (response.status !== 404) return response;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json') || contentType.includes('application/problem+json')) return response;
  return backendRouteNotFoundResponse(response.headers.get('x-correlation-id') ?? fallbackCorrelationId);
}
