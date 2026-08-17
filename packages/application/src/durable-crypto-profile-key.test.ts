import { describe, expect, test } from 'bun:test';
import { deriveDurableCryptoProfileKey } from './durable-crypto-profile-key';

describe('durable crypto profile KDF', () => {
  test('is deterministic and purpose separated', () => {
    const rootKeyBytes = new Uint8Array(32).fill(0x37);
    const workspaceInvitation = deriveDurableCryptoProfileKey({
      rootKeyBytes,
      coordinate: {
        family: 'persistent_hmac',
        purpose: 'persistent-domain-hmac',
        key: 'security.workspace-invitation-lookup',
        version: 1
      }
    });
    expect(Buffer.from(workspaceInvitation).toString('hex')).toBe(
      '3ae8d1e7bfd3e8a35dc12988e9067e830ae00bd3302316ffb4562850264bf99b'
    );
    expect(deriveDurableCryptoProfileKey({
      rootKeyBytes,
      coordinate: {
        family: 'persistent_hmac',
        purpose: 'persistent-domain-hmac',
        key: 'security.workspace-invitation-lookup',
        version: 1
      }
    })).toEqual(workspaceInvitation);
    expect(deriveDurableCryptoProfileKey({
      rootKeyBytes,
      coordinate: {
        family: 'persistent_hmac',
        purpose: 'persistent-domain-hmac',
        key: 'security.communication-address-fingerprint',
        version: 1
      }
    })).not.toEqual(workspaceInvitation);
  });
});
