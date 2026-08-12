import { describe, expect, test } from 'bun:test';
import {
  createPayloadRef,
  parseIntegrationInboxReceiptId,
  parseInstant,
  parsePayloadRefId,
  parseSourceConnectionId,
  parseSourceConnectionRevisionId,
  parseVerifierRevisionId
} from '@jooevents/kernel';
import {
  EMPTY_VERIFIED_INBOX_STATE,
  opaqueKeyedContentBinding,
  parseInboxAttentionId,
  parseInboxConflictId,
  parseInboxProcessingPointerId,
  parseOpaqueInboxSemanticIdentity,
  parseOpaqueKeyedBindingValue,
  reduceVerifiedInbox,
  type NonEmptyContentBindings,
  type VerifiedInboxIntake
} from './inbox';

const BINDING_A = `kb1_${'A'.repeat(43)}`;
const BINDING_B = `kb1_${'B'.repeat(43)}`;
const BINDING_C = `kb1_${'C'.repeat(43)}`;
const BINDING_D = `kb1_${'D'.repeat(43)}`;

const content = (
  profileVersion: number,
  value: string
) => opaqueKeyedContentBinding('webhook.content', profileVersion, value);

function intake(
  idStem: string,
  payloadSuffix: string,
  bindings: NonEmptyContentBindings,
  receivedAt: string
): VerifiedInboxIntake {
  return {
    receiptId: parseIntegrationInboxReceiptId(`00000000-0000-4000-8000-${idStem}01`),
    processingPointerId: parseInboxProcessingPointerId(`00000000-0000-4000-8000-${idStem}02`),
    conflictId: parseInboxConflictId(`00000000-0000-4000-8000-${idStem}03`),
    attentionId: parseInboxAttentionId(`00000000-0000-4000-8000-${idStem}04`),
    sourceConnectionId: parseSourceConnectionId('00000000-0000-4000-8000-000000000101'),
    sourceConnectionRevisionId: parseSourceConnectionRevisionId(
      `00000000-0000-4000-8000-${idStem}05`
    ),
    semanticIdentity: parseOpaqueInboxSemanticIdentity(`si1_${'S'.repeat(32)}`),
    verifierRevisionId: parseVerifierRevisionId(`00000000-0000-4000-8000-${idStem}06`),
    contentBindings: bindings,
    preparedPayloadRef: createPayloadRef(
      parsePayloadRefId(`00000000-0000-4000-8000-${payloadSuffix}`)
    ),
    receivedAt: parseInstant(receivedAt)
  };
}

describe('verified inbox reduction', () => {
  test('adopts a new payload and creates exactly one normal processing pointer', () => {
    const result = reduceVerifiedInbox(
      EMPTY_VERIFIED_INBOX_STATE,
      intake('0000000002', '000000000201', [content(1, BINDING_A)], '2026-08-11T00:00:00Z')
    );

    expect(result.kind).toBe('new');
    expect(result.payloadDisposition).toBe('adopted');
    expect(result.created).toEqual({
      receipt: true,
      processingPointer: true,
      conflict: false,
      attention: false
    });
    expect(result.state.receipts).toHaveLength(1);
    expect(result.state.processingPointers).toHaveLength(1);
    expect(result.state.adoptedPayloadRefs).toHaveLength(1);
    expect(result.state.conflicts).toHaveLength(0);
  });

  test('treats a retained-profile content match as a no-write safe replay', () => {
    const first = reduceVerifiedInbox(
      EMPTY_VERIFIED_INBOX_STATE,
      intake('0000000002', '000000000201', [content(1, BINDING_A)], '2026-08-11T00:00:00Z')
    );
    const replay = reduceVerifiedInbox(
      first.state,
      intake(
        '0000000003',
        '000000000301',
        [content(2, BINDING_B), content(1, BINDING_A)],
        '2026-08-11T00:00:01Z'
      )
    );

    expect(replay.kind).toBe('same');
    expect(replay.payloadDisposition).toBe('ignored');
    expect(replay.state).toBe(first.state);
    expect(replay.created).toEqual({
      receipt: false,
      processingPointer: false,
      conflict: false,
      attention: false
    });
    expect(replay.state.processingPointers).toHaveLength(1);
    expect(replay.state.adoptedPayloadRefs).toHaveLength(1);
  });

  test('quarantines changed content once and replays the prior conflict through aliases', () => {
    const first = reduceVerifiedInbox(
      EMPTY_VERIFIED_INBOX_STATE,
      intake('0000000002', '000000000201', [content(1, BINDING_A)], '2026-08-11T00:00:00Z')
    );
    const changed = reduceVerifiedInbox(
      first.state,
      intake('0000000004', '000000000401', [content(2, BINDING_C)], '2026-08-11T00:00:02Z')
    );
    expect(changed.kind).toBe('changed');
    expect(changed.payloadDisposition).toBe('quarantined');
    expect(changed.created.conflict).toBe(true);
    expect(changed.created.attention).toBe(true);
    expect(changed.created.processingPointer).toBe(false);
    expect(changed.state.conflicts).toHaveLength(1);
    expect(changed.state.attentions).toHaveLength(1);
    expect(changed.state.processingPointers).toHaveLength(1);
    expect(changed.state.quarantinedPayloadRefs).toHaveLength(1);

    const changedReplay = reduceVerifiedInbox(
      changed.state,
      intake(
        '0000000005',
        '000000000501',
        [content(3, BINDING_D), content(2, BINDING_C)],
        '2026-08-11T00:00:03Z'
      )
    );
    expect(changedReplay.kind).toBe('changed');
    expect(changedReplay.payloadDisposition).toBe('ignored');
    expect(changedReplay.state).toBe(changed.state);
    expect(changedReplay.created.conflict).toBe(false);
    expect(changedReplay.state.conflicts).toHaveLength(1);
    expect(changedReplay.state.attentions).toHaveLength(1);
    expect(changedReplay.state.quarantinedPayloadRefs).toHaveLength(1);
  });

  test('rejects bare hashes and detects an alias set that resolves to two outcomes', () => {
    expect(() => parseOpaqueKeyedBindingValue('a'.repeat(64))).toThrow(/opaque kb1_/);

    const first = reduceVerifiedInbox(
      EMPTY_VERIFIED_INBOX_STATE,
      intake('0000000002', '000000000201', [content(1, BINDING_A)], '2026-08-11T00:00:00Z')
    );
    const changed = reduceVerifiedInbox(
      first.state,
      intake('0000000004', '000000000401', [content(2, BINDING_C)], '2026-08-11T00:00:02Z')
    );
    expect(() =>
      reduceVerifiedInbox(
        changed.state,
        intake(
          '0000000006',
          '000000000601',
          [content(1, BINDING_A), content(2, BINDING_C)],
          '2026-08-11T00:00:04Z'
        )
      )
    ).toThrow(/more than one inbox outcome/);
    expect(JSON.stringify(changed.state)).not.toContain('contentDigest');
  });
});
