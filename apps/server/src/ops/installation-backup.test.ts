import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  linkSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIVE_BUILD_IDENTITY_FILENAME,
  LIVE_BUILD_IDENTITY_SCOPE,
  liveBuildIdentityDigestPayload
} from '@jooevents/contracts/live-build-identity';
import { openSQLite, statusSQLite } from '@jooevents/persistence';
import { loadConfig } from '../config';
import { flowWorld } from '../testing/flows/flow-world';
import { runJ2Spine } from '../testing/flows/j2-spine.flow';
import {
  backupSingleMachineInstallation,
  restoreSingleMachineInstallationForRehearsal,
  verifySingleMachineInstallationBackup
} from './installation-backup';
import {
  doctorSingleMachine,
  installSingleMachine,
  readSingleMachineEnvironmentFile
} from './single-machine';

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function write(path: string, contents: string, mode = 0o600): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
}

function createSyntheticRelease(root: string): void {
  const build = join(root, 'apps/web/build-live');
  const paths = [
    '_app/immutable/entry/app.fixture.js',
    '_app/immutable/entry/start.fixture.js',
    'access/blocked.html',
    'access/pending.html',
    'app.html',
    'auth/complete.html',
    'index.html',
    'portal.html',
    'sign-in.html'
  ];
  const files = paths.map((path) => {
    const contents = `fixture:${path}`;
    write(join(build, ...path.split('/')), contents);
    return Object.freeze({ path, bytes: Buffer.byteLength(contents), sha256: sha256(contents) });
  });
  const body = Object.freeze({
    formatVersion: 1 as const,
    kind: 'live' as const,
    scope: LIVE_BUILD_IDENTITY_SCOPE,
    files: Object.freeze(files)
  });
  const live = Object.freeze({ ...body, digestSha256: sha256(liveBuildIdentityDigestPayload(body)) });
  write(join(build, LIVE_BUILD_IDENTITY_FILENAME), JSON.stringify(live));
  const sourceFiles: readonly never[] = [];
  write(join(root, 'jooevents-release.json'), JSON.stringify({
    formatVersion: 1,
    kind: 'jooevents-single-machine',
    releaseId: 'sqlite-e2-s6-test',
    sourceRevision: '0'.repeat(40),
    sourceDirty: false,
    bunVersion: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    sqliteReleaseFloor: 'sqlite-e2-s6',
    liveBuildDigestSha256: live.digestSha256,
    sourceFiles,
    sourceDigestSha256: sha256(JSON.stringify(sourceFiles))
  }));
}

interface Fixture {
  readonly root: string;
  readonly releaseRoot: string;
  readonly installRoot: string;
  readonly environmentFile: string;
  readonly databasePath: string;
  readonly databaseId: string;
  readonly backupPath: string;
  readonly secret: string;
}

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jooevents-installation-backup-test-')));
  chmodSync(root, 0o700);
  const releaseRoot = join(root, 'release');
  const installRoot = join(root, 'install');
  mkdirSync(releaseRoot, { mode: 0o700 });
  mkdirSync(join(installRoot, 'config'), { recursive: true, mode: 0o700 });
  mkdirSync(join(installRoot, 'service'), { mode: 0o700 });
  createSyntheticRelease(releaseRoot);
  const environmentFile = join(installRoot, 'config/jooevents.env');
  installSingleMachine({
    releaseRoot,
    dataDirectory: join(installRoot, 'data'),
    backupDirectory: join(installRoot, 'backups'),
    logDirectory: join(installRoot, 'logs'),
    environmentFile,
    serviceFile: join(installRoot, 'service/jooevents.plist'),
    serviceKind: 'launchd',
    bunExecutable: process.execPath,
    baseUrl: 'http://127.0.0.1:54101',
    ownerEmail: 'backup-owner@example.test',
    googleClientId: 'backup-client.apps.googleusercontent.com',
    admissionMode: 'reservation_only',
    port: 54101
  });
  const secret = 'out-of-band-google-secret-value';
  const environment = readFileSync(environmentFile, 'utf8').replace(
    'JOOEVENTS_GOOGLE_CLIENT_SECRET=REPLACE_IN_FILE',
    `JOOEVENTS_GOOGLE_CLIENT_SECRET=${secret}`
  );
  writeFileSync(environmentFile, environment, { mode: 0o600 });
  chmodSync(environmentFile, 0o600);
  const databasePath = join(installRoot, 'data/jooevents.sqlite');
  const status = statusSQLite(databasePath);
  if (status.kind !== 'compatible' || !status.migration.databaseId) throw new TypeError('fixture_database_missing');
  const blobPath = join(installRoot, 'data/blobs/recovery/proof-bin');
  write(blobPath, 'restored-file-proof');
  return Object.freeze({
    root,
    releaseRoot,
    installRoot,
    environmentFile,
    databasePath,
    databaseId: status.migration.databaseId,
    backupPath: join(installRoot, 'backups/installation'),
    secret
  });
}

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  if (fixture?.root) rmSync(fixture.root, { recursive: true });
});

function createBackup(): void {
  backupSingleMachineInstallation({
    releaseRoot: fixture.releaseRoot,
    environmentFile: fixture.environmentFile,
    backupSetPath: fixture.backupPath,
    expectedDatabaseId: fixture.databaseId,
    maximumBytes: 64 * 1024 * 1024
  });
}

describe('complete single-machine installation backup and recovery', () => {
  test('backs up database, blobs, and redacted configuration, then restores a fresh root', () => {
    expect(doctorSingleMachine({
      releaseRoot: fixture.releaseRoot,
      environmentFile: fixture.environmentFile
    })).toMatchObject({ databaseId: fixture.databaseId });
    createBackup();
    const verified = verifySingleMachineInstallationBackup({
      backupSetPath: fixture.backupPath,
      maximumBytes: 64 * 1024 * 1024
    });
    expect(verified).toMatchObject({ databaseId: fixture.databaseId, blobFiles: 1, blobBytes: 19 });
    expect(readFileSync(join(fixture.backupPath, 'backup-manifest.json'), 'utf8')).not.toContain(fixture.secret);

    const restored = restoreSingleMachineInstallationForRehearsal({
      releaseRoot: fixture.releaseRoot,
      backupSetPath: fixture.backupPath,
      targetRoot: join(fixture.root, 'restored'),
      secretEnvironmentFile: fixture.environmentFile,
      baseUrl: 'http://127.0.0.1:54102',
      port: 54102,
      bunExecutable: process.execPath,
      serviceKind: 'launchd',
      maximumBytes: 64 * 1024 * 1024
    });
    expect(statusSQLite(join(restored.targetRoot, 'data/jooevents.sqlite'))).toMatchObject({
      kind: 'compatible',
      migration: { databaseId: fixture.databaseId, databaseClass: 'frozen_release' }
    });
    expect(readFileSync(join(restored.targetRoot, 'data/blobs/recovery/proof-bin'), 'utf8')).toBe('restored-file-proof');
    expect(readFileSync(restored.environmentFile, 'utf8')).toContain(`JOOEVENTS_GOOGLE_CLIENT_SECRET=${fixture.secret}`);
    expect(readFileSync(join(restored.targetRoot, 'restore-receipt.json'), 'utf8')).not.toContain(fixture.secret);
    expect(() => restoreSingleMachineInstallationForRehearsal({
      releaseRoot: fixture.releaseRoot,
      backupSetPath: fixture.backupPath,
      targetRoot: restored.targetRoot,
      secretEnvironmentFile: fixture.environmentFile,
      baseUrl: 'http://127.0.0.1:54102',
      port: 54102,
      bunExecutable: process.execPath,
      serviceKind: 'launchd',
      maximumBytes: 64 * 1024 * 1024
    })).toThrow('never replaces');
  });

  test('refuses a live database owner and leaves no backup artifact', () => {
    const opened = openSQLite(fixture.databasePath, { migrationPolicy: 'validate' });
    try {
      expect(() => createBackup()).toThrow('Every SQLite runtime owner must stop');
      expect(existsSync(fixture.backupPath)).toBe(false);
    } finally {
      opened.sqlite.close();
    }
    expect(() => backupSingleMachineInstallation({
      releaseRoot: fixture.releaseRoot,
      environmentFile: fixture.environmentFile,
      backupSetPath: fixture.backupPath,
      expectedDatabaseId: fixture.databaseId,
      maximumBytes: 1
    })).toThrow('exceeds its configured serialization ceiling');
    expect(existsSync(fixture.backupPath)).toBe(false);
  });

  test('refuses links and permissive files, and detects changed backup bytes', () => {
    const link = join(fixture.installRoot, 'data/blobs/recovery/escape-link');
    symlinkSync('/etc/hosts', link);
    expect(() => createBackup()).toThrow('refuses links');
    rmSync(link);
    const proof = join(fixture.installRoot, 'data/blobs/recovery/proof-bin');
    const hardlink = join(fixture.installRoot, 'data/blobs/recovery/hardlink');
    linkSync(proof, hardlink);
    expect(() => createBackup()).toThrow('unsafe or oversized blob');
    rmSync(hardlink);
    const partial = join(fixture.installRoot, 'data/blobs/recovery/proof-bin.partial-deadbeef');
    write(partial, 'incomplete');
    expect(() => createBackup()).toThrow('unsafe or incomplete path');
    rmSync(partial);
    chmodSync(proof, 0o644);
    expect(() => createBackup()).toThrow('unsafe or oversized blob');
    chmodSync(proof, 0o600);
    createBackup();
    writeFileSync(join(fixture.backupPath, 'blobs/recovery/proof-bin'), 'restored-file-prooF', { mode: 0o600 });
    expect(() => verifySingleMachineInstallationBackup({
      backupSetPath: fixture.backupPath,
      maximumBytes: 64 * 1024 * 1024
    })).toThrow('blob bytes do not match');
  });

  test('restores an accepted event, file, publication, participant, delivery, and history into a running copy', async () => {
    const originalConfiguration = loadConfig(readSingleMachineEnvironmentFile(fixture.environmentFile));
    const world = await flowWorld({
      database: 'retained-frozen',
      retainedConfiguration: originalConfiguration
    });
    try {
      const result = await runJ2Spine(world);
      const organizer = world.as('organizer');
      const bytes = Buffer.from('%PDF-1.7\nrestored acceptance proof\n', 'utf8');
      const digest = sha256(bytes);
      const intentId = crypto.randomUUID();
      const assetId = crypto.randomUUID();
      const attachmentId = crypto.randomUUID();
      await organizer.do('file.upload.intent', {
        intentId,
        purpose: 'engagement_material',
        displayFilename: 'recovery-proof.pdf',
        contentType: 'application/pdf',
        declaredByteSize: bytes.byteLength
      });
      const stored = await world.runtime.app.request(
        `/api/events/current/files/uploads/${intentId}/bytes`,
        {
          method: 'PUT',
          headers: {
            cookie: organizer.actor.cookie,
            origin: originalConfiguration.baseUrl,
            'x-correlation-id': crypto.randomUUID()
          },
          body: bytes
        }
      );
      expect(stored.status).toBe(200);
      expect(await stored.json()).toMatchObject({
        kind: 'stored', intent: { byteSize: bytes.byteLength, sha256: digest }
      });
      await organizer.do('file.upload.confirm', { intentId, assetId, sha256: digest });
      await organizer.do('file.attachment.attach', {
        attachmentId,
        subject: { kind: 'submission', submissionId: result.submissionId },
        assetId
      });
      await organizer.expectRead('file.overview.read', (projection) =>
        (projection as {
          readonly attachments: readonly {
            readonly attachment: { readonly id: string };
            readonly asset: { readonly displayFilename: string } | null;
          }[];
        }).attachments.some((row) => row.attachment.id === attachmentId
          && row.asset?.displayFilename === 'recovery-proof.pdf')
      );

      await world.pauseRetained();
      const backupStartedAt = performance.now();
      createBackup();
      const backupElapsedMs = performance.now() - backupStartedAt;
      const restored = restoreSingleMachineInstallationForRehearsal({
        releaseRoot: fixture.releaseRoot,
        backupSetPath: fixture.backupPath,
        targetRoot: join(fixture.root, 'accepted-restored'),
        secretEnvironmentFile: fixture.environmentFile,
        baseUrl: 'http://127.0.0.1:54103',
        port: 54103,
        bunExecutable: process.execPath,
        serviceKind: 'launchd',
        maximumBytes: 64 * 1024 * 1024
      });
      const resumeStartedAt = performance.now();
      const restoredConfiguration = loadConfig(readSingleMachineEnvironmentFile(restored.environmentFile));
      await world.resumeRetained(restoredConfiguration);
      const resumeElapsedMs = performance.now() - resumeStartedAt;

      await organizer.expectRead('event.current.read', (projection) =>
        (projection as { readonly event?: { readonly id?: string } }).event?.id !== undefined
      );
      await organizer.expectRead('file.overview.read', (projection) =>
        (projection as {
          readonly attachments: readonly {
            readonly attachment: { readonly id: string };
            readonly asset: { readonly displayFilename: string; readonly sha256: string } | null;
          }[];
        }).attachments.some((row) => row.attachment.id === attachmentId
          && row.asset?.displayFilename === 'recovery-proof.pdf'
          && row.asset.sha256 === digest)
      );
      await world.asPublic().expectRead('schedule.public.read', (projection) =>
        (projection as { readonly sessions: readonly { readonly sessionId: string }[] }).sessions
          .some((session) => session.sessionId === result.sessionId)
      );
      await world.asSubmitter('pia.public@example.test').expectRead('portal.snapshot.read', (projection) => {
        const snapshot = projection as {
          readonly submissions: readonly { readonly id: string }[];
          readonly engagements: readonly { readonly sessionId: string }[];
        };
        return snapshot.submissions.some((submission) => submission.id === result.submissionId)
          && snapshot.engagements.some((engagement) => engagement.sessionId === result.sessionId);
      });
      await organizer.expectRead('get_delivery_history', { limit: 100 }, (projection) =>
        (projection as { readonly rows: readonly unknown[] }).rows.length > 0
      );
      expect((await world.history(organizer.actor)).entries.length).toBeGreaterThan(10);
      expect(backupElapsedMs).toBeLessThan(30_000);
      expect(resumeElapsedMs).toBeLessThan(30_000);
      expect(world.trace()).toContain('retained runtime → restored copy resumed');
    } finally {
      world.close();
    }
  }, 120_000);
});
