import {
  emailProviderConnectionDraftInputSchema,
  emailProviderConnectionProjectionSchema,
  emailProviderConnectionRevisionAppendInputSchema,
  emailRoutingPolicyDraftInputSchema,
  emailRoutingPolicyProjectionSchema,
  emailRoutingPolicyRevisionAppendInputSchema,
  emailSenderProfileDraftInputSchema,
  emailSenderProfileProjectionSchema,
  emailSenderProfileRevisionAppendInputSchema,
  providerOpaqueIdSchema,
  type EmailProviderConnectionDraftInput,
  type EmailProviderConnectionProjection,
  type EmailProviderConnectionRevisionAppendInput,
  type EmailRoutingPolicyDraftInput,
  type EmailRoutingPolicyProjection,
  type EmailRoutingPolicyRevisionAppendInput,
  type EmailSenderProfileDraftInput,
  type EmailSenderProfileProjection,
  type EmailSenderProfileRevisionAppendInput
} from '@jooevents/contracts';
import type { OutboundEmailProviderRegistry } from './registry';

type Awaitable<T> = T | Promise<T>;

/**
 * Persistence owns uniqueness, optimistic head checks, and cross-reference checks.
 * Returned projections must never contain configuration payloads or secret locators.
 */
export interface EmailProviderConfigurationStore {
  createConnection(
    input: EmailProviderConnectionDraftInput
  ): Awaitable<EmailProviderConnectionProjection>;
  appendConnectionRevision(
    input: EmailProviderConnectionRevisionAppendInput
  ): Awaitable<EmailProviderConnectionProjection>;
  getConnection(connectionId: string): Awaitable<EmailProviderConnectionProjection | null>;
  listConnections(workspaceId: string): Awaitable<readonly EmailProviderConnectionProjection[]>;
  createSenderProfile(input: EmailSenderProfileDraftInput): Awaitable<EmailSenderProfileProjection>;
  appendSenderProfileRevision(
    input: EmailSenderProfileRevisionAppendInput
  ): Awaitable<EmailSenderProfileProjection>;
  getSenderProfile(senderProfileId: string): Awaitable<EmailSenderProfileProjection | null>;
  createRoutingPolicy(input: EmailRoutingPolicyDraftInput): Awaitable<EmailRoutingPolicyProjection>;
  appendRoutingPolicyRevision(
    input: EmailRoutingPolicyRevisionAppendInput
  ): Awaitable<EmailRoutingPolicyProjection>;
  getRoutingPolicy(routingPolicyId: string): Awaitable<EmailRoutingPolicyProjection | null>;
}

export interface EmailProviderConfigurationService {
  createConnection(input: EmailProviderConnectionDraftInput): Promise<EmailProviderConnectionProjection>;
  appendConnectionRevision(
    input: EmailProviderConnectionRevisionAppendInput
  ): Promise<EmailProviderConnectionProjection>;
  getConnection(connectionId: string): Promise<EmailProviderConnectionProjection | null>;
  listConnections(workspaceId: string): Promise<readonly EmailProviderConnectionProjection[]>;
  createSenderProfile(input: EmailSenderProfileDraftInput): Promise<EmailSenderProfileProjection>;
  appendSenderProfileRevision(
    input: EmailSenderProfileRevisionAppendInput
  ): Promise<EmailSenderProfileProjection>;
  getSenderProfile(senderProfileId: string): Promise<EmailSenderProfileProjection | null>;
  createRoutingPolicy(input: EmailRoutingPolicyDraftInput): Promise<EmailRoutingPolicyProjection>;
  appendRoutingPolicyRevision(
    input: EmailRoutingPolicyRevisionAppendInput
  ): Promise<EmailRoutingPolicyProjection>;
  getRoutingPolicy(routingPolicyId: string): Promise<EmailRoutingPolicyProjection | null>;
}

function assertRegisteredManifest(
  registry: OutboundEmailProviderRegistry,
  input: EmailProviderConnectionDraftInput
): void {
  registry.resolve({
    adapterKey: input.adapterKey,
    adapterVersion: input.adapterVersion,
    manifestKey: input.manifest.manifestKey,
    manifestVersion: input.manifest.manifestVersion,
    manifestDigestSha256: input.manifest.manifestDigestSha256
  });
}

/**
 * Validates the full candidate before it reaches persistence and resolves the exact
 * registered provider tuple. This service only stages immutable candidates; it does
 * not activate a connection, sender, or routing pointer.
 */
export function createEmailProviderConfigurationService(input: Readonly<{
  registry: OutboundEmailProviderRegistry;
  store: EmailProviderConfigurationStore;
}>): EmailProviderConfigurationService {
  return Object.freeze({
    async createConnection(raw: EmailProviderConnectionDraftInput) {
      const draft = emailProviderConnectionDraftInputSchema.parse(raw);
      assertRegisteredManifest(input.registry, draft);
      return emailProviderConnectionProjectionSchema.parse(
        await input.store.createConnection(draft)
      );
    },
    async appendConnectionRevision(raw: EmailProviderConnectionRevisionAppendInput) {
      const draft = emailProviderConnectionRevisionAppendInputSchema.parse(raw);
      assertRegisteredManifest(input.registry, draft);
      return emailProviderConnectionProjectionSchema.parse(
        await input.store.appendConnectionRevision(draft)
      );
    },
    async getConnection(connectionId: string) {
      const id = providerOpaqueIdSchema.parse(connectionId);
      const result = await input.store.getConnection(id);
      return result === null ? null : emailProviderConnectionProjectionSchema.parse(result);
    },
    async listConnections(workspaceId: string) {
      const id = providerOpaqueIdSchema.parse(workspaceId);
      const result = await input.store.listConnections(id);
      return Object.freeze(result.map((connection) =>
        emailProviderConnectionProjectionSchema.parse(connection)));
    },
    async createSenderProfile(raw: EmailSenderProfileDraftInput) {
      const draft = emailSenderProfileDraftInputSchema.parse(raw);
      return emailSenderProfileProjectionSchema.parse(
        await input.store.createSenderProfile(draft)
      );
    },
    async appendSenderProfileRevision(raw: EmailSenderProfileRevisionAppendInput) {
      const draft = emailSenderProfileRevisionAppendInputSchema.parse(raw);
      return emailSenderProfileProjectionSchema.parse(
        await input.store.appendSenderProfileRevision(draft)
      );
    },
    async getSenderProfile(senderProfileId: string) {
      const id = providerOpaqueIdSchema.parse(senderProfileId);
      const result = await input.store.getSenderProfile(id);
      return result === null ? null : emailSenderProfileProjectionSchema.parse(result);
    },
    async createRoutingPolicy(raw: EmailRoutingPolicyDraftInput) {
      const draft = emailRoutingPolicyDraftInputSchema.parse(raw);
      return emailRoutingPolicyProjectionSchema.parse(
        await input.store.createRoutingPolicy(draft)
      );
    },
    async appendRoutingPolicyRevision(raw: EmailRoutingPolicyRevisionAppendInput) {
      const draft = emailRoutingPolicyRevisionAppendInputSchema.parse(raw);
      return emailRoutingPolicyProjectionSchema.parse(
        await input.store.appendRoutingPolicyRevision(draft)
      );
    },
    async getRoutingPolicy(routingPolicyId: string) {
      const id = providerOpaqueIdSchema.parse(routingPolicyId);
      const result = await input.store.getRoutingPolicy(id);
      return result === null ? null : emailRoutingPolicyProjectionSchema.parse(result);
    }
  });
}
