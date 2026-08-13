import { describe, expect, test } from 'bun:test';
import {
  OUTBOUND_EMAIL_DELIVERY_OPERATION_SCHEMA_REFS,
  outboundEmailDeliveryWorkInputSchema,
  type OutboundEmailDeliveryWorkInput
} from './outbound-email-delivery';

const digest = (value: string) => value.repeat(64);

function validInput(): OutboundEmailDeliveryWorkInput {
  return {
    contractVersion: 1,
    deliveryId: 'delivery-1',
    releaseId: 'release-1',
    dispatchGeneration: 1,
    reviewedMessageDigestSha256: digest('1'),
    reviewedEnvelopeDigestSha256: digest('2'),
    recipientRefId: 'recipient-ref-1',
    templateRevisionRefId: 'template-ref-1',
    contentRefId: 'content-ref-1',
    providerConnectionRevisionId: 'connection-ref-1',
    externalDeliveryKey: 'external-delivery-1',
    senderProfileRevisionId: 'sender-ref-1',
    senderPresentationContractKey: 'sender.presentation',
    senderPresentationContractVersion: 1,
    senderPresentationDigestSha256: digest('3'),
    channelAddressId: 'channel-address-1',
    channelAddressVersion: 1,
    addressLookupFingerprintProfile: 'address.fingerprint',
    addressLookupFingerprintVersion: 1,
    addressLookupFingerprintSha256: digest('4')
  };
}

describe('outbound email delivery operation contract', () => {
  test('accepts only opaque governed references and reviewed digests', () => {
    expect(outboundEmailDeliveryWorkInputSchema.parse(validInput())).toEqual(validInput());
    expect(() => outboundEmailDeliveryWorkInputSchema.parse({
      ...validInput(),
      recipientAddress: 'person@example.test'
    })).toThrow();
    expect(() => outboundEmailDeliveryWorkInputSchema.parse({
      ...validInput(),
      content: '<p>not allowed</p>'
    })).toThrow();
  });

  test('publishes stable input and terminal-result schema identities', () => {
    expect(OUTBOUND_EMAIL_DELIVERY_OPERATION_SCHEMA_REFS.dispatch.inputSchema.key)
      .toBe('schema.communication.outbound-email-delivery.dispatch.input');
    expect(OUTBOUND_EMAIL_DELIVERY_OPERATION_SCHEMA_REFS.dispatch.resultSchema.key)
      .toBe('schema.communication.outbound-email-delivery.dispatch.result');
    expect(OUTBOUND_EMAIL_DELIVERY_OPERATION_SCHEMA_REFS.dispatch.inputSchema.digestSha256)
      .toMatch(/^[a-f0-9]{64}$/);
  });
});
