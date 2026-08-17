import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createSerialHttpRequestBoundary,
  DEFAULT_HTTP_SERIALIZATION_LIMITS,
  RequestSerializationAbortedError,
  RequestSerializationUnavailableError
} from './request-serialization';

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('serialized HTTP request boundary', () => {
  test('a queued request cannot read rows written by an uncommitted request on the shared SQLite handle', async () => {
    const sqlite = new Database(':memory:');
    sqlite.run('create table records (id text primary key)');
    const boundary = createSerialHttpRequestBoundary();
    const writeStarted = deferred();
    const finishWrite = deferred();
    let readStarted = false;

    const write = boundary.run(async () => {
      sqlite.run('begin immediate');
      sqlite.run("insert into records (id) values ('uncommitted')");
      writeStarted.resolve();
      await finishWrite.promise;
      sqlite.run('rollback');
    });
    await writeStarted.promise;

    const read = boundary.run(() => {
      readStarted = true;
      return sqlite.query<{ count: number }, []>('select count(*) as count from records').get()!.count;
    });
    await Promise.resolve();
    expect(readStarted).toBe(false);

    finishWrite.resolve();
    await write;
    expect(await read).toBe(0);
    sqlite.close();
  });

  test('an aborted queued request never runs and does not prevent the next lease', async () => {
    const boundary = createSerialHttpRequestBoundary();
    const firstStarted = deferred();
    const finishFirst = deferred();
    const abort = new AbortController();
    let canceledWorkRan = false;

    const first = boundary.run(async () => {
      firstStarted.resolve();
      await finishFirst.promise;
      return 'first';
    });
    await firstStarted.promise;
    const canceled = boundary.run(() => {
      canceledWorkRan = true;
      return 'canceled';
    }, abort.signal);
    abort.abort();

    await expect(canceled).rejects.toBeInstanceOf(RequestSerializationAbortedError);
    finishFirst.resolve();
    expect(await first).toBe('first');
    expect(await boundary.run(() => 'next')).toBe('next');
    expect(canceledWorkRan).toBe(false);
  });

  test('a failed active request releases its lease', async () => {
    const boundary = createSerialHttpRequestBoundary();
    const failure = new Error('request failed');
    await expect(boundary.run(() => { throw failure; })).rejects.toBe(failure);
    expect(await boundary.run(() => 'recovered')).toBe('recovered');
  });

  test('an active request that settles on cancellation releases its lease', async () => {
    const boundary = createSerialHttpRequestBoundary();
    const abort = new AbortController();
    const started = deferred();
    const canceled = new Error('active request canceled');
    const active = boundary.run(async () => {
      started.resolve();
      await new Promise<never>((_resolve, reject) => {
        abort.signal.addEventListener('abort', () => reject(canceled), { once: true });
      });
    }, abort.signal);

    await started.promise;
    abort.abort();
    await expect(active).rejects.toBe(canceled);
    expect(await boundary.run(() => 'next')).toBe('next');
  });

  test('the bounded waiting list refuses excess work without disturbing accepted leases', async () => {
    const boundary = createSerialHttpRequestBoundary({
      maximumQueuedRequests: 1,
      maximumWaitMilliseconds: 1_000
    });
    const firstStarted = deferred();
    const finishFirst = deferred();
    const first = boundary.run(async () => {
      firstStarted.resolve();
      await finishFirst.promise;
      return 'first';
    });
    await firstStarted.promise;
    const accepted = boundary.run(() => 'accepted');

    await expect(boundary.run(() => 'excess')).rejects.toMatchObject({
      name: 'RequestSerializationUnavailableError',
      reason: 'queue_full'
    });
    finishFirst.resolve();
    expect(await first).toBe('first');
    expect(await accepted).toBe('accepted');
  });

  test('the supported default admits exactly 128 waiters behind the active request', async () => {
    const boundary = createSerialHttpRequestBoundary();
    const firstStarted = deferred();
    const finishFirst = deferred();
    const first = boundary.run(async () => {
      firstStarted.resolve();
      await finishFirst.promise;
    });
    await firstStarted.promise;
    const accepted = Array.from(
      { length: DEFAULT_HTTP_SERIALIZATION_LIMITS.maximumQueuedRequests },
      (_, index) => boundary.run(() => index)
    );

    await expect(boundary.run(() => 'excess')).rejects.toMatchObject({ reason: 'queue_full' });
    finishFirst.resolve();
    await first;
    expect(await Promise.all(accepted)).toEqual(
      Array.from({ length: 128 }, (_, index) => index)
    );
  });

  test('a timed-out waiter is removed and the following lease can still run', async () => {
    const boundary = createSerialHttpRequestBoundary({
      maximumQueuedRequests: 1,
      maximumWaitMilliseconds: 5
    });
    const firstStarted = deferred();
    const finishFirst = deferred();
    const first = boundary.run(async () => {
      firstStarted.resolve();
      await finishFirst.promise;
    });
    await firstStarted.promise;

    await expect(boundary.run(() => 'timed out')).rejects.toEqual(
      new RequestSerializationUnavailableError('queue_timeout')
    );
    finishFirst.resolve();
    await first;
    expect(await boundary.run(() => 'next')).toBe('next');
  });

  test('invalid resource limits are rejected at startup', () => {
    expect(() => createSerialHttpRequestBoundary({
      maximumQueuedRequests: -1,
      maximumWaitMilliseconds: 1
    })).toThrow('http_serialization_maximum_queued_requests_invalid');
    expect(() => createSerialHttpRequestBoundary({
      maximumQueuedRequests: 1,
      maximumWaitMilliseconds: 0
    })).toThrow('http_serialization_maximum_wait_milliseconds_invalid');
  });
});
