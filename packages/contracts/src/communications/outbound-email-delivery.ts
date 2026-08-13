import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs
} from '../operations';
import {
  providerOpaqueIdSchema,
  providerPositiveVersionSchema,
  providerSha256Schema,
  providerStableKeySchema
} from './provider';

/**
 * Trusted registered-job projection for one reviewed outbound message release.
 * Scope and authority are sealed by the operation context. Address and message
 * bytes are deliberately represented only by governed opaque references.
 */
export const outboundEmailDeliveryWorkInputSchema = z.strictObject({
  contractVersion: z.literal(1),
  deliveryId: providerOpaqueIdSchema,
  releaseId: providerOpaqueIdSchema,
  dispatchGeneration: providerPositiveVersionSchema,
  reviewedMessageDigestSha256: providerSha256Schema,
  reviewedEnvelopeDigestSha256: providerSha256Schema,
  recipientRefId: providerOpaqueIdSchema,
  templateRevisionRefId: providerOpaqueIdSchema,
  contentRefId: providerOpaqueIdSchema,
  providerConnectionRevisionId: providerOpaqueIdSchema,
  externalDeliveryKey: providerOpaqueIdSchema,
  senderProfileRevisionId: providerOpaqueIdSchema,
  senderPresentationContractKey: providerStableKeySchema,
  senderPresentationContractVersion: providerPositiveVersionSchema,
  senderPresentationDigestSha256: providerSha256Schema,
  channelAddressId: providerOpaqueIdSchema,
  channelAddressVersion: providerPositiveVersionSchema,
  addressLookupFingerprintProfile: providerStableKeySchema,
  addressLookupFingerprintVersion: providerPositiveVersionSchema,
  addressLookupFingerprintSha256: providerSha256Schema
});

export const outboundEmailDeliveryWorkAnchorSchema = z.strictObject({
  contractVersion: z.literal(1),
  deliveryId: providerOpaqueIdSchema,
  releaseId: providerOpaqueIdSchema,
  dispatchGeneration: providerPositiveVersionSchema,
  workAnchorState: z.literal('durable'),
  disposition: z.enum(['created', 'already_ready'])
});

export const outboundEmailDeliveryWorkOperationResultSchema =
  createEffectfulOperationResultSchema(outboundEmailDeliveryWorkAnchorSchema);

export const OUTBOUND_EMAIL_DELIVERY_OPERATION_SCHEMA_REFS = Object.freeze({
  dispatch: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.outbound-email-delivery.dispatch.input',
    inputSchema: outboundEmailDeliveryWorkInputSchema,
    resultKey: 'schema.communication.outbound-email-delivery.dispatch.result',
    resultSchema: outboundEmailDeliveryWorkOperationResultSchema
  })
});

export type OutboundEmailDeliveryWorkInput = z.infer<
  typeof outboundEmailDeliveryWorkInputSchema
>;
export type OutboundEmailDeliveryWorkAnchor = z.infer<
  typeof outboundEmailDeliveryWorkAnchorSchema
>;
