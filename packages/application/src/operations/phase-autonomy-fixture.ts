import type { OperationRisk, SafeSchemaManifestRef, VersionedDefinitionRef } from '@jooevents/contracts';
import type { UtcInstant } from '@jooevents/kernel';
import type { OperationAutonomyPolicy } from '../autonomy';
import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createOperationRiskResolverRegistration,
  createRenewedApprovalResolverRegistration
} from './autonomy-preflight';
import {
  createSingleUnitOfWorkFamilyRegistration,
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration
} from './phase-contract';
import type { OrdinaryEffectOperationDefinition } from './types';

const farFuture = '2099-01-01T00:00:00.000Z' as UtcInstant;
const approvalExpiry = '2098-01-01T00:00:00.000Z' as UtcInstant;

function ref(operationName: string, suffix: string, version: number): VersionedDefinitionRef {
  return Object.freeze({ key: `${operationName}.${suffix}`, version });
}

/**
 * Public conformance fixtures use this closed bundle to prove the real executor.
 * It is deliberately explicit test evidence, not a production autonomy default or grant.
 */
export function createSingleUnitOfWorkConformanceFixture(input: {
  readonly operation: { readonly name: string; readonly version: number; readonly effect: 'draft' | 'commit' };
  readonly maximumRisk: OperationRisk;
  readonly consequenceTags: readonly string[];
  readonly autonomyPolicy: OperationAutonomyPolicy;
  readonly handler: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: SafeSchemaManifestRef;
  readonly nullDetailSchema: SafeSchemaManifestRef;
}): {
  readonly execution: OrdinaryEffectOperationDefinition['execution'];
  readonly outcomeDeclarations: ReturnType<typeof autonomyInterventionOutcomeDeclarations>;
  readonly contentionOutcomeDeclaration: {
    readonly class: 'conflict';
    readonly kind: 'operation.in_progress';
    readonly retryable: true;
    readonly detailSchema: SafeSchemaManifestRef;
  };
  readonly registrations: Pick<
    import('./types').OperationRegistrySource,
    | 'effectExecutionFamilies'
    | 'effectPhases'
    | 'terminalizationResolvers'
    | 'riskResolvers'
    | 'autonomyEvidenceResolvers'
    | 'renewedApprovalResolvers'
    | 'autonomyPreflights'
  >;
} {
  const operation = Object.freeze({ ...input.operation });
  const family = ref(operation.name, 'execution-family', operation.version);
  const phase = ref(operation.name, 'phase.single-uow', operation.version);
  const terminalization = ref(operation.name, 'terminalization', operation.version);
  const riskResolver = ref(operation.name, 'risk-resolver', operation.version);
  const evidenceResolver = ref(operation.name, 'autonomy-evidence', operation.version);
  const approvalResolver = ref(operation.name, 'approval-resolver', operation.version);
  const preflight = ref(operation.name, 'autonomy-preflight', operation.version);
  const contentionOutcome = Object.freeze({
    class: 'conflict' as const,
    kind: 'operation.in_progress',
    retryable: true,
    subjects: [],
    detail: null,
    detailSchemaVersion: input.nullDetailSchema.version
  });
  const risk = createOperationRiskResolverRegistration({
    reference: riskResolver,
    operation,
    resolve: (subject) => ({
      risk: input.maximumRisk,
      consequenceTags: [...subject.registeredConsequenceTags],
      evidenceIds: [`risk.${operation.name}`]
    })
  });
  const evidence = createAutonomyEvidenceResolverRegistration({
    reference: evidenceResolver,
    operation,
    resolve: ({ subject }) => ({
      evaluatedAt: subject.receivedAt,
      hardBounds: {
        scopeKeys: [...subject.scopeKeys],
        maximumSpendMicros: 0,
        maximumActions: 1,
        notAfter: farFuture
      },
      unattendedBounds: {
        scopeKeys: [...subject.scopeKeys],
        maximumSpendMicros: 0,
        maximumActions: 1,
        notAfter: farFuture
      },
      spendMicros: 0,
      actionCount: 1,
      completesBy: farFuture,
      proposedAction: {
        key: `${operation.name}.execute`,
        version: operation.version,
        digestSha256: subject.requestHashSha256
      },
      failure: { kind: 'none' }
    })
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: approvalResolver,
    operation,
    resolve: ({ invocation, policy, evaluatedAt }) => input.autonomyPolicy.requiresSeparateApproval
      ? {
          approverCurrentlyAuthorized: true,
          evidence: {
            id: `approval.${operation.name}`,
            policy: { ...policy.definition },
            operation: { ...invocation.operation },
            requestOrPlanDigestSha256: invocation.requestOrPlanDigestSha256,
            proposedAction: { ...invocation.proposedAction },
            scopeKeys: [...invocation.scopeKeys],
            maximumSpendMicros: invocation.spendMicros,
            maximumActions: invocation.actionCount,
            notAfter: invocation.completesBy,
            proposerPrincipalKey: invocation.authority.principalKey,
            approverPrincipalKey: 'principal.fixture-approver',
            issuedAt: evaluatedAt,
            expiresAt: approvalExpiry,
            evidenceIds: [...invocation.consequenceEvidenceIds]
          }
        }
      : { approverCurrentlyAuthorized: false }
  });
  const terminal = createTerminalizationResolverRegistration({
    reference: terminalization,
    operation,
    phase,
    resolve: ({ result }) => result.kind === 'success'
      ? { kind: 'terminal' }
      : { kind: 'nonterminal' }
  });
  const preflightRegistration = createAutonomyPreflightRegistration({
    reference: preflight,
    operation,
    policy: input.autonomyPolicy.definition,
    riskResolver,
    evidenceResolver,
    approvalResolver,
    interventionOutcomes: autonomyInterventionOutcomes(input.nullDetailSchema.version)
  });
  const phaseRegistration = createSingleUnitOfWorkPhaseRegistration({
    reference: phase,
    family,
    operation,
    effect: operation.effect,
    handler: input.handler,
    handlerCapability: input.handlerCapability,
    contributionSchema: input.contributionSchema,
    terminalization,
    terminalOutcomeKeys: [],
    contentionOutcome
  });
  return Object.freeze({
    execution: Object.freeze({
      kind: 'single_unit_of_work' as const,
      family,
      phase,
      terminalization,
      autonomyPreflight: preflight
    }),
    outcomeDeclarations: autonomyInterventionOutcomeDeclarations(input.nullDetailSchema),
    contentionOutcomeDeclaration: Object.freeze({
      class: 'conflict' as const,
      kind: 'operation.in_progress',
      retryable: true as const,
      detailSchema: Object.freeze({ ...input.nullDetailSchema })
    }),
    registrations: Object.freeze({
      effectExecutionFamilies: Object.freeze([createSingleUnitOfWorkFamilyRegistration({ reference: family, phase })]),
      effectPhases: Object.freeze([phaseRegistration]),
      terminalizationResolvers: Object.freeze([terminal]),
      riskResolvers: Object.freeze([risk]),
      autonomyEvidenceResolvers: Object.freeze([evidence]),
      renewedApprovalResolvers: Object.freeze([approval]),
      autonomyPreflights: Object.freeze([preflightRegistration])
    })
  });
}
