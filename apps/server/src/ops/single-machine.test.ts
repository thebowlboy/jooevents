import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSingleMachineEnvironmentFile,
  renderSingleMachineService
} from './single-machine';

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jooevents-single-machine-')));
  temporaryDirectories.push(directory);
  return directory;
}

describe('single-machine operator contracts', () => {
  test('reads only a direct owner-only line-oriented environment file', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'jooevents.env');
    writeFileSync(path, 'NODE_ENV=production\nJOOEVENTS_EMAIL_PROVIDER_MODE=disabled\n', { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(readSingleMachineEnvironmentFile(path)).toEqual({
      NODE_ENV: 'production',
      JOOEVENTS_EMAIL_PROVIDER_MODE: 'disabled'
    });
    chmodSync(path, 0o644);
    expect(() => readSingleMachineEnvironmentFile(path)).toThrow('owner-only');
  });

  test('renders a hardened systemd service with exact paths and stop semantics', () => {
    const service = renderSingleMachineService({
      kind: 'systemd',
      releaseRoot: '/opt/jooevents/current',
      environmentFile: '/etc/jooevents/jooevents.env',
      dataDirectory: '/var/lib/jooevents',
      backupDirectory: '/var/backups/jooevents',
      logDirectory: '/var/log/jooevents',
      bunExecutable: '/usr/local/bin/bun',
      serviceUser: 'jooevents',
      serviceGroup: 'jooevents'
    });
    expect(service).toContain('User=jooevents');
    expect(service).toContain('EnvironmentFile="/etc/jooevents/jooevents.env"');
    expect(service).toContain('KillSignal=SIGTERM');
    expect(service).toContain('TimeoutStopSec=45s');
    expect(service).toContain('ProtectSystem=strict');
    expect(service).toContain('LimitNOFILE=65536');
    expect(service).toContain('MemoryMax=2G');
    expect(service).toContain('UMask=0077');
  });

  test('renders launchd with an environment file, private umask, logs, and keepalive', () => {
    const service = renderSingleMachineService({
      kind: 'launchd',
      releaseRoot: '/Library/JooEvents/current',
      environmentFile: '/Library/JooEvents/config/jooevents.env',
      dataDirectory: '/Library/JooEvents/data',
      backupDirectory: '/Library/JooEvents/backups',
      logDirectory: '/Library/JooEvents/logs',
      bunExecutable: '/usr/local/bin/bun'
    });
    expect(service).toContain('<string>--env-file=/Library/JooEvents/config/jooevents.env</string>');
    expect(service).toContain('<key>Umask</key><integer>63</integer>');
    expect(service).toContain('<key>SoftResourceLimits</key>');
    expect(service).toContain('<key>KeepAlive</key><true/>');
    expect(service).toContain('/Library/JooEvents/logs/jooevents-error.log');
  });

  test('renders a headless system-domain launchd service that drops root authority', () => {
    const service = renderSingleMachineService({
      kind: 'launchd',
      releaseRoot: '/Library/JooEvents/current',
      environmentFile: '/Library/JooEvents/config/jooevents.env',
      dataDirectory: '/Library/JooEvents/data',
      backupDirectory: '/Library/JooEvents/backups',
      logDirectory: '/Library/JooEvents/logs',
      bunExecutable: '/usr/local/bin/bun',
      serviceUser: 'jooevents',
      serviceGroup: 'jooevents'
    });
    expect(service).toContain('<key>UserName</key><string>jooevents</string>');
    expect(service).toContain('<key>GroupName</key><string>jooevents</string>');
  });

  test('refuses unsafe systemd user or group interpolation', () => {
    expect(() => renderSingleMachineService({
      kind: 'systemd',
      releaseRoot: '/opt/jooevents/current',
      environmentFile: '/etc/jooevents/jooevents.env',
      dataDirectory: '/var/lib/jooevents',
      backupDirectory: '/var/backups/jooevents',
      logDirectory: '/var/log/jooevents',
      bunExecutable: '/usr/local/bin/bun',
      serviceUser: 'jooevents;root',
      serviceGroup: 'jooevents'
    })).toThrow('safe user and group');
  });

  test('refuses partial or unsafe launchd service identities', () => {
    const common = {
      kind: 'launchd' as const,
      releaseRoot: '/Library/JooEvents/current',
      environmentFile: '/Library/JooEvents/config/jooevents.env',
      dataDirectory: '/Library/JooEvents/data',
      backupDirectory: '/Library/JooEvents/backups',
      logDirectory: '/Library/JooEvents/logs',
      bunExecutable: '/usr/local/bin/bun'
    };
    expect(() => renderSingleMachineService({
      ...common,
      serviceUser: 'jooevents'
    })).toThrow('safe paired user and group');
    expect(() => renderSingleMachineService({
      ...common,
      serviceUser: 'jooevents',
      serviceGroup: 'staff</string><key>RunAtLoad</key><true/>'
    })).toThrow('safe paired user and group');
  });
});
