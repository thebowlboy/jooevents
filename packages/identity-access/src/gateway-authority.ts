import {
  canonicalJsonText,
  encodeCanonicalFrame,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type Clock,
  type ContractVersion,
  type MembershipId,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  gatewayAuthorityProjectionSchema,
  type GatewayAuthorityProjection
} from '@jooevents/contracts';
import type { VersionedKeyProfileRef } from './authority-principal';

export const GATEWAY_AUTHORITY_PROFILE_LIMITS = Object.freeze({
  maximumRetainedPartitionProfiles: 4,
  // 30-day action lifetime plus the browser record's 7-day terminal-retention bound.
  maximumRecoverableBrowserRecordLifetimeMs: 37 * 24 * 60 * 60 * 1_000,
  minimumHmacKeyBytes: 32,
  maximumEvidenceEntries: 512
});

export interface GatewayAuthorityHmacProfile {
  readonly reference: VersionedKeyProfileRef;
  readonly keyBytes: Uint8Array;
}

export interface RetainedGatewayPartitionHmacProfile extends GatewayAuthorityHmacProfile {
  /** Last instant at which this profile could have been emitted as current. */
  readonly lastIssuedAt: string;
  /** The profile remains an emitted alias only until this UTC instant. */
  readonly retainUntil: string;
}

export interface GatewayAuthorityHmacProfiles {
  readonly pendingPartition: {
    readonly current: GatewayAuthorityHmacProfile;
    /** Newest expiry first. Profile refs and key bytes must be unique. */
    readonly retained: readonly RetainedGatewayPartitionHmacProfile[];
  };
  readonly disclosureEpoch: GatewayAuthorityHmacProfile;
}

export interface GatewayWorkspacePrincipal {
  readonly userId: UserId;
  readonly membershipId: MembershipId;
  readonly workspaceId: WorkspaceId;
}

export interface GatewayRoleRevisionEvidence {
  readonly assignmentId: string;
  readonly assignmentVersion: number;
  readonly roleId: string;
  readonly roleVersion: number;
}

export interface GatewayOverrideRevisionEvidence {
  readonly overrideId: string;
  readonly overrideVersion: number;
}

export interface GatewayPolicyRevisionEvidence {
  readonly key: string;
  readonly version: number;
}

/** Complete current evidence that may affect permission-filtered presentation. */
export interface GatewayDisclosureEvidence {
  readonly membershipVersion: number;
  readonly permissionCatalog: GatewayPolicyRevisionEvidence;
  readonly effectivePermissionIds: readonly string[];
  readonly roleRevisions: readonly GatewayRoleRevisionEvidence[];
  readonly overrideRevisions: readonly GatewayOverrideRevisionEvidence[];
  readonly policyRevisions: readonly GatewayPolicyRevisionEvidence[];
}

export interface GatewayAuthorityProjectionInput {
  readonly principal: GatewayWorkspacePrincipal;
  readonly disclosure: GatewayDisclosureEvidence;
}

export type DerivedGatewayAuthorityProjection = Readonly<
  Omit<GatewayAuthorityProjection, 'principalPartition'> & {
    readonly principalPartition: Readonly<
      Omit<GatewayAuthorityProjection['principalPartition'], 'aliases'> & {
        readonly aliases: readonly GatewayAuthorityProjection['principalPartition']['aliases'][number][];
      }
    >;
  }
>;

export interface GatewayAuthorityMac {
  sign(input: {
    readonly keyBytes: Uint8Array;
    readonly frame: Uint8Array;
  }): Promise<Uint8Array>;
}

const stableKeyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function profileIdentity(profile: GatewayAuthorityHmacProfile): string {
  return `${profile.reference.key}\u0000${String(profile.reference.version)}`;
}

function requirePositiveVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

function requireStableKey(value: string, label: string): void {
  if (!stableKeyPattern.test(value) || value.length > 160) {
    throw new TypeError(`${label} must be a bounded stable key.`);
  }
}

function requireOpaqueEvidenceId(value: string, label: string): void {
  if (
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    value !== value.normalize('NFC')
  ) {
    throw new TypeError(`${label} must be a bounded non-empty identifier.`);
  }
}

function parseInstantMillis(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError(`${label} must be a canonical UTC instant.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be a real UTC instant.`);
  }
  return parsed;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    different |= left[index]! ^ right[index]!;
  }
  return different === 0;
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copyAndValidateProfile(
  profile: GatewayAuthorityHmacProfile,
  label: string
): GatewayAuthorityHmacProfile {
  requireStableKey(profile.reference.key, `${label} reference key`);
  requirePositiveVersion(profile.reference.version, `${label} reference version`);
  if (!(profile.keyBytes instanceof Uint8Array)) {
    throw new TypeError(`${label} key must be bytes.`);
  }
  if (profile.keyBytes.byteLength < GATEWAY_AUTHORITY_PROFILE_LIMITS.minimumHmacKeyBytes) {
    throw new TypeError(`${label} key is too short.`);
  }
  return Object.freeze({
    reference: Object.freeze({ ...profile.reference }),
    keyBytes: Uint8Array.from(profile.keyBytes)
  });
}

function copyProfiles(
  profiles: GatewayAuthorityHmacProfiles,
  nowMillis: number
): GatewayAuthorityHmacProfiles {
  if (
    profiles.pendingPartition.retained.length >
    GATEWAY_AUTHORITY_PROFILE_LIMITS.maximumRetainedPartitionProfiles
  ) {
    throw new TypeError('Too many retained gateway partition profiles.');
  }

  const current = copyAndValidateProfile(
    profiles.pendingPartition.current,
    'current gateway partition profile'
  );
  const disclosureEpoch = copyAndValidateProfile(
    profiles.disclosureEpoch,
    'gateway disclosure profile'
  );
  const retained = profiles.pendingPartition.retained.map((profile, index) => {
    const copied = copyAndValidateProfile(profile, `retained gateway partition profile ${index}`);
    const retainUntilMillis = parseInstantMillis(
      profile.retainUntil,
      `retained gateway partition profile ${index} expiry`
    );
    const lastIssuedAtMillis = parseInstantMillis(
      profile.lastIssuedAt,
      `retained gateway partition profile ${index} last-issued instant`
    );
    if (lastIssuedAtMillis > nowMillis) {
      throw new TypeError('A retained gateway partition profile was issued in the future.');
    }
    if (retainUntilMillis <= nowMillis) {
      throw new TypeError('A configured retained gateway partition profile is already expired.');
    }
    const retainedLifetime = retainUntilMillis - lastIssuedAtMillis;
    if (
      retainedLifetime <
      GATEWAY_AUTHORITY_PROFILE_LIMITS.maximumRecoverableBrowserRecordLifetimeMs
    ) {
      throw new TypeError('A gateway partition alias is shorter than the recoverable record lifetime.');
    }
    if (
      retainedLifetime >
      GATEWAY_AUTHORITY_PROFILE_LIMITS.maximumRecoverableBrowserRecordLifetimeMs
    ) {
      throw new TypeError('A gateway partition alias exceeds the bounded recoverable record lifetime.');
    }
    return Object.freeze({
      ...copied,
      lastIssuedAt: profile.lastIssuedAt,
      retainUntil: profile.retainUntil
    });
  });

  for (let index = 1; index < retained.length; index += 1) {
    if (retained[index - 1]!.retainUntil <= retained[index]!.retainUntil) {
      throw new TypeError('Retained gateway partition profiles must be ordered by decreasing expiry.');
    }
  }

  const all = [current, ...retained, disclosureEpoch];
  if (new Set(all.map(profileIdentity)).size !== all.length) {
    throw new TypeError('Gateway HMAC profile references must be purpose-distinct and unique.');
  }
  for (let left = 0; left < all.length; left += 1) {
    for (let right = left + 1; right < all.length; right += 1) {
      if (bytesEqual(all[left]!.keyBytes, all[right]!.keyBytes)) {
        throw new TypeError('Gateway HMAC profile key material must be purpose-distinct and unique.');
      }
    }
  }

  return Object.freeze({
    pendingPartition: Object.freeze({
      current,
      retained: Object.freeze(retained)
    }),
    disclosureEpoch
  });
}

function sortedUniqueStrings(
  values: readonly string[],
  label: string,
  validator: (value: string, label: string) => void
): readonly string[] {
  if (values.length > GATEWAY_AUTHORITY_PROFILE_LIMITS.maximumEvidenceEntries) {
    throw new TypeError(`${label} has too many entries.`);
  }
  const copy = values.map((value, index) => {
    validator(value, `${label}[${index}]`);
    return value.normalize('NFC');
  }).sort();
  if (new Set(copy).size !== copy.length) throw new TypeError(`${label} contains duplicates.`);
  return Object.freeze(copy);
}

function normalizeDisclosureEvidence(value: GatewayDisclosureEvidence): GatewayDisclosureEvidence {
  requirePositiveVersion(value.membershipVersion, 'membership version');
  requireStableKey(value.permissionCatalog.key, 'permission catalog key');
  requirePositiveVersion(value.permissionCatalog.version, 'permission catalog version');

  const roleRevisions = value.roleRevisions.map((entry, index) => {
    requireOpaqueEvidenceId(entry.assignmentId, `role revision ${index} assignment`);
    requirePositiveVersion(entry.assignmentVersion, `role revision ${index} assignment version`);
    requireOpaqueEvidenceId(entry.roleId, `role revision ${index} role`);
    requirePositiveVersion(entry.roleVersion, `role revision ${index} role version`);
    return Object.freeze({ ...entry });
  }).sort((left, right) =>
    compareCanonicalStrings(left.assignmentId, right.assignmentId) ||
    compareCanonicalStrings(left.roleId, right.roleId)
  );
  if (roleRevisions.length > GATEWAY_AUTHORITY_PROFILE_LIMITS.maximumEvidenceEntries) {
    throw new TypeError('role revisions has too many entries.');
  }
  if (new Set(roleRevisions.map(entry => entry.assignmentId)).size !== roleRevisions.length) {
    throw new TypeError('role revisions contains duplicate assignments.');
  }

  const overrideRevisions = value.overrideRevisions.map((entry, index) => {
    requireOpaqueEvidenceId(entry.overrideId, `override revision ${index} override`);
    requirePositiveVersion(entry.overrideVersion, `override revision ${index} version`);
    return Object.freeze({ ...entry });
  }).sort((left, right) => compareCanonicalStrings(left.overrideId, right.overrideId));
  if (overrideRevisions.length > GATEWAY_AUTHORITY_PROFILE_LIMITS.maximumEvidenceEntries) {
    throw new TypeError('override revisions has too many entries.');
  }
  if (new Set(overrideRevisions.map(entry => entry.overrideId)).size !== overrideRevisions.length) {
    throw new TypeError('override revisions contains duplicates.');
  }

  if (value.policyRevisions.length === 0) {
    throw new TypeError('At least one current access policy revision is required.');
  }
  const policyRevisions = value.policyRevisions.map((entry, index) => {
    requireStableKey(entry.key, `policy revision ${index} key`);
    requirePositiveVersion(entry.version, `policy revision ${index} version`);
    return Object.freeze({ ...entry });
  }).sort((left, right) => compareCanonicalStrings(left.key, right.key));
  if (policyRevisions.length > GATEWAY_AUTHORITY_PROFILE_LIMITS.maximumEvidenceEntries) {
    throw new TypeError('policy revisions has too many entries.');
  }
  if (new Set(policyRevisions.map(entry => entry.key)).size !== policyRevisions.length) {
    throw new TypeError('policy revisions contains duplicates.');
  }

  return Object.freeze({
    membershipVersion: value.membershipVersion,
    permissionCatalog: Object.freeze({ ...value.permissionCatalog }),
    effectivePermissionIds: sortedUniqueStrings(
      value.effectivePermissionIds,
      'effective permissions',
      requireStableKey
    ),
    roleRevisions: Object.freeze(roleRevisions),
    overrideRevisions: Object.freeze(overrideRevisions),
    policyRevisions: Object.freeze(policyRevisions)
  });
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export const webCryptoGatewayAuthorityMac: GatewayAuthorityMac = Object.freeze({
  async sign(input: {
    readonly keyBytes: Uint8Array;
    readonly frame: Uint8Array;
  }): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      'raw',
      ownedBuffer(input.keyBytes),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, ownedBuffer(input.frame)));
  }
});

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function signOwned(
  mac: GatewayAuthorityMac,
  profile: GatewayAuthorityHmacProfile,
  frame: Uint8Array
): Promise<Uint8Array> {
  const signed = await mac.sign({
    keyBytes: Uint8Array.from(profile.keyBytes),
    frame: Uint8Array.from(frame)
  });
  if (!(signed instanceof Uint8Array) || signed.byteLength !== 32) {
    throw new TypeError('Gateway HMAC adapter must return one SHA-256 tag.');
  }
  return Uint8Array.from(signed);
}

function canonicalPartitionFrame(
  principal: GatewayWorkspacePrincipal,
  profile: VersionedKeyProfileRef
): Uint8Array {
  return encodeCanonicalFrame({
    namespace: 'jooevents.gateway.pending-principal-partition',
    profileKey: profile.key,
    profileVersion: profile.version as ContractVersion,
    kind: 'workspace_user',
    fields: [principal.userId, principal.membershipId, principal.workspaceId]
  });
}

function canonicalDisclosureFrame(
  principal: GatewayWorkspacePrincipal,
  evidence: GatewayDisclosureEvidence,
  profile: VersionedKeyProfileRef
): Uint8Array {
  return encodeCanonicalFrame({
    namespace: 'jooevents.gateway.permission-disclosure-epoch',
    profileKey: profile.key,
    profileVersion: profile.version as ContractVersion,
    kind: 'workspace_user_access',
    fields: [
      principal.userId,
      principal.membershipId,
      principal.workspaceId,
      canonicalJsonText(evidence)
    ]
  });
}

function snapshotPrincipal(principal: GatewayWorkspacePrincipal): GatewayWorkspacePrincipal {
  return Object.freeze({
    userId: parseUserId(principal.userId),
    membershipId: parseMembershipId(principal.membershipId),
    workspaceId: parseWorkspaceId(principal.workspaceId)
  });
}

export interface GatewayAuthorityProjector {
  project(input: GatewayAuthorityProjectionInput): Promise<DerivedGatewayAuthorityProjection>;
}

/**
 * Builds disclosure-safe browser partition values without calculating or exposing
 * the internal authority-principal key. Configuration supplies purpose-specific
 * server key material; constructing this projector does not select a runtime adapter.
 */
export function createGatewayAuthorityProjector(options: {
  readonly profiles: GatewayAuthorityHmacProfiles;
  readonly clock: Clock;
  readonly mac?: GatewayAuthorityMac;
}): GatewayAuthorityProjector {
  const createdAtMillis = parseInstantMillis(options.clock.now(), 'gateway projector clock');
  const profiles = copyProfiles(options.profiles, createdAtMillis);
  const mac = options.mac ?? webCryptoGatewayAuthorityMac;

  return Object.freeze({
    async project(input: GatewayAuthorityProjectionInput): Promise<DerivedGatewayAuthorityProjection> {
      const principal = snapshotPrincipal(input.principal);
      const disclosure = normalizeDisclosureEvidence(input.disclosure);
      const nowMillis = parseInstantMillis(options.clock.now(), 'gateway projector clock');
      const retainedProfiles = profiles.pendingPartition.retained.filter(profile =>
        parseInstantMillis(profile.retainUntil, 'gateway partition alias expiry') > nowMillis
      );
      const currentFrame = canonicalPartitionFrame(
        principal,
        profiles.pendingPartition.current.reference
      );
      const aliasFrames = retainedProfiles.map(profile => Object.freeze({
        profile,
        frame: canonicalPartitionFrame(principal, profile.reference)
      }));
      const disclosureFrame = canonicalDisclosureFrame(
        principal,
        disclosure,
        profiles.disclosureEpoch.reference
      );

      const current = `gpp_${base64Url(await signOwned(
        mac,
        profiles.pendingPartition.current,
        currentFrame
      ))}`;
      const aliases: string[] = [];
      for (const { profile, frame } of aliasFrames) {
        aliases.push(`gpp_${base64Url(await signOwned(
          mac,
          profile,
          frame
        ))}`);
      }
      const disclosureEpoch = `gde_${base64Url(await signOwned(
        mac,
        profiles.disclosureEpoch,
        disclosureFrame
      ))}`;

      if (new Set([current, ...aliases]).size !== aliases.length + 1) {
        throw new TypeError('Gateway partition derivation produced a collision.');
      }
      const parsed = gatewayAuthorityProjectionSchema.parse({
        schemaVersion: 1 as const,
        principalPartition: {
          current,
          aliases
        },
        disclosureEpoch
      });
      return Object.freeze({
        ...parsed,
        principalPartition: Object.freeze({
          ...parsed.principalPartition,
          aliases: Object.freeze([...parsed.principalPartition.aliases])
        })
      });
    }
  });
}
