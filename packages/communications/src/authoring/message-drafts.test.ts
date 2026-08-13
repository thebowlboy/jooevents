import { describe, expect, test } from 'bun:test';
import {
  OrganizerMessageDraftError,
  createOrganizerMessageDraft,
  discardOrganizerMessageDraft,
  reviseOrganizerMessageDraft
} from './message-drafts';

const at = '2026-08-13T00:00:00.000Z';
const purpose = {
  purposeId: 'purpose-1', purposeKey: 'event.transactional', revisionId: 'purpose-revision-1',
  revisionNumber: 1, digestSha256: 'a'.repeat(64)
};
const contentPayload = {
  payloadRefId: 'payload-content-1', payloadRefVersion: 1, payloadKind: 'message_content' as const,
  schemaKey: 'je.communication.message-content', schemaVersion: 1,
  classification: 'communication.authoring.message'
};
const audiencePayload = {
  payloadRefId: 'payload-audience-1', payloadRefVersion: 1,
  payloadKind: 'message_audience_draft' as const,
  schemaKey: 'je.communication.audience-draft', schemaVersion: 1,
  classification: 'communication.authoring.audience'
};

function create(initial: unknown) {
  return createOrganizerMessageDraft({
    workspaceId: 'workspace-1', eventId: 'event-1', ownerKey: 'actor-1', draftId: 'draft-1',
    businessInput: { channel: 'email', purposeRevision: purpose, initial },
    provenance: { kind: 'human' }, now: at
  });
}

describe('organizer message draft planners', () => {
  test('creates an explicit uninitialized draft without content placeholders', () => {
    const draft = create({
      kind: 'registered_empty_refs',
      contentRefId: 'je.communication.message-draft.empty-content/v1',
      audienceRefId: 'je.communication.message-draft.empty-audience/v1'
    });
    expect(draft.authoring).toEqual({
      state: 'uninitialized',
      contentRefId: 'je.communication.message-draft.empty-content/v1',
      audienceRefId: 'je.communication.message-draft.empty-audience/v1'
    });
    expect('subject' in draft.authoring).toBe(false);
    expect(draft.version).toBe(1);
  });

  test('revises active draft to exact ready refs with one version advance', () => {
    const initial = create({
      kind: 'registered_empty_refs',
      contentRefId: 'je.communication.message-draft.empty-content/v1',
      audienceRefId: 'je.communication.message-draft.empty-audience/v1'
    });
    const revised = reviseOrganizerMessageDraft({
      current: initial,
      businessInput: { draftId: 'draft-1', expectedVersion: 1, contentPayload, audiencePayload },
      now: '2026-08-13T00:01:00.000Z'
    });
    expect(revised.authoring).toEqual({ state: 'ready', contentPayload, audiencePayload });
    expect(revised.version).toBe(2);
    expect(initial.authoring.state).toBe('uninitialized');
  });

  test('guards versions and terminal states', () => {
    const active = create({ kind: 'adopted_payload_refs', contentPayload, audiencePayload });
    expect(() => reviseOrganizerMessageDraft({
      current: active,
      businessInput: { draftId: 'draft-1', expectedVersion: 2, contentPayload, audiencePayload },
      now: at
    })).toThrow(new OrganizerMessageDraftError('stale_revision'));
    const discarded = discardOrganizerMessageDraft({
      current: active,
      businessInput: { draftId: 'draft-1', expectedVersion: 1, reasonCode: 'organizer.cancelled' },
      now: '2026-08-13T00:01:00.000Z'
    });
    expect(discarded.state).toBe('discarded');
    expect(discarded.version).toBe(2);
    expect(() => discardOrganizerMessageDraft({
      current: discarded,
      businessInput: { draftId: 'draft-1', expectedVersion: 2, reasonCode: 'organizer.cancelled' },
      now: at
    })).toThrow(new OrganizerMessageDraftError('draft_not_active'));
  });
});
