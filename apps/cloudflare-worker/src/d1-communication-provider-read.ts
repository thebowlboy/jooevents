import type {
  CommunicationProviderConfigurationReadPort,
  CommunicationProviderReadinessReadPort
} from '@jooevents/application';
import { createCloudflareWorkersEmailProvider } from '@jooevents/cloudflare-email';
import {
  createEmailProviderReadinessReader,
  createOutboundEmailProviderRegistry,
  type EmailProviderConfigurationService
} from '@jooevents/communications';
import {
  emailProviderConnectionProjectionSchema,
  emailProviderReadinessCheckProjectionSchema,
  type EmailProviderConnectionProjection,
  type EmailProviderReadinessCheckProjection
} from '@jooevents/contracts';
import { canonicalJsonText, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';

interface ConnectionRow {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly display_name: string;
  readonly adapter_key: string;
  readonly lifecycle: string;
  readonly head_version: number;
  readonly current_revision_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RevisionRow { readonly revision_json: string }
interface ReadinessRow { readonly projection_json: string }

function parseCanonical<Value>(text: string, parse: (value: unknown) => Value): Value {
  const value = parse(JSON.parse(text));
  if (canonicalJsonText(value) !== text) {
    throw new TypeError('d1_communication_provider_canonical_json_invalid');
  }
  return value;
}

class D1EmailProviderConfigurationReadStore {
  constructor(private readonly database: D1Database) {}

  async getConnection(connectionId: string): Promise<EmailProviderConnectionProjection | null> {
    const session = this.database.withSession('first-primary');
    const row = await session.prepare(`SELECT connection_id,workspace_id,display_name,
      adapter_key,lifecycle,head_version,current_revision_id,created_at,updated_at
      FROM email_provider_connections WHERE connection_id = ?`
    ).bind(connectionId).first<ConnectionRow>();
    return row ? this.project(session, row) : null;
  }

  async listConnections(workspaceIdInput: string): Promise<readonly EmailProviderConnectionProjection[]> {
    const workspaceId = parseWorkspaceId(workspaceIdInput);
    const session = this.database.withSession('first-primary');
    const rows = await session.prepare(`SELECT connection_id,workspace_id,display_name,
      adapter_key,lifecycle,head_version,current_revision_id,created_at,updated_at
      FROM email_provider_connections WHERE workspace_id = ? ORDER BY connection_id`
    ).bind(workspaceId).all<ConnectionRow>();
    return Object.freeze(await Promise.all(rows.results.map((row) => this.project(session, row))));
  }

  private async project(
    session: D1DatabaseSession,
    row: ConnectionRow
  ): Promise<EmailProviderConnectionProjection> {
    const revisions = await session.prepare(`SELECT revision_json
      FROM email_provider_connection_revisions
      WHERE connection_id = ? ORDER BY revision_number`
    ).bind(row.connection_id).all<RevisionRow>();
    return emailProviderConnectionProjectionSchema.parse({
      schemaVersion: 1,
      connectionId: row.connection_id,
      workspaceId: row.workspace_id,
      displayName: row.display_name,
      adapterKey: row.adapter_key,
      lifecycle: row.lifecycle,
      headVersion: row.head_version,
      currentRevisionId: row.current_revision_id,
      candidateRevisions: revisions.results.map((revision) => parseCanonical(
        revision.revision_json,
        (value) => emailProviderConnectionProjectionSchema.shape.candidateRevisions.element.parse(value)
      )),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }
}

class D1EmailProviderReadinessReadStore {
  constructor(private readonly database: D1Database) {}

  async listLatestChecks(
    connectionRevisionId: string
  ): Promise<readonly EmailProviderReadinessCheckProjection[]> {
    const rows = await this.database.withSession('first-primary').prepare(`SELECT c.projection_json
      FROM email_provider_readiness_heads h
      JOIN email_provider_readiness_checks c ON c.readiness_check_id = h.latest_check_id
      WHERE h.connection_revision_id = ? ORDER BY h.capability`
    ).bind(connectionRevisionId).all<ReadinessRow>();
    return Object.freeze(rows.results.map((row) => parseCanonical(
      row.projection_json,
      (value) => emailProviderReadinessCheckProjectionSchema.parse(value)
    )));
  }
}

function readOnlyConfiguration(
  store: D1EmailProviderConfigurationReadStore
): EmailProviderConfigurationService {
  const unsupported = (): never => {
    throw new TypeError('d1_communication_provider_configuration_write_not_mounted');
  };
  return Object.freeze({
    createConnection: unsupported,
    appendConnectionRevision: unsupported,
    getConnection: (connectionId: string) => store.getConnection(connectionId),
    listConnections: (workspaceId: string) => store.listConnections(workspaceId),
    createSenderProfile: unsupported,
    appendSenderProfileRevision: unsupported,
    getSenderProfile: unsupported,
    createRoutingPolicy: unsupported,
    appendRoutingPolicyRevision: unsupported,
    getRoutingPolicy: unsupported
  });
}

/** Persisted provider/readiness projections; construction and reads perform no provider I/O. */
export function createD1CommunicationProviderReadPorts(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
}): Readonly<{
  configuration: CommunicationProviderConfigurationReadPort;
  readiness: CommunicationProviderReadinessReadPort;
}> {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const store = new D1EmailProviderConfigurationReadStore(input.database);
  const configuration = readOnlyConfiguration(store);
  const provider = createCloudflareWorkersEmailProvider({
    binding: Object.freeze({
      async send(): Promise<never> {
        throw new TypeError('d1_communication_provider_read_cannot_send');
      }
    })
  });
  const registry = createOutboundEmailProviderRegistry([provider]);
  const readiness = createEmailProviderReadinessReader({
    configuration,
    registry,
    store: new D1EmailProviderReadinessReadStore(input.database),
    nowEpochMs: Date.now
  });
  return Object.freeze({
    configuration: Object.freeze({
      getConnection: (connectionId: string) => store.getConnection(connectionId)
    }),
    readiness: Object.freeze({
      getReadiness(
        request: Parameters<CommunicationProviderReadinessReadPort['getReadiness']>[0]
      ) {
        if (parseWorkspaceId(request.workspaceId) !== workspaceId) {
          throw new TypeError('d1_communication_provider_read_workspace_mismatch');
        }
        return readiness.getReadiness(request);
      }
    })
  });
}
