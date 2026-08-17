import { expect, test } from 'bun:test';
import { parseUserId } from '@jooevents/kernel';
import { ApiKeySecretDeliveryVault } from './api-key-secret-delivery';

test('delivers a secret once, only to its owner, and expires abandoned handles', () => {
  let now = 1_000;
  const vault = new ApiKeySecretDeliveryVault(() => now, 1_000);
  const owner = parseUserId('018f0f47-7a86-7d36-8a25-9f86589c7200');
  const stranger = parseUserId('018f0f47-7a86-7d36-8a25-9f86589c7201');
  vault.deposit({ handle: '018f0f47-7a86-7d36-8a25-9f86589c7400', secret: 'secret', ownerUserId: owner });
  expect(vault.consume('018f0f47-7a86-7d36-8a25-9f86589c7400', stranger)).toBeUndefined();
  expect(vault.consume('018f0f47-7a86-7d36-8a25-9f86589c7400', owner)).toBe('secret');
  expect(vault.consume('018f0f47-7a86-7d36-8a25-9f86589c7400', owner)).toBeUndefined();

  vault.deposit({ handle: '018f0f47-7a86-7d36-8a25-9f86589c7401', secret: 'expired', ownerUserId: owner });
  now = 2_000;
  expect(vault.consume('018f0f47-7a86-7d36-8a25-9f86589c7401', owner)).toBeUndefined();
});
