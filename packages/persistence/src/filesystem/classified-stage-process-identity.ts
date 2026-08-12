import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export type ClassifiedStageProcessIdentityObservation =
  | { readonly kind: 'present'; readonly startToken: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' };

function processToken(pid: number, source: string): string {
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

function observeLinuxProcess(pid: number): ClassifiedStageProcessIdentityObservation {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().toLowerCase();
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0 || !/^[0-9a-f-]{36}$/.test(bootId)) return { kind: 'unavailable' };
    // After the command field, index 0 is field 3 (`state`); starttime is field 22.
    const startTime = stat.slice(commandEnd + 1).trim().split(/\s+/)[19];
    if (!startTime || !/^\d+$/.test(startTime)) return { kind: 'unavailable' };
    return {
      kind: 'present',
      startToken: processToken(pid, `boot:${bootId}:proc-starttime:${startTime}`)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && signalObservation(pid) === 'absent') {
      return { kind: 'absent' };
    }
    return { kind: 'unavailable' };
  }
}

function observeDarwinProcess(pid: number): ClassifiedStageProcessIdentityObservation {
  const signal = signalObservation(pid);
  if (signal === 'absent') return { kind: 'absent' };
  if (signal === 'unknown') return { kind: 'unavailable' };
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { LC_ALL: 'C', LANG: 'C' }
  });
  const started = result.status === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : '';
  if (!started) {
    if (signalObservation(pid) === 'absent') return { kind: 'absent' };
    return { kind: 'unavailable' };
  }
  return { kind: 'present', startToken: processToken(pid, `ps-lstart:${started}`) };
}

/** Observes a process instance rather than trusting a reusable PID. */
export function observeClassifiedStageProcessIdentity(
  pid: number
): ClassifiedStageProcessIdentityObservation {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: 'unavailable' };
  if (process.platform === 'linux') return observeLinuxProcess(pid);
  if (process.platform === 'darwin') return observeDarwinProcess(pid);
  return signalObservation(pid) === 'absent' ? { kind: 'absent' } : { kind: 'unavailable' };
}

export function currentClassifiedStageProcessStartToken(): string | null {
  const observation = observeClassifiedStageProcessIdentity(process.pid);
  return observation.kind === 'present' ? observation.startToken : null;
}
