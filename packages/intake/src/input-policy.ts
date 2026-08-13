import { createHash } from 'node:crypto';
import {
  intakeDigestSchema,
  intakeIdSchema,
  intakeInstantSchema,
  intakeScopeSchema,
  intakeStableKeySchema,
  intakeVersionSchema,
  publicInputPolicyDecisionEvidenceSchema,
  type IntakeScopeDto,
  type PublicInputPolicyDecisionEvidence,
  type PublicInputPolicyDisposition
} from '@jooevents/contracts';
import { encodeCanonicalJson } from '@jooevents/kernel';
import { deepFreeze, sameIntakeScope } from './model';

export const PUBLIC_INPUT_POLICY_ACTION = Object.freeze({
  draftBegin: 'application_draft_begin',
  draftSave: 'application_draft_save',
  submit: 'application_submit'
} as const);

export type PublicInputPolicyAction =
  typeof PUBLIC_INPUT_POLICY_ACTION[keyof typeof PUBLIC_INPUT_POLICY_ACTION];

export interface PublicInputPolicyEvaluationContext {
  readonly scope: IntakeScopeDto;
  readonly action: PublicInputPolicyAction;
  readonly requestDigestSha256: string;
  readonly evaluatedAt: string;
}

export interface PublicInputPolicyDecisionDraft {
  readonly disposition: PublicInputPolicyDisposition;
  readonly reasonCode: string | null;
  readonly remedyCode: string | null;
}

declare const publicInputPolicyEvaluatorBrand: unique symbol;
declare const sealedPublicInputPolicyDecisionBrand: unique symbol;

/** An evaluator issued by this module for a trusted synchronous composition. */
export interface PublicInputPolicyEvaluator {
  readonly [publicInputPolicyEvaluatorBrand]: 'PublicInputPolicyEvaluator';
}

/** An opaque, process-local decision. Only this module can authenticate and open it. */
export interface SealedPublicInputPolicyDecision {
  readonly [sealedPublicInputPolicyDecisionBrand]: 'SealedPublicInputPolicyDecision';
}

export type PublicInputPolicyErrorCode =
  | 'invalid_input_policy_evaluator'
  | 'invalid_input_policy_context'
  | 'invalid_input_policy_decision'
  | 'invalid_input_policy_decision_seal'
  | 'input_policy_context_mismatch'
  | 'input_policy_evaluator_must_be_synchronous';

export class PublicInputPolicyError extends TypeError {
  constructor(readonly code: PublicInputPolicyErrorCode) {
    super(code);
    this.name = 'PublicInputPolicyError';
  }
}

interface IssuedEvaluatorRecord {
  readonly policy: PublicInputPolicyDecisionEvidence['policy'];
  readonly issueEvaluationId: () => string;
  readonly decide: (context: PublicInputPolicyEvaluationContext) => PublicInputPolicyDecisionDraft;
}

interface IssuedDecisionRecord {
  readonly context: PublicInputPolicyEvaluationContext;
  readonly evidence: PublicInputPolicyDecisionEvidence;
}

const issuedEvaluators = new WeakMap<object, IssuedEvaluatorRecord>();
const issuedDecisions = new WeakMap<object, IssuedDecisionRecord>();

/**
 * Registers a synchronous, code-owned evaluator. A structurally similar object is
 * not an evaluator: later evaluation authenticates the exact issued object.
 */
export function issuePublicInputPolicyEvaluator(input: {
  readonly policy: PublicInputPolicyDecisionEvidence['policy'];
  readonly issueEvaluationId: () => string;
  readonly decide: (context: PublicInputPolicyEvaluationContext) => PublicInputPolicyDecisionDraft;
}): PublicInputPolicyEvaluator {
  if (typeof input.issueEvaluationId !== 'function' || typeof input.decide !== 'function') {
    throw new PublicInputPolicyError('invalid_input_policy_evaluator');
  }
  if (input.issueEvaluationId.constructor.name === 'AsyncFunction'
      || input.decide.constructor.name === 'AsyncFunction') {
    throw new PublicInputPolicyError('input_policy_evaluator_must_be_synchronous');
  }
  let policy: PublicInputPolicyDecisionEvidence['policy'];
  try {
    policy = deepFreeze({
      key: intakeStableKeySchema.parse(input.policy.key),
      version: intakeVersionSchema.parse(input.policy.version)
    });
  } catch {
    throw new PublicInputPolicyError('invalid_input_policy_evaluator');
  }
  const evaluator = Object.freeze(Object.create(null)) as PublicInputPolicyEvaluator;
  issuedEvaluators.set(evaluator, {
    policy,
    issueEvaluationId: input.issueEvaluationId,
    decide: input.decide
  });
  return evaluator;
}

/** Rejects parsed, copied, or structurally forged evaluator handles. */
export function assertPublicInputPolicyEvaluator(
  evaluator: PublicInputPolicyEvaluator
): void {
  if (!issuedEvaluators.has(evaluator)) {
    throw new PublicInputPolicyError('invalid_input_policy_evaluator');
  }
}

/** Evaluates one exact server-enriched context and returns only an opaque seal. */
export function evaluatePublicInputPolicy(
  evaluator: PublicInputPolicyEvaluator,
  candidate: PublicInputPolicyEvaluationContext
): SealedPublicInputPolicyDecision {
  const registered = issuedEvaluators.get(evaluator);
  if (!registered) throw new PublicInputPolicyError('invalid_input_policy_evaluator');
  const context = parseEvaluationContext(candidate);
  const decisionCandidate = registered.decide(context);
  if (isThenable(decisionCandidate)) {
    throw new PublicInputPolicyError('input_policy_evaluator_must_be_synchronous');
  }
  const decision = parseDecisionDraft(decisionCandidate);
  const evaluationIdCandidate = registered.issueEvaluationId();
  if (isThenable(evaluationIdCandidate)) {
    throw new PublicInputPolicyError('input_policy_evaluator_must_be_synchronous');
  }
  let evaluationId: string;
  try {
    evaluationId = intakeIdSchema.parse(evaluationIdCandidate);
  } catch {
    throw new PublicInputPolicyError('invalid_input_policy_decision');
  }
  const evidence = publicInputPolicyDecisionEvidenceSchema.parse({
    schemaVersion: 1,
    evaluationId,
    policy: registered.policy,
    disposition: decision.disposition,
    reasonCode: decision.reasonCode,
    remedyCode: decision.remedyCode,
    requestDigestSha256: context.requestDigestSha256,
    evaluatedAt: context.evaluatedAt,
    evidenceDigestSha256: evidenceDigest({
      evaluationId,
      policy: registered.policy,
      context,
      decision
    })
  });
  const seal = Object.freeze(Object.create(null)) as SealedPublicInputPolicyDecision;
  issuedDecisions.set(seal, {
    context,
    evidence: deepFreeze(evidence)
  });
  return seal;
}

/**
 * Opens a decision only for the exact context it evaluated. This is the sole path
 * from process-local authority to persistable immutable policy evidence.
 */
export function openPublicInputPolicyDecision(
  seal: SealedPublicInputPolicyDecision,
  expectedContext: PublicInputPolicyEvaluationContext
): PublicInputPolicyDecisionEvidence {
  const issued = issuedDecisions.get(seal);
  if (!issued) throw new PublicInputPolicyError('invalid_input_policy_decision_seal');
  const expected = parseEvaluationContext(expectedContext);
  if (!sameEvaluationContext(issued.context, expected)) {
    throw new PublicInputPolicyError('input_policy_context_mismatch');
  }
  const expectedDigest = evidenceDigest({
    evaluationId: issued.evidence.evaluationId,
    policy: issued.evidence.policy,
    context: issued.context,
    decision: issued.evidence
  });
  if (expectedDigest !== issued.evidence.evidenceDigestSha256) {
    throw new PublicInputPolicyError('invalid_input_policy_decision_seal');
  }
  return issued.evidence;
}

/** Verifies rehydrated durable evidence against the context formerly sealed in process. */
export function parsePersistedPublicInputPolicyEvidence(input: {
  readonly evidence: unknown;
  readonly context: PublicInputPolicyEvaluationContext;
}): PublicInputPolicyDecisionEvidence {
  let evidence: PublicInputPolicyDecisionEvidence;
  try {
    evidence = publicInputPolicyDecisionEvidenceSchema.parse(input.evidence);
  } catch {
    throw new PublicInputPolicyError('invalid_input_policy_decision');
  }
  const context = parseEvaluationContext(input.context);
  if (evidence.requestDigestSha256 !== context.requestDigestSha256
      || evidence.evaluatedAt !== context.evaluatedAt
      || evidenceDigest({
        evaluationId: evidence.evaluationId,
        policy: evidence.policy,
        context,
        decision: evidence
      }) !== evidence.evidenceDigestSha256) {
    throw new PublicInputPolicyError('input_policy_context_mismatch');
  }
  return deepFreeze(evidence);
}

function parseEvaluationContext(candidate: PublicInputPolicyEvaluationContext): PublicInputPolicyEvaluationContext {
  try {
    if (!candidate || typeof candidate !== 'object'
        || !hasExactKeys(candidate as unknown as Record<string, unknown>, [
          'scope', 'action', 'requestDigestSha256', 'evaluatedAt'
        ])
        || !Object.values(PUBLIC_INPUT_POLICY_ACTION).includes(candidate.action)) {
      throw new TypeError();
    }
    return deepFreeze({
      scope: intakeScopeSchema.parse(candidate.scope),
      action: candidate.action,
      requestDigestSha256: intakeDigestSchema.parse(candidate.requestDigestSha256),
      evaluatedAt: intakeInstantSchema.parse(candidate.evaluatedAt)
    });
  } catch {
    throw new PublicInputPolicyError('invalid_input_policy_context');
  }
}

function parseDecisionDraft(candidate: PublicInputPolicyDecisionDraft): PublicInputPolicyDecisionDraft {
  try {
    if (!candidate || typeof candidate !== 'object'
        || !hasExactKeys(candidate as unknown as Record<string, unknown>, [
          'disposition', 'reasonCode', 'remedyCode'
        ])) throw new TypeError();
    const parsed = publicInputPolicyDecisionEvidenceSchema.parse({
      schemaVersion: 1,
      evaluationId: '00000000-0000-7000-8000-000000000000',
      policy: { key: 'validation.input_policy', version: 1 },
      disposition: candidate.disposition,
      reasonCode: candidate.reasonCode,
      remedyCode: candidate.remedyCode,
      requestDigestSha256: '0'.repeat(64),
      evaluatedAt: '2000-01-01T00:00:00.000Z',
      evidenceDigestSha256: '0'.repeat(64)
    });
    return deepFreeze({
      disposition: parsed.disposition,
      reasonCode: parsed.reasonCode,
      remedyCode: parsed.remedyCode
    });
  } catch {
    throw new PublicInputPolicyError('invalid_input_policy_decision');
  }
}

function sameEvaluationContext(
  left: PublicInputPolicyEvaluationContext,
  right: PublicInputPolicyEvaluationContext
): boolean {
  return sameIntakeScope(left.scope, right.scope)
    && left.action === right.action
    && left.requestDigestSha256 === right.requestDigestSha256
    && left.evaluatedAt === right.evaluatedAt;
}

function evidenceDigest(input: {
  readonly evaluationId: string;
  readonly policy: PublicInputPolicyDecisionEvidence['policy'];
  readonly context: PublicInputPolicyEvaluationContext;
  readonly decision: PublicInputPolicyDecisionDraft;
}): string {
  return createHash('sha256').update(encodeCanonicalJson({
    schemaVersion: 1,
    evaluationId: input.evaluationId,
    policy: input.policy,
    evaluationContext: input.context,
    disposition: input.decision.disposition,
    reasonCode: input.decision.reasonCode,
    remedyCode: input.decision.remedyCode
  })).digest('hex');
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { readonly then?: unknown }).then === 'function';
}
