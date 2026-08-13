export type BunRuntimeShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface BunRuntimeServer {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export interface BunRuntimeCloseTarget {
  close(): void | Promise<void>;
}

export interface BunRuntimeSignalSource {
  once(signal: BunRuntimeShutdownSignal, listener: () => void): unknown;
  off(signal: BunRuntimeShutdownSignal, listener: () => void): unknown;
}

export interface ManagedBunRuntime<Server extends BunRuntimeServer = BunRuntimeServer> {
  readonly server: Server;
  close(): Promise<void>;
}

function throwFailures(errors: readonly unknown[], message: string): never {
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

async function closeRuntimeAfterStartupFailure(
  runtime: BunRuntimeCloseTarget,
  startupError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (closeError) {
    throw new AggregateError(
      [startupError, closeError],
      'Bun runtime startup and SQLite cleanup both failed.'
    );
  }
  throw startupError;
}

async function stopServerThenCloseRuntime(input: {
  readonly server: BunRuntimeServer;
  readonly runtime: BunRuntimeCloseTarget;
}): Promise<void> {
  let stopFailed = false;
  let stopError: unknown;
  try {
    await input.server.stop();
  } catch (error) {
    stopFailed = true;
    stopError = error;
  }

  try {
    await input.runtime.close();
  } catch (closeError) {
    if (stopFailed) {
      throw new AggregateError(
        [stopError, closeError],
        'Bun server shutdown and SQLite cleanup both failed.'
      );
    }
    throw closeError;
  }
  if (stopFailed) throw stopError;
}

/**
 * Starts a Bun listener only after its runtime exists, then owns stop-before-close
 * ordering. Every startup failure closes the already-open runtime before returning.
 */
export async function startManagedBunRuntime<Server extends BunRuntimeServer>(input: {
  readonly runtime: BunRuntimeCloseTarget;
  readonly start: () => Server;
  readonly signalSource?: BunRuntimeSignalSource;
  readonly onSignalError: (error: unknown) => void;
}): Promise<ManagedBunRuntime<Server>> {
  let server: Server;
  try {
    server = input.start();
  } catch (error) {
    return closeRuntimeAfterStartupFailure(input.runtime, error);
  }

  const signalSource = input.signalSource ?? process;
  let sigintInstalled = false;
  let sigtermInstalled = false;
  let closePromise: Promise<void> | undefined;

  function onSignal() {
    void close().catch(input.onSignalError);
  }
  const removeSignalHandlers = (): readonly unknown[] => {
    const errors: unknown[] = [];
    if (sigintInstalled) {
      sigintInstalled = false;
      try {
        signalSource.off('SIGINT', onSignal);
      } catch (error) {
        errors.push(error);
      }
    }
    if (sigtermInstalled) {
      sigtermInstalled = false;
      try {
        signalSource.off('SIGTERM', onSignal);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const errors = [...removeSignalHandlers()];
      try {
        await stopServerThenCloseRuntime({ server, runtime: input.runtime });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throwFailures(errors, 'Bun signal cleanup and runtime shutdown failed.');
      }
    })();
    return closePromise;
  };

  try {
    signalSource.once('SIGINT', onSignal);
    sigintInstalled = true;
    signalSource.once('SIGTERM', onSignal);
    sigtermInstalled = true;
  } catch (error) {
    const errors = [error, ...removeSignalHandlers()];
    try {
      await stopServerThenCloseRuntime({ server, runtime: input.runtime });
    } catch (closeError) {
      errors.push(closeError);
    }
    throwFailures(errors, 'Bun signal registration and runtime cleanup failed.');
  }

  return Object.freeze({ server, close });
}
