import { describe, expect, test } from 'bun:test';
import { parseAirtableUserId } from '@jooevents/airtable';
import { createDefaultManagedBaseManifest, previewManagedProvisioning } from './index';

describe('managed provisioning capability preview', () => {
  test('shows missing provider access and personal-data consequences without widening authority', () => {
    const manifest = createDefaultManagedBaseManifest({
      scope: 'all_events',
      includeSpeakerEmail: true,
      includeSpeakerPhone: false
    });
    const preview = previewManagedProvisioning({
      identity: {
        userId: parseAirtableUserId('usr00000000000001'),
        email: 'owner@example.test',
        scopes: ['schema.bases:read', 'data.records:read']
      },
      manifest
    });
    expect(preview.ready).toBe(false);
    expect(preview.missingScopes).toEqual([
      'schema.bases:write', 'data.records:write', 'user.email:read'
    ]);
    expect(preview.includesPersonalContact).toEqual(['speaker_email']);
    expect(preview.inboundEffectiveFieldCount).toBe(1);
    expect(preview.requestFieldCount).toBe(2);
  });
});
