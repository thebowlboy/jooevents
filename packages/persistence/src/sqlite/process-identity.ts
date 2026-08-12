import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SQLiteFoundationError } from './foundation-errors';

export type ProcessIdentityObservation =
  | { readonly kind: 'present'; readonly startToken: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable'; readonly reason: string };

function token(pid: number, source: string): string {
  return createHash('sha256')
    .update(`${process.platform}\0${pid}\0${source}`, 'utf8')
    .digest('hex');
}

function signalObservation(pid: number): 'present' | 'absent' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'absent';
    if (code === 'EPERM') return 'present';
    return 'unknown';
  }
}

function observeLinux(pid: number): ProcessIdentityObservation {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return { kind: 'unavailable', reason: 'Linux process stat has an unknown shape.' };
    // After the command field, index 0 is field 3 (`state`); starttime is field 22.
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTime = fields[19];
    if (!startTime || !/^\d+$/.test(startTime)) {
      return { kind: 'unavailable', reason: 'Linux process start time is unavailable.' };
    }
    return { kind: 'present', startToken: token(pid, `proc-starttime:${startTime}`) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && signalObservation(pid) === 'absent') {
      return { kind: 'absent' };
    }
    return { kind: 'unavailable', reason: 'Linux process identity could not be read safely.' };
  }
}

function observeDarwin(pid: number): ProcessIdentityObservation {
  const signal = signalObservation(pid);
  if (signal === 'absent') return { kind: 'absent' };
  if (signal === 'unknown') return { kind: 'unavailable', reason: 'Process liveness cannot be established.' };
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { LC_ALL: 'C', LANG: 'C' }
  });
  const started = result.status === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : '';
  if (!started) {
    // A process can exit between kill(2) and ps(1); prove that exact case once more.
    if (signalObservation(pid) === 'absent') return { kind: 'absent' };
    return { kind: 'unavailable', reason: 'Darwin process start identity is unavailable.' };
  }
  return { kind: 'present', startToken: token(pid, `ps-lstart:${started}`) };
}

/** Returns a boot/process-instance identity where the host exposes one, never a PID-only guess. */
export function observeProcessIdentity(pid: number): ProcessIdentityObservation {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { kind: 'unavailable', reason: 'Process ID is invalid.' };
  }
  if (process.platform === 'linux') return observeLinux(pid);
  if (process.platform === 'darwin') return observeDarwin(pid);
  return signalObservation(pid) === 'absent'
    ? { kind: 'absent' }
    : { kind: 'unavailable', reason: `Process start identity is unsupported on ${process.platform}.` };
}

export function currentProcessStartToken(): string | null {
  const observation = observeProcessIdentity(process.pid);
  return observation.kind === 'present' ? observation.startToken : null;
}

/** Succeeds only when the recorded process instance—not merely its PID—is proven gone. */
export function assertRecordedProcessDead(pid: number, recordedStartToken: string | null): void {
  if (!recordedStartToken) {
    throw new SQLiteFoundationError(
      'database_busy',
      'This platform did not record a process-start identity; stale coordination cannot be reclaimed safely.'
    );
  }
  const observation = observeProcessIdentity(pid);
  if (observation.kind === 'unavailable') {
    throw new SQLiteFoundationError('database_busy', 'The recorded process instance cannot be proven dead.', {
      reason: observation.reason
    });
  }
  if (observation.kind === 'present' && observation.startToken === recordedStartToken) {
    throw new SQLiteFoundationError('database_busy', 'The recorded process instance is still alive.');
  }
  // `absent`, or a different start token for a reused PID, proves the recorded
  // process instance no longer exists.
}
