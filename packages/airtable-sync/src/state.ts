export const CONNECTION_STATES = [
  'draft',
  'provisioning',
  'active',
  'paused',
  'needs_reconnect',
  'disconnecting',
  'disconnected'
] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

const CONNECTION_TRANSITIONS: Readonly<Record<ConnectionState, readonly ConnectionState[]>> = {
  draft: ['provisioning', 'disconnected'],
  provisioning: ['active', 'paused', 'needs_reconnect', 'disconnected'],
  active: ['paused', 'needs_reconnect', 'disconnecting'],
  paused: ['active', 'needs_reconnect', 'disconnecting'],
  needs_reconnect: ['paused', 'active', 'disconnecting'],
  disconnecting: ['disconnected'],
  disconnected: []
};

export type ConnectionTransitionResult =
  | { readonly kind: 'accepted'; readonly state: ConnectionState }
  | { readonly kind: 'refused'; readonly code: 'transition_not_allowed' };

export function transitionConnection(
  current: ConnectionState,
  next: ConnectionState
): ConnectionTransitionResult {
  if (!CONNECTION_TRANSITIONS[current].includes(next)) {
    return { kind: 'refused', code: 'transition_not_allowed' };
  }
  return { kind: 'accepted', state: next };
}

export type ProviderDiagnostic = Readonly<{
  code: string;
  correlationId: string;
  providerRequestId?: string;
  retryAfterMs?: number;
}>;

export function safeProviderDiagnostic(input: ProviderDiagnostic): ProviderDiagnostic {
  if (!/^[a-z0-9_]{1,80}$/.test(input.code)) throw new TypeError('diagnostic_code_invalid');
  if (!/^[0-9a-f-]{36}$/.test(input.correlationId)) {
    throw new TypeError('diagnostic_correlation_id_invalid');
  }
  if (
    input.providerRequestId !== undefined
    && !/^[A-Za-z0-9_-]{1,160}$/.test(input.providerRequestId)
  ) {
    throw new TypeError('diagnostic_provider_request_id_invalid');
  }
  if (
    input.retryAfterMs !== undefined
    && (!Number.isInteger(input.retryAfterMs) || input.retryAfterMs < 0 || input.retryAfterMs > 86_400_000)
  ) {
    throw new TypeError('diagnostic_retry_after_invalid');
  }
  return Object.freeze({ ...input });
}
