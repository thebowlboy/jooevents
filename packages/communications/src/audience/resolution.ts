import {
  ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT,
  organizerCommunicationAudienceDraftSchema,
  organizerCommunicationDefinitionRefSchema,
  organizerCommunicationDigestSchema,
  organizerCommunicationInstantSchema,
  organizerCommunicationOpaqueIdSchema,
  organizerCommunicationStableKeySchema,
  organizerCommunicationSubjectRefIdSchema,
  organizerCommunicationVersionSchema,
  organizerMessagePreviewSourceVersionSchema,
  type OrganizerCommunicationAudienceDraft,
  type OrganizerCommunicationPurposeRevisionRef,
  type OrganizerMessagePreviewSummary
} from '@jooevents/contracts/communications/organizer';
import {
  parseEventId,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

const canonicalSafeLabelSchema = z.string().max(240).refine((value) => {
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return normalized.length > 0 && normalized === value && !CONTROL.test(value);
}, { message: 'Expected a canonical safe display label.' });

export const organizerAudienceEvidenceRefSchema = z.strictObject({
  evidenceRefId: organizerCommunicationOpaqueIdSchema,
  evidenceVersion: organizerCommunicationVersionSchema,
  evidenceDigestSha256: organizerCommunicationDigestSchema
});

export const organizerAudienceCandidateSchema = z.strictObject({
  subjectRefId: organizerCommunicationSubjectRefIdSchema,
  subjectVersion: organizerCommunicationVersionSchema,
  personRefId: organizerCommunicationSubjectRefIdSchema,
  contactRefId: organizerCommunicationSubjectRefIdSchema,
  safeLabel: canonicalSafeLabelSchema,
  membershipEvidence: organizerAudienceEvidenceRefSchema
});

export const organizerClassifiedEmailAddressSchema = z.strictObject({
  addressRefId: organizerCommunicationOpaqueIdSchema,
  addressVersion: organizerCommunicationVersionSchema,
  contactRefId: organizerCommunicationSubjectRefIdSchema,
  channel: z.literal('email'),
  lifecycle: z.enum(['active', 'revoked']),
  lifecycleEvidence: organizerAudienceEvidenceRefSchema,
  lookupFingerprint: z.strictObject({
    profile: organizerCommunicationStableKeySchema,
    version: organizerCommunicationVersionSchema,
    keyedValue: organizerCommunicationDigestSchema
  }),
  classifiedValue: z.strictObject({
    payloadRefId: organizerCommunicationOpaqueIdSchema,
    payloadRefVersion: organizerCommunicationVersionSchema,
    classification: z.literal('communication.contact.email'),
    value: z.email().max(320)
  })
});

const evaluatedAddressPolicySchema = z.strictObject({
  kind: z.literal('evaluated'),
  selectionPolicy: organizerCommunicationDefinitionRefSchema,
  address: organizerClassifiedEmailAddressSchema,
  purposeBasis: z.strictObject({
    state: z.enum(['allowed', 'denied']),
    evidence: organizerAudienceEvidenceRefSchema
  }),
  consent: z.strictObject({
    state: z.enum(['not_required', 'granted', 'missing', 'withdrawn']),
    evidence: organizerAudienceEvidenceRefSchema
  }),
  suppression: z.strictObject({
    state: z.enum(['clear', 'suppressed']),
    evidence: organizerAudienceEvidenceRefSchema
  }),
  doNotContact: z.strictObject({
    state: z.enum(['clear', 'active']),
    evidence: organizerAudienceEvidenceRefSchema
  })
});

export const organizerAddressPolicyResolutionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('no_eligible_address'),
    evidence: organizerAudienceEvidenceRefSchema
  }),
  evaluatedAddressPolicySchema
]);

export type OrganizerAudienceEvidenceRef = z.infer<typeof organizerAudienceEvidenceRefSchema>;
export type OrganizerAudienceCandidate = z.infer<typeof organizerAudienceCandidateSchema>;
export type OrganizerClassifiedEmailAddress = z.infer<typeof organizerClassifiedEmailAddressSchema>;
export type OrganizerAddressPolicyResolution = z.infer<typeof organizerAddressPolicyResolutionSchema>;
export type OrganizerMessagePreviewSourceVersion = OrganizerMessagePreviewSummary['sourceVersions'][number];
type OrganizerEvaluatedAddressPolicy = Extract<
  OrganizerAddressPolicyResolution,
  { readonly kind: 'evaluated' }
>;

export interface OrganizerAudienceScope {
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
}

export interface OrganizerAudienceSourceSnapshot {
  readonly source: OrganizerCommunicationAudienceDraft['source'];
  /** Only caller-visible members. No unfiltered total or hidden identifier is accepted. */
  readonly candidates: readonly OrganizerAudienceCandidate[];
  readonly sourceVersions: readonly OrganizerMessagePreviewSourceVersion[];
}

export interface OrganizerAudienceSourcePort {
  resolveCurrentSnapshot(input: {
    readonly scope: OrganizerAudienceScope;
    readonly audience: OrganizerCommunicationAudienceDraft;
  }): OrganizerAudienceSourceSnapshot | Promise<OrganizerAudienceSourceSnapshot>;
}

export interface OrganizerAddressPolicyPort {
  resolveEmail(input: {
    readonly scope: OrganizerAudienceScope;
    readonly purposeRevision: OrganizerCommunicationPurposeRevisionRef;
    readonly candidate: OrganizerAudienceCandidate;
    readonly asOf: string;
  }): OrganizerAddressPolicyResolution | Promise<OrganizerAddressPolicyResolution>;
}

export const ORGANIZER_AUDIENCE_EXCLUSION_REASONS = Object.freeze({
  noEligibleAddress: 'address.no_eligible',
  addressRevoked: 'address.revoked',
  purposeNotAllowed: 'purpose.not_allowed',
  consentMissing: 'purpose.consent_missing',
  consentWithdrawn: 'purpose.consent_withdrawn',
  doNotContact: 'person.do_not_contact',
  suppressed: 'address.suppressed'
} as const);

export type OrganizerAudienceExclusionReason =
  (typeof ORGANIZER_AUDIENCE_EXCLUSION_REASONS)[keyof typeof ORGANIZER_AUDIENCE_EXCLUSION_REASONS];

interface OrganizerResolvedAudienceMemberBase {
  readonly candidate: OrganizerAudienceCandidate;
  readonly evidence: readonly OrganizerAudienceEvidenceRef[];
  readonly policyEvidence:
    | Readonly<{
        kind: 'no_eligible_address';
        evidence: OrganizerAudienceEvidenceRef;
      }>
    | Readonly<{
        kind: 'evaluated';
        selectionPolicy: OrganizerEvaluatedAddressPolicy['selectionPolicy'];
        addressLifecycle: Readonly<{
          state: OrganizerEvaluatedAddressPolicy['address']['lifecycle'];
          evidence: OrganizerAudienceEvidenceRef;
        }>;
        purposeBasis: OrganizerEvaluatedAddressPolicy['purposeBasis'];
        consent: OrganizerEvaluatedAddressPolicy['consent'];
        suppression: OrganizerEvaluatedAddressPolicy['suppression'];
        doNotContact: OrganizerEvaluatedAddressPolicy['doNotContact'];
      }>;
}

export type OrganizerResolvedAudienceMember =
  | (OrganizerResolvedAudienceMemberBase & {
      readonly state: 'eligible';
      readonly address: OrganizerClassifiedEmailAddress;
      readonly addressPolicy: ReturnType<typeof organizerCommunicationDefinitionRefSchema.parse>;
    })
  | (OrganizerResolvedAudienceMemberBase & {
      readonly state: 'excluded';
      readonly reasonCode: OrganizerAudienceExclusionReason;
      readonly address?: OrganizerClassifiedEmailAddress;
      readonly addressPolicy?: ReturnType<typeof organizerCommunicationDefinitionRefSchema.parse>;
    });

export interface OrganizerResolvedAudienceSnapshot {
  readonly scope: OrganizerAudienceScope;
  readonly audience: OrganizerCommunicationAudienceDraft;
  readonly sourceVersions: readonly OrganizerMessagePreviewSourceVersion[];
  readonly members: readonly OrganizerResolvedAudienceMember[];
}

export type OrganizerAudienceResolutionErrorCode =
  | 'invalid_input'
  | 'source_not_registered'
  | 'source_contract_mismatch'
  | 'source_too_large'
  | 'duplicate_source_subject'
  | 'address_evidence_invalid'
  | 'address_contact_mismatch';

export class OrganizerAudienceResolutionError extends Error {
  constructor(readonly code: OrganizerAudienceResolutionErrorCode) {
    super(code);
    this.name = 'OrganizerAudienceResolutionError';
  }
}

function canonicalScope(input: OrganizerAudienceScope): OrganizerAudienceScope {
  try {
    return Object.freeze({
      workspaceId: parseWorkspaceId(input.workspaceId),
      eventId: parseEventId(input.eventId)
    });
  } catch {
    throw new OrganizerAudienceResolutionError('invalid_input');
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateSortKey(candidate: OrganizerAudienceCandidate): string {
  return `${candidate.safeLabel.normalize('NFC').toLocaleLowerCase('en-US')}\u0000${candidate.subjectRefId}`;
}

function canonicalEvidence(values: readonly OrganizerAudienceEvidenceRef[]): readonly OrganizerAudienceEvidenceRef[] {
  const parsed = values.map((value) => organizerAudienceEvidenceRefSchema.parse(value));
  parsed.sort((left, right) => compareText(
    `${left.evidenceRefId}\u0000${left.evidenceVersion}`,
    `${right.evidenceRefId}\u0000${right.evidenceVersion}`
  ));
  const unique: OrganizerAudienceEvidenceRef[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const current = parsed[index]!;
    const prior = unique.at(-1);
    if (prior === undefined
        || prior.evidenceRefId !== current.evidenceRefId
        || prior.evidenceVersion !== current.evidenceVersion) {
      unique.push(current);
      continue;
    }
    if (prior.evidenceDigestSha256 !== current.evidenceDigestSha256) {
      throw new OrganizerAudienceResolutionError('address_evidence_invalid');
    }
  }
  return Object.freeze(unique.map((value) => Object.freeze({ ...value })));
}

function freezeEvidenceRef(value: OrganizerAudienceEvidenceRef): OrganizerAudienceEvidenceRef {
  return Object.freeze({ ...value });
}

function freezePolicyEvidence(resolution: OrganizerAddressPolicyResolution):
  OrganizerResolvedAudienceMemberBase['policyEvidence'] {
  if (resolution.kind === 'no_eligible_address') {
    return Object.freeze({
      kind: 'no_eligible_address',
      evidence: freezeEvidenceRef(resolution.evidence)
    });
  }
  return Object.freeze({
    kind: 'evaluated',
    selectionPolicy: Object.freeze({
      reference: Object.freeze({ ...resolution.selectionPolicy.reference }),
      definitionDigestSha256: resolution.selectionPolicy.definitionDigestSha256
    }),
    addressLifecycle: Object.freeze({
      state: resolution.address.lifecycle,
      evidence: freezeEvidenceRef(resolution.address.lifecycleEvidence)
    }),
    purposeBasis: Object.freeze({
      state: resolution.purposeBasis.state,
      evidence: freezeEvidenceRef(resolution.purposeBasis.evidence)
    }),
    consent: Object.freeze({
      state: resolution.consent.state,
      evidence: freezeEvidenceRef(resolution.consent.evidence)
    }),
    suppression: Object.freeze({
      state: resolution.suppression.state,
      evidence: freezeEvidenceRef(resolution.suppression.evidence)
    }),
    doNotContact: Object.freeze({
      state: resolution.doNotContact.state,
      evidence: freezeEvidenceRef(resolution.doNotContact.evidence)
    })
  });
}

function excludedReason(
  resolution: Extract<OrganizerAddressPolicyResolution, { readonly kind: 'evaluated' }>
): OrganizerAudienceExclusionReason | undefined {
  if (resolution.address.lifecycle === 'revoked') {
    return ORGANIZER_AUDIENCE_EXCLUSION_REASONS.addressRevoked;
  }
  if (resolution.purposeBasis.state === 'denied') {
    return ORGANIZER_AUDIENCE_EXCLUSION_REASONS.purposeNotAllowed;
  }
  if (resolution.consent.state === 'missing') {
    return ORGANIZER_AUDIENCE_EXCLUSION_REASONS.consentMissing;
  }
  if (resolution.consent.state === 'withdrawn') {
    return ORGANIZER_AUDIENCE_EXCLUSION_REASONS.consentWithdrawn;
  }
  if (resolution.doNotContact.state === 'active') {
    return ORGANIZER_AUDIENCE_EXCLUSION_REASONS.doNotContact;
  }
  if (resolution.suppression.state === 'suppressed') {
    return ORGANIZER_AUDIENCE_EXCLUSION_REASONS.suppressed;
  }
  return undefined;
}

function freezeCandidate(candidate: OrganizerAudienceCandidate): OrganizerAudienceCandidate {
  return Object.freeze({
    ...candidate,
    membershipEvidence: Object.freeze({ ...candidate.membershipEvidence })
  });
}

function freezeAddress(address: OrganizerClassifiedEmailAddress): OrganizerClassifiedEmailAddress {
  return Object.freeze({
    ...address,
    lifecycleEvidence: Object.freeze({ ...address.lifecycleEvidence }),
    lookupFingerprint: Object.freeze({ ...address.lookupFingerprint }),
    classifiedValue: Object.freeze({ ...address.classifiedValue })
  });
}

function canonicalSourceSnapshot(
  expected: OrganizerCommunicationAudienceDraft,
  snapshot: OrganizerAudienceSourceSnapshot
): OrganizerAudienceSourceSnapshot {
  let source: OrganizerCommunicationAudienceDraft['source'];
  let candidates: OrganizerAudienceCandidate[];
  let sourceVersions: OrganizerMessagePreviewSourceVersion[];
  if (!Array.isArray(snapshot.candidates) || !Array.isArray(snapshot.sourceVersions)) {
    throw new OrganizerAudienceResolutionError('source_contract_mismatch');
  }
  if (snapshot.candidates.length > ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT) {
    throw new OrganizerAudienceResolutionError('source_too_large');
  }
  if (snapshot.sourceVersions.length > 100) {
    throw new OrganizerAudienceResolutionError('source_contract_mismatch');
  }
  try {
    source = organizerCommunicationAudienceDraftSchema.shape.source.parse(snapshot.source);
    candidates = snapshot.candidates.map((candidate) => organizerAudienceCandidateSchema.parse(candidate));
    sourceVersions = snapshot.sourceVersions.map((version) =>
      organizerMessagePreviewSourceVersionSchema.parse(version)
    );
  } catch {
    throw new OrganizerAudienceResolutionError('source_contract_mismatch');
  }
  if (!sameJson(source, expected.source)) {
    throw new OrganizerAudienceResolutionError('source_contract_mismatch');
  }
  candidates.sort((left, right) => compareText(candidateSortKey(left), candidateSortKey(right)));
  const seenSubjects = new Set<string>();
  for (const candidate of candidates) {
    if (seenSubjects.has(candidate.subjectRefId)) {
      throw new OrganizerAudienceResolutionError('duplicate_source_subject');
    }
    seenSubjects.add(candidate.subjectRefId);
  }
  sourceVersions.sort((left, right) => compareText(left.sourceKey, right.sourceKey));
  for (let index = 1; index < sourceVersions.length; index += 1) {
    if (sourceVersions[index - 1]!.sourceKey === sourceVersions[index]!.sourceKey) {
      throw new OrganizerAudienceResolutionError('source_contract_mismatch');
    }
  }
  return Object.freeze({
    source: Object.freeze({ ...source }),
    candidates: Object.freeze(candidates.map(freezeCandidate)),
    sourceVersions: Object.freeze(sourceVersions.map((version) => Object.freeze({ ...version })))
  });
}

/**
 * Resolves only a caller-scoped current snapshot. Email equality is never inspected,
 * and every returned member remains keyed by its source/person/contact references.
 */
export async function resolveOrganizerAudience(input: {
  readonly scope: OrganizerAudienceScope;
  readonly audience: unknown;
  readonly asOf: unknown;
  readonly source: OrganizerAudienceSourcePort;
  readonly addressPolicy: OrganizerAddressPolicyPort;
}): Promise<OrganizerResolvedAudienceSnapshot> {
  let audience: OrganizerCommunicationAudienceDraft;
  let asOf: string;
  try {
    audience = organizerCommunicationAudienceDraftSchema.parse(input.audience);
    asOf = organizerCommunicationInstantSchema.parse(input.asOf);
  } catch {
    throw new OrganizerAudienceResolutionError('invalid_input');
  }
  const scope = canonicalScope(input.scope);

	if (audience.source.kind === 'composite') {
		const resolvedGroups = await Promise.all(audience.source.groups.map((group) =>
			resolveOrganizerAudience({
				...input,
				scope,
				audience: {
					...audience,
					source: group.source
				}
			})
		));
		const members: OrganizerResolvedAudienceMember[] = [];
		const indexByAddress = new Map<string, number>();
		for (const resolved of resolvedGroups) {
			for (const member of resolved.members) {
				const address = member.address?.classifiedValue.value.trim().toLocaleLowerCase('en-US');
				if (!address) {
					members.push(member);
					continue;
				}
				const existingIndex = indexByAddress.get(address);
				if (existingIndex === undefined) {
					indexByAddress.set(address, members.length);
					members.push(member);
					continue;
				}
				// Exclusion is the more careful state, while the first group still
				// owns the rendered context. Policy evidence from the excluding
				// membership applies to the same normalized mailbox; the combined
				// evidence retains both membership chains without swapping the person
				// whose copy was selected.
				const first = members[existingIndex]!;
				if (first.state === 'eligible' && member.state === 'excluded') {
					members[existingIndex] = Object.freeze({
						...first,
						state: 'excluded' as const,
						reasonCode: member.reasonCode,
						evidence: canonicalEvidence([...first.evidence, ...member.evidence]),
						policyEvidence: member.policyEvidence
					});
				}
			}
		}
		const versions = new Map<string, OrganizerMessagePreviewSourceVersion>();
		for (const resolved of resolvedGroups) {
			for (const version of resolved.sourceVersions) {
				const prior = versions.get(version.sourceKey);
				if (prior && !sameJson(prior, version)) {
					throw new OrganizerAudienceResolutionError('source_contract_mismatch');
				}
				versions.set(version.sourceKey, version);
			}
		}
		return Object.freeze({
			scope,
			audience: Object.freeze({
				...audience,
				purposeRevision: Object.freeze({ ...audience.purposeRevision }),
				source: audience.source
			}),
			sourceVersions: Object.freeze([...versions.values()].sort((left, right) =>
				compareText(left.sourceKey, right.sourceKey)
			)),
			members: Object.freeze(members)
		});
	}
  let rawSource: OrganizerAudienceSourceSnapshot;
  try {
    rawSource = await input.source.resolveCurrentSnapshot({ scope, audience });
  } catch (error) {
    if (error instanceof OrganizerAudienceResolutionError) throw error;
    throw new OrganizerAudienceResolutionError('source_not_registered');
  }
  const source = canonicalSourceSnapshot(audience, rawSource);
  const members: OrganizerResolvedAudienceMember[] = [];

  for (const candidate of source.candidates) {
    let resolution: OrganizerAddressPolicyResolution;
    try {
      resolution = organizerAddressPolicyResolutionSchema.parse(await input.addressPolicy.resolveEmail({
        scope,
        purposeRevision: audience.purposeRevision,
        candidate,
        asOf
      }));
    } catch (error) {
      if (error instanceof OrganizerAudienceResolutionError) throw error;
      throw new OrganizerAudienceResolutionError('address_evidence_invalid');
    }
    if (resolution.kind === 'no_eligible_address') {
      members.push(Object.freeze({
        state: 'excluded',
        candidate,
        reasonCode: ORGANIZER_AUDIENCE_EXCLUSION_REASONS.noEligibleAddress,
        evidence: canonicalEvidence([candidate.membershipEvidence, resolution.evidence]),
        policyEvidence: freezePolicyEvidence(resolution)
      }));
      continue;
    }
    if (resolution.address.contactRefId !== candidate.contactRefId) {
      throw new OrganizerAudienceResolutionError('address_contact_mismatch');
    }
    const address = freezeAddress(resolution.address);
    const addressPolicy = Object.freeze({
      reference: Object.freeze({ ...resolution.selectionPolicy.reference }),
      definitionDigestSha256: resolution.selectionPolicy.definitionDigestSha256
    });
    const evidence = canonicalEvidence([
      candidate.membershipEvidence,
      resolution.address.lifecycleEvidence,
      resolution.purposeBasis.evidence,
      resolution.consent.evidence,
      resolution.suppression.evidence,
      resolution.doNotContact.evidence
    ]);
    const reasonCode = excludedReason(resolution);
    const policyEvidence = freezePolicyEvidence(resolution);
    members.push(reasonCode === undefined
      ? Object.freeze({ state: 'eligible', candidate, address, addressPolicy, evidence, policyEvidence })
      : Object.freeze({
          state: 'excluded', candidate, address, addressPolicy, reasonCode, evidence, policyEvidence
        }));
  }

  return Object.freeze({
    scope,
    audience: Object.freeze({
      ...audience,
      purposeRevision: Object.freeze({ ...audience.purposeRevision }),
      source: Object.freeze({ ...audience.source })
    }),
    sourceVersions: source.sourceVersions,
    members: Object.freeze(members)
  });
}

export interface InMemoryOrganizerAudienceScopeFixture {
  readonly scope: OrganizerAudienceScope;
  readonly candidates: readonly OrganizerAudienceCandidate[];
  readonly sourceVersions: readonly OrganizerMessagePreviewSourceVersion[];
  readonly registeredQueries?: readonly Extract<
    OrganizerCommunicationAudienceDraft['source'],
    { readonly kind: 'registered_query' }
  >[];
}

function scopeKey(scope: OrganizerAudienceScope): string {
  return `${scope.workspaceId}\u0000${scope.eventId}`;
}

/** A deterministic, source-neutral catalog used by disposable runtimes and tests. */
export function createInMemoryOrganizerAudienceSourcePort(
  fixtures: readonly InMemoryOrganizerAudienceScopeFixture[]
): OrganizerAudienceSourcePort {
  const byScope = new Map<string, Readonly<{
    candidates: readonly OrganizerAudienceCandidate[];
    sourceVersions: readonly OrganizerMessagePreviewSourceVersion[];
    registeredQueries: readonly OrganizerCommunicationAudienceDraft['source'][];
  }>>();
  for (const fixture of fixtures) {
    const scope = canonicalScope(fixture.scope);
    const candidates = fixture.candidates.map((candidate) =>
      freezeCandidate(organizerAudienceCandidateSchema.parse(candidate))
    );
    const sourceVersions = fixture.sourceVersions.map((version) => Object.freeze(
      organizerMessagePreviewSourceVersionSchema.parse(version)
    ));
    const registeredQueries = (fixture.registeredQueries ?? []).map((source) => Object.freeze(
      organizerCommunicationAudienceDraftSchema.shape.source.parse(source)
    ));
    const key = scopeKey(scope);
    if (byScope.has(key)) throw new OrganizerAudienceResolutionError('source_contract_mismatch');
    byScope.set(key, Object.freeze({
      candidates: Object.freeze(candidates),
      sourceVersions: Object.freeze(sourceVersions),
      registeredQueries: Object.freeze(registeredQueries)
    }));
  }
  return Object.freeze({
    resolveCurrentSnapshot({ scope, audience }: {
      readonly scope: OrganizerAudienceScope;
      readonly audience: OrganizerCommunicationAudienceDraft;
    }) {
      const fixture = byScope.get(scopeKey(canonicalScope(scope)));
      if (fixture === undefined) {
        throw new OrganizerAudienceResolutionError('source_not_registered');
      }
      if (audience.source.kind === 'registered_query') {
        const registered = fixture.registeredQueries.find((candidate) =>
          sameJson(candidate, audience.source)
        );
        if (registered === undefined) {
          throw new OrganizerAudienceResolutionError('source_not_registered');
        }
        return Object.freeze({
          source: registered,
          candidates: fixture.candidates,
          sourceVersions: fixture.sourceVersions
        });
      }
      if (audience.source.kind !== 'explicit_contacts') {
		throw new OrganizerAudienceResolutionError('source_contract_mismatch');
	  }
	  const requested = new Set(audience.source.contactRefIds);
      // Missing refs remain wholly absent: neither a hidden row nor a hidden count is returned.
      const visible = fixture.candidates.filter((candidate) => requested.has(candidate.contactRefId));
      return Object.freeze({
        source: audience.source,
        candidates: Object.freeze(visible),
        sourceVersions: fixture.sourceVersions
      });
    }
  });
}

export interface InMemoryOrganizerAddressPolicyFixture {
  readonly scope: OrganizerAudienceScope;
  readonly contactRefId: string;
  readonly result: OrganizerAddressPolicyResolution;
}

/** Resolves by exact scoped contact reference only; address text is never a lookup key. */
export function createInMemoryOrganizerAddressPolicyPort(
  fixtures: readonly InMemoryOrganizerAddressPolicyFixture[]
): OrganizerAddressPolicyPort {
  const records = new Map<string, OrganizerAddressPolicyResolution>();
  for (const fixture of fixtures) {
    const scope = canonicalScope(fixture.scope);
    const contactRefId = organizerCommunicationSubjectRefIdSchema.parse(fixture.contactRefId);
    const result = organizerAddressPolicyResolutionSchema.parse(fixture.result);
    const key = `${scopeKey(scope)}\u0000${contactRefId}`;
    if (records.has(key)) throw new OrganizerAudienceResolutionError('address_evidence_invalid');
    records.set(key, result);
  }
  return Object.freeze({
    resolveEmail({ scope, candidate }: {
      readonly scope: OrganizerAudienceScope;
      readonly purposeRevision: OrganizerCommunicationPurposeRevisionRef;
      readonly candidate: OrganizerAudienceCandidate;
      readonly asOf: string;
    }) {
      const result = records.get(`${scopeKey(canonicalScope(scope))}\u0000${candidate.contactRefId}`);
      return result ?? Object.freeze({
        kind: 'no_eligible_address' as const,
        evidence: Object.freeze({
          evidenceRefId: 'address-policy-no-match',
          evidenceVersion: 1,
          evidenceDigestSha256: '0'.repeat(64)
        })
      });
    }
  });
}
