import type {
  SecretStore,
  SecretStoreAdapterRef
} from '@jooevents/application';
import {
  createAirtableAuthorizationRequest,
  type AirtableGrantIdentity,
  type AirtableOAuthGrant,
  type AirtableOAuthPort,
  type AirtableOAuthScope,
  type AirtableProviderResult
} from '@jooevents/airtable';
import { canonicalJsonSha256 } from '@jooevents/kernel';
import {
  storeAirtableOAuthAttempt,
  storeAirtableOAuthGrant,
  withAirtableOAuthAttemptVerifier,
  type StoredAirtableOAuthAttempt,
  type StoredAirtableOAuthGrant
} from './grant-secrets';

export interface AirtableOAuthAttemptClaim {
  readonly id: string;
  readonly connectionId: string;
  readonly stored: StoredAirtableOAuthAttempt;
  readonly redirectUri: string;
  readonly workerId: string;
  readonly leaseVersion: number;
}

export interface AirtableOAuthCoordinatorRepository {
  createOAuthConnectionAttempt(input: Readonly<{
    connectionId: string;
    workspaceId: string;
    publicCallbackRef: string;
    attemptId: string;
    stored: StoredAirtableOAuthAttempt;
    redirectUri: string;
    nowMs: number;
  }>): void | Promise<void>;
  claimOAuthAttempt(input: Readonly<{
    stateDigestSha256: string;
    workerId: string;
    nowMs: number;
    leaseMs: number;
  }>): AirtableOAuthAttemptClaim | undefined | Promise<AirtableOAuthAttemptClaim | undefined>;
  completeOAuthConnection(input: Readonly<{
    claim: AirtableOAuthAttemptClaim;
    providerAccountId: string;
    stored: StoredAirtableOAuthGrant;
    nowMs: number;
  }>): boolean | Promise<boolean>;
  finishOAuthAttempt(input: Readonly<{
    id: string;
    workerId: string;
    leaseVersion: number;
    outcome: 'consumed' | 'failed';
    nowMs: number;
  }>): boolean | Promise<boolean>;
}

export interface AirtableOAuthCoordinator {
  start(input: Readonly<{
    connectionId: string;
    workspaceId: string;
    publicCallbackRef: string;
    attemptId: string;
    redirectUri: string;
    scopes: readonly AirtableOAuthScope[];
  }>): Promise<Readonly<{ authorizationUrl: string; expiresAt: string }>>;
  complete(input: Readonly<{
    code: string;
    state: string;
  }>): Promise<Readonly<{
    connectionId: string;
    identity: AirtableGrantIdentity;
    scopes: readonly AirtableOAuthScope[];
  }>>;
}

export class AirtableOAuthCompletionError extends Error {
  constructor(
    readonly code:
      | 'attempt_unavailable'
      | 'provider_unavailable'
      | 'grant_identity_unavailable'
      | 'completion_raced',
    readonly retry: 'restart' | 'after_delay'
  ) {
    super(code);
    this.name = 'AirtableOAuthCompletionError';
  }
}

/**
 * Fences the browser OAuth ceremony around durable attempt and grant references.
 * Token values cross only provider and SecretStore callbacks and never enter results.
 */
export function createAirtableOAuthCoordinator(input: Readonly<{
  clientId: string;
  oauth: AirtableOAuthPort;
  repository: AirtableOAuthCoordinatorRepository;
  secretStore: SecretStore;
  secretAdapter: SecretStoreAdapterRef;
  inspectGrant(grant: AirtableOAuthGrant): Promise<AirtableProviderResult<AirtableGrantIdentity>>;
  workerId: string;
  now?: () => number;
}>): AirtableOAuthCoordinator {
  if (!input.workerId || input.workerId.length > 160) {
    throw new TypeError('airtable_oauth_worker_id_invalid');
  }
  const now = input.now ?? Date.now;

  const coordinator: AirtableOAuthCoordinator = {
    async start(value) {
      const request = await createAirtableAuthorizationRequest({
        clientId: input.clientId,
        redirectUri: value.redirectUri,
        scopes: value.scopes
      });
      const nowMs = now();
      const stored = await storeAirtableOAuthAttempt({
        secretStore: input.secretStore,
        adapter: input.secretAdapter,
        connectionId: value.connectionId,
        request,
        nowMs
      });
      try {
        await input.repository.createOAuthConnectionAttempt({
          connectionId: value.connectionId,
          workspaceId: value.workspaceId,
          publicCallbackRef: value.publicCallbackRef,
          attemptId: value.attemptId,
          stored,
          redirectUri: value.redirectUri,
          nowMs
        });
      } catch (error) {
        await input.secretStore.revoke({
          reference: stored.secretReference,
          expectedVersion: stored.secretReference.version
        });
        throw error;
      }
      return Object.freeze({
        authorizationUrl: request.authorizationUrl,
        expiresAt: stored.expiresAt
      });
    },

    async complete(value) {
      const stateDigestSha256 = canonicalJsonSha256({ state: value.state });
      const claim = await input.repository.claimOAuthAttempt({
        stateDigestSha256,
        workerId: input.workerId,
        nowMs: now(),
        leaseMs: 30_000
      });
      if (!claim) throw new AirtableOAuthCompletionError('attempt_unavailable', 'restart');

      let storedGrant: StoredAirtableOAuthGrant | undefined;
      try {
        const completed = await withAirtableOAuthAttemptVerifier({
          secretStore: input.secretStore,
          stored: claim.stored,
          connectionId: claim.connectionId,
          returnedState: value.state,
          nowMs: now(),
          use: async (codeVerifier, scopes) => {
            const exchanged = await input.oauth.exchangeAuthorizationCode({
              code: value.code,
              redirectUri: claim.redirectUri,
              codeVerifier,
              expectedScopes: scopes
            });
            if (exchanged.kind === 'failure') {
              throw new AirtableOAuthCompletionError(
                'provider_unavailable',
                exchanged.failure.retry === 'after_delay' ? 'after_delay' : 'restart'
              );
            }
            const identity = await input.inspectGrant(exchanged.value);
            if (identity.kind === 'failure') {
              throw new AirtableOAuthCompletionError(
                'grant_identity_unavailable',
                identity.failure.retry === 'after_delay' ? 'after_delay' : 'restart'
              );
            }
            storedGrant = await storeAirtableOAuthGrant({
              secretStore: input.secretStore,
              adapter: input.secretAdapter,
              connectionId: claim.connectionId,
              grant: exchanged.value
            });
            const accepted = await input.repository.completeOAuthConnection({
              claim,
              providerAccountId: identity.value.userId,
              stored: storedGrant,
              nowMs: now()
            });
            if (!accepted) throw new AirtableOAuthCompletionError('completion_raced', 'restart');
            return Object.freeze({
              connectionId: claim.connectionId,
              identity: identity.value,
              scopes: storedGrant.scopes
            });
          }
        });
        return completed;
      } catch (error) {
        if (storedGrant) {
          await input.secretStore.revoke({
            reference: storedGrant.secretReference,
            expectedVersion: storedGrant.secretReference.version
          });
        }
        await input.repository.finishOAuthAttempt({
          id: claim.id,
          workerId: claim.workerId,
          leaseVersion: claim.leaseVersion,
          outcome: 'failed',
          nowMs: now()
        });
        throw error;
      }
    }
  };
  return Object.freeze(coordinator);
}
