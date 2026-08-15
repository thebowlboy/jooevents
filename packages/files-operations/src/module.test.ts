import { describe, expect, test } from 'bun:test';
import { createOperationRegistry } from '@jooevents/application';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  FILE_MCP_READ_ACCESS_POLICY,
  FILE_OVERVIEW_READ_OPERATION,
  FILE_PORTAL_ENGAGEMENT_FILES_READ_OPERATION,
  FILE_PORTAL_READ_ACCESS_POLICY,
  FILE_READ_ACCESS_POLICY,
  FILE_READ_PERMISSION_ID,
  FILE_MANAGE_PERMISSION_ID,
  createFilesPortalReadOperationModule,
  createFilesReadOperationModule,
  portalEngagementGrantKeys
} from './module';

const scope = Object.freeze({
  workspaceId: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  eventId: parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101')
});
const profile = Object.freeze({ key: 'files-operation-test', version: parseContractVersion(1) });
const engagementId = '019c1df7-86b5-769b-bba4-5f7097bfa601';

const shared = Object.freeze({
  currentAuthority: {
    resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'missing' as const })
  },
  clock: { now: () => parseInstant('2026-08-15T12:00:00.000Z') },
  ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
  authorityPrincipalKeyProfile: profile,
  scopePartitionProfile: profile,
  requestCanonicalizationProfile: profile
});

describe('files read operation modules', () => {
  test('permission reuse: no new permission id is minted for files v1', () => {
    expect(FILE_READ_PERMISSION_ID).toBe('submission.read');
    expect(FILE_MANAGE_PERMISSION_ID).toBe('event.manage');
  });

  test('registers the organizer overview read on the operator lane', async () => {
    const module = createFilesReadOperationModule({
      workspaceId: scope.workspaceId,
      readPolicy: FILE_READ_ACCESS_POLICY,
      ...shared,
      currentEvent: {
        resolveCurrentEvent: () => Object.freeze({
          eventId: scope.eventId,
          evidenceIds: Object.freeze(['event.current.selection'])
        })
      },
      read: { readOrganizerFileOverview: () => undefined }
    });
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path
    }))).toEqual([{
      operation: `${FILE_OVERVIEW_READ_OPERATION.name}@1`,
      method: 'GET',
      path: '/api/events/current/files'
    }]);
    const manifest = registry.safeManifest.operations.find(
      (operation) => operation.name === FILE_OVERVIEW_READ_OPERATION.name
    );
    expect(manifest).toMatchObject({ effect: 'read', maxRisk: 'low' });
    const sourceOperation = (module.source as unknown as {
      operations: readonly { accessLanes: readonly { kind: string }[] }[];
    }).operations[0]!;
    expect(sourceOperation.accessLanes.map((lane) => lane.kind)).toEqual(['operator']);
  });

  test('adds the external MCP read lane only when its policy is composed', async () => {
    const module = createFilesReadOperationModule({
      workspaceId: scope.workspaceId,
      readPolicy: FILE_READ_ACCESS_POLICY,
      mcpReadPolicy: FILE_MCP_READ_ACCESS_POLICY,
      ...shared,
      currentEvent: {
        resolveCurrentEvent: () => Object.freeze({
          eventId: scope.eventId, evidenceIds: Object.freeze(['event.current.selection'])
        })
      },
      read: { readOrganizerFileOverview: () => undefined }
    });
    await createOperationRegistry(module.source);
    const sourceOperation = (module.source as unknown as {
      operations: readonly {
        accessLanes: readonly { kind: string }[];
        bindings: readonly { surface: string; toolName?: string }[];
      }[];
    }).operations[0]!;
    expect(sourceOperation.accessLanes.map((lane) => lane.kind).sort())
      .toEqual(['external_mcp', 'operator']);
    // The MCP lane is served by an external_mcp tool binding, never by SPA paths.
    expect(sourceOperation.bindings).toContainEqual(expect.objectContaining({
      surface: 'external_mcp',
      toolName: FILE_OVERVIEW_READ_OPERATION.name
    }));
  });

  test('refuses a policy outside the declared catalog', () => {
    expect(() => createFilesReadOperationModule({
      workspaceId: scope.workspaceId,
      readPolicy: Object.freeze({ key: 'authority.other', version: parseContractVersion(1) }),
      ...shared,
      currentEvent: {
        resolveCurrentEvent: () => Object.freeze({ evidenceIds: Object.freeze([]) })
      },
      read: { readOrganizerFileOverview: () => undefined }
    })).toThrow('files_read_policy_catalog_mismatch');
    expect(() => createFilesPortalReadOperationModule({
      lane: { workspaceId: scope.workspaceId, eventId: scope.eventId },
      readPolicy: FILE_READ_ACCESS_POLICY,
      ...shared,
      read: { readPortalEngagementFiles: () => undefined }
    })).toThrow('files_portal_read_policy_catalog_mismatch');
  });

  test('the portal read registers on the participant lane and reuses the portal read policy', async () => {
    const module = createFilesPortalReadOperationModule({
      lane: { workspaceId: scope.workspaceId, eventId: scope.eventId },
      readPolicy: FILE_PORTAL_READ_ACCESS_POLICY,
      ...shared,
      read: { readPortalEngagementFiles: () => undefined }
    });
    expect(FILE_PORTAL_READ_ACCESS_POLICY.key).toBe('authority.portal.participant.read');
    const registry = await createOperationRegistry(module.source);
    const manifest = registry.safeManifest.operations.find(
      (operation) => operation.name === FILE_PORTAL_ENGAGEMENT_FILES_READ_OPERATION.name
    );
    expect(manifest).toMatchObject({ effect: 'read', maxRisk: 'low' });
    const sourceOperation = (module.source as unknown as {
      operations: readonly { accessLanes: readonly { kind: string; surface: string }[] }[];
    }).operations[0]!;
    expect(sourceOperation.accessLanes)
      .toEqual([expect.objectContaining({ kind: 'participant', surface: 'participant_http' })]);
    const outcomes = (manifest as unknown as { outcomes: readonly { class: string; kind: string }[] }).outcomes
      .map((outcome) => `${outcome.class}:${outcome.kind}`);
    expect(outcomes).toContain('access_denied:file.portal.not_related');
  });

  test('D8 portal scoping: the handler serves exactly the engagements the current relationship lists', async () => {
    const served = {
      schemaVersion: 1 as const,
      engagementId,
      attachments: [],
      requests: []
    };
    const module = createFilesPortalReadOperationModule({
      lane: { workspaceId: scope.workspaceId, eventId: scope.eventId },
      readPolicy: FILE_PORTAL_READ_ACCESS_POLICY,
      ...shared,
      read: { readPortalEngagementFiles: (_scope, id) => id === engagementId ? served : undefined }
    });
    const handler = module.source.handlers[0]!;
    const context = (grants: readonly unknown[]) => ({
      scope: { workspaceId: scope.workspaceId, eventId: scope.eventId },
      authority: { grants }
    }) as never;
    const related = [{ kind: 'participant_relationship', key: `engagement:${engagementId}` }];

    const granted = handler.handle({
      businessInput: { subject: { kind: 'engagement', engagementId } },
      context: context(related),
      snapshot: { context: context(related) }
    } as never) as { kind: string; data?: unknown };
    expect(granted).toEqual({ kind: 'success', data: served });

    const unrelated = handler.handle({
      businessInput: { subject: { kind: 'engagement', engagementId: '019c1df7-86b5-769b-bba4-5f7097bfa999' } },
      context: context(related),
      snapshot: { context: context(related) }
    } as never) as { kind: string; outcome?: { kind: string } };
    expect(unrelated.kind).toBe('outcome');
    expect(unrelated.outcome?.kind).toBe('file.portal.not_related');

    const wrongSubject = handler.handle({
      businessInput: { subject: { kind: 'submission', submissionId: engagementId } },
      context: context(related),
      snapshot: { context: context(related) }
    } as never) as { kind: string; outcome?: { kind: string } };
    expect(wrongSubject.outcome?.kind).toBe('file.portal.not_related');

    const noRelationship = handler.handle({
      businessInput: { subject: { kind: 'engagement', engagementId } },
      context: context([]),
      snapshot: { context: context([]) }
    } as never) as { kind: string; outcome?: { kind: string } };
    expect(noRelationship.outcome?.kind).toBe('file.portal.not_related');
  });

  test('grant extraction reads only participant_relationship grants', () => {
    const keys = portalEngagementGrantKeys({
      authority: {
        grants: [
          { kind: 'participant_relationship', key: `engagement:${engagementId}` },
          { kind: 'participant_relationship', key: 'submission:abc' },
          { kind: 'permission', key: 'event.manage' },
          null,
          'engagement:evil'
        ]
      }
    } as never);
    expect([...keys].sort()).toEqual([
      `engagement:${engagementId}`,
      'submission:abc'
    ]);
  });
});
