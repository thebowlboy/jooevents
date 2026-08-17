export interface HttpRequestSerializationBoundary {
  run<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T>;
}

export const DEFAULT_HTTP_SERIALIZATION_LIMITS = Object.freeze({
  maximumQueuedRequests: 128,
  maximumWaitMilliseconds: 30_000
});

export class RequestSerializationAbortedError extends Error {
  constructor() {
    super('The request ended before serialized work began.');
    this.name = 'RequestSerializationAbortedError';
  }
}

export class RequestSerializationUnavailableError extends Error {
  constructor(readonly reason: 'queue_full' | 'queue_timeout') {
    super(reason === 'queue_full'
      ? 'The serialized request queue is full.'
      : 'The request waited too long for serialized work.');
    this.name = 'RequestSerializationUnavailableError';
  }
}

interface PendingLease {
  granted: boolean;
  canceled: boolean;
  readonly resolve: (release: () => void) => void;
  readonly reject: (
    error: RequestSerializationAbortedError | RequestSerializationUnavailableError
  ) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Serializes work inside one process. A granted lease is retained until its work
 * settles, including when the request signal is aborted while that work is active.
 */
export function createSerialHttpRequestBoundary(
  limits: Readonly<{
    readonly maximumQueuedRequests: number;
    readonly maximumWaitMilliseconds: number;
  }> = DEFAULT_HTTP_SERIALIZATION_LIMITS
): HttpRequestSerializationBoundary {
  if (!Number.isSafeInteger(limits.maximumQueuedRequests) || limits.maximumQueuedRequests < 0) {
    throw new TypeError('http_serialization_maximum_queued_requests_invalid');
  }
  if (!Number.isSafeInteger(limits.maximumWaitMilliseconds) || limits.maximumWaitMilliseconds <= 0) {
    throw new TypeError('http_serialization_maximum_wait_milliseconds_invalid');
  }
  let held = false;
  const pending: PendingLease[] = [];

  const cancelPending = (
    lease: PendingLease,
    error: RequestSerializationAbortedError | RequestSerializationUnavailableError
  ): void => {
    if (lease.granted || lease.canceled) return;
    lease.canceled = true;
    const index = pending.indexOf(lease);
    if (index >= 0) pending.splice(index, 1);
    lease.signal?.removeEventListener('abort', lease.onAbort);
    if (lease.timer !== undefined) clearTimeout(lease.timer);
    lease.timer = undefined;
    lease.reject(error);
  };

  const grantNext = (): void => {
    while (pending.length > 0) {
      const next = pending.shift();
      if (!next || next.canceled) continue;
      next.granted = true;
      next.signal?.removeEventListener('abort', next.onAbort);
      if (next.timer !== undefined) clearTimeout(next.timer);
      next.timer = undefined;
      next.resolve(createRelease());
      return;
    }
    held = false;
  };

  const createRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      grantNext();
    };
  };

  const acquire = (signal: AbortSignal | undefined): Promise<() => void> => {
    if (signal?.aborted) return Promise.reject(new RequestSerializationAbortedError());
    if (!held) {
      held = true;
      return Promise.resolve(createRelease());
    }

    if (pending.length >= limits.maximumQueuedRequests) {
      return Promise.reject(new RequestSerializationUnavailableError('queue_full'));
    }

    return new Promise((resolve, reject) => {
      const lease: PendingLease = {
        granted: false,
        canceled: false,
        resolve,
        reject,
        signal,
        onAbort: () => cancelPending(lease, new RequestSerializationAbortedError()),
        timer: undefined
      };
      pending.push(lease);
      signal?.addEventListener('abort', lease.onAbort, { once: true });
      lease.timer = setTimeout(() => {
        cancelPending(lease, new RequestSerializationUnavailableError('queue_timeout'));
      }, limits.maximumWaitMilliseconds);
      if (signal?.aborted) lease.onAbort();
    });
  };

  return Object.freeze({
    async run<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
      const release = await acquire(signal);
      try {
        if (signal?.aborted) throw new RequestSerializationAbortedError();
        return await work();
      } finally {
        release();
      }
    }
  });
}
