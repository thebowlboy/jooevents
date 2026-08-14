import {
  organizerCommunicationDefinitionRefSchema,
  organizerCommunicationStableKeySchema,
  organizerEmailMessageContentSchema,
  organizerEmailTemplateContentSchema,
  organizerMessageTemplateFieldBindingSchema,
  organizerMessageTemplateRevisionRefSchema,
  type OrganizerEmailMessageContent
} from '@jooevents/contracts/communications/organizer';
import { canonicalJsonText } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  type OrganizerAudienceCandidate,
  type OrganizerAudienceScope
} from '../audience/resolution';
import {
  type OrganizerPreviewDraft,
  type OrganizerPreviewRenderPort,
  type OrganizerPreviewRenderResult
} from '../audience/preview';
import { OrganizerEmailRenderError, renderOrganizerEmailV1 } from './email-v1';
import {
  createOrganizerMergeRegistryRelease,
  type OrganizerMergeFieldDefinition,
  type OrganizerMergeRegistryRelease,
  type OrganizerResolvedMergeValue
} from './merge-registry';

/** The one transactional purpose this wave notifies under (recorder default BLOCKED-5). */
export const DECISION_NOTIFICATION_PURPOSE_KEY = 'decision_notification' as const;

/**
 * Merge fields served to decision-notification templates. Canonically sorted by
 * field key; all plain text so the deterministic plain-text renderer never
 * consumes a URL or rich value it cannot bound.
 */
export const DECISION_NOTIFICATION_MERGE_FIELDS: readonly OrganizerMergeFieldDefinition[] =
  Object.freeze([
    Object.freeze({ fieldKey: 'decision.status', valueType: 'text' as const }),
    Object.freeze({ fieldKey: 'person.name', valueType: 'text' as const }),
    Object.freeze({ fieldKey: 'submission.title', valueType: 'text' as const })
  ]);

export const DECISION_NOTIFICATION_MERGE_REGISTRY_REFERENCE = Object.freeze({
  key: 'merge-registry.communication.plain-text',
  version: 1
});

/** The exact release the runtime must mount at its merge-registry seam. */
export function createDecisionNotificationMergeRegistryRelease(): OrganizerMergeRegistryRelease {
  return createOrganizerMergeRegistryRelease({
    reference: DECISION_NOTIFICATION_MERGE_REGISTRY_REFERENCE,
    fields: DECISION_NOTIFICATION_MERGE_FIELDS
  });
}

export interface OrganizerRenderTemplateBinding {
  readonly revision: ReturnType<typeof organizerMessageTemplateRevisionRefSchema.parse>;
  readonly content: ReturnType<typeof organizerEmailTemplateContentSchema.parse>;
  readonly fieldBindings: readonly ReturnType<typeof organizerMessageTemplateFieldBindingSchema.parse>[];
}

export interface OrganizerRenderContentBinding {
  readonly messageContent: OrganizerEmailMessageContent;
  readonly template?: OrganizerRenderTemplateBinding;
}

/** Resolves the reviewed draft content this render strategy must reproduce byte-exactly. */
export interface OrganizerRenderContentSource {
  readContent(input: {
    readonly scope: OrganizerAudienceScope;
    readonly draft: OrganizerPreviewDraft;
  }): OrganizerRenderContentBinding | undefined;
}

/** Resolves per-recipient merge values by reference only; email is never an input key. */
export interface OrganizerMergeValueSource {
  resolveMergeValues(input: {
    readonly scope: OrganizerAudienceScope;
    readonly candidate: OrganizerAudienceCandidate;
    readonly fieldKeys: readonly string[];
  }): readonly OrganizerResolvedMergeValue[];
}

function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJsonText(value))));
}

function blocked(reasonCode: string): OrganizerPreviewRenderResult {
  return Object.freeze({
    kind: 'blocked' as const,
    reasonCode: organizerCommunicationStableKeySchema.parse(reasonCode),
    mergeFallbackFieldKeys: Object.freeze([] as string[])
  });
}

function requestedFieldKeys(binding: OrganizerRenderContentBinding): readonly string[] {
  if (binding.template === undefined) return Object.freeze([]);
  const keys = new Set<string>();
  const inline = (nodes: readonly { readonly kind: string; readonly fieldKey?: string }[]) => {
    for (const node of nodes) {
      if (node.kind === 'merge_field' && node.fieldKey !== undefined) keys.add(node.fieldKey);
    }
  };
  const content = binding.template.content;
  inline(content.subject);
  if (content.explicitPlainText !== undefined) inline(content.explicitPlainText);
  if (content.body.mode === 'composed') {
    for (const block of content.body.blocks) {
      switch (block.kind) {
        case 'paragraph':
        case 'heading': inline(block.content); break;
        case 'list': for (const item of block.items) inline(item); break;
        case 'action_link': inline(block.label); keys.add(block.hrefFieldKey); break;
        case 'detail_rows':
          for (const row of block.rows) { inline(row.label); inline(row.value); }
          break;
      }
    }
  }
  return Object.freeze([...keys].sort());
}

/**
 * Deterministic plain-text render strategy for decision notifications: it
 * re-reads the reviewed draft content and renders through the canonical
 * `renderOrganizerEmailV1` path with per-recipient merge values resolved by
 * reference. It performs no I/O beyond the two injected read ports and emits a
 * typed blocked row — never a partial render — when content or a required
 * merge value is unavailable.
 */
export function createOrganizerPlainTextRenderStrategyPort(input: {
  readonly mergeRegistry: OrganizerMergeRegistryRelease;
  readonly content: OrganizerRenderContentSource;
  readonly values: OrganizerMergeValueSource;
}): OrganizerPreviewRenderPort {
  const registryIdentity = organizerCommunicationDefinitionRefSchema.parse(
    input.mergeRegistry.identity
  );
  return Object.freeze({
    render({ scope, draft, member, recipientResolutionId, releaseId, renderer, mergeRegistry }:
      Parameters<OrganizerPreviewRenderPort['render']>[0]) {
      if (canonicalJsonText(mergeRegistry) !== canonicalJsonText(registryIdentity)) {
        return blocked('render.merge_registry_mismatch');
      }
      const binding = input.content.readContent({ scope, draft });
      if (binding === undefined) return blocked('render.content_unavailable');
      let messageContent: OrganizerEmailMessageContent;
      try {
        messageContent = organizerEmailMessageContentSchema.parse(binding.messageContent);
      } catch {
        return blocked('render.content_invalid');
      }
      const fieldKeys = requestedFieldKeys(binding);
      let resolvedValues: readonly OrganizerResolvedMergeValue[];
      try {
        resolvedValues = input.values.resolveMergeValues({
          scope,
          candidate: member.candidate,
          fieldKeys
        });
      } catch {
        return blocked('render.merge_value_source_failed');
      }
      const releaseDigestSha256 = digest({
        schemaVersion: 1,
        namespace: 'communication.decision-notification.release',
        recipientResolutionId,
        releaseId,
        subjectRefId: member.candidate.subjectRefId,
        subjectVersion: member.candidate.subjectVersion,
        personRefId: member.candidate.personRefId,
        contactRefId: member.candidate.contactRefId,
        addressRefId: member.address.addressRefId,
        addressVersion: member.address.addressVersion,
        messageContent,
        template: binding.template === undefined
          ? null
          : { revision: binding.template.revision },
        renderer,
        mergeRegistry: registryIdentity,
        resolvedValues
      });
      try {
        const render = renderOrganizerEmailV1({
          recipientResolutionId,
          releaseId,
          releaseDigestSha256,
          renderer,
          mergeRegistry: input.mergeRegistry,
          messageContent,
          ...(binding.template === undefined ? {} : { template: binding.template }),
          resolvedValues
        });
        return Object.freeze({
          kind: 'rendered' as const,
          render,
          mergeFallbackFieldKeys: Object.freeze([] as string[])
        });
      } catch (error) {
        if (error instanceof OrganizerEmailRenderError) {
          return blocked(
            error.code === 'merge_resolution_failed'
              ? `render.merge_${error.mergeCode ?? 'resolution_failed'}`
              : `render.${error.code}`
          );
        }
        throw error;
      }
    }
  });
}
