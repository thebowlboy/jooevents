export interface HttpRequestSerializationBoundary {
  run<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T>;
}

export class RequestSerializationAbortedError extends Error {
  constructor() {
    super('The request ended before serialized work began.');
    this.name = 'RequestSerializationAbortedError';
  }
}

interface PendingLease {
  granted: boolean;
  canceled: boolean;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: RequestSerializationAbortedError) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

/**
 * Serializes work inside one process. A granted lease is retained until its work
 * settles, including when the request signal is aborted while that work is active.
 */
export function createSerialHttpRequestBoundary(): HttpRequestSerializationBoundary {
  let held = false;
  const pending: PendingLease[] = [];

  const grantNext = (): void => {
    while (pending.length > 0) {
      const next = pending.shift();
      if (!next || next.canceled) continue;
      next.granted = true;
      next.signal?.removeEventListener('abort', next.onAbort);
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

    return new Promise((resolve, reject) => {
      const lease: PendingLease = {
        granted: false,
        canceled: false,
        resolve,
        reject,
        signal,
        onAbort: () => {
          if (lease.granted || lease.canceled) return;
          lease.canceled = true;
          const index = pending.indexOf(lease);
          if (index >= 0) pending.splice(index, 1);
          lease.signal?.removeEventListener('abort', lease.onAbort);
          lease.reject(new RequestSerializationAbortedError());
        }
      };
      pending.push(lease);
      signal?.addEventListener('abort', lease.onAbort, { once: true });
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
