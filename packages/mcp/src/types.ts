import type {
  OperationEffect,
  OperationLifecycle,
  OperationRisk,
  SafeOperationAutonomy,
  SafeSchemaManifestRef,
  VersionedDefinitionRef
} from '@jooevents/contracts';
import type { CanonicalJson } from '@jooevents/kernel';

export interface McpRegistryActivation {
  /** Consequential tools remain absent unless composition explicitly opts in. */
  readonly enableCommitTools?: boolean;
}

export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface McpReadIdempotencyMetadata {
  readonly required: false;
}

export interface McpEffectIdempotencyMetadata {
  readonly required: true;
  readonly keySource: VersionedDefinitionRef;
  readonly credentialVerifierProfile: VersionedDefinitionRef;
  readonly requestHashProfile: VersionedDefinitionRef;
}

export type McpIdempotencyMetadata =
  | McpReadIdempotencyMetadata
  | McpEffectIdempotencyMetadata;

export interface McpToolContractMetadata {
  readonly operation: {
    readonly name: string;
    readonly version: number;
  };
  readonly effect: OperationEffect;
  readonly maxRisk: OperationRisk;
  readonly autonomy: SafeOperationAutonomy;
  readonly consequenceTags: readonly string[];
  readonly lifecycle: OperationLifecycle;
  readonly idempotency: McpIdempotencyMetadata;
}

/** JSON-only tool metadata; an SDK adapter may translate these exact refs later. */
export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: SafeSchemaManifestRef;
  readonly outputSchema: SafeSchemaManifestRef;
  readonly annotations: McpToolAnnotations;
  readonly contract: McpToolContractMetadata;
}

export interface WithheldMcpTool {
  readonly name: string;
  readonly operation: {
    readonly name: string;
    readonly version: number;
  };
  readonly reason: 'commit_activation_required';
}

export interface McpToolRegistryBody {
  readonly schemaVersion: 1;
  readonly sourceOperationRegistryDigestSha256: string;
  readonly activation: {
    readonly commitToolsEnabled: boolean;
  };
  readonly tools: readonly McpToolDefinition[];
  readonly withheldTools: readonly WithheldMcpTool[];
}

export interface McpToolRegistry extends McpToolRegistryBody {
  readonly registryDigestSha256: string;
}

export interface McpSchemaParser {
  readonly reference: SafeSchemaManifestRef;
  parse(value: unknown): unknown;
}

export interface McpToolCall {
  readonly toolName: string;
  readonly arguments: unknown;
  readonly idempotencyKey?: string;
}

export interface McpReadInvocationEnvelope {
  readonly surface: 'external_mcp';
  readonly toolName: string;
  readonly operation: {
    readonly name: string;
    readonly version: number;
  };
  readonly effect: 'read';
  readonly inputSchema: SafeSchemaManifestRef;
  readonly resultSchema: SafeSchemaManifestRef;
  readonly businessInput: CanonicalJson;
  readonly idempotency: { readonly required: false };
}

export interface McpEffectInvocationEnvelope {
  readonly surface: 'external_mcp';
  readonly toolName: string;
  readonly operation: {
    readonly name: string;
    readonly version: number;
  };
  readonly effect: 'draft' | 'commit';
  readonly inputSchema: SafeSchemaManifestRef;
  readonly resultSchema: SafeSchemaManifestRef;
  readonly businessInput: CanonicalJson;
  readonly idempotency: {
    readonly required: true;
    readonly key: string;
    readonly keySource: VersionedDefinitionRef;
    readonly credentialVerifierProfile: VersionedDefinitionRef;
    readonly requestHashProfile: VersionedDefinitionRef;
  };
}

export type McpInvocationEnvelope = McpReadInvocationEnvelope | McpEffectInvocationEnvelope;

export interface McpTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface McpToolResultEnvelope {
  readonly isError: boolean;
  readonly content: readonly [McpTextContent];
  readonly structuredContent: { readonly [key: string]: CanonicalJson };
}
