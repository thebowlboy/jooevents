import { resolve } from 'node:path';
import {
  backupSingleMachineInstallation,
  restoreSingleMachineInstallationForRehearsal,
  verifySingleMachineInstallationBackup
} from '../ops/installation-backup';
import {
  doctorSingleMachine,
  installSingleMachine,
  upgradeSingleMachine,
  verifyRunningSingleMachine,
  type SingleMachineServiceKind
} from '../ops/single-machine';

function flag(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function usage(): never {
  process.stderr.write([
    'Usage:',
    '  jooevents-operator install --data-directory ABS --backup-directory ABS --log-directory ABS --environment-file ABS --service-file ABS --service-kind systemd|launchd --base-url ORIGIN --owner-email EMAIL [--operator-auth-mode magic_link|google_and_magic_link] [--review-entry-mode disabled|organizer] [--google-client-id ID] [--admission-mode pending|workspace_domain|reservation_only] [--google-hosted-domain DOMAIN] [--port N] [--service-user USER --service-group GROUP] [--allow-rehearsal]',
    '  jooevents-operator doctor --environment-file ABS [--allow-rehearsal]',
    '  jooevents-operator verify --environment-file ABS [--allow-rehearsal]',
    '  jooevents-operator upgrade --environment-file ABS --expected-database-id ID --max-backup-bytes N [--allow-rehearsal]',
    '  jooevents-operator backup-installation --environment-file ABS --backup-set ABS --expected-database-id ID --max-bytes N [--allow-rehearsal]',
    '  jooevents-operator verify-backup --backup-set ABS --max-bytes N',
    '  jooevents-operator restore-rehearsal --backup-set ABS --target-root ABS --secret-environment-file ABS --base-url ORIGIN [--port N] [--service-kind systemd|launchd] [--service-user USER --service-group GROUP] --max-bytes N [--allow-rehearsal]',
    ''
  ].join('\n'));
  process.exit(64);
}

const arguments_ = process.argv.slice(2);
const [command] = arguments_;
const releaseRoot = resolve(import.meta.dir, '../../../..');

if (command === 'install') {
  const dataDirectory = flag(arguments_, '--data-directory');
  const backupDirectory = flag(arguments_, '--backup-directory');
  const logDirectory = flag(arguments_, '--log-directory');
  const environmentFile = flag(arguments_, '--environment-file');
  const serviceFile = flag(arguments_, '--service-file');
  const serviceKind = flag(arguments_, '--service-kind') as SingleMachineServiceKind | undefined;
  const baseUrl = flag(arguments_, '--base-url');
  const ownerEmail = flag(arguments_, '--owner-email');
  const googleClientId = flag(arguments_, '--google-client-id');
  const operatorAuthMode = flag(arguments_, '--operator-auth-mode') ?? 'google_and_magic_link';
  const reviewEntryMode = flag(arguments_, '--review-entry-mode') ?? 'disabled';
  const admissionMode = flag(arguments_, '--admission-mode') ?? 'reservation_only';
  const googleHostedDomain = flag(arguments_, '--google-hosted-domain');
  const port = Number(flag(arguments_, '--port') ?? '5176');
  const serviceUser = flag(arguments_, '--service-user');
  const serviceGroup = flag(arguments_, '--service-group');
  if (
    !dataDirectory || !backupDirectory || !logDirectory || !environmentFile || !serviceFile ||
    !baseUrl || !ownerEmail || !['systemd', 'launchd'].includes(serviceKind ?? '') ||
    !['pending', 'workspace_domain', 'reservation_only'].includes(admissionMode) ||
    !['magic_link', 'google_and_magic_link'].includes(operatorAuthMode) ||
    !['disabled', 'organizer'].includes(reviewEntryMode) ||
    (operatorAuthMode === 'google_and_magic_link' && !googleClientId)
  ) usage();
  const result = installSingleMachine({
    releaseRoot,
    dataDirectory,
    backupDirectory,
    logDirectory,
    environmentFile,
    serviceFile,
    serviceKind: serviceKind!,
    bunExecutable: process.execPath,
    baseUrl,
    ownerEmail,
    operatorAuthMode: operatorAuthMode as 'magic_link' | 'google_and_magic_link',
    reviewEntryMode: reviewEntryMode as 'disabled' | 'organizer',
    ...(googleClientId ? { googleClientId } : {}),
    admissionMode: admissionMode as 'pending' | 'workspace_domain' | 'reservation_only',
    ...(googleHostedDomain ? { googleHostedDomain } : {}),
    port,
    ...(serviceUser ? { serviceUser } : {}),
    ...(serviceGroup ? { serviceGroup } : {}),
    allowRehearsal: arguments_.includes('--allow-rehearsal')
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

if (command === 'verify') {
  const environmentFile = flag(arguments_, '--environment-file');
  if (!environmentFile) usage();
  const report = await verifyRunningSingleMachine({
    releaseRoot,
    environmentFile,
    allowRehearsal: arguments_.includes('--allow-rehearsal')
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(report.status === 'failed' ? 2 : report.status === 'action_required' ? 3 : 0);
}

if (command === 'upgrade') {
  const environmentFile = flag(arguments_, '--environment-file');
  const expectedDatabaseId = flag(arguments_, '--expected-database-id');
  const maximumBackupBytes = Number(flag(arguments_, '--max-backup-bytes'));
  if (!environmentFile || !expectedDatabaseId) usage();
  const result = upgradeSingleMachine({
    releaseRoot,
    environmentFile,
    expectedDatabaseId,
    maximumBackupBytes,
    allowRehearsal: arguments_.includes('--allow-rehearsal')
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

if (command === 'backup-installation') {
  const environmentFile = flag(arguments_, '--environment-file');
  const backupSetPath = flag(arguments_, '--backup-set');
  const expectedDatabaseId = flag(arguments_, '--expected-database-id');
  const maximumBytes = Number(flag(arguments_, '--max-bytes'));
  if (!environmentFile || !backupSetPath || !expectedDatabaseId) usage();
  const result = backupSingleMachineInstallation({
    releaseRoot,
    environmentFile,
    backupSetPath,
    expectedDatabaseId,
    maximumBytes,
    allowRehearsal: arguments_.includes('--allow-rehearsal')
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

if (command === 'verify-backup') {
  const backupSetPath = flag(arguments_, '--backup-set');
  const maximumBytes = Number(flag(arguments_, '--max-bytes'));
  if (!backupSetPath) usage();
  const result = verifySingleMachineInstallationBackup({ backupSetPath, maximumBytes });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

if (command === 'restore-rehearsal') {
  const backupSetPath = flag(arguments_, '--backup-set');
  const targetRoot = flag(arguments_, '--target-root');
  const secretEnvironmentFile = flag(arguments_, '--secret-environment-file');
  const baseUrl = flag(arguments_, '--base-url');
  const port = Number(flag(arguments_, '--port') ?? '5176');
  const serviceKind = (flag(arguments_, '--service-kind') ?? (process.platform === 'darwin' ? 'launchd' : 'systemd')) as SingleMachineServiceKind;
  const serviceUser = flag(arguments_, '--service-user');
  const serviceGroup = flag(arguments_, '--service-group');
  const maximumBytes = Number(flag(arguments_, '--max-bytes'));
  if (!backupSetPath || !targetRoot || !secretEnvironmentFile || !baseUrl || !['systemd', 'launchd'].includes(serviceKind)) usage();
  const result = restoreSingleMachineInstallationForRehearsal({
    releaseRoot,
    backupSetPath,
    targetRoot,
    secretEnvironmentFile,
    baseUrl,
    port,
    bunExecutable: process.execPath,
    serviceKind,
    ...(serviceUser ? { serviceUser } : {}),
    ...(serviceGroup ? { serviceGroup } : {}),
    maximumBytes,
    allowRehearsal: arguments_.includes('--allow-rehearsal')
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

if (command === 'doctor') {
  const environmentFile = flag(arguments_, '--environment-file');
  if (!environmentFile) usage();
  const report = doctorSingleMachine({
    releaseRoot,
    environmentFile,
    allowRehearsal: arguments_.includes('--allow-rehearsal')
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(report.status === 'failed' ? 2 : report.status === 'action_required' ? 3 : 0);
}

usage();
