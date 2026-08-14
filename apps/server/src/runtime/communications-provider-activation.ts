import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import {
  computeEmailProviderConfigurationDigest,
  emailProviderDiagnosticTestProjectionSchema,
  type EmailProviderConnectionProjection,
  type EmailProviderConnectionRevisionCandidate,
  type EmailProviderDiagnosticTestProjection,
  type EmailProviderReadinessCheckProjection,
  type SafeEvidence
} from '@jooevents/contracts';
import {
  computeReviewedEmailEnvelopeDigestSha256,
  parseEmailAddress,
  prepareEmailProviderReadinessRequest,
  type EmailProviderConfigurationService,
  type ImmutableEmailDiagnosticSubmission,
  type ImmutableEmailEnvelope,
  type OutboundEmailProviderRegistration
} from '@jooevents/communications';
import { encodeCanonicalJson } from '@jooevents/kernel';
import type {
  SQLiteEmailProviderConfigurationRepository
} from '@jooevents/persistence/email-provider-configuration';

/**
 * Activation-change composition for one configured outbound email provider:
 * the `email_provider_connections` lifecycle row and the two owner-lane
 * external-effect executors (`runReadinessCheck`, `sendDiagnosticTest`).
 *
 * Contract discipline:
 * - Provider I/O runs strictly outside any open database transaction; both
 *   executors assert this before touching the adapter, mirroring the
 *   outbound-dispatch worker contract.
 * - The lifecycle row is deterministic per (workspace, adapter, exact config
 *   digest), so re-running composition converges instead of multiplying rows;
 *   a changed configuration appends an immutable revision and repoints the
 *   active head under the schema's own head-bump triggers.
 * - The readiness executor records evidence through the repository's
 *   begin/complete fence; a probe or resolver failure lands as a typed
 *   `blocked` check, never as an unhandled crash.
 */

const CONNECTION_DISPLAY_NAME = 'Cloudflare Email Sending';
const CONFIGURATION_SCHEMA_KEY = 'cloudflare.email.rest.configuration';
const DIAGNOSTIC_RECIPIENT_FINGERPRINT_PROFILE = 'fingerprint.communication.diagnostic-recipient.sha256';
const DIAGNOSTIC_RECIPIENT_FINGERPRINT_VERSION = 1;
const DIAGNOSTIC_VALIDITY_MS = 10 * 60_000;

export class CommunicationsProviderActivationError extends Error {
  constructor(readonly code:
    | 'connection_revision_unavailable'
    | 'diagnostics_not_supported'
    | 'open_transaction'
    | 'readiness_check_undeclared') {
    super(code);
    this.name = 'CommunicationsProviderActivationError';
  }
}

export interface CommunicationsProviderSenderIdentity {
  readonly fromAddress: string;
  readonly fromDisplayName?: string;
  readonly replyToAddress?: string;
}

export interface CommunicationsProviderActivationInput {
  readonly sqlite: Database;
  readonly workspaceId: string;
  readonly configuration: EmailProviderConfigurationService;
  readonly repository: SQLiteEmailProviderConfigurationRepository;
  readonly registration: OutboundEmailProviderRegistration;
  readonly connectionConfig: Readonly<{
    accountId: string;
    apiTokenSecret: Readonly<{ storeKey: string; reference: string }>;
  }>;
  readonly sender: CommunicationsProviderSenderIdentity;
  readonly clock: { now(): string };
  readonly nowEpochMs: () => number;
  readonly ids: { newId(): string };
}

export interface ActiveOutboundConnection {
  readonly connectionId: string;
  readonly revisionId: string;
  readonly configDigestSha256: string;
}

export interface CommunicationsProviderActivation {
  /** Idempotently stages and activates the one deployment connection. */
  ensureActiveOutboundConnection(): Promise<ActiveOutboundConnection>;
  /** External-effect executor: one readiness check on the exact active revision. */
  runReadinessCheck(): Promise<EmailProviderReadinessCheckProjection>;
  /** External-effect executor: one owner-authorized fixture send. Real cost. */
  sendDiagnosticTest(input: Readonly<{ recipient: string }>): Promise<
    EmailProviderDiagnosticTestProjection
  >;
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function deterministicUuid(namespace: string, material: unknown): string {
  const hex = sha256Hex({ namespace, material });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function evidenceRef(evidence: SafeEvidence, evidenceId: string, observedAt: string) {
  return Object.freeze({
    evidenceId,
    registeredCode: evidence.registeredCode as string,
    digestSha256: evidence.canonicalDigestSha256,
    observedAt
  });
}

export function createCommunicationsProviderActivation(
  input: CommunicationsProviderActivationInput
): CommunicationsProviderActivation {
  const manifest = input.registration.setup.manifest;
  const configDigestSha256 = sha256Hex({
    schemaVersion: 1,
    mode: 'cloudflare_rest',
    adapterKey: manifest.adapterKey,
    adapterVersion: manifest.adapterVersion,
    accountId: input.connectionConfig.accountId,
    apiTokenSecretStoreKey: input.connectionConfig.apiTokenSecret.storeKey,
    apiTokenSecretReference: input.connectionConfig.apiTokenSecret.reference
  });
  const connectionId = deterministicUuid('communication.provider-connection', {
    workspaceId: input.workspaceId,
    adapterKey: manifest.adapterKey,
    adapterVersion: manifest.adapterVersion
  });
  const revisionIdFor = (digest: string): string =>
    deterministicUuid('communication.provider-connection-revision', { connectionId, digest });

  function assertNoOpenTransaction(): void {
    if (input.sqlite.inTransaction) {
      throw new CommunicationsProviderActivationError('open_transaction');
    }
  }

  function draftShape(revisionId: string) {
    return {
      connectionId,
      revisionId,
      workspaceId: input.workspaceId,
      displayName: CONNECTION_DISPLAY_NAME,
      adapterKey: manifest.adapterKey,
      adapterVersion: manifest.adapterVersion,
      manifest,
      configSchemaVersion: 1,
      configRef: {
        payloadRefId: deterministicUuid('communication.provider-config-ref', {
          connectionId,
          configDigestSha256
        }),
        payloadRefVersion: 1,
        payloadKind: 'email_provider_configuration' as const,
        schemaKey: CONFIGURATION_SCHEMA_KEY,
        schemaVersion: 1,
        classification: 'restricted' as const
      },
      secretReferences: manifest.requiredSecretReferences.map((requirement) => ({
        key: requirement.key,
        secretStoreKey: input.connectionConfig.apiTokenSecret.storeKey,
        secretReference: input.connectionConfig.apiTokenSecret.reference
      })),
      configDigestSha256,
      createdAt: input.clock.now()
    };
  }

  function activatePointer(revisionId: string): void {
    const transition = () => {
      const row = input.sqlite.query<{
        readonly lifecycle: string;
        readonly current_revision_id: string | null;
        readonly head_version: number;
      }, [string]>(`
        SELECT lifecycle, current_revision_id, head_version
          FROM email_provider_connections WHERE connection_id = ?
      `).get(connectionId);
      if (row === null) {
        throw new CommunicationsProviderActivationError('connection_revision_unavailable');
      }
      if (row.lifecycle === 'active_outbound' && row.current_revision_id === revisionId) return;
      const updated = input.sqlite.query(`
        UPDATE email_provider_connections
           SET lifecycle = 'active_outbound', current_revision_id = ?,
               head_version = ?, updated_at = ?
         WHERE connection_id = ? AND head_version = ?
      `).run(revisionId, row.head_version + 1, input.clock.now(), connectionId, row.head_version);
      if (updated.changes !== 1) {
        throw new CommunicationsProviderActivationError('connection_revision_unavailable');
      }
    };
    if (input.sqlite.inTransaction) transition();
    else input.sqlite.transaction(transition).immediate();
  }

  async function activeRevision(): Promise<Readonly<{
    connection: EmailProviderConnectionProjection;
    revision: EmailProviderConnectionRevisionCandidate;
  }>> {
    const connection = await input.configuration.getConnection(connectionId);
    const revision = connection?.candidateRevisions.find(
      (candidate) => candidate.revisionId === connection.currentRevisionId
    );
    if (
      connection === null || connection === undefined || revision === undefined
      || connection.lifecycle !== 'active_outbound'
    ) {
      throw new CommunicationsProviderActivationError('connection_revision_unavailable');
    }
    return Object.freeze({ connection, revision });
  }

  return Object.freeze({
    async ensureActiveOutboundConnection(): Promise<ActiveOutboundConnection> {
      const revisionId = revisionIdFor(configDigestSha256);
      const existing = await input.configuration.getConnection(connectionId);
      if (existing === null) {
        await input.configuration.createConnection(draftShape(revisionId));
      } else if (!existing.candidateRevisions.some(
        (candidate) => candidate.configDigestSha256 === configDigestSha256
      )) {
        await input.configuration.appendConnectionRevision({
          ...draftShape(revisionId),
          expectedHeadVersion: existing.headVersion
        });
      }
      const staged = await input.configuration.getConnection(connectionId);
      const revision = staged?.candidateRevisions.find(
        (candidate) => candidate.configDigestSha256 === configDigestSha256
      );
      if (staged === null || staged === undefined || revision === undefined) {
        throw new CommunicationsProviderActivationError('connection_revision_unavailable');
      }
      activatePointer(revision.revisionId);
      return Object.freeze({
        connectionId,
        revisionId: revision.revisionId,
        configDigestSha256
      });
    },

    async runReadinessCheck(): Promise<EmailProviderReadinessCheckProjection> {
      assertNoOpenTransaction();
      const { connection, revision } = await activeRevision();
      const declared = manifest.readinessChecks.find(
        (check) => check.capability === 'transactional_outbound'
      );
      if (declared === undefined) {
        throw new CommunicationsProviderActivationError('readiness_check_undeclared');
      }
      const preparedAtEpochMs = input.nowEpochMs();
      const requestedValidUntil = preparedAtEpochMs + declared.maximumValidityMs;
      const readinessCheckId = input.ids.newId();
      const unsigned = {
        contractVersion: 1 as const,
        connectionId: connection.connectionId,
        connectionRevisionId: revision.revisionId,
        connectionConfigDigestSha256: revision.configDigestSha256,
        capability: 'transactional_outbound' as const,
        readinessCheckId,
        checkKey: declared.key,
        adapterKey: revision.adapterKey,
        adapterVersion: revision.adapterVersion,
        manifestKey: revision.setupManifestKey,
        manifestVersion: revision.setupManifestVersion,
        manifestDigestSha256: revision.setupManifestDigestSha256,
        externalCheckKey: declared.externalCheckKey,
        requestedValidUntil,
        observationSchemaVersion: declared.observationSchemaVersion,
        normalizerVersion: declared.normalizerVersion
      };
      const check = {
        readinessCheckId,
        connectionId: connection.connectionId,
        connectionRevisionId: revision.revisionId,
        expectedConfigDigestSha256: revision.configDigestSha256,
        capability: 'transactional_outbound' as const,
        checkKey: declared.key,
        requestedValidUntil,
        requestDigestSha256: computeEmailProviderConfigurationDigest(unsigned)
      };
      const request = prepareEmailProviderReadinessRequest({
        check,
        connection,
        manifest,
        preparedAtEpochMs
      });
      input.repository.beginReadinessCheck(check, input.clock.now());
      // Provider I/O — strictly between the begin and complete transactions.
      const observation = await input.registration.setup.checkReadiness(request);
      const completedAt = input.clock.now();
      if (observation.kind === 'passed') {
        return input.repository.completeReadinessCheck({
          readinessCheckId,
          readiness: observation.readiness,
          evidence: evidenceRef(observation.evidence, input.ids.newId(), completedAt),
          validUntil: observation.validUntil,
          completedAt
        });
      }
      return input.repository.completeReadinessCheck({
        readinessCheckId,
        readiness: 'blocked',
        evidence: evidenceRef(observation.evidence, input.ids.newId(), completedAt),
        validUntil: null,
        completedAt
      });
    },

    async sendDiagnosticTest(request: Readonly<{ recipient: string }>): Promise<
      EmailProviderDiagnosticTestProjection
    > {
      assertNoOpenTransaction();
      const { revision } = await activeRevision();
      if (manifest.diagnostics.kind !== 'supported') {
        throw new CommunicationsProviderActivationError('diagnostics_not_supported');
      }
      const recipient = parseEmailAddress(request.recipient);
      const diagnosticAttemptId = input.ids.newId();
      const now = input.clock.now();
      const envelope: ImmutableEmailEnvelope = Object.freeze({
        contractVersion: 1,
        from: Object.freeze({
          address: parseEmailAddress(input.sender.fromAddress),
          ...(input.sender.fromDisplayName === undefined
            ? {}
            : { displayName: input.sender.fromDisplayName })
        }),
        to: Object.freeze({ address: recipient }),
        ...(input.sender.replyToAddress === undefined
          ? {}
          : { replyTo: Object.freeze({ address: parseEmailAddress(input.sender.replyToAddress) }) }),
        subject: 'JooEvents email diagnostic test',
        textBody: [
          'This is a one-time diagnostic test message from JooEvents.',
          '',
          `Diagnostic attempt: ${diagnosticAttemptId}`,
          `Requested at: ${now}`,
          '',
          'If you did not expect this message, you can ignore it.'
        ].join('\n'),
        headers: Object.freeze([])
      });
      const submission: ImmutableEmailDiagnosticSubmission = Object.freeze({
        contractVersion: 1,
        diagnosticAttemptId,
        providerConnectionRevisionId: revision.revisionId,
        externalDiagnosticKey: `diagnostic.${diagnosticAttemptId}`,
        fixtureKey: manifest.diagnostics.fixtureKey,
        fixtureVersion: manifest.diagnostics.fixtureVersion,
        recipientFingerprintProfile: DIAGNOSTIC_RECIPIENT_FINGERPRINT_PROFILE,
        recipientFingerprintVersion: DIAGNOSTIC_RECIPIENT_FINGERPRINT_VERSION,
        recipientFingerprintSha256: sha256Hex({
          profile: DIAGNOSTIC_RECIPIENT_FINGERPRINT_PROFILE,
          version: DIAGNOSTIC_RECIPIENT_FINGERPRINT_VERSION,
          address: recipient.trim().toLowerCase()
        }),
        reviewedEnvelopeDigestSha256: computeReviewedEmailEnvelopeDigestSha256(envelope),
        validUntil: input.nowEpochMs() + DIAGNOSTIC_VALIDITY_MS,
        maximumCostMinorUnits: manifest.diagnostics.maximumCostMinorUnits,
        currency: manifest.diagnostics.currency,
        envelope
      });
      const prepared = input.registration.diagnostics.prepare(submission);
      // Provider I/O — no database transaction may be open here.
      const outcome = await input.registration.diagnostics.submit(prepared);
      const observedAt = input.clock.now();
      const state = outcome.kind === 'accepted'
        ? 'accepted' as const
        : outcome.kind === 'acceptance_unknown'
          ? 'acceptance_unknown' as const
          : 'known_failed' as const;
      return emailProviderDiagnosticTestProjectionSchema.parse({
        schemaVersion: 1,
        diagnosticAttemptId,
        connectionRevisionId: revision.revisionId,
        state,
        outcomeCode: outcome.evidence.registeredCode,
        evidence: evidenceRef(outcome.evidence, input.ids.newId(), observedAt),
        providerMessageRecorded: outcome.kind === 'accepted',
        cost: null,
        observedAt
      });
    }
  });
}
