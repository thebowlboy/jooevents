import { describe, expect, test } from 'bun:test';
import {
  startManagedBunRuntime,
  type BunRuntimeShutdownSignal,
  type BunRuntimeSignalSource
} from './bun-runtime-lifecycle';

class TestSignalSource implements BunRuntimeSignalSource {
  readonly listeners = new Map<BunRuntimeShutdownSignal, Set<() => void>>();
  failRegistrationFor?: BunRuntimeShutdownSignal;

  once(signal: BunRuntimeShutdownSignal, listener: () => void): void {
    if (this.failRegistrationFor === signal) throw new Error(`cannot_register:${signal}`);
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: BunRuntimeShutdownSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: BunRuntimeShutdownSignal): boolean {
    const listeners = [...(this.listeners.get(signal) ?? [])];
    this.listeners.delete(signal);
    for (const listener of listeners) listener();
    return listeners.length > 0;
  }

  listenerCount(signal: BunRuntimeShutdownSignal): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

describe('managed Bun runtime lifecycle', () => {
  test('closes an already-open runtime when listener startup fails', async () => {
    const startupError = new Error('listener startup failed');
    let runtimeCloseCount = 0;
    const start = startManagedBunRuntime({
      runtime: { close: () => { runtimeCloseCount += 1; } },
      start: () => { throw startupError; },
      signalSource: new TestSignalSource(),
      onSignalError: () => {}
    });

    await expect(start).rejects.toBe(startupError);
    expect(runtimeCloseCount).toBe(1);
  });

  test('coalesces concurrent closes and stops the listener before the runtime', async () => {
    const signalSource = new TestSignalSource();
    const order: string[] = [];
    const managed = await startManagedBunRuntime({
      runtime: { close: () => { order.push('runtime.close'); } },
      start: () => ({ stop: async () => { order.push('server.stop'); } }),
      signalSource,
      onSignalError: () => {}
    });
    expect(signalSource.listenerCount('SIGINT')).toBe(1);
    expect(signalSource.listenerCount('SIGTERM')).toBe(1);

    const first = managed.close();
    const second = managed.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(order).toEqual(['server.stop', 'runtime.close']);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  });

  test('starts background work only after the listener exists', async () => {
    const order: string[] = [];
    const managed = await startManagedBunRuntime({
      runtime: {
        startBackgroundWork: () => { order.push('background.start'); },
        close: () => { order.push('runtime.close'); }
      },
      start: () => {
        order.push('server.start');
        return { stop: () => { order.push('server.stop'); } };
      },
      signalSource: new TestSignalSource(),
      onSignalError: () => {}
    });

    expect(order).toEqual(['server.start', 'background.start']);
    await managed.close();
    expect(order).toEqual([
      'server.start', 'background.start', 'server.stop', 'runtime.close'
    ]);
  });

  test('stops the listener and closes storage when background startup fails', async () => {
    const failure = new Error('background_start_failed');
    const order: string[] = [];
    const starting = startManagedBunRuntime({
      runtime: {
        startBackgroundWork: () => { throw failure; },
        close: () => { order.push('runtime.close'); }
      },
      start: () => ({ stop: () => { order.push('server.stop'); } }),
      signalSource: new TestSignalSource(),
      onSignalError: () => {}
    });

    await expect(starting).rejects.toBe(failure);
    expect(order).toEqual(['server.stop', 'runtime.close']);
  });

  test('coalesces signal-driven shutdown with an explicit close', async () => {
    const signalSource = new TestSignalSource();
    let serverStopCount = 0;
    let runtimeCloseCount = 0;
    const signalErrors: unknown[] = [];
    const managed = await startManagedBunRuntime({
      runtime: { close: () => { runtimeCloseCount += 1; } },
      start: () => ({ stop: () => { serverStopCount += 1; } }),
      signalSource,
      onSignalError: (error) => { signalErrors.push(error); }
    });

    expect(signalSource.emit('SIGTERM')).toBe(true);
    await managed.close();
    expect(serverStopCount).toBe(1);
    expect(runtimeCloseCount).toBe(1);
    expect(signalErrors).toEqual([]);
    expect(signalSource.emit('SIGINT')).toBe(false);
  });

  test('still closes the runtime when listener stop fails', async () => {
    const stopError = new Error('listener stop failed');
    let runtimeCloseCount = 0;
    const managed = await startManagedBunRuntime({
      runtime: { close: () => { runtimeCloseCount += 1; } },
      start: () => ({ stop: () => { throw stopError; } }),
      signalSource: new TestSignalSource(),
      onSignalError: () => {}
    });

    await expect(managed.close()).rejects.toBe(stopError);
    expect(runtimeCloseCount).toBe(1);
    await expect(managed.close()).rejects.toBe(stopError);
    expect(runtimeCloseCount).toBe(1);
  });

  test('stops and closes when signal registration fails', async () => {
    const signalSource = new TestSignalSource();
    signalSource.failRegistrationFor = 'SIGTERM';
    const order: string[] = [];
    const start = startManagedBunRuntime({
      runtime: { close: () => { order.push('runtime.close'); } },
      start: () => ({ stop: () => { order.push('server.stop'); } }),
      signalSource,
      onSignalError: () => {}
    });

    await expect(start).rejects.toThrow('cannot_register:SIGTERM');
    expect(order).toEqual(['server.stop', 'runtime.close']);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
  });
});
