import {
  computeEmailProviderConfigurationDigest,
  emailProviderReadinessCheckInputSchema,
  organizerEmailReadinessProjectionSchema,
  providerReadinessInputSchema,
  type EmailProviderConnectionProjection,
  type EmailProviderConnectionRevisionCandidate,
  type EmailProviderReadinessCheckInput,
  type EmailProviderReadinessCheckProjection,
  type EmailSetupManifest,
  type OrganizerEmailReadinessProjection,
  type ProviderReadinessInput
} from '@jooevents/contracts';
import type { EmailProviderConfigurationService } from './configuration';
import type { OutboundEmailProviderRegistry } from './registry';

type Awaitable<T> = T | Promise<T>;

/**
 * The external-effect executor family exists: the server composition mounts a
 * readiness-check executor and an owner-lane diagnostic send for the one
 * configured provider registration (deployments without a configured provider
 * mode compose neither). Provider I/O runs strictly outside every unit of
 * work, between the executor's own short begin/complete transactions.
 */
export const EMAIL_PROVIDER_EXTERNAL_OPERATION_ACTIVATION = Object.freeze({
  runReadinessCheck: 'external_effect_executor_mounted',
  sendDiagnosticTest: 'external_effect_executor_mounted'
} as const);

/** Read-side evidence only. The external-effect executor owns check/head writes. */
export interface EmailProviderReadinessReadStore {
  listLatestChecks(
    connectionRevisionId: string
  ): Awaitable<readonly EmailProviderReadinessCheckProjection[]>;
}

export type EmailProviderReadinessReader = Readonly<{
  getReadiness(input: Readonly<{
    workspaceId: string;
    connectionId?: string;
  }>): Promise<OrganizerEmailReadinessProjection>;
}>;

function canonicalInstant(epochMs: number): string {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) throw new TypeError('invalid epoch time');
  return new Date(epochMs).toISOString();
}

function unknown(nextStepCode: string): OrganizerEmailReadinessProjection {
  return organizerEmailReadinessProjectionSchema.parse({
    schemaVersion: 1,
    outbound: { state: 'unknown', nextStepCode },
    callbacks: { state: 'not_supported' },
    inbound: { state: 'not_enabled' }
  });
}

function actionRequired(input: Readonly<{
  connection?: EmailProviderConnectionProjection;
  revision?: EmailProviderConnectionRevisionCandidate;
  reasonCode: string;
  nextStepCode: string;
}>): OrganizerEmailReadinessProjection {
  return organizerEmailReadinessProjectionSchema.parse({
    schemaVersion: 1,
    ...(input.connection !== undefined && input.revision !== undefined
      ? { provider: {
          adapterKey: input.revision.adapterKey,
          adapterVersion: input.revision.adapterVersion,
          displayName: input.connection.displayName
        } }
      : {}),
    outbound: {
      state: 'action_required',
      reasonCode: input.reasonCode,
      nextStepCode: input.nextStepCode
    },
    callbacks: { state: 'not_supported' },
    inbound: { state: 'not_enabled' }
  });
}

/**
 * Projects only the exact active pointer. Evidence from inactive or prior revisions
 * never qualifies the organizer-visible outbound state.
 */
export function createEmailProviderReadinessReader(input: Readonly<{
  configuration: EmailProviderConfigurationService;
  registry: OutboundEmailProviderRegistry;
  store: EmailProviderReadinessReadStore;
  nowEpochMs(): number;
}>): EmailProviderReadinessReader {
  return Object.freeze({
    async getReadiness(request) {
      const connections = request.connectionId === undefined
        ? await input.configuration.listConnections(request.workspaceId)
        : [await input.configuration.getConnection(request.connectionId)].filter(
            (value): value is EmailProviderConnectionProjection => value !== null
          );
      const inWorkspace = connections.filter(
        (connection) => connection.workspaceId === request.workspaceId
      );
      if (inWorkspace.length === 0) return unknown('configure_email_provider');

      const active = inWorkspace.filter(
        (connection) => connection.lifecycle === 'active_outbound'
      );
      if (active.length !== 1) {
        const connection = inWorkspace.length === 1 ? inWorkspace[0] : undefined;
        const revision = connection?.currentRevisionId === null
          ? undefined
          : connection?.candidateRevisions.find(
              (candidate) => candidate.revisionId === connection.currentRevisionId
            );
        return actionRequired({
          ...(connection === undefined ? {} : { connection }),
          ...(revision === undefined ? {} : { revision }),
          reasonCode: active.length > 1
            ? 'multiple_active_email_providers'
            : 'email_provider_not_active',
          nextStepCode: 'activate_email_provider_revision'
        });
      }

      const connection = active[0]!;
      const revision = connection.candidateRevisions.find(
        (candidate) => candidate.revisionId === connection.currentRevisionId
      );
      if (revision === undefined) return actionRequired({
        reasonCode: 'email_provider_pointer_invalid',
        nextStepCode: 'repair_email_provider_pointer'
      });

      let manifest: EmailSetupManifest;
      try {
        manifest = input.registry.resolve({
          adapterKey: revision.adapterKey,
          adapterVersion: revision.adapterVersion,
          manifestKey: revision.setupManifestKey,
          manifestVersion: revision.setupManifestVersion,
          manifestDigestSha256: revision.setupManifestDigestSha256
        }).setup.manifest;
      } catch {
        return actionRequired({ connection, revision,
          reasonCode: 'email_provider_adapter_unavailable',
          nextStepCode: 'restore_email_provider_adapter' });
      }
      const declared = manifest.readinessChecks.find(
        (check) => check.capability === 'transactional_outbound'
      )!;
      const checks = await input.store.listLatestChecks(revision.revisionId);
      const check = checks.find((candidate) =>
        candidate.connectionId === connection.connectionId
        && candidate.connectionRevisionId === revision.revisionId
        && candidate.capability === 'transactional_outbound'
        && candidate.checkKey === declared.key);
      if (check === undefined || check.state === 'checking') return actionRequired({
        connection,
        revision,
        reasonCode: check === undefined
          ? 'email_provider_readiness_unknown'
          : 'email_provider_readiness_checking',
        nextStepCode: 'run_email_provider_readiness_check'
      });
      if (
        check.state !== 'passed'
        || check.readiness !== 'ready'
        || check.evidence === null
        || check.validUntil === null
      ) return actionRequired({ connection, revision,
        reasonCode: check.readiness === 'degraded'
          ? 'email_provider_readiness_degraded'
          : 'email_provider_readiness_blocked',
        nextStepCode: 'run_email_provider_readiness_check' });
      if (check.validUntil <= input.nowEpochMs()) return actionRequired({ connection, revision,
        reasonCode: 'email_provider_readiness_expired',
        nextStepCode: 'run_email_provider_readiness_check' });

      return organizerEmailReadinessProjectionSchema.parse({
        schemaVersion: 1,
        provider: {
          adapterKey: revision.adapterKey,
          adapterVersion: revision.adapterVersion,
          displayName: connection.displayName
        },
        outbound: {
          state: 'ready',
          connectionRevisionId: revision.revisionId,
          evidence: check.evidence,
          validUntil: canonicalInstant(check.validUntil)
        },
        callbacks: { state: 'not_supported' },
        inbound: { state: 'not_enabled' }
      });
    }
  });
}

/** Pure preparation for the future external-effect executor. It performs no I/O. */
export function prepareEmailProviderReadinessRequest(input: Readonly<{
  check: EmailProviderReadinessCheckInput;
  connection: EmailProviderConnectionProjection;
  manifest: EmailSetupManifest;
  preparedAtEpochMs: number;
}>): ProviderReadinessInput {
  const check = emailProviderReadinessCheckInputSchema.parse(input.check);
  const revision = input.connection.candidateRevisions.find(
    (candidate) => candidate.revisionId === check.connectionRevisionId
  );
  if (
    revision === undefined
    || revision.connectionId !== check.connectionId
    || revision.configDigestSha256 !== check.expectedConfigDigestSha256
  ) throw new TypeError('readiness check does not cite the exact connection revision');
  if (
    input.manifest.adapterKey !== revision.adapterKey
    || input.manifest.adapterVersion !== revision.adapterVersion
    || input.manifest.manifestKey !== revision.setupManifestKey
    || input.manifest.manifestVersion !== revision.setupManifestVersion
    || input.manifest.manifestDigestSha256 !== revision.setupManifestDigestSha256
  ) throw new TypeError('readiness check does not cite the exact setup manifest');
  const declared = input.manifest.readinessChecks.find(
    (candidate) => candidate.key === check.checkKey && candidate.capability === check.capability
  );
  if (declared === undefined) throw new TypeError('readiness check is not declared by the manifest');
  const registrationSelector = {
    adapterKey: revision.adapterKey,
    adapterVersion: revision.adapterVersion,
    manifestKey: revision.setupManifestKey,
    manifestVersion: revision.setupManifestVersion,
    manifestDigestSha256: revision.setupManifestDigestSha256
  };
  const maximumValidity = input.preparedAtEpochMs + declared.maximumValidityMs;
  if (
    check.requestedValidUntil <= input.preparedAtEpochMs
    || check.requestedValidUntil > maximumValidity
  ) {
    throw new TypeError('readiness validity exceeds the manifest bound');
  }
  const unsigned = {
    contractVersion: 1 as const,
    connectionId: check.connectionId,
    connectionRevisionId: check.connectionRevisionId,
    connectionConfigDigestSha256: check.expectedConfigDigestSha256,
    capability: check.capability,
    readinessCheckId: check.readinessCheckId,
    checkKey: check.checkKey,
    ...registrationSelector,
    externalCheckKey: declared.externalCheckKey,
    requestedValidUntil: check.requestedValidUntil,
    observationSchemaVersion: declared.observationSchemaVersion,
    normalizerVersion: declared.normalizerVersion
  };
  const expectedDigest = computeEmailProviderConfigurationDigest(unsigned);
  if (check.requestDigestSha256 !== expectedDigest) {
    throw new TypeError('readiness request digest does not match its immutable content');
  }
  return providerReadinessInputSchema.parse({ ...unsigned, requestDigestSha256: expectedDigest });
}
