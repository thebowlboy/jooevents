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
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  sealApiKeyMutationPreparation,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  apiKeyCreateInputSchema,
  apiKeyCreateOperationResultSchema,
  apiKeyRevokeInputSchema,
  apiKeyRotateInputSchema,
  apiKeyRotateOperationResultSchema,
  apiKeyViewSchema,
  type ApiKeyViewDto
} from '@jooevents/contracts';
import {
  API_KEY_DEFAULT_POLICY,
  mintApiKey,
  parseApiKeyPolicy,
  parseNewApiKeyRecord,
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
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type MutationAction = 'create' | 'rotate' | 'revoke';

interface ApiKeyRow {
  readonly api_key_id: string;
  readonly workspace_id: string;
  readonly owner_user_id: string;
  readonly owner_display_name: string;
  readonly display_name: string;
  readonly token_hash_sha256: string;
  readonly token_hint: string;
  readonly may_read: number;
  readonly may_submit_plans: number;
  readonly created_at_ms: number;
  readonly expires_at_ms: number | null;
  readonly last_used_at_ms: number | null;
  readonly standing: string;
  readonly revoked_at_ms: number | null;
  readonly revoked_by_user_id: string | null;
  readonly revoke_reason: ApiKeyRecord['revokeReason'];
  readonly rotation_successor_id: string | null;
  readonly version: number;
}

interface PermissionRow { readonly permission_id: string }
interface EventRow { readonly event_id: string }
interface OwnerRow { readonly display_name: string }
interface OverrideRow { readonly effect: 'grant' | 'deny' }
interface CountRow { readonly count: number }

interface CurrentKey {
  readonly record: ApiKeyRecord;
  readonly view: ApiKeyViewDto;
}

interface PreparedMutation {
  readonly context: EffectInvocationContext;
  readonly domain: unknown;
  readonly secretDelivery?: {
    readonly handle: string;
    readonly secret: string;
  };
  phase: 'prepared' | 'applied';
}

export interface D1ApiKeySecretDeliverySink {
  deposit(input: { readonly handle: string; readonly secret: string }): void;
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function actionFor(context: EffectInvocationContext): MutationAction | undefined {
  const entries = Object.entries(API_KEY_OPERATIONS) as readonly [MutationAction, {
    readonly name: string;
    readonly version: number;
  }][];
  return entries.find(([, operation]) => operation.name === context.operation.name
    && operation.version === context.operation.version)?.[0];
}

function refusal(code: 'missing' | 'stale' | 'not_owner' | 'expired_policy') {
  const classification = code === 'stale'
    ? 'stale_revision'
    : code === 'expired_policy'
      ? 'policy_violation'
      : 'conflict';
  return Object.freeze({
    result: Object.freeze({
      kind: 'outcome' as const,
      outcome: Object.freeze({
        class: classification,
        kind: 'api_key.change_refused',
        retryable: false,
        subjects: [],
        detail: { code },
        detailSchemaVersion: 1
      })
    }),
    domain: null,
    effectContributions: Object.freeze([]) as readonly []
  });
}

function epochInstant(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('d1_api_key_data_corrupt');
  }
  return parseInstant(new Date(value).toISOString());
}

function boolean(value: number): boolean {
  if (value !== 0 && value !== 1) throw new TypeError('d1_api_key_data_corrupt');
  return value === 1;
}

function project(record: ApiKeyRecord, ownerDisplayName: string): ApiKeyViewDto {
  return apiKeyViewSchema.parse({
    id: record.apiKeyId,
    ownerUserId: record.ownerUserId,
    ownerDisplayName,
    name: record.displayName,
    tokenHint: record.tokenHint,
    reads: record.mayRead,
    proposesChanges: record.maySubmitPlans,
    permissionIds: record.permissionIds,
    eventIds: record.eventIds,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    standing: record.standing,
    revokedAt: record.revokedAt,
    revokeReason: record.revokeReason,
    version: record.version
  });
}

function recordFromRows(
  row: ApiKeyRow,
  permissionRows: readonly PermissionRow[],
  eventRows: readonly EventRow[]
): CurrentKey {
  const immutable = parseNewApiKeyRecord({
    apiKeyId: parseApiKeyId(row.api_key_id),
    workspaceId: parseWorkspaceId(row.workspace_id),
    ownerUserId: parseUserId(row.owner_user_id),
    displayName: row.display_name,
    tokenHashSha256: row.token_hash_sha256,
    tokenHint: row.token_hint,
    mayRead: boolean(row.may_read),
    maySubmitPlans: boolean(row.may_submit_plans),
    permissionIds: permissionRows.map((value) => value.permission_id as PermissionId),
    eventIds: eventRows.map((value) => parseEventId(value.event_id)),
    createdAt: epochInstant(row.created_at_ms)!,
    expiresAt: epochInstant(row.expires_at_ms)
  });
  if (!Number.isSafeInteger(row.version) || row.version < 1
      || (row.standing !== 'active' && row.standing !== 'revoked')) {
    throw new TypeError('d1_api_key_data_corrupt');
  }
  const revokedAt = epochInstant(row.revoked_at_ms);
  const revokedByUserId = row.revoked_by_user_id === null
    ? null
    : parseUserId(row.revoked_by_user_id);
  if ((row.standing === 'active') !== (
    revokedAt === null && revokedByUserId === null && row.revoke_reason === null
  )) {
    throw new TypeError('d1_api_key_data_corrupt');
  }
  const record: ApiKeyRecord = Object.freeze({
    ...immutable,
    lastUsedAt: epochInstant(row.last_used_at_ms),
    standing: row.standing,
    revokedAt,
    revokedByUserId,
    revokeReason: row.revoke_reason,
    rotationSuccessorId: row.rotation_successor_id === null
      ? null
      : parseApiKeyId(row.rotation_successor_id),
    version: row.version
  });
  return Object.freeze({ record, view: project(record, row.owner_display_name) });
}

async function readCurrentKeys(input: {
  readonly unitOfWork: D1BufferedUnitOfWork;
  readonly workspaceId: WorkspaceId;
}): Promise<ReadonlyMap<string, CurrentKey>> {
  const [keyResult, permissionResult, eventResult] = await input.unitOfWork.readSession.batch([
    input.unitOfWork.readSession.prepare(`SELECT key.api_key_id,key.workspace_id,
      key.owner_user_id,owner.display_name AS owner_display_name,key.display_name,
      key.token_hash_sha256,key.token_hint,key.may_read,key.may_submit_plans,
      key.created_at_ms,key.expires_at_ms,key.last_used_at_ms,key.standing,
      key.revoked_at_ms,key.revoked_by_user_id,key.revoke_reason,
      key.rotation_successor_id,key.version
      FROM api_keys key JOIN users owner ON owner.id = key.owner_user_id
      WHERE key.workspace_id = ? ORDER BY key.api_key_id COLLATE BINARY`)
      .bind(input.workspaceId),
    input.unitOfWork.readSession.prepare(`SELECT scope.api_key_id,scope.permission_id
      FROM api_key_permission_scopes scope
      JOIN api_keys key ON key.api_key_id = scope.api_key_id
      WHERE key.workspace_id = ?
      ORDER BY scope.api_key_id COLLATE BINARY,scope.permission_id COLLATE BINARY`)
      .bind(input.workspaceId),
    input.unitOfWork.readSession.prepare(`SELECT scope.api_key_id,scope.event_id
      FROM api_key_event_scopes scope
      JOIN api_keys key ON key.api_key_id = scope.api_key_id
      WHERE key.workspace_id = ?
      ORDER BY scope.api_key_id COLLATE BINARY,scope.event_id COLLATE BINARY`)
      .bind(input.workspaceId)
  ]);
  const rows = (keyResult as D1Result<ApiKeyRow>).results;
  if (rows.length > 10_000) throw new TypeError('d1_api_key_data_corrupt');
  const permissionRows = (permissionResult as D1Result<PermissionRow & {
    readonly api_key_id: string;
  }>).results;
  const eventRows = (eventResult as D1Result<EventRow & {
    readonly api_key_id: string;
  }>).results;
  input.unitOfWork.assertCurrent(
    '(SELECT count(*) FROM api_keys WHERE workspace_id = ?) = ?',
    [input.workspaceId, rows.length]
  );
  input.unitOfWork.assertCurrent(`(SELECT count(*) FROM api_key_permission_scopes scope
    JOIN api_keys key ON key.api_key_id = scope.api_key_id
    WHERE key.workspace_id = ?) = ?`, [input.workspaceId, permissionRows.length]);
  input.unitOfWork.assertCurrent(`(SELECT count(*) FROM api_key_event_scopes scope
    JOIN api_keys key ON key.api_key_id = scope.api_key_id
    WHERE key.workspace_id = ?) = ?`, [input.workspaceId, eventRows.length]);
  const result = new Map<string, CurrentKey>();
  for (const row of rows) {
    const permissions = permissionRows.filter((scope) => scope.api_key_id === row.api_key_id);
    const events = eventRows.filter((scope) => scope.api_key_id === row.api_key_id);
    const current = recordFromRows(row, permissions, events);
    if (result.has(row.api_key_id)) throw new TypeError('d1_api_key_data_corrupt');
    result.set(row.api_key_id, current);
    input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM api_keys
      WHERE api_key_id = ? AND workspace_id = ? AND owner_user_id = ?
        AND display_name = ? AND token_hash_sha256 = ? AND token_hint = ?
        AND may_read = ? AND may_submit_plans = ? AND created_at_ms = ?
        AND expires_at_ms IS ? AND last_used_at_ms IS ? AND standing = ?
        AND revoked_at_ms IS ? AND revoked_by_user_id IS ? AND revoke_reason IS ?
        AND rotation_successor_id IS ? AND version = ?)`, [
      row.api_key_id, row.workspace_id, row.owner_user_id, row.display_name,
      row.token_hash_sha256, row.token_hint, row.may_read, row.may_submit_plans,
      row.created_at_ms, row.expires_at_ms, row.last_used_at_ms, row.standing,
      row.revoked_at_ms, row.revoked_by_user_id, row.revoke_reason,
      row.rotation_successor_id, row.version
    ]);
  }
  for (const permission of permissionRows) {
    input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM api_key_permission_scopes
      WHERE api_key_id = ? AND permission_id = ?)`, [
      permission.api_key_id, permission.permission_id
    ]);
  }
  for (const event of eventRows) {
    input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM api_key_event_scopes
      WHERE api_key_id = ? AND event_id = ?)`, [event.api_key_id, event.event_id]);
  }
  return result;
}

async function ownerDisplayName(input: {
  readonly unitOfWork: D1BufferedUnitOfWork;
  readonly userId: UserId;
}): Promise<string> {
  const row = await input.unitOfWork.readSession.prepare(
    'SELECT display_name FROM users WHERE id = ?'
  ).bind(input.userId).first<OwnerRow>();
  if (!row) throw new TypeError('d1_api_key_owner_missing');
  input.unitOfWork.assertCurrent(
    'EXISTS (SELECT 1 FROM users WHERE id = ? AND display_name = ?)',
    [input.userId, row.display_name]
  );
  return row.display_name;
}

async function workspaceEventIds(input: {
  readonly unitOfWork: D1BufferedUnitOfWork;
  readonly workspaceId: WorkspaceId;
}): Promise<ReadonlySet<string>> {
  const rows = (await input.unitOfWork.readSession.prepare(`SELECT id AS event_id
    FROM event_spine_heads WHERE workspace_id = ? ORDER BY id COLLATE BINARY`)
    .bind(input.workspaceId).all<EventRow>()).results;
  return new Set(rows.map((row) => parseEventId(row.event_id)));
}

async function mayAdministerOtherKeys(input: {
  readonly unitOfWork: D1BufferedUnitOfWork;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly nowEpochMs: number;
}): Promise<boolean> {
  const overrides = (await input.unitOfWork.readSession.prepare(`SELECT effect
    FROM permission_overrides
    WHERE workspace_id = ? AND user_id = ?
      AND permission_id = 'access.roles.manage'
      AND scope_kind = 'workspace' AND event_id IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY id COLLATE BINARY`).bind(
      input.workspaceId, input.userId, input.nowEpochMs
    ).all<OverrideRow>()).results;
  const roleCount = (await input.unitOfWork.readSession.prepare(`SELECT count(*) AS count
    FROM role_assignments assignment
    JOIN roles role ON role.id = assignment.role_id
      AND role.workspace_id = assignment.workspace_id
    JOIN role_permissions permission ON permission.role_id = role.id
      AND permission.permission_id = 'access.roles.manage'
    WHERE assignment.workspace_id = ? AND assignment.user_id = ?
      AND assignment.scope_kind = 'workspace' AND assignment.event_id IS NULL
      AND role.archived_at IS NULL
      AND (assignment.expires_at IS NULL OR assignment.expires_at > ?)`).bind(
      input.workspaceId, input.userId, input.nowEpochMs
    ).first<CountRow>())?.count ?? 0;
  const denied = overrides.some((override) => override.effect === 'deny');
  const granted = overrides.some((override) => override.effect === 'grant');
  const allowed = !denied && (granted || roleCount > 0);
  const applicableOverride = `workspace_id = ? AND user_id = ?
    AND permission_id = 'access.roles.manage'
    AND scope_kind = 'workspace' AND event_id IS NULL
    AND (expires_at IS NULL OR expires_at > ?)`;
  input.unitOfWork.assertCurrent(
    `${denied ? '' : 'NOT '}EXISTS (SELECT 1 FROM permission_overrides
      WHERE ${applicableOverride} AND effect = 'deny')`,
    [input.workspaceId, input.userId, input.nowEpochMs]
  );
  if (!denied) {
    input.unitOfWork.assertCurrent(
      `${granted ? '' : 'NOT '}EXISTS (SELECT 1 FROM permission_overrides
        WHERE ${applicableOverride} AND effect = 'grant')`,
      [input.workspaceId, input.userId, input.nowEpochMs]
    );
    if (!granted) {
      input.unitOfWork.assertCurrent(`(SELECT count(*) FROM role_assignments assignment
        JOIN roles role ON role.id = assignment.role_id
          AND role.workspace_id = assignment.workspace_id
        JOIN role_permissions permission ON permission.role_id = role.id
          AND permission.permission_id = 'access.roles.manage'
        WHERE assignment.workspace_id = ? AND assignment.user_id = ?
          AND assignment.scope_kind = 'workspace' AND assignment.event_id IS NULL
          AND role.archived_at IS NULL
          AND (assignment.expires_at IS NULL OR assignment.expires_at > ?)) = ?`, [
        input.workspaceId, input.userId, input.nowEpochMs, roleCount
      ]);
    }
  }
  return allowed;
}

export class D1ApiKeyMutationEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #policy: ApiKeyPolicy;
  readonly #issued = new Set<string>();
  #prepared: PreparedMutation | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly policy?: ApiKeyPolicy;
    readonly ids: {
      newApiKeyId(): string;
      newSecretHandle(): string;
    };
    readonly secretDelivery: D1ApiKeySecretDeliverySink;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    this.#policy = parseApiKeyPolicy(input.policy ?? API_KEY_DEFAULT_POLICY);
  }

  async openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    const action = actionFor(context);
    if (!sameRef(capability, API_KEY_MUTATION_HANDLER_CAPABILITY)
        || !action
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || context.scope.eventId !== undefined) {
      throw new TypeError('d1_api_key_effect_context_invalid');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const now = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || !sameRef(authority.lane.policy, API_KEY_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'integration.api.manage')) {
      throw new TypeError('d1_api_key_effect_authority_invalid');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const currentKeys = action === 'create'
      ? undefined
      : await readCurrentKeys({
          unitOfWork: this.input.unitOfWork,
          workspaceId: this.#workspaceId
        });
    const ownerName = action === 'create'
      ? await ownerDisplayName({ unitOfWork: this.input.unitOfWork, userId: actorUserId })
      : undefined;
    const allowedEventIds = action === 'create'
      ? await workspaceEventIds({
          unitOfWork: this.input.unitOfWork,
          workspaceId: this.#workspaceId
        })
      : undefined;
    const mayAdminister = action === 'revoke'
      ? await mayAdministerOtherKeys({
          unitOfWork: this.input.unitOfWork,
          workspaceId: this.#workspaceId,
          userId: actorUserId,
          nowEpochMs: Date.parse(now)
        })
      : false;
    this.#prepared = undefined;
    return sealApiKeyMutationPreparation({
      context,
      preparation: {
        prepare: ({ action: receivedAction, businessInput, context: receivedContext }) => {
          if (receivedAction !== action || receivedContext !== context) {
            throw new TypeError('d1_api_key_effect_context_substitution');
          }
          if (action === 'create') {
            const wire = apiKeyCreateInputSchema.parse(businessInput);
            if (wire.expiresInDays !== null
                && wire.expiresInDays > this.#policy.maximumTtlDays) {
              return refusal('expired_policy');
            }
            if (!wire.eventIds.every((eventId) => allowedEventIds?.has(eventId))) {
              return refusal('missing');
            }
            for (const eventId of wire.eventIds) {
              this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_heads
                WHERE workspace_id = ? AND id = ?)`, [this.#workspaceId, eventId]);
            }
            const secret = mintApiKey();
            const secretHandle = this.#fresh(this.input.ids.newSecretHandle);
            const record = parseNewApiKeyRecord({
              apiKeyId: parseApiKeyId(this.#fresh(this.input.ids.newApiKeyId)),
              workspaceId: this.#workspaceId,
              ownerUserId: actorUserId,
              displayName: wire.name,
              tokenHashSha256: secret.tokenHashSha256,
              tokenHint: secret.tokenHint,
              mayRead: wire.mayRead,
              maySubmitPlans: wire.maySubmitPlans,
              permissionIds: wire.permissionIds as PermissionId[],
              eventIds: wire.eventIds.map(parseEventId),
              createdAt: now,
              expiresAt: wire.expiresInDays === null
                ? null
                : new Date(Date.parse(now) + wire.expiresInDays * DAY_MS).toISOString()
            });
            const domain = apiKeyCreateDomainContributionSchema.parse({
              kind: 'api_key_create',
              record
            });
            const key = project(Object.freeze({
              ...record,
              lastUsedAt: null,
              standing: 'active' as const,
              revokedAt: null,
              revokedByUserId: null,
              revokeReason: null,
              rotationSuccessorId: null,
              version: 1
            }), ownerName!);
            const contribution = apiKeyCreateContributionSchema.parse({
              result: { kind: 'success', data: { key, secretHandle } },
              domain,
              effectContributions: []
            });
            this.#prepared = {
              context,
              domain,
              phase: 'prepared',
              secretDelivery: { handle: secretHandle, secret: secret.secret }
            };
            return contribution;
          }
          const wire = action === 'rotate'
            ? apiKeyRotateInputSchema.parse(businessInput)
            : apiKeyRevokeInputSchema.parse(businessInput);
          const current = currentKeys?.get(wire.apiKeyId);
          if (!current) return refusal('missing');
          const administeringAnotherOwner = current.record.ownerUserId !== actorUserId;
          if (administeringAnotherOwner
              && (action !== 'revoke' || !mayAdminister)) {
            return refusal('not_owner');
          }
          if (current.record.standing !== 'active'
              || current.record.version !== wire.expectedVersion) {
            return refusal('stale');
          }
          if (action === 'rotate') {
            const secret = mintApiKey();
            const secretHandle = this.#fresh(this.input.ids.newSecretHandle);
            const successor = parseNewApiKeyRecord({
              apiKeyId: parseApiKeyId(this.#fresh(this.input.ids.newApiKeyId)),
              workspaceId: current.record.workspaceId,
              ownerUserId: current.record.ownerUserId,
              displayName: current.record.displayName,
              tokenHashSha256: secret.tokenHashSha256,
              tokenHint: secret.tokenHint,
              mayRead: current.record.mayRead,
              maySubmitPlans: current.record.maySubmitPlans,
              permissionIds: current.record.permissionIds,
              eventIds: current.record.eventIds,
              createdAt: now,
              expiresAt: current.record.expiresAt === null
                ? null
                : new Date(Date.parse(now) + this.#policy.defaultTtlDays * DAY_MS).toISOString()
            });
            const predecessorExpiresAt = new Date(Math.min(
              current.record.expiresAt === null
                ? Number.POSITIVE_INFINITY
                : Date.parse(current.record.expiresAt),
              Date.parse(now) + this.#policy.rotationGraceHours * HOUR_MS
            )).toISOString();
            const domain = apiKeyRotateDomainContributionSchema.parse({
              kind: 'api_key_rotate',
              predecessorId: current.record.apiKeyId,
              expectedVersion: current.record.version,
              predecessorExpiresAt,
              successor
            });
            const predecessor = project(Object.freeze({
              ...current.record,
              expiresAt: predecessorExpiresAt,
              rotationSuccessorId: successor.apiKeyId,
              version: current.record.version + 1
            }), current.view.ownerDisplayName);
            const successorView = project(Object.freeze({
              ...successor,
              lastUsedAt: null,
              standing: 'active' as const,
              revokedAt: null,
              revokedByUserId: null,
              revokeReason: null,
              rotationSuccessorId: null,
              version: 1
            }), current.view.ownerDisplayName);
            const contribution = apiKeyRotateContributionSchema.parse({
              result: {
                kind: 'success',
                data: { predecessor, successor: successorView, secretHandle }
              },
              domain,
              effectContributions: []
            });
            this.#prepared = {
              context,
              domain,
              phase: 'prepared',
              secretDelivery: { handle: secretHandle, secret: secret.secret }
            };
            return contribution;
          }
          const revokeWire = apiKeyRevokeInputSchema.parse(businessInput);
          if (administeringAnotherOwner && revokeWire.reason !== 'admin_request') {
            return refusal('not_owner');
          }
          const domain = apiKeyRevokeDomainContributionSchema.parse({
            kind: 'api_key_revoke',
            apiKeyId: current.record.apiKeyId,
            expectedVersion: current.record.version,
            revokedAt: now,
            revokedByUserId: actorUserId,
            reason: revokeWire.reason
          });
          const revoked = project(Object.freeze({
            ...current.record,
            standing: 'revoked' as const,
            revokedAt: now,
            revokedByUserId: actorUserId,
            revokeReason: revokeWire.reason,
            version: current.record.version + 1
          }), current.view.ownerDisplayName);
          const contribution = apiKeyRevokeContributionSchema.parse({
            result: { kind: 'success', data: revoked },
            domain,
            effectContributions: []
          });
          this.#prepared = { context, domain, phase: 'prepared' };
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (contribution === null) return;
    const prepared = this.#prepared;
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(prepared.domain) !== canonicalJsonText(contribution)) {
      throw new TypeError('d1_api_key_effect_preparation_invalid');
    }
    const create = apiKeyCreateDomainContributionSchema.safeParse(contribution);
    if (create.success) {
      this.#insert(create.data.record);
    } else {
      const rotate = apiKeyRotateDomainContributionSchema.safeParse(contribution);
      if (rotate.success) {
        this.#insert(rotate.data.successor);
        this.input.unitOfWork.write(`UPDATE api_keys
          SET expires_at_ms = ?,rotation_successor_id = ?,version = version + 1
          WHERE api_key_id = ? AND workspace_id = ? AND version = ?
            AND standing = 'active'`, [
          Date.parse(rotate.data.predecessorExpiresAt),
          rotate.data.successor.apiKeyId,
          rotate.data.predecessorId,
          this.#workspaceId,
          rotate.data.expectedVersion
        ]);
      } else {
        const revoke = apiKeyRevokeDomainContributionSchema.parse(contribution);
        this.input.unitOfWork.write(`UPDATE api_keys SET standing = 'revoked',
          revoked_at_ms = ?,revoked_by_user_id = ?,revoke_reason = ?,version = version + 1
          WHERE api_key_id = ? AND workspace_id = ? AND version = ?
            AND standing = 'active'`, [
          Date.parse(revoke.revokedAt),
          revoke.revokedByUserId,
          revoke.reason,
          revoke.apiKeyId,
          this.#workspaceId,
          revoke.expectedVersion
        ]);
      }
    }
    prepared.phase = 'applied';
  }

  afterUnitOfWorkCommitted(): void {
    const delivery = this.#prepared?.secretDelivery;
    if (delivery) this.input.secretDelivery.deposit(delivery);
  }

  afterUnitOfWorkFinished(): void {
    this.#prepared = undefined;
  }

  #insert(record: {
    readonly apiKeyId: string;
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly displayName: string;
    readonly tokenHashSha256: string;
    readonly tokenHint: string;
    readonly mayRead: boolean;
    readonly maySubmitPlans: boolean;
    readonly permissionIds: readonly string[];
    readonly eventIds: readonly string[];
    readonly createdAt: string;
    readonly expiresAt: string | null;
  }): void {
    this.input.unitOfWork.write(`INSERT INTO api_keys (
      api_key_id,workspace_id,owner_user_id,display_name,token_hash_sha256,token_hint,
      may_read,may_submit_plans,created_at_ms,expires_at_ms,last_used_at_ms,standing,
      revoked_at_ms,revoked_by_user_id,revoke_reason,rotation_successor_id,version
    ) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'active',NULL,NULL,NULL,NULL,1)`, [
      record.apiKeyId,
      record.workspaceId,
      record.ownerUserId,
      record.displayName,
      record.tokenHashSha256,
      record.tokenHint,
      record.mayRead ? 1 : 0,
      record.maySubmitPlans ? 1 : 0,
      Date.parse(record.createdAt),
      record.expiresAt === null ? null : Date.parse(record.expiresAt)
    ]);
    for (const permissionId of record.permissionIds) {
      this.input.unitOfWork.write(`INSERT INTO api_key_permission_scopes
        (api_key_id,permission_id) VALUES (?,?)`, [record.apiKeyId, permissionId]);
    }
    for (const eventId of record.eventIds) {
      this.input.unitOfWork.write(`INSERT INTO api_key_event_scopes
        (api_key_id,event_id) VALUES (?,?)`, [record.apiKeyId, eventId]);
    }
  }

  #fresh(factory: () => string): string {
    const value = factory.call(this.input.ids);
    if (typeof value !== 'string' || this.#issued.has(value)) {
      throw new TypeError('d1_api_key_effect_id_invalid');
    }
    this.#issued.add(value);
    return value;
  }
}

export function createD1ApiKeyMutationEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy?: ApiKeyPolicy;
  readonly ids: {
    newApiKeyId(): string;
    newSecretHandle(): string;
  };
  readonly secretDelivery: D1ApiKeySecretDeliverySink;
}): D1EffectDomainAdapterRegistration {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const policy = parseApiKeyPolicy(input.policy ?? API_KEY_DEFAULT_POLICY);
  return Object.freeze({
    capability: API_KEY_MUTATION_HANDLER_CAPABILITY,
    create(unitOfWork: D1BufferedUnitOfWork) {
      return new D1ApiKeyMutationEffectDomainAdapter({
        unitOfWork,
        workspaceId,
        policy,
        ids: input.ids,
        secretDelivery: input.secretDelivery
      });
    }
  });
}

/** Adds a freshly committed secret to this response only; replay stays secret-free. */
export function createD1ApiKeyResponseSecretHandoff(): D1ApiKeySecretDeliverySink & {
  attach(response: Response): Promise<Response>;
} {
  const deliveries = new Map<string, string>();
  return Object.freeze({
    deposit(input: { readonly handle: string; readonly secret: string }) {
      if (deliveries.has(input.handle)) throw new TypeError('d1_api_key_secret_duplicate');
      deliveries.set(input.handle, input.secret);
    },
    async attach(response: Response): Promise<Response> {
      if (response.status !== 200 || deliveries.size === 0) return response;
      let candidate: unknown;
      try {
        candidate = await response.clone().json() as unknown;
      } catch {
        return response;
      }
      const created = apiKeyCreateOperationResultSchema.safeParse(candidate);
      const rotated = created.success ? undefined : apiKeyRotateOperationResultSchema.safeParse(candidate);
      const parsed = created.success ? created : rotated;
      if (!parsed?.success || parsed.data.kind !== 'success') return response;
      const secret = deliveries.get(parsed.data.data.secretHandle);
      if (!secret) return response;
      deliveries.delete(parsed.data.data.secretHandle);
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify({
        ...parsed.data,
        data: { ...parsed.data.data, oneTimeSecret: secret }
      }), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }
  });
}
