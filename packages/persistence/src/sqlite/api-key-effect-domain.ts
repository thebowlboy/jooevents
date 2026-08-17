import type { Database } from 'bun:sqlite';
import {
  API_KEY_MANAGE_ACCESS_POLICY,
  API_KEY_MUTATION_HANDLER_CAPABILITY,
  API_KEY_OPERATIONS,
  apiKeyCreateContributionSchema,
  apiKeyCreateDomainContributionSchema,
  apiKeyRevokeContributionSchema,
  apiKeyRevokeDomainContributionSchema,
  apiKeyRotateContributionSchema,
  apiKeyRotateDomainContributionSchema,
  createApiKeyManagementProfiles,
  createApiKeyManagementPermissionViews,
  resolveEffectInvocationAuthorityRecheckAttribution,
  sealApiKeyMutationPreparation,
  type ApiKeyManagementReadPort,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  apiKeyCreateInputSchema,
  apiKeyRevokeInputSchema,
  apiKeyRotateInputSchema,
  type ApiKeyListDataDto,
  type ApiKeyViewDto
} from '@jooevents/contracts';
import {
  API_KEY_DEFAULT_POLICY,
  PERMISSIONS,
  evaluateAccess,
  mintApiKey,
  parseApiKeyPolicy,
  type ApiKeyPolicy,
  type ApiKeyRecord,
  type PermissionId
} from '@jooevents/identity-access';
import {
  canonicalJsonText,
  parseApiKeyId,
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import { createSQLiteAccessRepositories } from './access-repositories';
import { SQLiteApiKeyStore } from './api-keys';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function sameRef(left: { readonly key: string; readonly version: number }, right: { readonly key: string; readonly version: number }): boolean {
  return left.key === right.key && left.version === right.version;
}

function refusal(code: 'missing' | 'stale' | 'not_owner' | 'expired_policy') {
  const classification = code === 'stale' ? 'stale_revision'
    : code === 'expired_policy' ? 'policy_violation' : 'conflict';
  return Object.freeze({
    result: Object.freeze({
      kind: 'outcome' as const,
      outcome: Object.freeze({
        class: classification,
        kind: 'api_key.change_refused', retryable: false, subjects: [],
        detail: { code }, detailSchemaVersion: 1
      })
    }),
    domain: null,
    effectContributions: Object.freeze([]) as readonly []
  });
}

function ownerName(sqlite: Database, userId: string): string {
  return sqlite.query<{ readonly display_name: string }, [string]>(
    'SELECT display_name FROM users WHERE id = ?'
  ).get(userId)?.display_name ?? 'Unknown user';
}

function hasWorkspaceApiAdministration(
  sqlite: Database,
  workspaceId: WorkspaceId,
  userId: UserId,
  now: string
): boolean {
  const nowMs = Date.parse(now);
  const membership = sqlite.query<{ readonly status: string }, [string, string]>(`
    SELECT status FROM workspace_memberships WHERE workspace_id=? AND user_id=?
  `).get(workspaceId, userId);
  if (membership?.status !== 'active') return false;
  const override = sqlite.query<{ readonly effect: 'grant' | 'deny' }, [string, string, number]>(`
    SELECT effect FROM permission_overrides
     WHERE workspace_id=? AND user_id=? AND permission_id='access.roles.manage'
       AND scope_kind='workspace' AND (expires_at IS NULL OR expires_at>?)
     ORDER BY CASE effect WHEN 'deny' THEN 0 ELSE 1 END, version DESC LIMIT 1
  `).get(workspaceId, userId, nowMs);
  if (override?.effect === 'deny') return false;
  if (override?.effect === 'grant') return true;
  return sqlite.query<{ readonly allowed: number }, [string, string, number]>(`
    SELECT 1 AS allowed FROM role_assignments a
    JOIN roles r ON r.id=a.role_id AND r.workspace_id=a.workspace_id
    JOIN role_permissions p ON p.role_id=r.id AND p.permission_id='access.roles.manage'
    WHERE a.workspace_id=? AND a.user_id=? AND a.scope_kind='workspace'
      AND r.archived_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?) LIMIT 1
  `).get(workspaceId, userId, nowMs)?.allowed === 1;
}

function view(sqlite: Database, record: ApiKeyRecord): ApiKeyViewDto {
  return {
    id: record.apiKeyId,
    ownerUserId: record.ownerUserId,
    ownerDisplayName: ownerName(sqlite, record.ownerUserId),
    name: record.displayName,
    tokenHint: record.tokenHint,
    reads: record.mayRead,
    proposesChanges: record.maySubmitPlans,
    permissionIds: [...record.permissionIds],
    eventIds: [...record.eventIds],
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    standing: record.standing,
    revokedAt: record.revokedAt,
    revokeReason: record.revokeReason,
    version: record.version
  };
}

export class SQLiteApiKeyManagementReadPort implements ApiKeyManagementReadPort {
  readonly #workspaceId: WorkspaceId;
  readonly #store: SQLiteApiKeyStore;
  readonly #policy: ApiKeyPolicy;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly policy?: ApiKeyPolicy;
    readonly now: () => string;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    this.#store = new SQLiteApiKeyStore(input.sqlite);
    this.#policy = parseApiKeyPolicy(input.policy ?? API_KEY_DEFAULT_POLICY);
  }

  async read(viewerUserId: UserId): Promise<ApiKeyListDataDto> {
    const userId = parseUserId(viewerUserId);
    const access = createSQLiteAccessRepositories(this.input.sqlite);
    const membership = await access.memberships.find(this.#workspaceId, userId);
    const roles = await access.authorization.listRoles(this.#workspaceId);
    const assignments = await access.authorization.listAssignments(this.#workspaceId, userId);
    const overrides = await access.authorization.listOverrides(this.#workspaceId, userId);
    const now = parseInstant(this.input.now());
    const mayAdminister = evaluateAccess({
      userId,
      permissionId: 'access.roles.manage',
      requestedScope: { kind: 'workspace', workspaceId: this.#workspaceId },
      ...(membership ? { membership } : {}), roles, assignments, overrides, now
    }).allowed;
    const heldPermissionIds = new Set<PermissionId>(PERMISSIONS
      .filter((permission) => permission.id !== 'integration.api.manage')
      .filter((permission) => evaluateAccess({
          userId,
          permissionId: permission.id,
          requestedScope: { kind: 'workspace', workspaceId: this.#workspaceId },
          ...(membership ? { membership } : {}), roles, assignments, overrides, now
        }).allowed)
      .map((permission) => permission.id));
    const permissions = createApiKeyManagementPermissionViews(heldPermissionIds);
    const events = this.input.sqlite.query<{ readonly id: string; readonly name: string }, [string]>(`
      SELECT id,name FROM event_spine_heads WHERE workspace_id=? ORDER BY name,id
    `).all(this.#workspaceId).map((event) => ({ id: parseEventId(event.id), name: event.name }));
    const timezone = this.input.sqlite.query<{ readonly timezone: string }, [string]>(`
      SELECT h.timezone FROM event_spine_workspace_sets s
      JOIN event_spine_heads h ON h.workspace_id=s.workspace_id AND h.id=s.current_event_id
      WHERE s.workspace_id=?
    `).get(this.#workspaceId)?.timezone ?? 'UTC';
    return {
      schemaVersion: 1,
      timezone,
      keys: this.#store.list({
        workspaceId: this.#workspaceId,
        ...(mayAdminister ? {} : { ownerUserId: userId })
      })
        .map((key) => view(this.input.sqlite, key)),
      permissions,
      profiles: createApiKeyManagementProfiles(),
      events,
      expiry: {
        defaultDays: this.#policy.defaultTtlDays,
        maxDays: this.#policy.maximumTtlDays,
        rotationGraceHours: this.#policy.rotationGraceHours
      }
    };
  }
}

interface PreparedMutation {
  readonly context: EffectInvocationContext;
  readonly domain: unknown;
  readonly secretDelivery?: {
    readonly handle: string;
    readonly secret: string;
    readonly ownerUserId: UserId;
  };
  phase: 'prepared' | 'applied';
}

/** Post-commit, process-local handoff. Implementations must make handles single-use and short-lived. */
export interface ApiKeySecretDeliverySink {
  deposit(input: {
    readonly handle: string;
    readonly secret: string;
    readonly ownerUserId: UserId;
  }): void;
}

export class SQLiteApiKeyEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #store: SQLiteApiKeyStore;
  readonly #policy: ApiKeyPolicy;
  #prepared: PreparedMutation | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly policy?: ApiKeyPolicy;
    readonly now: () => string;
    readonly newApiKeyId: () => string;
    readonly secretDelivery: ApiKeySecretDeliverySink;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    this.#store = new SQLiteApiKeyStore(input.sqlite);
    this.#policy = parseApiKeyPolicy(input.policy ?? API_KEY_DEFAULT_POLICY);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('api_key_effect_transaction_required');
    if (!sameRef(capability, API_KEY_MUTATION_HANDLER_CAPABILITY)
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || context.scope.eventId !== undefined) {
      throw new TypeError('api_key_effect_context_invalid');
    }
    const action = Object.entries(API_KEY_OPERATIONS).find(([, operation]) =>
      operation.name === context.operation.name && operation.version === context.operation.version
    )?.[0] as 'create' | 'rotate' | 'revoke' | undefined;
    if (!action) throw new TypeError('api_key_effect_operation_invalid');
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || authority.lane.kind !== 'operator'
        || !sameRef(authority.lane.policy, API_KEY_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'integration.api.manage')) {
      throw new TypeError('api_key_effect_authority_invalid');
    }
    const actorUserId = authority.actor.userId;
    this.#prepared = undefined;
    return sealApiKeyMutationPreparation({
      context,
      preparation: {
        prepare: ({ action: receivedAction, businessInput, context: receivedContext }) => {
          if (receivedAction !== action || receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('api_key_effect_context_substitution');
          }
          const now = parseInstant(this.input.now());
          if (action === 'create') {
            const wire = apiKeyCreateInputSchema.parse(businessInput);
            if (wire.expiresInDays !== null && wire.expiresInDays > this.#policy.maximumTtlDays) {
              return refusal('expired_policy');
            }
            const secret = mintApiKey();
            const secretHandle = crypto.randomUUID();
            const domain = apiKeyCreateDomainContributionSchema.parse({
              kind: 'api_key_create',
              record: {
                apiKeyId: parseApiKeyId(this.input.newApiKeyId()), workspaceId: this.#workspaceId,
                ownerUserId: actorUserId, displayName: wire.name,
                tokenHashSha256: secret.tokenHashSha256, tokenHint: secret.tokenHint,
                mayRead: wire.mayRead, maySubmitPlans: wire.maySubmitPlans,
                permissionIds: wire.permissionIds, eventIds: wire.eventIds,
                createdAt: now,
                expiresAt: wire.expiresInDays === null
                  ? null
                  : new Date(Date.parse(now) + wire.expiresInDays * DAY_MS).toISOString()
              }
            });
            const projected = view(this.input.sqlite, {
              ...domain.record,
              apiKeyId: parseApiKeyId(domain.record.apiKeyId),
              workspaceId: parseWorkspaceId(domain.record.workspaceId),
              ownerUserId: parseUserId(domain.record.ownerUserId),
              permissionIds: domain.record.permissionIds as PermissionId[],
              eventIds: domain.record.eventIds.map(parseEventId), lastUsedAt: null,
              standing: 'active', revokedAt: null, revokedByUserId: null,
              revokeReason: null, rotationSuccessorId: null, version: 1
            });
            const contribution = apiKeyCreateContributionSchema.parse({
              result: { kind: 'success', data: { key: projected, secretHandle } },
              domain, effectContributions: []
            });
            this.#prepared = {
              context, domain, phase: 'prepared',
              secretDelivery: { handle: secretHandle, secret: secret.secret, ownerUserId: actorUserId }
            };
            return contribution;
          }
          const wire = action === 'rotate'
            ? apiKeyRotateInputSchema.parse(businessInput)
            : apiKeyRevokeInputSchema.parse(businessInput);
          const current = this.#store.get(parseApiKeyId(wire.apiKeyId));
          if (!current || current.workspaceId !== this.#workspaceId) return refusal('missing');
          const administeringAnotherOwner = current.ownerUserId !== actorUserId;
          if (administeringAnotherOwner
              && (action !== 'revoke'
                || !hasWorkspaceApiAdministration(this.input.sqlite, this.#workspaceId, actorUserId, now))) {
            return refusal('not_owner');
          }
          if (current.standing !== 'active' || current.version !== wire.expectedVersion) return refusal('stale');
          if (action === 'rotate') {
            const secret = mintApiKey();
            const secretHandle = crypto.randomUUID();
            const successorExpiresAt = current.expiresAt === null
              ? null
              : new Date(Date.parse(now) + this.#policy.defaultTtlDays * DAY_MS).toISOString();
            const predecessorExpiresAt = new Date(Math.min(
              current.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(current.expiresAt),
              Date.parse(now) + this.#policy.rotationGraceHours * HOUR_MS
            )).toISOString();
            const domain = apiKeyRotateDomainContributionSchema.parse({
              kind: 'api_key_rotate', predecessorId: current.apiKeyId,
              expectedVersion: current.version, predecessorExpiresAt,
              successor: {
                apiKeyId: parseApiKeyId(this.input.newApiKeyId()), workspaceId: current.workspaceId,
                ownerUserId: current.ownerUserId, displayName: current.displayName,
                tokenHashSha256: secret.tokenHashSha256, tokenHint: secret.tokenHint,
                mayRead: current.mayRead, maySubmitPlans: current.maySubmitPlans,
                permissionIds: current.permissionIds, eventIds: current.eventIds,
                createdAt: now, expiresAt: successorExpiresAt
              }
            });
            const predecessor = view(this.input.sqlite, {
              ...current, expiresAt: predecessorExpiresAt,
              rotationSuccessorId: parseApiKeyId(domain.successor.apiKeyId), version: current.version + 1
            });
            const successor = view(this.input.sqlite, {
              ...domain.successor,
              apiKeyId: parseApiKeyId(domain.successor.apiKeyId),
              workspaceId: parseWorkspaceId(domain.successor.workspaceId),
              ownerUserId: parseUserId(domain.successor.ownerUserId),
              permissionIds: domain.successor.permissionIds as PermissionId[],
              eventIds: domain.successor.eventIds.map(parseEventId), lastUsedAt: null,
              standing: 'active', revokedAt: null, revokedByUserId: null,
              revokeReason: null, rotationSuccessorId: null, version: 1
            });
            const contribution = apiKeyRotateContributionSchema.parse({
              result: { kind: 'success', data: { predecessor, successor, secretHandle } },
              domain, effectContributions: []
            });
            this.#prepared = {
              context, domain, phase: 'prepared',
              secretDelivery: { handle: secretHandle, secret: secret.secret, ownerUserId: actorUserId }
            };
            return contribution;
          }
          const revokeWire = apiKeyRevokeInputSchema.parse(businessInput);
          if (administeringAnotherOwner && revokeWire.reason !== 'admin_request') {
            return refusal('not_owner');
          }
          const domain = apiKeyRevokeDomainContributionSchema.parse({
            kind: 'api_key_revoke', apiKeyId: current.apiKeyId,
            expectedVersion: current.version, revokedAt: now,
            revokedByUserId: actorUserId, reason: revokeWire.reason
          });
          const revoked = view(this.input.sqlite, {
            ...current, standing: 'revoked', revokedAt: now,
            revokedByUserId: actorUserId, revokeReason: revokeWire.reason,
            version: current.version + 1
          });
          const contribution = apiKeyRevokeContributionSchema.parse({
            result: { kind: 'success', data: revoked }, domain, effectContributions: []
          });
          this.#prepared = { context, domain, phase: 'prepared' };
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('api_key_effect_transaction_required');
    if (contribution === null) return;
    const prepared = this.#prepared;
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(prepared.domain) !== canonicalJsonText(contribution)) {
      throw new TypeError('api_key_effect_preparation_invalid');
    }
    const create = apiKeyCreateDomainContributionSchema.safeParse(contribution);
    if (create.success) {
      this.#store.create({
        ...create.data.record,
        apiKeyId: parseApiKeyId(create.data.record.apiKeyId),
        workspaceId: parseWorkspaceId(create.data.record.workspaceId),
        ownerUserId: parseUserId(create.data.record.ownerUserId),
        permissionIds: create.data.record.permissionIds as PermissionId[],
        eventIds: create.data.record.eventIds.map(parseEventId)
      });
    } else {
      const rotate = apiKeyRotateDomainContributionSchema.safeParse(contribution);
      if (rotate.success) {
        this.#store.rotate({
          predecessorId: parseApiKeyId(rotate.data.predecessorId),
          expectedVersion: rotate.data.expectedVersion,
          predecessorExpiresAt: rotate.data.predecessorExpiresAt,
          successor: {
            ...rotate.data.successor,
            apiKeyId: parseApiKeyId(rotate.data.successor.apiKeyId),
            workspaceId: parseWorkspaceId(rotate.data.successor.workspaceId),
            ownerUserId: parseUserId(rotate.data.successor.ownerUserId),
            permissionIds: rotate.data.successor.permissionIds as PermissionId[],
            eventIds: rotate.data.successor.eventIds.map(parseEventId)
          }
        });
      } else {
        const revoke = apiKeyRevokeDomainContributionSchema.parse(contribution);
        this.#store.revoke({
          apiKeyId: parseApiKeyId(revoke.apiKeyId), expectedVersion: revoke.expectedVersion,
          revokedAt: revoke.revokedAt, revokedByUserId: parseUserId(revoke.revokedByUserId),
          reason: revoke.reason
        });
      }
    }
    prepared.phase = 'applied';
  }

  afterUnitOfWorkCommitted(): void {
    const delivery = this.#prepared?.secretDelivery;
    if (delivery) this.input.secretDelivery.deposit(delivery);
  }
  afterUnitOfWorkFinished(): void { this.#prepared = undefined; }
}

export function createSQLiteApiKeyEffectDomainRegistration(input: ConstructorParameters<
  typeof SQLiteApiKeyEffectDomainAdapter
>[0]): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: API_KEY_MUTATION_HANDLER_CAPABILITY,
    adapter: new SQLiteApiKeyEffectDomainAdapter(input)
  });
}
