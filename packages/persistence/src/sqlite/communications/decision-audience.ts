import type { Database } from 'bun:sqlite';
import { createHash, createHmac } from 'node:crypto';
import {
  DECISION_NOTIFICATION_PURPOSE_KEY,
  TASK_REMINDER_PURPOSE_KEY,
  OrganizerAudienceResolutionError,
  organizerAddressPolicyResolutionSchema,
  organizerAudienceCandidateSchema,
  type OrganizerAddressPolicyResolution,
  type OrganizerAudienceCandidate,
  type OrganizerAudienceScope,
  type OrganizerAudienceSourceSnapshot,
  type OrganizerMergeValueSource,
  type OrganizerRenderContentBinding,
  type OrganizerRenderContentSource,
  type OrganizerResolvedMergeValue
} from '@jooevents/communications';
import {
  ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT,
  organizerCommunicationAudienceDraftSchema,
  organizerCommunicationAudienceOptionSchema,
  organizerCommunicationDefinitionRefSchema,
  organizerCommunicationDraftProjectionSchema,
  organizerCommunicationPurposeRevisionRefSchema,
  organizerMessagePreviewSourceVersionSchema,
  organizerMessageTemplateDetailSchema,
  type OrganizerCommunicationAudienceDraft,
  type OrganizerCommunicationAudienceOption,
  type OrganizerCommunicationDraftProjection,
  type OrganizerCommunicationPurposeRevisionRef,
  type OrganizerMessageTemplateDetail
} from '@jooevents/contracts/communications/organizer';
import { submissionTriageSourceRowSchema } from '@jooevents/contracts/submission-triage';
import type { OrganizerSubmissionContactDto } from '@jooevents/contracts';
import { canonicalJsonText, parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import type { SubmissionTriageSourcePort } from '@jooevents/submission-triage';
import type {
  OrganizerCommunicationScope
} from '@jooevents/communication-operations';
import type {
  SQLiteOrganizerAudiencePreviewRepository,
  SQLiteRegisteredAudienceSourceDelegate
} from './audience-preview';

/** Recorder default BLOCKED-4/12: the two decided-set audiences this wave mints. */
export const DECISION_AUDIENCE_STATUSES = Object.freeze(['accepted', 'declined'] as const);

export type DecisionAudienceStatus = (typeof DECISION_AUDIENCE_STATUSES)[number];

const CONTACT_REF_PREFIX = 'submission-contact:';

export type SQLiteDecisionAudienceErrorCode =
  | 'invalid_input'
  | 'data_corrupt'
  | 'contact_attribution_mismatch';

export class SQLiteDecisionAudienceError extends Error {
  constructor(readonly code: SQLiteDecisionAudienceErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteDecisionAudienceError';
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonText(value), 'utf8').digest('hex');
}

function evidenceRef(namespace: string, material: unknown) {
  const bound = digest({ namespace, material });
  return Object.freeze({
    evidenceRefId: `evi1_${bound.slice(0, 40)}`,
    evidenceVersion: 1,
    evidenceDigestSha256: bound
  });
}

function canonicalLabel(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function scope(value: OrganizerCommunicationScope): OrganizerAudienceScope {
  try {
    return Object.freeze({
      workspaceId: parseWorkspaceId(value.workspaceId),
      eventId: parseEventId(value.eventId)
    });
  } catch (error) {
    throw new SQLiteDecisionAudienceError('invalid_input', error);
  }
}

/**
 * The per-status decision-set source definition: a registered query over the
 * decision heads, resolved as `binding: 'current_snapshot'` at preview time.
 * The definition digest pins the exact query semantics, never a result set.
 */
export function decisionAudienceSourceDefinition(status: DecisionAudienceStatus) {
  const reference = Object.freeze({
    key: `audience-source.communication.decision-set.${status}`,
    version: 1
  });
  return organizerCommunicationDefinitionRefSchema.parse({
    reference,
    definitionDigestSha256: digest({
      schemaVersion: 1,
      kind: 'decision_set',
      binding: 'current_snapshot',
      reference,
      statuses: [status]
    })
  });
}

export function decisionAudienceRecipeSource(status: DecisionAudienceStatus) {
  const sourceDefinition = decisionAudienceSourceDefinition(status);
  const recipeId = `recipe.communication.decision-set.${status}`;
  return Object.freeze({
    kind: 'registered_query' as const,
    recipeId,
    recipeVersion: 1,
    recipeDigestSha256: digest({
      schemaVersion: 1,
      recipeId,
      recipeVersion: 1,
      sourceDefinition,
      statuses: [status]
    }),
    sourceDefinition
  });
}

const OPTION_LABELS: Readonly<Record<DecisionAudienceStatus, string>> = Object.freeze({
  accepted: 'Accepted submissions',
  declined: 'Declined submissions'
});

export function decisionAudienceOption(input: {
  readonly status: DecisionAudienceStatus;
  readonly purposeRevision: OrganizerCommunicationPurposeRevisionRef;
}): OrganizerCommunicationAudienceOption {
  const purposeRevision = organizerCommunicationPurposeRevisionRefSchema.parse(
    input.purposeRevision
  );
  const source = decisionAudienceRecipeSource(input.status);
  const audienceDraft: OrganizerCommunicationAudienceDraft =
    organizerCommunicationAudienceDraftSchema.parse({
      schemaVersion: 1,
      binding: 'current_snapshot',
      purposeRevision,
      source
    });
  const optionId = `option.communication.decision-set.${input.status}`;
  const body = {
    schemaVersion: 1,
    optionId,
    optionVersion: 1,
    label: OPTION_LABELS[input.status],
    // Honest by construction: membership is resolved live at preview time, so
    // an immutable option row never carries a count that can go stale.
    recipientEstimate: Object.freeze({
      knowledge: 'unknown' as const,
      reasonCode: 'audience.resolved_at_preview'
    }),
    audienceDraft
  };
  return organizerCommunicationAudienceOptionSchema.parse({
    ...body,
    optionDigestSha256: digest(body)
  });
}

/**
 * Mints the immutable decision-set recipes into
 * `communication_registered_audience_recipes` so `list_audience_options`
 * serves them. Deterministic identities make the mint idempotent; the caller
 * owns the transaction. Membership rows are never mirrored for these recipes —
 * the registered live delegate resolves the current decision heads instead.
 */
export function mintDecisionAudienceRecipes(input: {
  readonly repository: Pick<SQLiteOrganizerAudiencePreviewRepository, 'registerAudienceRecipe'>;
  readonly scope: OrganizerCommunicationScope;
  readonly purposeRevision: OrganizerCommunicationPurposeRevisionRef;
}): readonly OrganizerCommunicationAudienceOption[] {
  return Object.freeze(DECISION_AUDIENCE_STATUSES.map((status) => {
    const option = decisionAudienceOption({ status, purposeRevision: input.purposeRevision });
    input.repository.registerAudienceRecipe(input.scope, option);
    return option;
  }));
}

/** Classified contact read over the intake projection; both submission sources. */
export interface DecisionAudienceContactSource {
  readSubmissionContact(
    scope: { readonly workspaceId: string; readonly eventId: string },
    submissionId: string
  ): OrganizerSubmissionContactDto | undefined;
}

interface DecisionHeadRow {
  readonly submission_id: string;
  readonly state: string;
  readonly version: number;
  readonly digest_sha256: string;
  readonly evidence_id: string;
  readonly person_id: string;
  readonly participant_identity_id: string;
  readonly evidence_digest_sha256: string;
}

export interface SQLiteDecisionAudienceSource
  extends SQLiteRegisteredAudienceSourceDelegate, OrganizerMergeValueSource {
  readonly sourceDefinitionKeys: readonly string[];
}

/**
 * Live decision-set audience source: candidates come from the decision heads
 * joined to the immutable submission participant evidence, identity is carried
 * by personId-bearing evidence references, and the classified email value is
 * read through the intake contact projection only at resolution time. Email
 * text never appears in any row this module writes and is never a lookup key.
 */
export function createSQLiteDecisionAudienceSource(input: {
  readonly sqlite: Database;
  readonly contacts: DecisionAudienceContactSource;
  readonly submissions: Pick<SubmissionTriageSourcePort, 'readSourceRow'>;
  /** Keys the address lookup fingerprint; ephemeral runtimes pass a process key. */
  readonly addressFingerprintKeyBytes: Uint8Array;
}): SQLiteDecisionAudienceSource {
  if (!(input.addressFingerprintKeyBytes instanceof Uint8Array)
      || input.addressFingerprintKeyBytes.byteLength < 32) {
    throw new SQLiteDecisionAudienceError('invalid_input');
  }
  const fingerprintKey = Uint8Array.from(input.addressFingerprintKeyBytes);
  const byRecipeId = new Map(
    DECISION_AUDIENCE_STATUSES.map((status) => [decisionAudienceRecipeSource(status).recipeId, status])
  );
  const definitionKeys = Object.freeze(DECISION_AUDIENCE_STATUSES.map((status) =>
    decisionAudienceSourceDefinition(status).reference.key
  ));

  function headRows(selected: OrganizerAudienceScope, status: DecisionAudienceStatus): DecisionHeadRow[] {
    const rows = input.sqlite.query<DecisionHeadRow, [string, string, string, number]>(`
      SELECT d.submission_id, d.state, d.version, d.digest_sha256,
             p.evidence_id, p.person_id, p.participant_identity_id, p.evidence_digest_sha256
        FROM decision_heads d
        JOIN intake_submission_participant_evidence p
          ON p.workspace_id = d.workspace_id AND p.event_id = d.event_id
         AND p.submission_id = d.submission_id
       WHERE d.workspace_id = ? AND d.event_id = ? AND d.state = ?
       ORDER BY d.submission_id COLLATE BINARY
       LIMIT ?
    `).all(
      selected.workspaceId, selected.eventId, status,
      ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT + 1
    );
    if (rows.length > ORGANIZER_COMMUNICATION_AUDIENCE_MEMBER_LIMIT) {
      throw new OrganizerAudienceResolutionError('source_too_large');
    }
    return rows;
  }

  function headRow(selected: OrganizerAudienceScope, submissionId: string): DecisionHeadRow | undefined {
    const rows = input.sqlite.query<DecisionHeadRow, [string, string, string]>(`
      SELECT d.submission_id, d.state, d.version, d.digest_sha256,
             p.evidence_id, p.person_id, p.participant_identity_id, p.evidence_digest_sha256
        FROM decision_heads d
        JOIN intake_submission_participant_evidence p
          ON p.workspace_id = d.workspace_id AND p.event_id = d.event_id
         AND p.submission_id = d.submission_id
       WHERE d.workspace_id = ? AND d.event_id = ? AND d.submission_id = ?
       LIMIT 2
    `).all(selected.workspaceId, selected.eventId, submissionId);
    if (rows.length > 1) throw new SQLiteDecisionAudienceError('data_corrupt');
    return rows[0];
  }

  function participantName(
    selected: OrganizerAudienceScope,
    submissionId: string
  ): { readonly name: string | null; readonly title: string | null } {
    const raw = input.submissions.readSourceRow(selected, submissionId);
    if (raw === undefined) return Object.freeze({ name: null, title: null });
    let row;
    try {
      row = submissionTriageSourceRowSchema.parse(raw);
    } catch (error) {
      throw new SQLiteDecisionAudienceError('data_corrupt', error);
    }
    return Object.freeze({
      name: row.summary.primaryParticipantName,
      title: row.summary.title
    });
  }

  function candidateFor(
    selected: OrganizerAudienceScope,
    row: DecisionHeadRow
  ): OrganizerAudienceCandidate {
    const projected = participantName(selected, row.submission_id);
    const label = canonicalLabel(projected.name ?? '');
    return organizerAudienceCandidateSchema.parse({
      subjectRefId: row.submission_id,
      subjectVersion: row.version,
      personRefId: row.person_id,
      contactRefId: `${CONTACT_REF_PREFIX}${row.submission_id}`,
      safeLabel: label.length > 0 ? label : `Speaker ${row.person_id.slice(0, 8)}`,
      membershipEvidence: {
        evidenceRefId: row.evidence_id,
        evidenceVersion: 1,
        evidenceDigestSha256: row.evidence_digest_sha256
      }
    });
  }

  function statusFor(audience: OrganizerCommunicationAudienceDraft): DecisionAudienceStatus {
    if (audience.source.kind !== 'registered_query') {
      throw new OrganizerAudienceResolutionError('source_not_registered');
    }
    const status = byRecipeId.get(audience.source.recipeId);
    if (status === undefined
        || canonicalJsonText(audience.source) !== canonicalJsonText(decisionAudienceRecipeSource(status))) {
      throw new OrganizerAudienceResolutionError('source_not_registered');
    }
    return status;
  }

  return Object.freeze({
    sourceDefinitionKeys: definitionKeys,
    // Registered under every per-status definition key through one shared
    // delegate object per key; the router keys are supplied by the caller.
    sourceDefinitionKey: definitionKeys[0]!,

    ownsContactRef(contactRefId: string): boolean {
      return contactRefId.startsWith(CONTACT_REF_PREFIX);
    },

    resolveCurrentSnapshot({ scope: rawScope, audience }: {
      readonly scope: OrganizerAudienceScope;
      readonly audience: OrganizerCommunicationAudienceDraft;
    }): OrganizerAudienceSourceSnapshot {
      const selected = scope(rawScope);
      const parsed = organizerCommunicationAudienceDraftSchema.parse(audience);
      const status = statusFor(parsed);
      const rows = headRows(selected, status);
      const candidates = rows.map((row) => candidateFor(selected, row));
      const sourceVersion = organizerMessagePreviewSourceVersionSchema.parse({
        sourceKey: `decision-set.${status}`,
        sourceVersion: 1 + rows.reduce((sum, row) => sum + row.version, 0),
        digestSha256: digest({
          schemaVersion: 1,
          status,
          heads: rows.map((row) => ({
            submissionId: row.submission_id,
            version: row.version,
            digestSha256: row.digest_sha256
          }))
        })
      });
      return Object.freeze({
        source: parsed.source,
        candidates: Object.freeze(candidates),
        sourceVersions: Object.freeze([sourceVersion])
      });
    },

    resolveEmail({ scope: rawScope, purposeRevision, candidate }: {
      readonly scope: OrganizerAudienceScope;
      readonly purposeRevision: OrganizerCommunicationPurposeRevisionRef;
      readonly candidate: OrganizerAudienceCandidate;
      readonly asOf: string;
    }): OrganizerAddressPolicyResolution {
      const selected = scope(rawScope);
      const parsedCandidate = organizerAudienceCandidateSchema.parse(candidate);
      const purpose = organizerCommunicationPurposeRevisionRefSchema.parse(purposeRevision);
      if (!parsedCandidate.contactRefId.startsWith(CONTACT_REF_PREFIX)) {
        throw new OrganizerAudienceResolutionError('address_contact_mismatch');
      }
      const submissionId = parsedCandidate.contactRefId.slice(CONTACT_REF_PREFIX.length);
      const head = headRow(selected, submissionId);
      if (head === undefined || head.person_id !== parsedCandidate.personRefId) {
        throw new OrganizerAudienceResolutionError('address_evidence_invalid');
      }
      let contact: OrganizerSubmissionContactDto | undefined;
      try {
        contact = input.contacts.readSubmissionContact(selected, submissionId);
      } catch (error) {
        if (error instanceof TypeError && error.message.startsWith('intake_contact')) {
          return organizerAddressPolicyResolutionSchema.parse({
            kind: 'no_eligible_address',
            evidence: evidenceRef('decision-audience.address.unresolvable', {
              scope: selected, submissionId, reason: error.message
            })
          });
        }
        throw error;
      }
      if (contact === undefined) {
        return organizerAddressPolicyResolutionSchema.parse({
          kind: 'no_eligible_address',
          evidence: evidenceRef('decision-audience.address.absent', {
            scope: selected, submissionId
          })
        });
      }
      if (contact.personId !== parsedCandidate.personRefId
          || contact.submissionId !== submissionId) {
        throw new SQLiteDecisionAudienceError('contact_attribution_mismatch');
      }
      const addressMaterial = {
        scope: selected,
        submissionId,
        participantIdentityId: contact.participantIdentityId,
        sourceFieldId: contact.sourceFieldId
      };
      const purposeAllowed = purpose.purposeKey === DECISION_NOTIFICATION_PURPOSE_KEY
        || purpose.purposeKey === TASK_REMINDER_PURPOSE_KEY;
      return organizerAddressPolicyResolutionSchema.parse({
        kind: 'evaluated',
        selectionPolicy: {
          reference: { key: 'address-policy.communication.submission-primary-contact', version: 1 },
          definitionDigestSha256: digest({
            schemaVersion: 1,
            policy: 'submission_primary_contact',
            purposeKeys: [DECISION_NOTIFICATION_PURPOSE_KEY, TASK_REMINDER_PURPOSE_KEY]
          })
        },
        address: {
          addressRefId: `addr1_${digest(addressMaterial).slice(0, 40)}`,
          // Submission evidence is immutable, so the address version is fixed.
          addressVersion: 1,
          contactRefId: parsedCandidate.contactRefId,
          channel: 'email',
          lifecycle: 'active',
          lifecycleEvidence: evidenceRef('decision-audience.address.lifecycle', addressMaterial),
          lookupFingerprint: {
            profile: 'communication.address-fingerprint.hmac-sha256',
            version: 1,
            keyedValue: createHmac('sha256', fingerprintKey)
              .update(contact.email, 'utf8')
              .digest('hex')
          },
          classifiedValue: {
            payloadRefId: deterministicUuid('communication.decision-contact', addressMaterial),
            payloadRefVersion: 1,
            classification: 'communication.contact.email',
            value: contact.email
          }
        },
        purposeBasis: {
          state: purposeAllowed ? 'allowed' : 'denied',
          evidence: evidenceRef('decision-audience.purpose', {
            purposeKey: purpose.purposeKey,
            revisionId: purpose.revisionId,
            allowed: purposeAllowed
          })
        },
        consent: {
          // Transactional decision notifications per the recorded BLOCKED-5
          // default: no separate consent artifact is required or invented.
          state: 'not_required',
          evidence: evidenceRef('decision-audience.consent', {
            purposeKey: purpose.purposeKey,
            communicationClass: 'transactional'
          })
        },
        suppression: {
          state: 'clear',
          evidence: evidenceRef('decision-audience.suppression', {
            scope: selected, submissionId, store: 'none_mounted'
          })
        },
        doNotContact: {
          state: 'clear',
          evidence: evidenceRef('decision-audience.do-not-contact', {
            scope: selected, personId: contact.personId, store: 'none_mounted'
          })
        }
      });
    },

    resolveMergeValues({ scope: rawScope, candidate, fieldKeys }: {
      readonly scope: OrganizerAudienceScope;
      readonly candidate: OrganizerAudienceCandidate;
      readonly fieldKeys: readonly string[];
    }): readonly OrganizerResolvedMergeValue[] {
      const selected = scope(rawScope);
      const parsedCandidate = organizerAudienceCandidateSchema.parse(candidate);
      if (!parsedCandidate.contactRefId.startsWith(CONTACT_REF_PREFIX)) {
        throw new SQLiteDecisionAudienceError('invalid_input');
      }
      const submissionId = parsedCandidate.contactRefId.slice(CONTACT_REF_PREFIX.length);
      const values: OrganizerResolvedMergeValue[] = [];
      for (const fieldKey of [...new Set(fieldKeys)].sort()) {
        if (fieldKey === 'person.name') {
          values.push(Object.freeze({
            fieldKey,
            value: Object.freeze({ valueType: 'text' as const, value: parsedCandidate.safeLabel })
          }));
          continue;
        }
        if (fieldKey === 'submission.title') {
          const projected = participantName(selected, submissionId);
          if (projected.title === null) continue;
          values.push(Object.freeze({
            fieldKey,
            value: Object.freeze({ valueType: 'text' as const, value: projected.title })
          }));
          continue;
        }
        if (fieldKey === 'decision.status') {
          const head = headRow(selected, submissionId);
          if (head === undefined) continue;
          values.push(Object.freeze({
            fieldKey,
            value: Object.freeze({ valueType: 'text' as const, value: head.state })
          }));
        }
      }
      return Object.freeze(values);
    }
  });
}

/**
 * One delegate registration per decision-set definition key over the single
 * shared source, matching the audience-preview repository's one-key routing.
 */
export function decisionAudienceDelegates(
  source: SQLiteDecisionAudienceSource
): readonly SQLiteRegisteredAudienceSourceDelegate[] {
  return Object.freeze(source.sourceDefinitionKeys.map((key) => Object.freeze({
    sourceDefinitionKey: key,
    ownsContactRef: source.ownsContactRef,
    resolveCurrentSnapshot: source.resolveCurrentSnapshot,
    resolveEmail: source.resolveEmail
  })));
}

function deterministicUuid(namespace: string, material: unknown): string {
  const hex = digest({ namespace, material });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface DecisionRenderAuthoringReads {
  getDraft(
    scope: OrganizerCommunicationScope,
    ownerKey: string,
    input: unknown
  ): { readonly kind: 'success'; readonly data: unknown } | { readonly kind: 'outcome'; readonly outcome: unknown };
  getTemplate(
    scope: OrganizerCommunicationScope,
    input: unknown
  ): { readonly kind: 'success'; readonly data: unknown } | { readonly kind: 'outcome'; readonly outcome: unknown };
}

/**
 * Render-time content source over the frozen authoring reads. The draft owner
 * key is re-read from the draft row itself: the render strategy runs inside an
 * already-authorized preview preparation and must reproduce the reviewed
 * content of that exact draft revision, whoever owns it.
 */
export function createSQLiteDraftRenderContentSource(input: {
  readonly sqlite: Database;
  readonly authoring: DecisionRenderAuthoringReads;
}): OrganizerRenderContentSource {
  return Object.freeze({
    readContent({ scope: rawScope, draft }: {
      readonly scope: OrganizerAudienceScope;
      readonly draft: { readonly draftId: string; readonly version: number };
    }): OrganizerRenderContentBinding | undefined {
      const selected = scope(rawScope);
      const rows = input.sqlite.query<{ readonly owner_key: string }, [string, string, string]>(`
        SELECT owner_key FROM communication_drafts
         WHERE workspace_id = ? AND event_id = ? AND draft_id = ? LIMIT 2
      `).all(selected.workspaceId, selected.eventId, draft.draftId);
      if (rows.length > 1) throw new SQLiteDecisionAudienceError('data_corrupt');
      if (rows[0] === undefined) return undefined;
      const draftResult = input.authoring.getDraft(selected, rows[0].owner_key, {
        draftId: draft.draftId,
        expectedVersion: draft.version
      });
      if (draftResult.kind !== 'success') return undefined;
      let projection: OrganizerCommunicationDraftProjection;
      try {
        projection = organizerCommunicationDraftProjectionSchema.parse(draftResult.data);
      } catch (error) {
        throw new SQLiteDecisionAudienceError('data_corrupt', error);
      }
      if (projection.content === undefined) return undefined;
      if (projection.templateRevision === undefined) {
        return Object.freeze({ messageContent: projection.content });
      }
      const templateResult = input.authoring.getTemplate(selected, {
        templateId: projection.templateRevision.templateId,
        revisionNumber: projection.templateRevision.revisionNumber
      });
      if (templateResult.kind !== 'success') return undefined;
      let template: OrganizerMessageTemplateDetail;
      try {
        template = organizerMessageTemplateDetailSchema.parse(templateResult.data);
      } catch (error) {
        throw new SQLiteDecisionAudienceError('data_corrupt', error);
      }
      return Object.freeze({
        messageContent: projection.content,
        template: Object.freeze({
          revision: template.revision,
          content: template.content,
          fieldBindings: template.fieldBindings
        })
      });
    }
  });
}

export const DECISION_NOTIFICATION_SEED_OWNER_KEY = 'system.communication.decision-seed';

export interface DecisionNotificationSeedAuthoring {
  storeAuthoringPayload(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly ownerKey: string;
    readonly payloadRefId: string;
    readonly payload: unknown;
    readonly createdAt: unknown;
  }): { readonly payloadRefId: string };
}

export interface DecisionNotificationSeedResult {
  readonly purposeRevision: OrganizerCommunicationPurposeRevisionRef;
  readonly templates: readonly Readonly<{
    status: DecisionAudienceStatus;
    templateId: string;
    templateRevisionId: string;
    revisionNumber: 1;
    digestSha256: string;
  }>[];
}

function templateContent(status: DecisionAudienceStatus) {
  // Inline text nodes are canonical (no edge whitespace), so separators lead
  // with punctuation and merge fields start their segments.
  const opening = status === 'accepted'
    ? ', good news — your submission was accepted.'
    : ', thank you for submitting. After review, your submission was not selected this time.';
  return Object.freeze({
    kind: 'email/v1' as const,
    subject: [
      { kind: 'merge_field' as const, fieldKey: 'submission.title' },
      { kind: 'text' as const, value: status === 'accepted' ? ': accepted' : ': decision update' }
    ],
    body: {
      mode: 'composed' as const,
      blocks: [
        {
          kind: 'paragraph' as const,
          content: [
            { kind: 'merge_field' as const, fieldKey: 'person.name' },
            { kind: 'text' as const, value: opening }
          ]
        },
        {
          kind: 'detail_rows' as const,
          rows: [
            {
              label: [{ kind: 'text' as const, value: 'Submission' }],
              value: [{ kind: 'merge_field' as const, fieldKey: 'submission.title' }]
            },
            {
              label: [{ kind: 'text' as const, value: 'Decision' }],
              value: [{ kind: 'merge_field' as const, fieldKey: 'decision.status' }]
            }
          ]
        }
      ]
    },
    plainTextPolicy: 'derive_v1' as const,
    attachmentSlotKeys: []
  });
}

const TEMPLATE_FIELD_BINDINGS = Object.freeze([
  Object.freeze({
    fieldKey: 'decision.status',
    requirement: 'required' as const,
    fallback: Object.freeze({ kind: 'none' as const })
  }),
  Object.freeze({
    fieldKey: 'person.name',
    requirement: 'required' as const,
    fallback: Object.freeze({ kind: 'none' as const })
  }),
  Object.freeze({
    fieldKey: 'submission.title',
    requirement: 'required' as const,
    fallback: Object.freeze({ kind: 'none' as const })
  })
]);

/**
 * Verified at implementation (BLOCKED-4): the authoring surface has no
 * template-create mutation, and nothing feeds `communication_purposes` or
 * `message_templates` outside tests. This idempotent seed — not a new mutation
 * operation — therefore installs the one transactional `decision_notification`
 * purpose and the two decision-notification templates. The caller owns the
 * transaction; identities are deterministic so a re-run converges.
 */
export function seedDecisionNotificationCommunications(input: {
  readonly sqlite: Database;
  readonly authoring: DecisionNotificationSeedAuthoring;
  readonly scope: OrganizerCommunicationScope;
  readonly mergeRegistry: {
    readonly reference: { readonly key: string; readonly version: number };
    readonly definitionDigestSha256: string;
  };
  readonly renderer: {
    readonly reference: { readonly key: string; readonly version: number };
    readonly definitionDigestSha256: string;
  };
  readonly now: string;
}): DecisionNotificationSeedResult {
  if (!input.sqlite.inTransaction) throw new SQLiteDecisionAudienceError('invalid_input');
  const selected = scope(input.scope);
  const renderer = organizerCommunicationDefinitionRefSchema.parse(input.renderer);
  const mergeRegistry = organizerCommunicationDefinitionRefSchema.parse(input.mergeRegistry);
  const purposeId = deterministicUuid('communication.purpose.decision-notification', selected);
  const revisionId = deterministicUuid('communication.purpose-revision.decision-notification', selected);
  const allowedAudienceSources = DECISION_AUDIENCE_STATUSES
    .map((status) => decisionAudienceSourceDefinition(status))
    .sort((left, right) =>
      `${left.reference.key}@${left.reference.version}`
        < `${right.reference.key}@${right.reference.version}` ? -1 : 1
    );
  const policyDigestSha256 = digest({
    schemaVersion: 1,
    purposeKey: DECISION_NOTIFICATION_PURPOSE_KEY,
    communicationClass: 'transactional',
    consent: 'not_required',
    allowedAudienceSources
  });
  const purposeRevision = organizerCommunicationPurposeRevisionRefSchema.parse({
    purposeId,
    purposeKey: DECISION_NOTIFICATION_PURPOSE_KEY,
    revisionId,
    revisionNumber: 1,
    digestSha256: digest({
      schemaVersion: 1,
      purposeId,
      purposeKey: DECISION_NOTIFICATION_PURPOSE_KEY,
      revisionId,
      revisionNumber: 1,
      policyDigestSha256
    })
  });
  const existingPurpose = input.sqlite.query<{ readonly purpose_key: string }, [string, string, string]>(`
    SELECT purpose_key FROM communication_purposes
     WHERE workspace_id = ? AND event_id = ? AND purpose_id = ? LIMIT 2
  `).all(selected.workspaceId, selected.eventId, purposeId);
  if (existingPurpose.length > 1) throw new SQLiteDecisionAudienceError('data_corrupt');
  if (existingPurpose.length === 0) {
    input.sqlite.query(`
      INSERT INTO communication_purposes (
        workspace_id, event_id, purpose_id, purpose_key, lifecycle, current_revision_id
      ) VALUES (?, ?, ?, ?, 'active', ?)
    `).run(
      selected.workspaceId, selected.eventId, purposeId,
      DECISION_NOTIFICATION_PURPOSE_KEY, revisionId
    );
    input.sqlite.query(`
      INSERT INTO communication_purpose_revisions (
        workspace_id, event_id, purpose_id, purpose_key, revision_id, revision_number,
        digest_sha256, label, communication_class, policy_digest_sha256, description,
        allowed_audience_sources_json
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'transactional', ?, ?, ?)
    `).run(
      selected.workspaceId, selected.eventId, purposeId, DECISION_NOTIFICATION_PURPOSE_KEY,
      revisionId, purposeRevision.digestSha256, 'Decision notifications',
      policyDigestSha256,
      'Transactional acceptance and decline notifications for decided submissions.',
      canonicalJsonText(allowedAudienceSources)
    );
  } else if (existingPurpose[0]!.purpose_key !== DECISION_NOTIFICATION_PURPOSE_KEY) {
    throw new SQLiteDecisionAudienceError('data_corrupt');
  }

  const templates = DECISION_AUDIENCE_STATUSES.map((status) => {
    const templateId = deterministicUuid(`communication.template.decision-${status}`, selected);
    const templateRevisionId = deterministicUuid(
      `communication.template-revision.decision-${status}`, selected
    );
    const contentPayloadRefId = deterministicUuid(
      `communication.template-content.decision-${status}`, selected
    );
    const bindingsPayloadRefId = deterministicUuid(
      `communication.template-bindings.decision-${status}`, selected
    );
    const digestSha256 = digest({
      schemaVersion: 1,
      templateId,
      templateRevisionId,
      revisionNumber: 1,
      content: templateContent(status),
      fieldBindings: TEMPLATE_FIELD_BINDINGS,
      renderer,
      mergeRegistry
    });
    const existing = input.sqlite.query<{ readonly template_key: string }, [string, string, string]>(`
      SELECT template_key FROM message_templates
       WHERE workspace_id = ? AND event_id = ? AND template_id = ? LIMIT 2
    `).all(selected.workspaceId, selected.eventId, templateId);
    if (existing.length > 1) throw new SQLiteDecisionAudienceError('data_corrupt');
    if (existing.length === 0) {
      input.authoring.storeAuthoringPayload({
        scope: selected,
        ownerKey: DECISION_NOTIFICATION_SEED_OWNER_KEY,
        payloadRefId: contentPayloadRefId,
        createdAt: input.now,
        payload: {
          payloadKind: 'template_content',
          schemaVersion: 1,
          value: templateContent(status)
        }
      });
      input.authoring.storeAuthoringPayload({
        scope: selected,
        ownerKey: DECISION_NOTIFICATION_SEED_OWNER_KEY,
        payloadRefId: bindingsPayloadRefId,
        createdAt: input.now,
        payload: {
          payloadKind: 'template_field_bindings',
          schemaVersion: 1,
          value: TEMPLATE_FIELD_BINDINGS
        }
      });
      input.sqlite.query(`
        INSERT INTO message_templates (
          workspace_id, event_id, template_id, template_key, template_name, lifecycle,
          purpose_revision_id, current_revision_id
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        selected.workspaceId, selected.eventId, templateId, `decision.${status}`,
        status === 'accepted' ? 'Decision accepted' : 'Decision declined',
        revisionId, templateRevisionId
      );
      input.sqlite.query(`
        INSERT INTO message_template_revisions (
          workspace_id, event_id, template_id, template_revision_id, revision_number,
          digest_sha256, content_payload_ref_id, field_bindings_payload_ref_id,
          renderer_key, renderer_version, renderer_digest_sha256,
          merge_registry_key, merge_registry_version, merge_registry_digest_sha256
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        selected.workspaceId, selected.eventId, templateId, templateRevisionId,
        digestSha256, contentPayloadRefId, bindingsPayloadRefId,
        renderer.reference.key, renderer.reference.version, renderer.definitionDigestSha256,
        mergeRegistry.reference.key, mergeRegistry.reference.version,
        mergeRegistry.definitionDigestSha256
      );
    }
    return Object.freeze({
      status,
      templateId,
      templateRevisionId,
      revisionNumber: 1 as const,
      digestSha256
    });
  });
  return Object.freeze({ purposeRevision, templates: Object.freeze(templates) });
}
