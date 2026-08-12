import {
  createClassifiedPayloadProfileRef,
  createStageReconciliationPolicyRef,
  createUnadoptedStageProofAuthority,
  type AuthenticatedPayloadStageDescriptor,
  type ClassifiedPayloadDescriptor,
  type ClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles,
  type PayloadStageReconciliationCandidate,
  type StageReconciliationPolicyRef
} from '@jooevents/application';
import { createPayloadRef, parseInstant, parsePayloadRefId } from '@jooevents/kernel';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LocalFilesystemClassifiedPayloadStageStore,
  type RetainedClassifiedPayloadProfileResolver
} from '../classified-payload-stage-store';

const mode = process.argv[2];

if (mode === 'watch-purged') {
  const stageRoot = process.argv[3];
  const targetPid = Number(process.argv[4]);
  const readyPath = process.argv[5];
  if (!stageRoot || !Number.isInteger(targetPid) || targetPid <= 0 || !readyPath) process.exit(64);
  writeFileSync(readyPath, 'ready\n', { mode: 0o600 });
  for (;;) {
    if (readdirSync(stageRoot).some((name) => name.startsWith('.purged-'))) {
      try {
        process.kill(targetPid, 'SIGKILL');
      } finally {
        process.exit(0);
      }
    }
    await Bun.sleep(1);
  }
}

const root = process.argv[3];
const inputPath = process.argv[4];
const readyPath = process.argv[5];
const goPath = process.argv[6];
const keyText = process.env.JOOEVENTS_TEST_DESCRIPTOR_AUTH_KEY;
if (mode !== 'operate' || !root || !inputPath || !readyPath || !keyText) process.exit(64);
const signalPath = readyPath;

const profiles: ClassifiedPayloadProfiles = Object.freeze({
  classification: createClassifiedPayloadProfileRef('classification', 'classification.private-document', 1),
  schema: createClassifiedPayloadProfileRef('schema', 'schema.private-document', 1),
  content: createClassifiedPayloadProfileRef('content', 'content.private-document', 1),
  integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
  descriptorAuth: createClassifiedPayloadProfileRef('descriptor_auth', 'descriptor-auth.hmac-sha256', 1)
});
const policy = createStageReconciliationPolicyRef('reconciliation.classified-stage', 1);
const storeRoot = join(root, '.jooevents-classified-payload-stages-v1');

function profileKey(profile: ClassifiedPayloadProfileRef): string {
  return `${profile.kind}:${profile.key}@${profile.version}`;
}

function policyKey(reference: StageReconciliationPolicyRef): string {
  return `${reference.key}@${reference.version}`;
}

const retained = new Set([
  profiles.classification,
  profiles.schema,
  profiles.content,
  profiles.integrity,
  profiles.descriptorAuth
].map(profileKey));
const keyBytes = new TextEncoder().encode(keyText);

type ChildAction =
  | {
    readonly action: 'adopt';
    readonly block: 'lock-held' | 'after-reclaim' | 'after-reclaim-resumable' | 'none';
    readonly blockState: 'staged' | 'adoption_pending';
    readonly stage: AuthenticatedPayloadStageDescriptor;
    readonly expectedDescriptor: ClassifiedPayloadDescriptor;
    readonly payloadRefId: string;
    readonly at: string;
  }
  | {
    readonly action: 'mark';
    readonly block: 'lock-held' | 'after-reclaim' | 'after-reclaim-resumable' | 'none';
    readonly blockState: 'adoption_pending';
    readonly stage: AuthenticatedPayloadStageDescriptor;
    readonly payloadRefId: string;
  }
  | {
    readonly action: 'purge';
    readonly block: 'lock-held' | 'after-reclaim' | 'after-reclaim-resumable' | 'none';
    readonly blockState: 'staged';
    readonly candidate: PayloadStageReconciliationCandidate;
  };

const action = JSON.parse(readFileSync(inputPath, 'utf8')) as ChildAction;
const stageId = action.action === 'purge' ? action.candidate.stageId : action.stage.stageId;
const stageDirectory = join(storeRoot, stageId);
let blocked = false;

async function maybeBlock(): Promise<void> {
  if (blocked || action.block === 'none') return;
  const names = existsSync(stageDirectory) ? readdirSync(stageDirectory) : [];
  let activePath = join(stageDirectory, '.lock');
  let hasActive = existsSync(activePath);
  let hasReclaimed = false;
  while (hasActive) {
    let nonce: string | undefined;
    try {
      nonce = JSON.parse(readFileSync(activePath, 'utf8')).owner?.nonce;
    } catch {
      break;
    }
    if (!nonce || !existsSync(join(stageDirectory, `.lock-reclaimed-${nonce}`))) break;
    hasReclaimed = true;
    const successor = join(stageDirectory, `.lock-next-${nonce}`);
    if (!existsSync(successor)) {
      hasActive = false;
      break;
    }
    activePath = successor;
  }
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(join(stageDirectory, 'metadata.json'), 'utf8')).record?.state;
  } catch {
    return;
  }
  const shouldBlock = action.block === 'lock-held'
    ? hasActive && state === action.blockState
    : hasReclaimed && !hasActive;
  if (!shouldBlock) return;
  blocked = true;
  writeFileSync(signalPath, 'ready\n', { mode: 0o600 });
  if (action.block === 'after-reclaim-resumable' && goPath) {
    while (!existsSync(goPath)) await Bun.sleep(2);
    return;
  }
  await new Promise<never>(() => {});
}

const resolver: RetainedClassifiedPayloadProfileResolver = {
  async isRetainedProfile(profile) {
    await maybeBlock();
    return retained.has(profileKey(profile));
  },
  async isRetainedReconciliationPolicy(candidate) {
    await maybeBlock();
    return policyKey(candidate) === policyKey(policy);
  },
  async resolveDescriptorAuthenticationKey(profile) {
    await maybeBlock();
    return profileKey(profile) === profileKey(profiles.descriptorAuth) ? keyBytes.slice() : undefined;
  }
};

const authority = createUnadoptedStageProofAuthority({
  clock: { now: () => parseInstant('2026-08-11T11:00:00.000Z') },
  ownership: { resolve: () => Object.freeze({ kind: 'unadopted' as const }) }
});
const store = new LocalFilesystemClassifiedPayloadStageStore({
  root,
  profileResolver: resolver,
  purgeProofVerifier: authority.verifier
});

if (goPath && action.block !== 'after-reclaim-resumable') {
  while (!existsSync(goPath)) await Bun.sleep(2);
}

if (action.action === 'adopt') {
  await store.adopt({
    stage: action.stage,
    expectedDescriptor: action.expectedDescriptor,
    payloadRefId: parsePayloadRefId(action.payloadRefId),
    at: parseInstant(action.at)
  });
} else if (action.action === 'mark') {
  await store.markAdopted({
    stage: action.stage,
    payloadRef: createPayloadRef(parsePayloadRefId(action.payloadRefId))
  });
} else {
  const inspection = await store.inspect({ source: 'reconciliation', candidate: action.candidate });
  const issued = await authority.issue({ candidate: action.candidate, inspection });
  if (issued.kind !== 'issued') process.exit(65);
  await store.purge({ candidate: action.candidate, proof: issued.proof });
}

process.exit(0);
