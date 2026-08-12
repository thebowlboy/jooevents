import { describe, expect, test } from 'bun:test';
import {
  canonicalAuthorityPrincipalKeyFrame,
  createGatewayAuthorityProjector,
  webCryptoGatewayAuthorityMac,
  type GatewayAuthorityHmacProfiles,
  type GatewayAuthorityProjectionInput,
  type GatewayDisclosureEvidence
} from './index';
import {
  parseContractVersion,
  parseInstant,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type Clock
} from '@jooevents/kernel';

const ids = {
  userA: parseUserId('018f0f47-7a86-7d36-8a25-9f86589c7001'),
  userB: parseUserId('018f0f47-7a86-7d36-8a25-9f86589c7002'),
  membershipA: parseMembershipId('018f0f47-7a86-7d36-8a25-9f86589c7011'),
  membershipB: parseMembershipId('018f0f47-7a86-7d36-8a25-9f86589c7012'),
  workspaceA: parseWorkspaceId('018f0f47-7a86-7d36-8a25-9f86589c7021'),
  workspaceB: parseWorkspaceId('018f0f47-7a86-7d36-8a25-9f86589c7022')
};

function bytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256);
}

function profile(key: string, version: number, seed: number) {
  return {
    reference: { key, version: parseContractVersion(version) },
    keyBytes: bytes(seed)
  };
}

function profiles(): GatewayAuthorityHmacProfiles {
  return {
    pendingPartition: {
      current: profile('gateway.pending.partition', 2, 20),
      retained: [{
        ...profile('gateway.pending.partition', 1, 60),
        lastIssuedAt: '2026-07-25T00:00:00.000Z',
        retainUntil: '2026-08-31T00:00:00.000Z'
      }]
    },
    disclosureEpoch: profile('gateway.disclosure.epoch', 3, 100)
  };
}

function mutableClock(initial = '2026-08-11T00:00:00.000Z') {
  let now = parseInstant(initial);
  return {
    clock: { now: () => now } satisfies Clock,
    set(value: string) { now = parseInstant(value); }
  };
}

const disclosure: GatewayDisclosureEvidence = {
  membershipVersion: 7,
  permissionCatalog: { key: 'permission.catalog', version: 4 },
  effectivePermissionIds: ['event.read', 'submission.score'],
  roleRevisions: [{
    assignmentId: 'assignment_reviewer_ada',
    assignmentVersion: 2,
    roleId: 'role_reviewer',
    roleVersion: 5
  }],
  overrideRevisions: [{ overrideId: 'override_conflict_ada', overrideVersion: 1 }],
  policyRevisions: [{ key: 'access.current_authority', version: 6 }]
};

function input(overrides: Partial<GatewayAuthorityProjectionInput> = {}): GatewayAuthorityProjectionInput {
  return {
    principal: {
      userId: ids.userA,
      membershipId: ids.membershipA,
      workspaceId: ids.workspaceA
    },
    disclosure,
    ...overrides
  };
}

describe('gateway browser authority projection', () => {
  test('keeps pending identity stable while every access-evidence change rotates disclosure', async () => {
    const time = mutableClock();
    const projector = createGatewayAuthorityProjector({ profiles: profiles(), clock: time.clock });
    const baseline = await projector.project(input());

    const variants: GatewayDisclosureEvidence[] = [
      { ...disclosure, membershipVersion: 8 },
      { ...disclosure, effectivePermissionIds: ['event.read'] },
      { ...disclosure, effectivePermissionIds: [...disclosure.effectivePermissionIds, 'event.update'] },
      {
        ...disclosure,
        roleRevisions: [{ ...disclosure.roleRevisions[0]!, roleVersion: 6 }]
      },
      {
        ...disclosure,
        overrideRevisions: [{ ...disclosure.overrideRevisions[0]!, overrideVersion: 2 }]
      },
      {
        ...disclosure,
        policyRevisions: [{ key: 'access.current_authority', version: 7 }]
      },
      { ...disclosure, permissionCatalog: { key: 'permission.catalog', version: 5 } }
    ];

    const epochs = new Set([baseline.disclosureEpoch]);
    for (const changed of variants) {
      const projected = await projector.project(input({ disclosure: changed }));
      expect(projected.principalPartition).toEqual(baseline.principalPartition);
      expect(projected.disclosureEpoch).not.toBe(baseline.disclosureEpoch);
      epochs.add(projected.disclosureEpoch);
    }
    expect(epochs.size).toBe(variants.length + 1);

    const reordered = await projector.project(input({
      disclosure: {
        ...disclosure,
        effectivePermissionIds: [...disclosure.effectivePermissionIds].reverse()
      }
    }));
    expect(reordered).toEqual(baseline);
  });

  test('isolates user, membership, and workspace replacement across both values', async () => {
    const time = mutableClock();
    const projector = createGatewayAuthorityProjector({ profiles: profiles(), clock: time.clock });
    const baseline = await projector.project(input());
    const replacements = [
      { userId: ids.userB, membershipId: ids.membershipA, workspaceId: ids.workspaceA },
      { userId: ids.userA, membershipId: ids.membershipB, workspaceId: ids.workspaceA },
      { userId: ids.userA, membershipId: ids.membershipA, workspaceId: ids.workspaceB }
    ];

    for (const principal of replacements) {
      const projected = await projector.project(input({ principal }));
      expect(projected.principalPartition.current).not.toBe(baseline.principalPartition.current);
      expect(projected.disclosureEpoch).not.toBe(baseline.disclosureEpoch);
    }
  });

  test('emits a bounded ordered rotation alias only until its checked expiry', async () => {
    const time = mutableClock();
    const oldProjector = createGatewayAuthorityProjector({
      profiles: {
        pendingPartition: { current: profile('gateway.pending.partition', 1, 60), retained: [] },
        disclosureEpoch: profile('gateway.disclosure.epoch', 3, 100)
      },
      clock: time.clock
    });
    const oldProjection = await oldProjector.project(input());

    const rotated = createGatewayAuthorityProjector({ profiles: profiles(), clock: time.clock });
    const rotatedProjection = await rotated.project(input());
    expect(rotatedProjection.principalPartition.aliases).toEqual([
      oldProjection.principalPartition.current
    ]);
    expect(rotatedProjection.principalPartition.current)
      .not.toBe(oldProjection.principalPartition.current);

    time.set('2026-08-31T00:00:00.000Z');
    expect((await rotated.project(input())).principalPartition.aliases).toEqual([]);
  });

  test('emits multiple retained aliases deterministically in decreasing-expiry order', async () => {
    const time = mutableClock();
    const disclosureProfile = profile('gateway.disclosure.epoch', 3, 200);
    const oldTwo = createGatewayAuthorityProjector({
      profiles: {
        pendingPartition: { current: profile('gateway.pending.partition', 2, 60), retained: [] },
        disclosureEpoch: disclosureProfile
      },
      clock: time.clock
    });
    const oldOne = createGatewayAuthorityProjector({
      profiles: {
        pendingPartition: { current: profile('gateway.pending.partition', 1, 140), retained: [] },
        disclosureEpoch: disclosureProfile
      },
      clock: time.clock
    });
    const rotated = createGatewayAuthorityProjector({
      profiles: {
        pendingPartition: {
          current: profile('gateway.pending.partition', 3, 20),
          retained: [
            {
              ...profile('gateway.pending.partition', 2, 60),
              lastIssuedAt: '2026-07-25T00:00:00.000Z',
              retainUntil: '2026-08-31T00:00:00.000Z'
            },
            {
              ...profile('gateway.pending.partition', 1, 140),
              lastIssuedAt: '2026-07-19T00:00:00.000Z',
              retainUntil: '2026-08-25T00:00:00.000Z'
            }
          ]
        },
        disclosureEpoch: disclosureProfile
      },
      clock: time.clock
    });
    const expected = [
      (await oldTwo.project(input())).principalPartition.current,
      (await oldOne.project(input())).principalPartition.current
    ];
    expect((await rotated.project(input())).principalPartition.aliases).toEqual(expected);
    expect((await rotated.project(input())).principalPartition.aliases).toEqual(expected);
  });

  test('rejects invalid, colliding, unordered, or over-retained profiles at composition', () => {
    const time = mutableClock();
    expect(() => createGatewayAuthorityProjector({
      profiles: {
        ...profiles(),
        pendingPartition: {
          current: profile('gateway.pending.partition', 2, 20),
          retained: [{
            ...profile('gateway.pending.partition', 1, 60),
            lastIssuedAt: '2026-07-04T00:00:00.000Z',
            retainUntil: '2026-08-10T00:00:00.000Z'
          }]
        }
      },
      clock: time.clock
    })).toThrow('already expired');

    expect(() => createGatewayAuthorityProjector({
      profiles: {
        ...profiles(),
        pendingPartition: {
          current: profile('gateway.pending.partition', 2, 20),
          retained: [
            {
              ...profile('gateway.pending.partition', 1, 60),
              lastIssuedAt: '2026-07-14T00:00:00.000Z',
              retainUntil: '2026-08-20T00:00:00.000Z'
            },
            {
              ...profile('gateway.pending.partition.old', 1, 140),
              lastIssuedAt: '2026-07-19T00:00:00.000Z',
              retainUntil: '2026-08-25T00:00:00.000Z'
            }
          ]
        }
      },
      clock: time.clock
    })).toThrow('decreasing expiry');

    expect(() => createGatewayAuthorityProjector({
      profiles: {
        ...profiles(),
        disclosureEpoch: profile('gateway.disclosure.epoch', 3, 20)
      },
      clock: time.clock
    })).toThrow('key material');

    expect(() => createGatewayAuthorityProjector({
      profiles: {
        ...profiles(),
        pendingPartition: {
          current: profile('gateway.pending.partition', 2, 20),
          retained: [{
            ...profile('gateway.pending.partition', 1, 60),
            lastIssuedAt: '2026-08-11T00:00:00.000Z',
            retainUntil: '2026-09-30T00:00:00.000Z'
          }]
        }
      },
      clock: time.clock
    })).toThrow('bounded recoverable record lifetime');

    expect(() => createGatewayAuthorityProjector({
      profiles: {
        ...profiles(),
        pendingPartition: {
          current: profile('gateway.pending.partition', 2, 20),
          retained: [{
            ...profile('gateway.pending.partition', 1, 60),
            lastIssuedAt: '2026-08-11T00:00:00.000Z',
            retainUntil: '2026-08-11T01:00:00.000Z'
          }]
        }
      },
      clock: time.clock
    })).toThrow('shorter than the recoverable record lifetime');
  });

  test('retains a just-rotated key through the full action and terminal-record lifetime', async () => {
    const time = mutableClock();
    const oldProfile = profile('gateway.pending.partition', 1, 60);
    const oldProjector = createGatewayAuthorityProjector({
      profiles: {
        pendingPartition: { current: oldProfile, retained: [] },
        disclosureEpoch: profile('gateway.disclosure.epoch', 3, 100)
      },
      clock: time.clock
    });
    const oldKey = (await oldProjector.project(input())).principalPartition.current;
    const rotated = createGatewayAuthorityProjector({
      profiles: {
        pendingPartition: {
          current: profile('gateway.pending.partition', 2, 20),
          retained: [{
            ...oldProfile,
            lastIssuedAt: '2026-08-11T00:00:00.000Z',
            retainUntil: '2026-09-17T00:00:00.000Z'
          }]
        },
        disclosureEpoch: profile('gateway.disclosure.epoch', 3, 100)
      },
      clock: time.clock
    });

    time.set('2026-09-16T23:59:59.999Z');
    expect((await rotated.project(input())).principalPartition.aliases).toEqual([oldKey]);
    time.set('2026-09-17T00:00:00.000Z');
    expect((await rotated.project(input())).principalPartition.aliases).toEqual([]);
  });

  test('copies key and frame bytes before invoking an injected MAC', async () => {
    const time = mutableClock();
    const configured = profiles();
    const control = createGatewayAuthorityProjector({ profiles: profiles(), clock: time.clock });
    const mutatingMac = {
      async sign(value: { readonly keyBytes: Uint8Array; readonly frame: Uint8Array }) {
        const material = new Uint8Array(value.keyBytes.byteLength + value.frame.byteLength);
        material.set(value.keyBytes);
        material.set(value.frame, value.keyBytes.byteLength);
        const tag = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
        value.keyBytes.fill(0);
        value.frame.fill(0);
        return tag;
      }
    };
    const projector = createGatewayAuthorityProjector({
      profiles: configured,
      clock: time.clock,
      mac: mutatingMac
    });
    configured.pendingPartition.current.keyBytes.fill(0);
    configured.pendingPartition.retained[0]!.keyBytes.fill(0);
    configured.disclosureEpoch.keyBytes.fill(0);

    const first = await projector.project(input());
    const second = await projector.project(input());
    expect(second).toEqual(first);
    expect(first.principalPartition.current).not.toBe(
      (await control.project(input())).principalPartition.current
    );
  });

  test('snapshots principal and disclosure before the first asynchronous MAC call', async () => {
    const time = mutableClock();
    const control = createGatewayAuthorityProjector({ profiles: profiles(), clock: time.clock });
    const expected = await control.project(input());
    const mutablePrincipal = {
      userId: ids.userA,
      membershipId: ids.membershipA,
      workspaceId: ids.workspaceA
    };
    const mutableDisclosure = {
      ...disclosure,
      effectivePermissionIds: [...disclosure.effectivePermissionIds],
      roleRevisions: disclosure.roleRevisions.map(entry => ({ ...entry })),
      overrideRevisions: disclosure.overrideRevisions.map(entry => ({ ...entry })),
      policyRevisions: disclosure.policyRevisions.map(entry => ({ ...entry }))
    };
    let mutated = false;
    const adversarial = createGatewayAuthorityProjector({
      profiles: profiles(),
      clock: time.clock,
      mac: {
        async sign(value) {
          if (!mutated) {
            mutated = true;
            mutablePrincipal.userId = ids.userB;
            mutablePrincipal.membershipId = ids.membershipB;
            mutablePrincipal.workspaceId = ids.workspaceB;
            mutableDisclosure.effectivePermissionIds.splice(0, Infinity, 'event.update');
            mutableDisclosure.roleRevisions[0]!.roleVersion += 100;
          }
          return webCryptoGatewayAuthorityMac.sign(value);
        }
      }
    });
    const projected = await adversarial.project({
      principal: mutablePrincipal,
      disclosure: mutableDisclosure
    });
    expect(projected).toEqual(expected);
    expect(mutablePrincipal.userId).toBe(ids.userB);
    expect(mutableDisclosure.effectivePermissionIds).toEqual(['event.update']);
  });

  test('refuses a derived current/alias collision from a faulty MAC adapter', async () => {
    const time = mutableClock();
    const projector = createGatewayAuthorityProjector({
      profiles: profiles(),
      clock: time.clock,
      mac: { sign: async () => new Uint8Array(32) }
    });
    await expect(projector.project(input())).rejects.toThrow('derivation produced a collision');
  });

  test('rejects non-canonical evidence identifiers before derivation', async () => {
    const time = mutableClock();
    const projector = createGatewayAuthorityProjector({ profiles: profiles(), clock: time.clock });
    await expect(projector.project(input({
      disclosure: {
        ...disclosure,
        roleRevisions: [{
          ...disclosure.roleRevisions[0]!,
          assignmentId: 'assign_e\u0301'
        }]
      }
    }))).rejects.toThrow('bounded non-empty identifier');
  });

  test('exposes no source identity, internal principal key, profile reference, or key material', async () => {
    const time = mutableClock();
    const configured = profiles();
    const projector = createGatewayAuthorityProjector({ profiles: configured, clock: time.clock });
    const projection = await projector.project(input());
    const serialized = JSON.stringify(projection);
    const configuredProfiles = [
      configured.pendingPartition.current,
      ...configured.pendingPartition.retained,
      configured.disclosureEpoch
    ];
    for (const canary of [
      ids.userA,
      ids.membershipA,
      ids.workspaceA,
      ...configuredProfiles.map(profile => profile.reference.key),
      ...configuredProfiles.map(profile => Buffer.from(profile.keyBytes).toString('hex'))
    ]) {
      expect(serialized).not.toContain(canary);
    }

    const internalFrame = canonicalAuthorityPrincipalKeyFrame({
      kind: 'workspace_user',
      userId: ids.userA,
      membershipId: ids.membershipA
    }, { key: 'authority.internal', version: parseContractVersion(1) });
    const internalKey = Buffer.from(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(internalFrame))
    ).toString('hex');
    expect(serialized).not.toContain(internalKey);
    expect(serialized).not.toContain(Buffer.from(internalFrame).toString('hex'));
    expect(projection.principalPartition.current).toMatch(/^gpp_[A-Za-z0-9_-]{43}$/);
    expect(projection.disclosureEpoch).toMatch(/^gde_[A-Za-z0-9_-]{43}$/);
  });
});
