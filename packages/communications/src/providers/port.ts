import { canonicalJsonText } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  emailDiagnosticLookupInputSchema,
  providerCapabilitiesSchema,
  providerLookupInputSchema,
  providerOpaqueIdSchema,
  providerSha256Schema,
  providerStableKeySchema,
  type CallbackCorrelationMode,
  type EmailDiagnosticLookupInput,
  type EmailDiagnosticLookupOutcome,
  type EmailDiagnosticSubmissionOutcome,
  type EmailSetupManifest,
  type ProviderCapabilities,
  type ProviderLookupInput,
  type ProviderLookupOutcome,
  type ProviderOutcomeV1,
  type ProviderReadinessAdapterObservation,
  type ProviderReadinessInput,
  type ProviderSubmissionOutcome,
  type SafeEvidence,
  type VerifiedProviderCallback
} from '@jooevents/contracts';
import { ProviderContractError } from './outcomes';

const preparedEmailSubmissionBrand: unique symbol = Symbol('preparedEmailSubmission');
const preparedEmailDiagnosticBrand: unique symbol = Symbol('preparedEmailDiagnostic');

const EMAIL_ADDRESS_MAXIMUM_LENGTH = 320;
const EMAIL_SUBJECT_MAXIMUM_LENGTH = 998;
const EMAIL_BODY_MAXIMUM_LENGTH = 26_214_400;

export type EmailAddress = string & { readonly __emailAddress: unique symbol };

export function parseEmailAddress(value: unknown): EmailAddress {
  if (
    typeof value !== 'string'
    || value.length < 3
    || value.length > EMAIL_ADDRESS_MAXIMUM_LENGTH
    || /[\u0000-\u001f\u007f\s]/u.test(value)
  ) {
    throw new TypeError('email address has an invalid bounded shape');
  }
  const separator = value.lastIndexOf('@');
  if (separator < 1 || separator === value.length - 1 || value.indexOf('@') !== separator) {
    throw new TypeError('email address must contain one non-edge @ separator');
  }
  return value as EmailAddress;
}

export type EmailHeader = Readonly<{ name: string; value: string }>;

export type ImmutableEmailEnvelope = Readonly<{
  contractVersion: 1;
  from: Readonly<{ address: EmailAddress; displayName?: string }>;
  to: Readonly<{ address: EmailAddress }>;
  replyTo?: Readonly<{ address: EmailAddress; displayName?: string }>;
  subject: string;
  textBody: string;
  htmlBody?: string;
  headers: readonly EmailHeader[];
}>;

export type ImmutableEmailSubmission = Readonly<{
  contractVersion: 1;
  deliveryAttemptId: string;
  providerConnectionRevisionId: string;
  externalDeliveryKey: string;
  senderProfileRevisionId: string;
  senderPresentationContractKey: string;
  senderPresentationContractVersion: number;
  senderPresentationDigestSha256: string;
  channelAddressId: string;
  channelAddressVersion: number;
  addressLookupFingerprintProfile: string;
  addressLookupFingerprintVersion: number;
  addressLookupFingerprintSha256: string;
  reviewedEnvelopeDigestSha256: string;
  envelope: ImmutableEmailEnvelope;
}>;

export type ImmutableEmailDiagnosticSubmission = Readonly<{
  contractVersion: 1;
  diagnosticAttemptId: string;
  providerConnectionRevisionId: string;
  externalDiagnosticKey: string;
  fixtureKey: string;
  fixtureVersion: number;
  senderProfileRevisionId?: string;
  senderPresentationContractKey?: string;
  senderPresentationContractVersion?: number;
  senderPresentationDigestSha256?: string;
  recipientFingerprintProfile: string;
  recipientFingerprintVersion: number;
  recipientFingerprintSha256: string;
  reviewedEnvelopeDigestSha256: string;
  validUntil: number;
  maximumCostMinorUnits: number;
  currency: string;
  envelope: ImmutableEmailEnvelope;
}>;

export type PreparedEmailSubmission<OpaquePrepared = unknown> = Readonly<{
  adapterKey: string;
  adapterVersion: string;
  providerRequestDigestSha256: string;
  reviewedEnvelopeDigestSha256: string;
  opaque: OpaquePrepared;
  [preparedEmailSubmissionBrand]: true;
}>;

export type PreparedEmailDiagnosticSubmission<OpaquePrepared = unknown> = Readonly<{
  adapterKey: string;
  adapterVersion: string;
  fixtureKey: string;
  fixtureVersion: number;
  providerRequestDigestSha256: string;
  reviewedEnvelopeDigestSha256: string;
  opaque: OpaquePrepared;
  [preparedEmailDiagnosticBrand]: true;
}>;

export interface EmailDeliveryAdapter<OpaquePrepared = unknown> {
  readonly adapterKey: string;
  readonly adapterVersion: string;
  readonly capabilities: ProviderCapabilities;
  prepare(input: ImmutableEmailSubmission): PreparedEmailSubmission<OpaquePrepared>;
  submit(prepared: PreparedEmailSubmission<OpaquePrepared>): Promise<ProviderSubmissionOutcome>;
  lookup?(input: ProviderLookupInput): Promise<ProviderLookupOutcome>;
}

export interface EmailDiagnosticsAdapter<OpaquePrepared = unknown> {
  readonly adapterKey: string;
  readonly adapterVersion: string;
  readonly capabilities: Pick<ProviderCapabilities, 'idempotency' | 'reconciliation' | 'callbacks'>;
  prepare(
    input: ImmutableEmailDiagnosticSubmission
  ): PreparedEmailDiagnosticSubmission<OpaquePrepared>;
  submit(
    prepared: PreparedEmailDiagnosticSubmission<OpaquePrepared>
  ): Promise<EmailDiagnosticSubmissionOutcome>;
  lookup?(input: EmailDiagnosticLookupInput): Promise<EmailDiagnosticLookupOutcome>;
}

export interface EmailSetupAdapter {
  readonly adapterKey: string;
  readonly adapterVersion: string;
  readonly manifest: EmailSetupManifest;
  checkReadiness(input: ProviderReadinessInput): Promise<ProviderReadinessAdapterObservation>;
}

export type RawProviderCallback = Readonly<{
  contractVersion: 1;
  providerConnectionId: string;
  ingressCorrelationId: string;
  payloadDigestSha256: string;
  payloadByteLength: number;
  rawPayloadBytes: Uint8Array;
  signatureEnvelopeBytes: Uint8Array;
}>;

export type CallbackVerifierCandidate<OpaqueVerifierContext = unknown> = Readonly<{
  connectionId: string;
  callbackVerifierRevisionId: string;
  verifierKey: string;
  verifierVersion: string;
  verificationContractVersion: number;
  keyIdMode: 'required' | 'optional' | 'absent';
  configDigestSha256: string;
  opaqueContext: OpaqueVerifierContext;
}> & (
  | { pointerRole: 'current'; eligibilityCeiling?: number }
  | { pointerRole: 'unexpired_previous'; eligibilityCeiling: number }
);

export type CallbackVerifierCandidateSet<OpaqueVerifierContext = unknown> = Readonly<{
  contractVersion: 1;
  connectionId: string;
  verifierPointerVersion: number;
  resolvedAtDatabaseTime: number;
  connectionLifecycleVerificationUntil?: number;
}> & (
  | {
      pointerState: 'active';
      current: CallbackVerifierCandidate<OpaqueVerifierContext> & { pointerRole: 'current' };
      previous?: CallbackVerifierCandidate<OpaqueVerifierContext> & {
        pointerRole: 'unexpired_previous';
      };
    }
  | {
      pointerState: 'draining_disabled';
      currentVerificationUntil: number;
      current?: CallbackVerifierCandidate<OpaqueVerifierContext> & { pointerRole: 'current' };
      previous?: CallbackVerifierCandidate<OpaqueVerifierContext> & {
        pointerRole: 'unexpired_previous';
      };
    }
  | {
      pointerState: 'disabled';
      current?: never;
      previous?: never;
    }
);

export type CallbackVerificationResolution = ProviderOutcomeV1<
  | {
      kind: 'exactly_one';
      callbackVerifierRevisionId: string;
      verifierKey: string;
      verifierVersion: string;
      verificationContractVersion: number;
      verifierConfigDigestSha256: string;
      verified: VerifiedProviderCallback;
      evidence: SafeEvidence;
    }
  | { kind: 'none'; correlationId: string; evidence: SafeEvidence }
  | { kind: 'ambiguous'; correlationId: string; evidence: SafeEvidence }
>;

export interface EmailCallbackVerifier<OpaqueVerifierContext = unknown> {
  readonly verifierKey: string;
  readonly verifierVersion: string;
  readonly verificationContractVersion: number;
  verifyCandidate(
    input: RawProviderCallback,
    candidate: CallbackVerifierCandidate<OpaqueVerifierContext>
  ): Promise<ProviderOutcomeV1<
    | { kind: 'verified'; verified: VerifiedProviderCallback; evidence: SafeEvidence }
    | { kind: 'not_verified'; evidence: SafeEvidence }
  >>;
}

export interface EmailCallbackVerifierRegistry<OpaqueVerifierContext = unknown> {
  resolve(
    input: RawProviderCallback,
    candidates: CallbackVerifierCandidateSet<OpaqueVerifierContext>
  ): Promise<CallbackVerificationResolution>;
}

type AuthenticatedPreparedRecord<Input, Opaque> = Readonly<{
  input: Input;
  opaque: Opaque;
  providerRequestDigestSha256: string;
}>;

export type EmailSubmissionPreparer<Opaque> = Readonly<{
  prepare(
    input: ImmutableEmailSubmission,
    buildOpaque: (immutableInput: ImmutableEmailSubmission) => Opaque
  ): PreparedEmailSubmission<Opaque>;
  open(prepared: PreparedEmailSubmission<Opaque>): Readonly<{
    input: ImmutableEmailSubmission;
    opaque: Opaque;
  }>;
}>;

export type EmailDiagnosticSubmissionPreparer<Opaque> = Readonly<{
  prepare(
    input: ImmutableEmailDiagnosticSubmission,
    buildOpaque: (immutableInput: ImmutableEmailDiagnosticSubmission) => Opaque
  ): PreparedEmailDiagnosticSubmission<Opaque>;
  open(prepared: PreparedEmailDiagnosticSubmission<Opaque>): Readonly<{
    input: ImmutableEmailDiagnosticSubmission;
    opaque: Opaque;
  }>;
}>;

function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJsonText(value))));
}

/** Digest profile used to bind an adapter input to the exact reviewed envelope. */
export function computeReviewedEmailEnvelopeDigestSha256(
  envelope: ImmutableEmailEnvelope
): string {
  validateEnvelope(envelope);
  return digest(envelope);
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function canonicalClone<Value>(value: Value): Value {
  return JSON.parse(canonicalJsonText(value)) as Value;
}

function assertHeader(header: EmailHeader, previousName: string | undefined): void {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(header.name)) {
    throw new TypeError('email header name has an invalid bounded shape');
  }
  const canonicalName = header.name.toLowerCase();
  if (previousName !== undefined && previousName >= canonicalName) {
    throw new TypeError('email headers must use unique canonical name order');
  }
  if (/^(?:bcc|cc|content-.*|date|from|message-id|reply-to|sender|subject|to)$/i.test(header.name)) {
    throw new TypeError('email headers cannot override adapter-owned envelope fields');
  }
  if (header.value.length > 16_384 || /[\r\n\u0000]/u.test(header.value)) {
    throw new TypeError('email header value has an invalid bounded shape');
  }
}

function validateEnvelope(envelope: ImmutableEmailEnvelope): void {
  if (envelope.contractVersion !== 1) throw new TypeError('email envelope version is unsupported');
  parseEmailAddress(envelope.from.address);
  parseEmailAddress(envelope.to.address);
  if (envelope.replyTo !== undefined) parseEmailAddress(envelope.replyTo.address);
  for (const name of [envelope.from.displayName, envelope.replyTo?.displayName]) {
    if (name !== undefined && (name.length === 0 || name.length > 200 || /[\r\n\u0000]/u.test(name))) {
      throw new TypeError('email display name has an invalid bounded shape');
    }
  }
  if (
    envelope.subject.length === 0
    || envelope.subject.length > EMAIL_SUBJECT_MAXIMUM_LENGTH
    || /[\r\n\u0000]/u.test(envelope.subject)
  ) {
    throw new TypeError('email subject has an invalid bounded shape');
  }
  if (
    new TextEncoder().encode(envelope.textBody).byteLength > EMAIL_BODY_MAXIMUM_LENGTH
    || envelope.textBody.includes('\u0000')
  ) {
    throw new TypeError('email text body exceeds the bounded contract');
  }
  if (
    envelope.htmlBody !== undefined
    && (
      new TextEncoder().encode(envelope.htmlBody).byteLength > EMAIL_BODY_MAXIMUM_LENGTH
      || envelope.htmlBody.includes('\u0000')
    )
  ) {
    throw new TypeError('email HTML body exceeds the bounded contract');
  }
  if (envelope.headers.length > 128) throw new TypeError('email envelope has too many headers');
  let previousName: string | undefined;
  let totalHeaderBytes = 0;
  for (const header of envelope.headers) {
    assertHeader(header, previousName);
    previousName = header.name.toLowerCase();
    totalHeaderBytes += new TextEncoder().encode(`${header.name}:${header.value}\r\n`).byteLength;
  }
  if (totalHeaderBytes > 16_384) throw new TypeError('email headers exceed the bounded contract');
}

function validateSenderTuple(input: {
  readonly senderProfileRevisionId?: string;
  readonly senderPresentationContractKey?: string;
  readonly senderPresentationContractVersion?: number;
  readonly senderPresentationDigestSha256?: string;
}, required: boolean): void {
  const tuple = [
    input.senderProfileRevisionId,
    input.senderPresentationContractKey,
    input.senderPresentationContractVersion,
    input.senderPresentationDigestSha256
  ];
  const supplied = tuple.filter((value) => value !== undefined).length;
  if ((required && supplied !== tuple.length) || (!required && supplied !== 0 && supplied !== tuple.length)) {
    throw new TypeError('sender presentation tuple must be all present or all absent');
  }
  if (supplied === 0) return;
  providerOpaqueIdSchema.parse(input.senderProfileRevisionId);
  providerStableKeySchema.parse(input.senderPresentationContractKey);
  if (
    !Number.isSafeInteger(input.senderPresentationContractVersion)
    || (input.senderPresentationContractVersion ?? 0) <= 0
  ) {
    throw new TypeError('sender presentation contract version must be positive');
  }
  providerSha256Schema.parse(input.senderPresentationDigestSha256);
}

function snapshotOrdinary(input: ImmutableEmailSubmission): ImmutableEmailSubmission {
  if (input.contractVersion !== 1) throw new TypeError('email submission version is unsupported');
  for (const value of [
    input.deliveryAttemptId,
    input.providerConnectionRevisionId,
    input.externalDeliveryKey,
    input.channelAddressId
  ]) providerOpaqueIdSchema.parse(value);
  validateSenderTuple(input, true);
  if (!Number.isSafeInteger(input.channelAddressVersion) || input.channelAddressVersion <= 0) {
    throw new TypeError('channel-address version must be positive');
  }
  providerStableKeySchema.parse(input.addressLookupFingerprintProfile);
  if (
    !Number.isSafeInteger(input.addressLookupFingerprintVersion)
    || input.addressLookupFingerprintVersion <= 0
  ) throw new TypeError('address fingerprint version must be positive');
  providerSha256Schema.parse(input.addressLookupFingerprintSha256);
  providerSha256Schema.parse(input.reviewedEnvelopeDigestSha256);
  validateEnvelope(input.envelope);
  const snapshot = deepFreeze(canonicalClone(input));
  if (digest(snapshot.envelope) !== snapshot.reviewedEnvelopeDigestSha256) {
    throw new TypeError('reviewed email envelope digest does not match immutable bytes');
  }
  return snapshot;
}

function snapshotDiagnostic(
  input: ImmutableEmailDiagnosticSubmission
): ImmutableEmailDiagnosticSubmission {
  if (input.contractVersion !== 1) throw new TypeError('diagnostic submission version is unsupported');
  for (const value of [
    input.diagnosticAttemptId,
    input.providerConnectionRevisionId,
    input.externalDiagnosticKey
  ]) providerOpaqueIdSchema.parse(value);
  providerStableKeySchema.parse(input.fixtureKey);
  if (!Number.isSafeInteger(input.fixtureVersion) || input.fixtureVersion <= 0) {
    throw new TypeError('diagnostic fixture version must be positive');
  }
  validateSenderTuple(input, false);
  providerStableKeySchema.parse(input.recipientFingerprintProfile);
  if (!Number.isSafeInteger(input.recipientFingerprintVersion) || input.recipientFingerprintVersion <= 0) {
    throw new TypeError('diagnostic recipient-fingerprint version must be positive');
  }
  providerSha256Schema.parse(input.recipientFingerprintSha256);
  providerSha256Schema.parse(input.reviewedEnvelopeDigestSha256);
  if (!Number.isSafeInteger(input.validUntil) || input.validUntil < 0) {
    throw new TypeError('diagnostic validity must use a nonnegative safe timestamp');
  }
  if (!Number.isSafeInteger(input.maximumCostMinorUnits) || input.maximumCostMinorUnits < 0) {
    throw new TypeError('diagnostic cost cap must be nonnegative');
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new TypeError('diagnostic currency is invalid');
  validateEnvelope(input.envelope);
  const snapshot = deepFreeze(canonicalClone(input));
  if (digest(snapshot.envelope) !== snapshot.reviewedEnvelopeDigestSha256) {
    throw new TypeError('reviewed diagnostic envelope digest does not match immutable bytes');
  }
  return snapshot;
}

function validateAdapterTuple(adapterKey: string, adapterVersion: string): void {
  providerStableKeySchema.parse(adapterKey);
  providerStableKeySchema.parse(adapterVersion);
}

/**
 * Creates one process-local authenticator for ordinary submissions. A prepared value
 * from another adapter, a spread clone, or changed metadata is rejected before I/O.
 */
export function createEmailSubmissionPreparer<Opaque>(
  adapterKey: string,
  adapterVersion: string
): EmailSubmissionPreparer<Opaque> {
  validateAdapterTuple(adapterKey, adapterVersion);
  const authenticated = new WeakMap<object, AuthenticatedPreparedRecord<ImmutableEmailSubmission, Opaque>>();
  return Object.freeze({
    prepare(input, buildOpaque) {
      const immutableInput = snapshotOrdinary(input);
      const opaque = deepFreeze(buildOpaque(immutableInput));
      const providerRequestDigestSha256 = digest({
        adapterKey,
        adapterVersion,
        input: immutableInput,
        opaque
      });
      const prepared = Object.freeze({
        adapterKey,
        adapterVersion,
        providerRequestDigestSha256,
        reviewedEnvelopeDigestSha256: immutableInput.reviewedEnvelopeDigestSha256,
        opaque,
        [preparedEmailSubmissionBrand]: true as const
      });
      authenticated.set(prepared, Object.freeze({
        input: immutableInput,
        opaque,
        providerRequestDigestSha256
      }));
      return prepared;
    },
    open(prepared) {
      const record = authenticated.get(prepared);
      if (
        record === undefined
        || prepared.adapterKey !== adapterKey
        || prepared.adapterVersion !== adapterVersion
        || prepared.providerRequestDigestSha256 !== record.providerRequestDigestSha256
        || prepared.reviewedEnvelopeDigestSha256 !== record.input.reviewedEnvelopeDigestSha256
        || prepared.opaque !== record.opaque
      ) {
        throw new ProviderContractError(
          'invalid_prepared_submission',
          'prepared email submission is not authenticated for this adapter'
        );
      }
      return Object.freeze({ input: record.input, opaque: record.opaque });
    }
  });
}

/** Process-local authenticator for the separate diagnostic submission grammar. */
export function createEmailDiagnosticSubmissionPreparer<Opaque>(
  adapterKey: string,
  adapterVersion: string
): EmailDiagnosticSubmissionPreparer<Opaque> {
  validateAdapterTuple(adapterKey, adapterVersion);
  const authenticated = new WeakMap<
    object,
    AuthenticatedPreparedRecord<ImmutableEmailDiagnosticSubmission, Opaque>
  >();
  return Object.freeze({
    prepare(input, buildOpaque) {
      const immutableInput = snapshotDiagnostic(input);
      const opaque = deepFreeze(buildOpaque(immutableInput));
      const providerRequestDigestSha256 = digest({
        adapterKey,
        adapterVersion,
        input: immutableInput,
        opaque
      });
      const prepared = Object.freeze({
        adapterKey,
        adapterVersion,
        fixtureKey: immutableInput.fixtureKey,
        fixtureVersion: immutableInput.fixtureVersion,
        providerRequestDigestSha256,
        reviewedEnvelopeDigestSha256: immutableInput.reviewedEnvelopeDigestSha256,
        opaque,
        [preparedEmailDiagnosticBrand]: true as const
      });
      authenticated.set(prepared, Object.freeze({
        input: immutableInput,
        opaque,
        providerRequestDigestSha256
      }));
      return prepared;
    },
    open(prepared) {
      const record = authenticated.get(prepared);
      if (
        record === undefined
        || prepared.adapterKey !== adapterKey
        || prepared.adapterVersion !== adapterVersion
        || prepared.fixtureKey !== record.input.fixtureKey
        || prepared.fixtureVersion !== record.input.fixtureVersion
        || prepared.providerRequestDigestSha256 !== record.providerRequestDigestSha256
        || prepared.reviewedEnvelopeDigestSha256 !== record.input.reviewedEnvelopeDigestSha256
        || prepared.opaque !== record.opaque
      ) {
        throw new ProviderContractError(
          'invalid_prepared_submission',
          'prepared diagnostic submission is not authenticated for this adapter'
        );
      }
      return Object.freeze({ input: record.input, opaque: record.opaque });
    }
  });
}

export function validateProviderCapabilities(value: unknown): ProviderCapabilities {
  return deepFreeze(providerCapabilitiesSchema.parse(value));
}

export function validateProviderLookupInput(value: unknown): ProviderLookupInput {
  return deepFreeze(providerLookupInputSchema.parse(value));
}

export function validateEmailDiagnosticLookupInput(
  value: unknown
): EmailDiagnosticLookupInput {
  return deepFreeze(emailDiagnosticLookupInputSchema.parse(value));
}

export function validateRawProviderCallback(value: RawProviderCallback): RawProviderCallback {
  if (value.contractVersion !== 1) throw new TypeError('callback envelope version is unsupported');
  providerOpaqueIdSchema.parse(value.providerConnectionId);
  providerOpaqueIdSchema.parse(value.ingressCorrelationId);
  providerSha256Schema.parse(value.payloadDigestSha256);
  if (
    !Number.isSafeInteger(value.payloadByteLength)
    || value.payloadByteLength < 0
    || value.payloadByteLength !== value.rawPayloadBytes.byteLength
  ) throw new TypeError('callback payload byte length does not match its bounded bytes');
  if (value.payloadByteLength > 1_048_576) throw new TypeError('callback payload exceeds maximum size');
  if (value.signatureEnvelopeBytes.byteLength > 16_384) {
    throw new TypeError('callback signature envelope exceeds maximum size');
  }
  const rawPayloadBytes = new Uint8Array(value.rawPayloadBytes);
  const signatureEnvelopeBytes = new Uint8Array(value.signatureEnvelopeBytes);
  if (bytesToHex(sha256(rawPayloadBytes)) !== value.payloadDigestSha256) {
    throw new TypeError('callback payload digest does not match its bounded bytes');
  }
  return Object.freeze({
    contractVersion: 1,
    providerConnectionId: value.providerConnectionId,
    ingressCorrelationId: value.ingressCorrelationId,
    payloadDigestSha256: value.payloadDigestSha256,
    payloadByteLength: value.payloadByteLength,
    rawPayloadBytes,
    signatureEnvelopeBytes
  });
}

export function validateCallbackCorrelationMode(
  mode: CallbackCorrelationMode | null
): CallbackCorrelationMode | null {
  return mode;
}
