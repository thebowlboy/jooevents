import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  type EffectUnitOfWorkPort,
  type InvocationEvidence
} from '@jooevents/application';
import {
  servedPublicRosterSchema,
  servedPublicScheduleSchema,
  type ServedPublicPresentationDto,
  type ServedPublicRosterDto,
  type ServedPublicScheduleDto
} from '@jooevents/contracts';
import type { CurrentAuthorityResolver } from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseCorrelationId,
  parseInstant,
  parseInvocationId,
  parsePublicPolicyRevisionId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  createReleasePublicReadOperationModule,
  RELEASE_PUBLIC_OPEN_ACCESS_POLICY,
  RELEASE_PUBLIC_APPLY_PRESENTATION_READ_OPERATION,
  RELEASE_PUBLIC_ROSTER_READ_OPERATION,
  RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_OPERATION,
  RELEASE_PUBLIC_SCHEDULE_READ_OPERATION,
  RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_OPERATION,
  type ReleasePublicReadPort
} from './module';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = '019c1df7-86b5-769b-bba4-5f7097bfd101';
const roomId = '019c1df7-86b5-769b-bba4-5f7097bfd401';
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfd201';
const personId = '019c1df7-86b5-769b-bba4-5f7097bfd501';
const revisionId = parsePublicPolicyRevisionId('019c1df7-86b5-769b-bba4-5f7097bfd601');
const profile = Object.freeze({ key: 'release.public-read-test', version: parseContractVersion(1) });
const clock = Object.freeze({ now: () => parseInstant('2026-08-14T12:00:00.000Z') });
let nextInvocation = 0;
const ids = Object.freeze({
  newInvocationId: () => parseInvocationId(
    `019c1df7-86b5-769b-bba4-${(0x5f7097bfd700 + nextInvocation++).toString(16).padStart(12, '0')}`
  )
});
const crypto = Object.freeze({
  authorityPrincipalKeyProfile: profile,
  scopePartitionProfile: profile,
  requestCanonicalizationProfile: profile
});

const publicOperations = Object.freeze([
  RELEASE_PUBLIC_SCHEDULE_READ_OPERATION,
  RELEASE_PUBLIC_ROSTER_READ_OPERATION,
  RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_OPERATION,
  RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_OPERATION,
  RELEASE_PUBLIC_APPLY_PRESENTATION_READ_OPERATION
]);

const publicAuthority: CurrentAuthorityResolver<InvocationEvidence> = Object.freeze({
  resolve(input: Parameters<CurrentAuthorityResolver<InvocationEvidence>['resolve']>[0]) {
    if (input.evidence.kind !== 'public_open'
        || input.evidence.publicPolicyRevisionId !== revisionId
        || input.lane.kind !== 'public_open'
        || input.lane.surface !== 'public_http'
        || input.lane.policy.key !== RELEASE_PUBLIC_OPEN_ACCESS_POLICY.key
        || input.lane.policy.version !== RELEASE_PUBLIC_OPEN_ACCESS_POLICY.version
        || !publicOperations.some((operation) => operation.name === input.operation.name
          && operation.version === input.operation.version)) {
      return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
    }
    return Object.freeze({
      kind: 'authorized' as const,
      authority: Object.freeze({
        actor: Object.freeze({
          kind: 'public_request' as const,
          publicPolicyRevisionId: revisionId,
          authority: Object.freeze({ kind: 'open_policy' as const })
        }),
        principal: Object.freeze({
          kind: 'public_capability' as const,
          publicPolicyRevisionId: revisionId,
          authority: Object.freeze({ kind: 'open_policy' as const })
        }),
        lane: input.lane,
        scope: input.scope,
        grants: Object.freeze([{ kind: 'public_policy' as const, key: input.operation.name }]),
        evidenceIds: Object.freeze(['release-public-read.current']),
        authorityCitationIds: Object.freeze([]),
        evaluatedAt: input.evaluatedAt
      })
    });
  }
});

const publicEvidence: InvocationEvidence = Object.freeze({
  kind: 'public_open',
  surface: 'public_http',
  client: { key: 'web.public' },
  publicPolicyRevisionId: revisionId
});

const operatorEvidence: InvocationEvidence = Object.freeze({
  kind: 'operator', surface: 'operator_http', client: { key: 'web.operator' },
  sessionHandle: 'session-release-test'
});

const unusedUnitOfWork: EffectUnitOfWorkPort = Object.freeze({
  findTerminalReceipt: () => undefined,
  recordShortOperationAudit: () => undefined,
  async runInUnitOfWork() { throw new TypeError('release_test_effect_not_mounted'); }
});

function servedSchedule(releaseNumber: number, speakers: readonly string[]): ServedPublicScheduleDto {
  return {
    schemaVersion: 1,
    releaseNumber,
    rooms: [{ id: roomId, name: 'Main Hall' }],
    sessions: [{
      sessionId,
      title: 'Opening Keynote',
      plannedDurationMinutes: 60,
      format: 'Talk',
      track: null,
      occurrences: [{
        occurrenceId: '019c1df7-86b5-769b-bba4-5f7097bfd901',
        roomId,
        startAt: '2026-11-01T09:00:00.000Z',
        endAt: '2026-11-01T10:00:00.000Z'
      }],
      speakers: [...speakers]
    }]
  };
}

function servedRoster(releaseNumber: number, names: readonly string[]): ServedPublicRosterDto {
  return {
    schemaVersion: 1,
    releaseNumber,
    speakers: names.map((name) => ({
      name,
      sessions: [{ sessionId, title: 'Opening Keynote' }]
    }))
  };
}

function servedPresentation(surfaceKind: 'schedule' | 'speakers' | 'apply'):
ServedPublicPresentationDto {
  return {
    schemaVersion: 1,
    surfaceKind,
    surfaceReleaseNumber: 1,
    manifest: { schemaVersion: 1, heading: 'Published', intro: 'Released presentation.' },
    styleSetReleaseNumber: 1,
    style: {
      name: 'Released', canvas: '#f4f1ed', surface: '#ffffff', text: '#29231f',
      action: '#a14e42', radius: 8, controlHeight: 38
    }
  };
}

interface PortState {
  schedule: ServedPublicScheduleDto | undefined;
  roster: ServedPublicRosterDto | undefined;
  presentations?: Partial<Record<'schedule' | 'speakers' | 'apply', ServedPublicPresentationDto>>;
}

function port(state: PortState): ReleasePublicReadPort {
  return Object.freeze({
    readServedSchedule: () => state.schedule,
    readServedRoster: () => state.roster,
    readServedPresentation: (
      _scope: Parameters<ReleasePublicReadPort['readServedPresentation']>[0],
      kind: Parameters<ReleasePublicReadPort['readServedPresentation']>[1]
    ) => state.presentations?.[kind]
  });
}

function scopeSource(expectedRevision = revisionId) {
  return Object.freeze({
    resolve(input: { readonly publicPolicyRevisionId: unknown }) {
      if (input.publicPolicyRevisionId !== expectedRevision) return undefined;
      return Object.freeze({
        workspaceId,
        eventId,
        evidenceIds: Object.freeze(['event:current', `release-public-policy:${expectedRevision}`])
      });
    }
  });
}

async function runtimeFor(state: PortState) {
  const module = createReleasePublicReadOperationModule({
    policy: RELEASE_PUBLIC_OPEN_ACCESS_POLICY,
    currentAuthority: publicAuthority,
    publicScope: scopeSource(),
    read: port(state),
    clock,
    ids,
    crypto
  });
  return createApplicationOperationRuntime({
    source: module.source,
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock,
      newInvocationId: ids.newInvocationId
    },
    unitOfWork: unusedUnitOfWork
  });
}

function execute(
  runtime: Awaited<ReturnType<typeof runtimeFor>>,
  operationName: string,
  evidence: InvocationEvidence = publicEvidence
) {
  return runtime.readExecutor.execute({
    operationName,
    operationVersion: 1,
    surface: 'public_http',
    correlationId: parseCorrelationId('019c1df7-86b5-769b-bba4-5f7097bfda01'),
    businessInput: {},
    verifiedEvidence: evidence
  });
}

describe('release public read operations', () => {
  test('freezes the public data and presentation reads', () => {
    const module = createReleasePublicReadOperationModule({
      policy: RELEASE_PUBLIC_OPEN_ACCESS_POLICY,
      currentAuthority: publicAuthority,
      publicScope: scopeSource(),
      read: port({ schedule: undefined, roster: undefined }),
      clock,
      ids,
      crypto
    });
    const table = (module.source.operations ?? []).flatMap((operation) =>
      operation.bindings.map((binding) => ({
        operation: `${operation.name}@${operation.version}`,
        effect: operation.effect,
        method: 'method' in binding ? binding.method : undefined,
        path: 'path' in binding ? binding.path : undefined,
        surface: binding.surface
      }))
    );
    expect(table).toEqual([
      { operation: 'schedule.public.read@1', effect: 'read', method: 'GET', path: '/api/public/schedule/current', surface: 'public_http' },
      { operation: 'roster.public.read@1', effect: 'read', method: 'GET', path: '/api/public/speakers/current', surface: 'public_http' },
      { operation: 'schedule.public.presentation.read@1', effect: 'read', method: 'GET', path: '/api/public/schedule/presentation', surface: 'public_http' },
      { operation: 'roster.public.presentation.read@1', effect: 'read', method: 'GET', path: '/api/public/speakers/presentation', surface: 'public_http' },
      { operation: 'apply.public.presentation.read@1', effect: 'read', method: 'GET', path: '/api/public/forms/presentation', surface: 'public_http' }
    ]);
    expect((module.source.effectOperations ?? [])).toHaveLength(0);
  });

  test('fails closed on a substituted policy reference', () => {
    expect(() => createReleasePublicReadOperationModule({
      policy: { key: 'authority.intake.public-open', version: parseContractVersion(1) },
      currentAuthority: publicAuthority,
      publicScope: scopeSource(),
      read: port({ schedule: undefined, roster: undefined }),
      clock,
      ids,
      crypto
    })).toThrow('release_public_open_policy_catalog_mismatch');
  });

  test('serves the newest published projection and successors immediately', async () => {
    const state: PortState = {
      schedule: servedSchedule(1, ['Ada Lovelace']),
      roster: servedRoster(1, ['Ada Lovelace']),
      presentations: {
        schedule: servedPresentation('schedule'),
        speakers: servedPresentation('speakers'),
        apply: servedPresentation('apply')
      }
    };
    const runtime = await runtimeFor(state);

    const schedule = await execute(runtime, 'schedule.public.read');
    if (schedule.kind !== 'success') throw new Error('expected success');
    expect(schedule.data).toEqual(servedSchedule(1, ['Ada Lovelace']));
    const roster = await execute(runtime, 'roster.public.read');
    if (roster.kind !== 'success') throw new Error('expected success');
    expect(roster.data).toEqual(servedRoster(1, ['Ada Lovelace']));
    const presentation = await execute(runtime, 'schedule.public.presentation.read');
    if (presentation.kind !== 'success') throw new Error('expected success');
    expect(presentation.data).toEqual(servedPresentation('schedule'));

    for (const bytes of [JSON.stringify(schedule), JSON.stringify(roster)]) {
      expect(bytes).not.toContain('personId');
      expect(bytes).not.toContain(personId);
      expect(bytes).not.toContain('email');
      expect(bytes).not.toContain('@');
      expect(bytes).not.toContain('"note"');
      expect(bytes).not.toContain(workspaceId);
      expect(bytes).not.toContain(eventId);
    }

    // A successor release replaces what is served with no pointer to move.
    state.schedule = servedSchedule(2, []);
    state.roster = servedRoster(2, []);
    const successor = await execute(runtime, 'schedule.public.read');
    if (successor.kind !== 'success') throw new Error('expected success');
    expect(servedPublicScheduleSchema.parse(successor.data).releaseNumber).toBe(2);
    expect(JSON.stringify(successor)).not.toContain('Ada Lovelace');
    const successorRoster = await execute(runtime, 'roster.public.read');
    if (successorRoster.kind !== 'success') throw new Error('expected success');
    expect(servedPublicRosterSchema.parse(successorRoster.data).speakers).toEqual([]);
  });

  test('no published release is a typed absence, never an empty page', async () => {
    const runtime = await runtimeFor({ schedule: undefined, roster: undefined });
    for (const operation of [
      'schedule.public.read',
      'roster.public.read',
      'schedule.public.presentation.read',
      'roster.public.presentation.read',
      'apply.public.presentation.read'
    ]) {
      const result = await execute(runtime, operation);
      expect(result).toEqual({
        kind: 'outcome',
        outcome: {
          class: 'conflict',
          kind: 'release.not_published',
          retryable: false,
          subjects: [],
          detail: null,
          detailSchemaVersion: 1
        },
        correlationId: parseCorrelationId('019c1df7-86b5-769b-bba4-5f7097bfda01')
      });
    }
  });

  test('refuses non-public evidence and unrecognized policy revisions', async () => {
    const runtime = await runtimeFor({
      schedule: servedSchedule(1, ['Ada Lovelace']),
      roster: servedRoster(1, ['Ada Lovelace'])
    });
    await expect(execute(runtime, 'schedule.public.read', operatorEvidence))
      .rejects.toThrow();
    const staleEvidence: InvocationEvidence = Object.freeze({
      kind: 'public_open',
      surface: 'public_http',
      client: { key: 'web.public' },
      publicPolicyRevisionId: parsePublicPolicyRevisionId('019c1df7-86b5-769b-bba4-5f7097bfd602')
    });
    await expect(execute(runtime, 'roster.public.read', staleEvidence))
      .rejects.toThrow();
  });

  test('refuses a read port that smuggles non-public fields', async () => {
    const hostileRoster = {
      ...servedRoster(1, ['Ada Lovelace']),
      speakers: [{
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        sessions: [{ sessionId, title: 'Opening Keynote' }]
      }]
    } as unknown as ServedPublicRosterDto;
    const runtime = await runtimeFor({
      schedule: servedSchedule(1, ['Ada Lovelace']),
      roster: hostileRoster
    });
    await expect(execute(runtime, 'roster.public.read')).rejects.toThrow();
  });
});
