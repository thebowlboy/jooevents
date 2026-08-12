import {
  canonicalJsonText,
  parseInstant,
  type Brand,
  type Instant,
  type IntegrationInboxReceiptId,
  type PayloadRef,
  type SourceConnectionId,
  type SourceConnectionRevisionId,
  type VerifierRevisionId
} from '@jooevents/kernel';
import { definitionRef, type DefinitionRef } from './definitions';
import { ReliabilityTransitionError } from './work-state';

export type InboxConflictId = Brand<string, 'InboxConflictId'>;
export type InboxProcessingPointerId = Brand<string, 'InboxProcessingPointerId'>;
export type InboxAttentionId = Brand<string, 'InboxAttentionId'>;
export type OpaqueKeyedBindingValue = Brand<string, 'OpaqueKeyedBindingValue'>;
export type OpaqueInboxSemanticIdentity = Brand<string, 'OpaqueInboxSemanticIdentity'>;
export type InboxSemanticKey = Brand<string, 'InboxSemanticKey'>;

const APPLICATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseLocalId<Name extends string>(value: unknown, label: string): Brand<string, Name> {
  if (typeof value !== 'string' || !APPLICATION_UUID.test(value)) {
    throw new TypeError(`${label} must be an application UUIDv4 or UUIDv7`);
  }
  return value.toLowerCase() as Brand<string, Name>;
}

export function parseInboxConflictId(value: unknown): InboxConflictId {
  return parseLocalId(value, 'inbox conflict ID');
}

export function parseInboxProcessingPointerId(value: unknown): InboxProcessingPointerId {
  return parseLocalId(value, 'inbox processing pointer ID');
}

export function parseInboxAttentionId(value: unknown): InboxAttentionId {
  return parseLocalId(value, 'inbox attention ID');
}

/**
 * Accepts only a visibly opaque, server-keyed binding envelope. A bare SHA-256 value
 * cannot cross this boundary accidentally.
 */
export function parseOpaqueKeyedBindingValue(value: unknown): OpaqueKeyedBindingValue {
  if (typeof value !== 'string' || !/^kb1_[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new TypeError('content binding must be an opaque kb1_ server-keyed value');
  }
  return value as OpaqueKeyedBindingValue;
}

export function parseOpaqueInboxSemanticIdentity(value: unknown): OpaqueInboxSemanticIdentity {
  if (typeof value !== 'string' || !/^si1_[A-Za-z0-9_-]{24,160}$/.test(value)) {
    throw new TypeError('inbox semantic identity must be an opaque si1_ value');
  }
  return value as OpaqueInboxSemanticIdentity;
}

export interface OpaqueKeyedContentBinding {
  readonly profile: DefinitionRef<'content_binding'>;
  readonly value: OpaqueKeyedBindingValue;
}

export function opaqueKeyedContentBinding(
  profileKey: string,
  profileVersion: number,
  value: string
): OpaqueKeyedContentBinding {
  return Object.freeze({
    profile: definitionRef('content_binding', profileKey, profileVersion),
    value: parseOpaqueKeyedBindingValue(value)
  });
}

export type NonEmptyContentBindings = readonly [
  OpaqueKeyedContentBinding,
  ...OpaqueKeyedContentBinding[]
];

export interface InboxReceipt {
  readonly id: IntegrationInboxReceiptId;
  readonly semanticKey: InboxSemanticKey;
  readonly sourceConnectionId: SourceConnectionId;
  readonly sourceConnectionRevisionId: SourceConnectionRevisionId;
  readonly semanticIdentity: OpaqueInboxSemanticIdentity;
  readonly verifierRevisionId: VerifierRevisionId;
  readonly contentBindings: NonEmptyContentBindings;
  readonly adoptedPayloadRef: PayloadRef;
  readonly receivedAt: Instant;
}

export interface InboxProcessingPointer {
  readonly id: InboxProcessingPointerId;
  readonly receiptId: IntegrationInboxReceiptId;
  readonly createdAt: Instant;
}

export interface InboxConflict {
  readonly id: InboxConflictId;
  readonly receiptId: IntegrationInboxReceiptId;
  readonly sourceConnectionRevisionId: SourceConnectionRevisionId;
  readonly verifierRevisionId: VerifierRevisionId;
  readonly contentBindings: NonEmptyContentBindings;
  readonly quarantinedPayloadRef: PayloadRef;
  readonly observedAt: Instant;
}

export interface InboxAttention {
  readonly id: InboxAttentionId;
  readonly conflictId: InboxConflictId;
  readonly createdAt: Instant;
}

export interface VerifiedInboxState {
  readonly receipts: readonly InboxReceipt[];
  readonly processingPointers: readonly InboxProcessingPointer[];
  readonly conflicts: readonly InboxConflict[];
  readonly attentions: readonly InboxAttention[];
  readonly adoptedPayloadRefs: readonly PayloadRef[];
  readonly quarantinedPayloadRefs: readonly PayloadRef[];
}

export const EMPTY_VERIFIED_INBOX_STATE: VerifiedInboxState = Object.freeze({
  receipts: Object.freeze([]),
  processingPointers: Object.freeze([]),
  conflicts: Object.freeze([]),
  attentions: Object.freeze([]),
  adoptedPayloadRefs: Object.freeze([]),
  quarantinedPayloadRefs: Object.freeze([])
});

export interface VerifiedInboxIntake {
  readonly receiptId: IntegrationInboxReceiptId;
  readonly processingPointerId: InboxProcessingPointerId;
  readonly conflictId: InboxConflictId;
  readonly attentionId: InboxAttentionId;
  readonly sourceConnectionId: SourceConnectionId;
  readonly sourceConnectionRevisionId: SourceConnectionRevisionId;
  readonly semanticIdentity: OpaqueInboxSemanticIdentity;
  readonly verifierRevisionId: VerifierRevisionId;
  /** Primary binding first, followed by the bounded retained-profile aliases. */
  readonly contentBindings: NonEmptyContentBindings;
  readonly preparedPayloadRef: PayloadRef;
  readonly receivedAt: Instant;
}

export interface VerifiedInboxReduction {
  readonly kind: 'new' | 'same' | 'changed';
  readonly state: VerifiedInboxState;
  readonly receipt: InboxReceipt;
  readonly conflict: InboxConflict | null;
  readonly created: {
    readonly receipt: boolean;
    readonly processingPointer: boolean;
    readonly conflict: boolean;
    readonly attention: boolean;
  };
  readonly payloadDisposition: 'adopted' | 'ignored' | 'quarantined';
}

function bindingIdentity(binding: OpaqueKeyedContentBinding): string {
  return canonicalJsonText({
    profile: { key: binding.profile.key, version: binding.profile.version },
    value: binding.value
  });
}

function freezeBindings(bindings: NonEmptyContentBindings): NonEmptyContentBindings {
  if (bindings.length > 8) throw new TypeError('at most eight retained content bindings are accepted');
  const identities = new Set<string>();
  const result = bindings.map((binding) => {
    if (binding.profile.kind !== 'content_binding') {
      throw new TypeError('content binding profile kind must be content_binding');
    }
    parseOpaqueKeyedBindingValue(binding.value);
    const identity = bindingIdentity(binding);
    if (identities.has(identity)) throw new TypeError('content bindings contain a duplicate alias');
    identities.add(identity);
    return Object.freeze({ profile: Object.freeze({ ...binding.profile }), value: binding.value });
  });
  const primary = result[0];
  if (primary === undefined) throw new TypeError('at least one keyed content binding is required');
  return Object.freeze([primary, ...result.slice(1)]) as NonEmptyContentBindings;
}

function bindingsIntersect(
  left: readonly OpaqueKeyedContentBinding[],
  right: readonly OpaqueKeyedContentBinding[]
): boolean {
  const identities = new Set(left.map(bindingIdentity));
  return right.some((binding) => identities.has(bindingIdentity(binding)));
}

function semanticKey(input: VerifiedInboxIntake): InboxSemanticKey {
  return canonicalJsonText({
    semanticIdentity: input.semanticIdentity,
    sourceConnectionId: input.sourceConnectionId
  }) as InboxSemanticKey;
}

function assertUniqueProposedIds(state: VerifiedInboxState, input: VerifiedInboxIntake): void {
  if (state.receipts.some((receipt) => receipt.id === input.receiptId)) {
    throw new ReliabilityTransitionError('duplicate_identity', 'proposed inbox receipt ID already exists');
  }
  if (state.processingPointers.some((pointer) => pointer.id === input.processingPointerId)) {
    throw new ReliabilityTransitionError('duplicate_identity', 'proposed processing pointer ID already exists');
  }
  if (state.conflicts.some((conflict) => conflict.id === input.conflictId)) {
    throw new ReliabilityTransitionError('duplicate_identity', 'proposed inbox conflict ID already exists');
  }
  if (state.attentions.some((attention) => attention.id === input.attentionId)) {
    throw new ReliabilityTransitionError('duplicate_identity', 'proposed inbox attention ID already exists');
  }
  if (
    state.adoptedPayloadRefs.some((payload) => payload.id === input.preparedPayloadRef.id) ||
    state.quarantinedPayloadRefs.some((payload) => payload.id === input.preparedPayloadRef.id)
  ) {
    throw new ReliabilityTransitionError('duplicate_identity', 'prepared payload reference was already consumed');
  }
}

const NOTHING_CREATED = Object.freeze({
  receipt: false,
  processingPointer: false,
  conflict: false,
  attention: false
});

/**
 * Reduces verified intake only. Signature/envelope verification and keyed-binding
 * computation happen before this function; unverified provider bytes are not inputs.
 */
export function reduceVerifiedInbox(
  state: VerifiedInboxState,
  input: VerifiedInboxIntake
): VerifiedInboxReduction {
  const receivedAt = parseInstant(input.receivedAt);
  const bindings = freezeBindings(input.contentBindings);
  const key = semanticKey(input);
  const receipt = state.receipts.find((candidate) => candidate.semanticKey === key);

  if (receipt === undefined) {
    assertUniqueProposedIds(state, input);
    const createdReceipt: InboxReceipt = Object.freeze({
      id: input.receiptId,
      semanticKey: key,
      sourceConnectionId: input.sourceConnectionId,
      sourceConnectionRevisionId: input.sourceConnectionRevisionId,
      semanticIdentity: input.semanticIdentity,
      verifierRevisionId: input.verifierRevisionId,
      contentBindings: bindings,
      adoptedPayloadRef: input.preparedPayloadRef,
      receivedAt
    });
    const pointer: InboxProcessingPointer = Object.freeze({
      id: input.processingPointerId,
      receiptId: createdReceipt.id,
      createdAt: receivedAt
    });
    const nextState: VerifiedInboxState = Object.freeze({
      ...state,
      receipts: Object.freeze([...state.receipts, createdReceipt]),
      processingPointers: Object.freeze([...state.processingPointers, pointer]),
      adoptedPayloadRefs: Object.freeze([...state.adoptedPayloadRefs, input.preparedPayloadRef])
    });
    return Object.freeze({
      kind: 'new',
      state: nextState,
      receipt: createdReceipt,
      conflict: null,
      created: Object.freeze({
        receipt: true,
        processingPointer: true,
        conflict: false,
        attention: false
      }),
      payloadDisposition: 'adopted'
    });
  }

  const canonicalMatch = bindingsIntersect(receipt.contentBindings, bindings);
  const matchingConflicts = state.conflicts.filter(
    (conflict) =>
      conflict.receiptId === receipt.id && bindingsIntersect(conflict.contentBindings, bindings)
  );
  if ((canonicalMatch && matchingConflicts.length > 0) || matchingConflicts.length > 1) {
    throw new ReliabilityTransitionError(
      'binding_collision',
      'retained keyed bindings resolve to more than one inbox outcome'
    );
  }
  if (canonicalMatch) {
    return Object.freeze({
      kind: 'same',
      state,
      receipt,
      conflict: null,
      created: NOTHING_CREATED,
      payloadDisposition: 'ignored'
    });
  }

  const matchingConflict = matchingConflicts[0];
  if (matchingConflict !== undefined) {
    return Object.freeze({
      kind: 'changed',
      state,
      receipt,
      conflict: matchingConflict,
      created: NOTHING_CREATED,
      payloadDisposition: 'ignored'
    });
  }

  assertUniqueProposedIds(state, input);
  const conflict: InboxConflict = Object.freeze({
    id: input.conflictId,
    receiptId: receipt.id,
    sourceConnectionRevisionId: input.sourceConnectionRevisionId,
    verifierRevisionId: input.verifierRevisionId,
    contentBindings: bindings,
    quarantinedPayloadRef: input.preparedPayloadRef,
    observedAt: receivedAt
  });
  const attention: InboxAttention = Object.freeze({
    id: input.attentionId,
    conflictId: conflict.id,
    createdAt: receivedAt
  });
  const nextState: VerifiedInboxState = Object.freeze({
    ...state,
    conflicts: Object.freeze([...state.conflicts, conflict]),
    attentions: Object.freeze([...state.attentions, attention]),
    quarantinedPayloadRefs: Object.freeze([
      ...state.quarantinedPayloadRefs,
      input.preparedPayloadRef
    ])
  });
  return Object.freeze({
    kind: 'changed',
    state: nextState,
    receipt,
    conflict,
    created: Object.freeze({
      receipt: false,
      processingPointer: false,
      conflict: true,
      attention: true
    }),
    payloadDisposition: 'quarantined'
  });
}
