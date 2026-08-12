import {
  createClassifiedPayloadDescriptor,
  createClassifiedPayloadProfileRef,
  createStageReconciliationPolicyRef,
  createUnadoptedStageProofAuthority,
  type ClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles,
  type StageReconciliationPolicyRef
} from '@jooevents/application';
import { parseInstant } from '@jooevents/kernel';
import { createHash } from 'node:crypto';
import {
  LocalFilesystemClassifiedPayloadStageStore,
  type RetainedClassifiedPayloadProfileResolver
} from '../classified-payload-stage-store';

const root = process.argv[2];
const keyText = process.env.JOOEVENTS_TEST_DESCRIPTOR_AUTH_KEY;
if (!root || !keyText) process.exit(64);

const profiles: ClassifiedPayloadProfiles = Object.freeze({
  classification: createClassifiedPayloadProfileRef('classification', 'classification.private-document', 1),
  schema: createClassifiedPayloadProfileRef('schema', 'schema.private-document', 1),
  content: createClassifiedPayloadProfileRef('content', 'content.private-document', 1),
  integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
  descriptorAuth: createClassifiedPayloadProfileRef('descriptor_auth', 'descriptor-auth.hmac-sha256', 1)
});
const policy = createStageReconciliationPolicyRef('reconciliation.classified-stage', 1);

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
const resolver: RetainedClassifiedPayloadProfileResolver = {
  isRetainedProfile: (profile) => retained.has(profileKey(profile)),
  isRetainedReconciliationPolicy: (candidate) => policyKey(candidate) === policyKey(policy),
  resolveDescriptorAuthenticationKey: (profile) =>
    profileKey(profile) === profileKey(profiles.descriptorAuth) ? keyBytes.slice() : undefined
};

const bytes = new TextEncoder().encode('subprocess classified stage canary');
const descriptor = createClassifiedPayloadDescriptor({
  profiles,
  scopeBinding: 'scope.subprocess-private-canary',
  contentType: 'application/x-subprocess-private-canary',
  byteSize: bytes.byteLength,
  integrityDigest: createHash('sha256').update(bytes).digest('hex')
});
const store = new LocalFilesystemClassifiedPayloadStageStore({
  root,
  profileResolver: resolver,
  purgeProofVerifier: createUnadoptedStageProofAuthority({
    clock: { now: () => parseInstant('2026-08-11T11:00:00.000Z') },
    ownership: { resolve: () => Object.freeze({ kind: 'unadopted' as const }) }
  }).verifier
});
await store.put({
  descriptor,
  bytes,
  expiresAt: parseInstant('2026-08-11T10:00:00.000Z'),
  reconciliationPolicy: policy
});

// Simulate losing the process before any caller can create SQL or job ownership.
process.exit(73);
