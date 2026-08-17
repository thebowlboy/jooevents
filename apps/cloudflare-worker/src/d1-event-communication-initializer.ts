import {
  adoptSynchronousClassifiedPayload,
  openSynchronousClassifiedPayloadAdoptionReceipt,
  type SynchronousClassifiedPayloadEncryptionProfile
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  EVENT_DECISION_SEED_OWNER_KEY,
  canonicalizeOrganizerAuthoringPayload,
  createDecisionNotificationMergeRegistryRelease,
  createEventCommunicationSeedPlan
} from '@jooevents/communications';
import { canonicalJsonText, parsePayloadRefId } from '@jooevents/kernel';
import {
  communicationAuthoringClassifiedPayloadPurpose,
  createCommunicationAuthoringClassifiedPayloadBinding
} from '@jooevents/persistence/communication-authoring-classified-payload';
import type { Event } from '@jooevents/event';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import { D1BufferedClassifiedPayloadStore } from './d1-classified-payload-store';

/** Buffers the complete deterministic communication roots for a newly created Event. */
export function initializeD1EventCommunicationRoots(input: {
  readonly unitOfWork: D1BufferedUnitOfWork;
  readonly event: Event;
  readonly encryptionProfile: SynchronousClassifiedPayloadEncryptionProfile;
  readonly renderer: {
    readonly reference: { readonly key: string; readonly version: number };
    readonly definitionDigestSha256: string;
  };
}): void {
  const scope = Object.freeze({ workspaceId: input.event.workspaceId, eventId: input.event.id });
  const plan = createEventCommunicationSeedPlan({
    scope,
    mergeRegistry: createDecisionNotificationMergeRegistryRelease().identity,
    renderer: input.renderer
  });
  const classifiedStore = new D1BufferedClassifiedPayloadStore({
    unitOfWork: input.unitOfWork,
    encryptionProfile: input.encryptionProfile
  });

  for (const seed of plan.purposes) {
    const revision = seed.purposeRevision;
    input.unitOfWork.write(`INSERT INTO communication_purposes (
      workspace_id,event_id,purpose_id,purpose_key,lifecycle,current_revision_id
    ) VALUES (?,?,?,?,'active',?)`, [
      scope.workspaceId,
      scope.eventId,
      revision.purposeId,
      revision.purposeKey,
      revision.revisionId
    ]);
    input.unitOfWork.write(`INSERT INTO communication_purpose_revisions (
      workspace_id,event_id,purpose_id,purpose_key,revision_id,revision_number,
      digest_sha256,label,communication_class,policy_digest_sha256,description,
      allowed_audience_sources_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
      scope.workspaceId,
      scope.eventId,
      revision.purposeId,
      revision.purposeKey,
      revision.revisionId,
      revision.revisionNumber,
      revision.digestSha256,
      seed.label,
      seed.communicationClass,
      seed.policyDigestSha256,
      seed.description,
      canonicalJsonText(seed.allowedAudienceSources)
    ]);
  }

  const storePayload = (payloadRefIdValue: string, payload: unknown): void => {
    const canonical = canonicalizeOrganizerAuthoringPayload(payload);
    const payloadRefId = parsePayloadRefId(payloadRefIdValue);
    try {
      const binding = createCommunicationAuthoringClassifiedPayloadBinding({
        scope,
        ownerKey: EVENT_DECISION_SEED_OWNER_KEY,
        kind: canonical.profile.payloadKind
      });
      const purpose = communicationAuthoringClassifiedPayloadPurpose(canonical.profile.payloadKind);
      const receipt = adoptSynchronousClassifiedPayload({
        store: classifiedStore,
        put: {
          payloadRefId,
          binding,
          purpose,
          bytes: canonical.bytes,
          createdAt: input.event.createdAt
        }
      });
      const adopted = openSynchronousClassifiedPayloadAdoptionReceipt({
        receipt,
        expectedStore: classifiedStore,
        expected: { binding, purpose, bytes: canonical.bytes }
      });
      if (adopted.payloadRef.id !== payloadRefId) {
        throw new TypeError('d1_event_communication_payload_adoption_invalid');
      }
      input.unitOfWork.write(`INSERT INTO communication_authoring_payloads (
        payload_ref_id,workspace_id,event_id,owner_key,payload_kind,payload_schema_key,
        payload_schema_version,classification_key,content_type,digest_sha256,byte_size,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
        payloadRefId,
        scope.workspaceId,
        scope.eventId,
        EVENT_DECISION_SEED_OWNER_KEY,
        canonical.profile.payloadKind,
        canonical.profile.schemaKey,
        canonical.profile.schemaVersion,
        canonical.profile.classification,
        canonical.profile.contentType,
        canonical.digestSha256,
        canonical.bytes.byteLength,
        input.event.createdAt
      ]);
    } finally {
      canonical.bytes.fill(0);
    }
  };

  for (const template of plan.templates) {
    storePayload(template.contentPayloadRefId, template.contentPayload);
    storePayload(template.bindingsPayloadRefId, template.bindingsPayload);
    input.unitOfWork.write(`INSERT INTO message_templates (
      workspace_id,event_id,template_id,template_key,template_name,lifecycle,
      purpose_revision_id,current_revision_id
    ) VALUES (?,?,?,?,?,'active',?,?)`, [
      scope.workspaceId,
      scope.eventId,
      template.templateId,
      template.templateKey,
      template.templateName,
      plan.decisionPurpose.purposeRevision.revisionId,
      template.templateRevisionId
    ]);
    input.unitOfWork.write(`INSERT INTO message_template_revisions (
      workspace_id,event_id,template_id,template_revision_id,revision_number,
      digest_sha256,content_payload_ref_id,field_bindings_payload_ref_id,
      renderer_key,renderer_version,renderer_digest_sha256,
      merge_registry_key,merge_registry_version,merge_registry_digest_sha256
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      scope.workspaceId,
      scope.eventId,
      template.templateId,
      template.templateRevisionId,
      template.revisionNumber,
      template.digestSha256,
      template.contentPayloadRefId,
      template.bindingsPayloadRefId,
      template.renderer.reference.key,
      template.renderer.reference.version,
      template.renderer.definitionDigestSha256,
      template.mergeRegistry.reference.key,
      template.mergeRegistry.reference.version,
      template.mergeRegistry.definitionDigestSha256
    ]);
  }

  for (const option of plan.audienceOptions) {
    if (option.audienceDraft.source.kind !== 'registered_query') {
      throw new TypeError('d1_event_communication_audience_seed_invalid');
    }
    const source = option.audienceDraft.source;
    input.unitOfWork.write(`INSERT INTO communication_registered_audience_recipes (
      workspace_id,event_id,recipe_id,recipe_version,recipe_digest_sha256,
      source_definition_key,source_definition_version,source_definition_digest_sha256,
      option_id,option_version,purpose_id,option_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
      scope.workspaceId,
      scope.eventId,
      source.recipeId,
      source.recipeVersion,
      source.recipeDigestSha256,
      source.sourceDefinition.reference.key,
      source.sourceDefinition.reference.version,
      source.sourceDefinition.definitionDigestSha256,
      option.optionId,
      option.optionVersion,
      option.audienceDraft.purposeRevision.purposeId,
      canonicalJsonText(option)
    ]);
  }
}
