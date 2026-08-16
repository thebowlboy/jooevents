import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createOperationRegistry } from '@jooevents/application';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  FILES_COMMAND_ACCESS_POLICY,
  FILES_COMMAND_ACTIONS,
  FILES_COMMAND_REQUEST_HASH_PROFILE,
  FILES_PORTAL_COMMAND_ACCESS_POLICY,
  FILES_PORTAL_COMMAND_ACTIONS,
  createFilesCommandOperationModule,
  createFilesPortalCommandOperationModule,
  filesCommandContributionSchema,
  portalSubjectGuard,
  sealFilesCommandPreparation,
  FILES_COMMAND_HANDLER_CAPABILITY
} from './command-module';

const scope = Object.freeze({
  workspaceId: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  eventId: parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101')
});
const profile = Object.freeze({ key: 'files-command-test', version: parseContractVersion(1) });
const uuid = (last: string) => `019c1df7-86b5-769b-bba4-5f7097bfa${last}`;

const shared = Object.freeze({
  currentAuthority: {
    resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'missing' as const })
  },
  clock: { now: () => parseInstant('2026-08-15T12:00:00.000Z') },
  ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
  authorityPrincipalKeyProfile: profile,
  scopePartitionProfile: profile,
  requestCanonicalizationProfile: profile,
  requestHashSealer: {
    seal: () => Object.freeze({
      profile: FILES_COMMAND_REQUEST_HASH_PROFILE,
      requestHashSha256: 'a'.repeat(64)
    })
  } as never,
  idempotencyCredentialProfile: profile,
  idempotencyCredentialSealer: {
    seal: (raw: string) => Object.freeze({
      verifierProfile: profile,
      verifierSha256: createHash('sha256').update(`files-key:${raw}`).digest('hex')
    })
  }
});

describe('files command operation modules', () => {
  test('registers all ten operator commands as commit-tier POST bindings', async () => {
    const module = createFilesCommandOperationModule({
      workspaceId: scope.workspaceId,
      commandPolicy: FILES_COMMAND_ACCESS_POLICY,
      currentEvent: {
        resolveCurrentEvent: () => Object.freeze({
          eventId: scope.eventId,
          evidenceIds: Object.freeze(['event.current.selection'])
        })
      },
      ...shared
    });
    const registry = await createOperationRegistry(module.source);
    const bindings = registry.operatorHttpEffectBindings.map((binding) => ({
      operation: binding.operationName,
      method: binding.method,
      path: binding.path
    }));
    expect(bindings).toHaveLength(FILES_COMMAND_ACTIONS.length);
    expect(bindings).toContainEqual({
      operation: 'file.upload.intent', method: 'POST',
      path: '/api/events/current/files/uploads/intent'
    });
    expect(bindings).toContainEqual({
      operation: 'file.upload.confirm', method: 'POST',
      path: '/api/events/current/files/uploads/confirm'
    });
    expect(bindings).toContainEqual({
      operation: 'file.attachment.link', method: 'POST',
      path: '/api/events/current/files/attachments/link'
    });
    expect(bindings).toContainEqual({
      operation: 'file.request.create', method: 'POST',
      path: '/api/events/current/files/requests/create'
    });
    for (const operation of registry.safeManifest.operations) {
      expect(operation).toMatchObject({ effect: 'commit', maxRisk: 'normal' });
      const outcomes = (operation as { outcomes: readonly { class: string; kind: string }[] })
        .outcomes.map((outcome) => `${outcome.class}:${outcome.kind}`);
      expect(outcomes).toContain('policy_violation:file.command_refused');
      expect(outcomes).toContain('idempotency_conflict:operation.request_changed');
      expect(outcomes).toContain('conflict:operation.in_progress');
    }
  });

  test('the portal module registers exactly the participant-permitted subset', async () => {
    const module = createFilesPortalCommandOperationModule({
      lane: { workspaceId: scope.workspaceId, eventId: scope.eventId },
      commandPolicy: FILES_PORTAL_COMMAND_ACCESS_POLICY,
      ...shared
    });
    expect(FILES_PORTAL_COMMAND_ACCESS_POLICY.key).toBe('authority.portal.participant.act');
    const registry = await createOperationRegistry(module.source);
    const names = registry.safeManifest.operations.map((operation) => operation.name).sort();
    expect(names).toEqual(
      [...FILES_PORTAL_COMMAND_ACTIONS].map((action) => `file.${action}`).sort()
    );
    // No detach, no share management, no request create/withdraw on the portal.
    expect(names).not.toContain('file.attachment.detach');
    expect(names).not.toContain('file.share.create');
    expect(names).not.toContain('file.request.create');
    for (const operation of (module.source as unknown as {
      effectOperations: readonly { accessLanes: readonly { kind: string; surface: string }[] }[];
    }).effectOperations) {
      expect(operation.accessLanes).toEqual([
        expect.objectContaining({ kind: 'participant', surface: 'participant_http' })
      ]);
    }
  });

  test('policy catalog mismatches refuse construction', () => {
    const wrong = Object.freeze({ key: 'authority.other', version: parseContractVersion(1) });
    expect(() => createFilesCommandOperationModule({
      workspaceId: scope.workspaceId,
      commandPolicy: wrong,
      currentEvent: { resolveCurrentEvent: () => ({ evidenceIds: [] }) },
      ...shared
    })).toThrow('files_command_policy_catalog_mismatch');
    expect(() => createFilesPortalCommandOperationModule({
      lane: { workspaceId: scope.workspaceId, eventId: scope.eventId },
      commandPolicy: wrong,
      ...shared
    })).toThrow('files_portal_command_policy_catalog_mismatch');
  });

  test('the contribution schema accepts coherent evidence and rejects foreign refusals', () => {
    const schema = filesCommandContributionSchema('request.withdraw');
    const request = {
      schemaVersion: 1,
      id: uuid('701'),
      scope: { workspaceId: scope.workspaceId, eventId: scope.eventId },
      engagementId: uuid('702'),
      what: 'Final deck',
      instructions: null,
      deadlineId: null,
      state: 'withdrawn',
      fulfillingAttachmentId: null,
      createdByUserId: uuid('703'),
      version: 2,
      createdAt: '2026-08-15T11:00:00.000Z',
      updatedAt: '2026-08-15T12:00:00.000Z'
    };
    const success = {
      result: { kind: 'success', data: { action: 'request.withdraw', request } },
      domain: {
        kind: 'files_command',
        preparationHandle: uuid('704'),
        action: 'request.withdraw',
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        recordId: uuid('701'),
        recordVersion: 2,
        occurredAt: '2026-08-15T12:00:00.000Z'
      },
      effectContributions: [{
        kind: 'domain_fact',
        factId: uuid('705'),
        factKind: 'file_request_changed',
        payload: { action: 'withdraw', requestId: uuid('701') },
        occurredAt: '2026-08-15T12:00:00.000Z'
      }]
    };
    expect(schema.safeParse(success).success).toBe(true);
    expect(schema.safeParse({
      ...success,
      domain: { ...success.domain, action: 'request.fulfill' }
    }).success).toBe(false);
    const refusal = (kind: string, klass: string, detail: unknown) => ({
      result: {
        kind: 'outcome',
        outcome: { class: klass, kind, retryable: false, subjects: [], detail, detailSchemaVersion: 1 }
      },
      domain: null,
      effectContributions: []
    });
    expect(schema.safeParse(refusal(
      'file.command_refused', 'policy_violation',
      { action: 'request.withdraw', code: 'stale_request' }
    )).success).toBe(true);
    expect(schema.safeParse(refusal('file.event_required', 'conflict', null)).success).toBe(true);
    expect(schema.safeParse(refusal(
      'file.command_refused', 'policy_violation',
      { action: 'request.withdraw', code: 'not_a_code' }
    )).success).toBe(false);
    expect(schema.safeParse(refusal('file.other', 'conflict', null)).success).toBe(false);
  });

  test('portal subject guard refuses attach outside the relationship before any adapter work', () => {
    const mine = uuid('801');
    const other = uuid('802');
    expect(portalSubjectGuard('attachment.attach', {
      attachmentId: uuid('803'),
      subject: { kind: 'engagement', engagementId: mine },
      assetId: uuid('804')
    }, [mine])).toBeUndefined();
    const refusedOther = portalSubjectGuard('attachment.attach', {
      attachmentId: uuid('803'),
      subject: { kind: 'engagement', engagementId: other },
      assetId: uuid('804')
    }, [mine]);
    expect((refusedOther?.result as { outcome: { detail: unknown } }).outcome.detail)
      .toEqual({ action: 'attachment.attach', code: 'portal_not_related' });
    const refusedSession = portalSubjectGuard('attachment.link', {
      attachmentId: uuid('803'),
      subject: { kind: 'session', sessionId: mine },
      link: { provider: 'url', label: 'x', url: 'https://example.com' }
    }, [mine]);
    expect(refusedSession).toBeDefined();
    // Non-subject commands pass through; record-level checks stay adapter-side.
    expect(portalSubjectGuard('upload.intent', {}, [mine])).toBeUndefined();
    expect(portalSubjectGuard('request.fulfill', {}, [mine])).toBeUndefined();
  });

  test('a sealed preparation runs exactly once, synchronously, on its own context', () => {
    const context = { fake: 'context' } as never;
    let calls = 0;
    const snapshot = sealFilesCommandPreparation({
      capability: FILES_COMMAND_HANDLER_CAPABILITY,
      context,
      preparation: {
        prepare: () => {
          calls += 1;
          return { result: { kind: 'outcome' }, domain: null, effectContributions: [] };
        }
      }
    });
    expect(snapshot).toEqual({ strategy: 'files_command', version: 1 });
    expect(calls).toBe(0);
    expect(() => sealFilesCommandPreparation({
      capability: FILES_COMMAND_HANDLER_CAPABILITY,
      context,
      preparation: { prepare: (async () => ({})) as never }
    })).toThrow('files_command_preparation_must_be_synchronous');
  });
});
