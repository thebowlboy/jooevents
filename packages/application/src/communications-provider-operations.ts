import {
  emailProviderConfigurationReadInputSchema,
  emailProviderConnectionCanonicalResultSchema,
  emailProviderConnectionProjectionSchema,
  emailProviderReadinessCanonicalResultSchema,
  emailProviderReadinessGetInputSchema,
  organizerEmailReadinessProjectionSchema,
  type EmailProviderConfigurationReadInput,
  type EmailProviderConnectionCanonicalResult,
  type EmailProviderConnectionProjection,
  type EmailProviderReadinessCanonicalResult,
  type EmailProviderReadinessGetInput,
  type OrganizerEmailReadinessProjection
} from '@jooevents/contracts';
import { parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';

type Awaitable<T> = T | Promise<T>;

export const COMMUNICATION_PROVIDER_OPERATIONS = Object.freeze({
  getConnection: Object.freeze({ name: 'communication.provider_connection.read', version: 1 }),
  getReadiness: Object.freeze({ name: 'communication.email_readiness.read', version: 1 }),
  runReadinessCheck: Object.freeze({ name: 'communication.email_readiness.check', version: 1 }),
  sendDiagnosticTest: Object.freeze({ name: 'communication.email_diagnostic.send_test', version: 1 })
});

/**
 * The two external-effect operations are served by the server composition's
 * external-effect executor family (mounted only for a configured provider
 * registration, owner-lane gated behind the provider-manage policy), never by
 * an ordinary single-unit-of-work handler: provider I/O stays strictly outside
 * every unit of work.
 */
export const COMMUNICATION_PROVIDER_OPERATION_ACTIVATION = Object.freeze({
  getConnection: 'read_leaf_ready',
  getReadiness: 'read_leaf_ready',
  runReadinessCheck: 'external_effect_executor_mounted',
  sendDiagnosticTest: 'external_effect_executor_mounted'
} as const);

export interface CommunicationProviderConfigurationReadPort {
  getConnection(connectionId: string): Awaitable<EmailProviderConnectionProjection | null>;
}

export interface CommunicationProviderReadinessReadPort {
  getReadiness(input: Readonly<{
    workspaceId: string;
    connectionId?: string;
  }>): Awaitable<OrganizerEmailReadinessProjection>;
}

export type CommunicationProviderReadOperations = Readonly<{
  getConnection(input: EmailProviderConfigurationReadInput): Promise<EmailProviderConnectionCanonicalResult>;
  getReadiness(input: EmailProviderReadinessGetInput): Promise<EmailProviderReadinessCanonicalResult>;
}>;

function hiddenNotFound(connectionId: string): EmailProviderConnectionCanonicalResult {
  return emailProviderConnectionCanonicalResultSchema.parse({
    kind: 'outcome',
    outcome: {
      class: 'conflict',
      kind: 'communication.provider_connection_unavailable',
      retryable: false,
      subjects: [{ type: 'communication.provider_connection', id: connectionId }],
      detail: null,
      detailSchemaVersion: 1
    }
  });
}

/**
 * Scope-bound read facade for a later registry module. It exposes no unscoped read
 * and deliberately has no readiness-check or diagnostic effect method.
 */
export function createCommunicationProviderReadOperations(input: Readonly<{
  workspaceId: WorkspaceId | string;
  configuration: CommunicationProviderConfigurationReadPort;
  readiness: CommunicationProviderReadinessReadPort;
}>): CommunicationProviderReadOperations {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async getConnection(raw: EmailProviderConfigurationReadInput) {
      const request = emailProviderConfigurationReadInputSchema.parse(raw);
      const connection = await input.configuration.getConnection(request.connectionId);
      if (connection === null || connection.workspaceId !== workspaceId) {
        return hiddenNotFound(request.connectionId);
      }
      return emailProviderConnectionCanonicalResultSchema.parse({
        kind: 'success', data: emailProviderConnectionProjectionSchema.parse(connection)
      });
    },
    async getReadiness(raw: EmailProviderReadinessGetInput) {
      const request = emailProviderReadinessGetInputSchema.parse(raw);
      const readiness = await input.readiness.getReadiness({
        workspaceId,
        ...(request.connectionId === undefined ? {} : { connectionId: request.connectionId })
      });
      return emailProviderReadinessCanonicalResultSchema.parse({
        kind: 'success', data: organizerEmailReadinessProjectionSchema.parse(readiness)
      });
    }
  });
}
