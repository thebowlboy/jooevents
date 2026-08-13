import {
  ORGANIZER_COMMUNICATION_RECIPIENT_LIMIT,
  organizerCommunicationAudienceDraftSchema,
  organizerCommunicationDefinitionRefSchema,
  organizerCommunicationDigestSchema,
  organizerCommunicationOpaqueIdSchema,
  organizerCommunicationRecipientResolutionIdSchema,
  organizerCommunicationStableKeySchema,
  organizerCommunicationVersionSchema,
  organizerMessageBatchPreviewDetailSchema,
  organizerMessageBatchPreviewGetInputSchema,
  organizerMessagePreviewIdentitySchema,
  organizerMessagePreviewRecipientListInputSchema,
  organizerMessagePreviewRecipientPageSchema,
  organizerMessagePreviewRecipientRowSchema,
  organizerMessagePreviewSummarySchema,
  organizerMessageTemplateRevisionRefSchema,
  organizerCommunicationPurposeRevisionRefSchema,
  organizerRenderedAttachmentSchema,
  organizerServerRenderedEmailSchema,
  type OrganizerCommunicationAudienceDraft,
  type OrganizerCommunicationPurposeRevisionRef,
  type OrganizerMessageBatchPreviewDetail,
  type OrganizerMessagePreviewIdentity,
  type OrganizerMessagePreviewRecipientRow,
  type OrganizerMessagePreviewSummary,
  type OrganizerMessageTemplateRevisionRef
} from '@jooevents/contracts/communications/organizer';
import { canonicalJsonText, parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  resolveOrganizerAudience,
  type OrganizerAddressPolicyPort,
  type OrganizerAudienceCandidate,
  type OrganizerAudienceEvidenceRef,
  type OrganizerAudienceScope,
  type OrganizerAudienceSourcePort,
  type OrganizerClassifiedEmailAddress,
  type OrganizerResolvedAudienceMember
} from './resolution';

type OrganizerServerRenderedEmail = ReturnType<typeof organizerServerRenderedEmailSchema.parse>;
type OrganizerRenderedAttachment = ReturnType<typeof organizerRenderedAttachmentSchema.parse>;
type OrganizerDefinitionRef = ReturnType<typeof organizerCommunicationDefinitionRefSchema.parse>;

export interface OrganizerPreviewDraft {
  readonly draftId: string;
  readonly version: number;
  readonly purposeRevision: OrganizerCommunicationPurposeRevisionRef;
  readonly templateRevision?: OrganizerMessageTemplateRevisionRef;
  readonly audience: OrganizerCommunicationAudienceDraft;
}

export interface OrganizerPreviewDigestProfile {
  readonly key: string;
  readonly version: number;
}

export interface OrganizerPreviewOpaqueTokenCodec {
  issueAudienceSpecId(input: {
    readonly scope: OrganizerAudienceScope;
    readonly draft: OrganizerPreviewDraft;
    readonly previewGeneration: number;
  }): string;
  issueRecipientResolutionId(input: {
    readonly audienceSpecId: string;
    readonly draftId: string;
    readonly draftVersion: number;
    readonly previewGeneration: number;
    readonly subjectRefId: string;
    readonly ordinal: number;
  }): string;
  issueReleaseId(input: {
    readonly recipientResolutionId: string;
    readonly addressRefId: string;
    readonly addressVersion: number;
  }): string;
  issueCursor(input: {
    readonly bindingDigestSha256: string;
    readonly offset: number;
  }): string;
  readCursor(input: {
    readonly bindingDigestSha256: string;
    readonly cursor: string;
  }): number | undefined;
}

export type OrganizerPreviewRenderResult =
  | {
      readonly kind: 'rendered';
      readonly render: OrganizerServerRenderedEmail;
      readonly mergeFallbackFieldKeys: readonly string[];
    }
  | {
      readonly kind: 'blocked';
      readonly reasonCode: string;
      readonly mergeFallbackFieldKeys: readonly string[];
    };

export interface OrganizerPreviewRenderPort {
  render(input: {
    readonly scope: OrganizerAudienceScope;
    readonly draft: OrganizerPreviewDraft;
    readonly member: Extract<OrganizerResolvedAudienceMember, { readonly state: 'eligible' }>;
    readonly recipientResolutionId: string;
    readonly releaseId: string;
    readonly renderer: OrganizerDefinitionRef;
    readonly mergeRegistry: OrganizerDefinitionRef;
  }): OrganizerPreviewRenderResult | Promise<OrganizerPreviewRenderResult>;
}

interface OrganizerPreparedPreviewRowBase {
  readonly recipientResolutionId: string;
  readonly candidate: OrganizerAudienceCandidate;
  readonly address?: OrganizerClassifiedEmailAddress;
  readonly evidence: readonly OrganizerAudienceEvidenceRef[];
  readonly mergeFallbackFieldKeys: readonly string[];
}

export type OrganizerPreparedPreviewRow =
  | (OrganizerPreparedPreviewRowBase & {
      readonly state: 'included';
      readonly releaseId: string;
      readonly releaseDigestSha256: string;
      readonly render: OrganizerServerRenderedEmail;
    })
  | (OrganizerPreparedPreviewRowBase & {
      readonly state: 'excluded' | 'blocked';
      readonly reasonCode: string;
    });

export interface OrganizerPreparedMessageBatchPreview {
  readonly scope: OrganizerAudienceScope;
  readonly draft: OrganizerPreviewDraft;
  readonly previewGeneration: number;
  readonly digestProfile: OrganizerPreviewDigestProfile;
  readonly summary: OrganizerMessagePreviewSummary;
  readonly rows: readonly OrganizerPreparedPreviewRow[];
}

export interface OrganizerPrepareMessageBatchPreviewInput {
  readonly scope: OrganizerAudienceScope;
  readonly draft: OrganizerPreviewDraft;
  readonly previewGeneration: number;
  readonly digestProfile: OrganizerPreviewDigestProfile;
  readonly renderer: OrganizerDefinitionRef;
  readonly mergeRegistry: OrganizerDefinitionRef;
  readonly asOf: string;
  readonly source: OrganizerAudienceSourcePort;
  readonly addressPolicy: OrganizerAddressPolicyPort;
  readonly opaqueTokens: OrganizerPreviewOpaqueTokenCodec;
  readonly render: OrganizerPreviewRenderPort;
}

export type OrganizerAudiencePreviewErrorCode =
  | 'invalid_input'
  | 'purpose_mismatch'
  | 'opaque_identity_invalid'
  | 'opaque_identity_collision'
  | 'render_contract_mismatch'
  | 'stale_preview'
  | 'recipient_not_available'
  | 'invalid_cursor';

export class OrganizerAudiencePreviewError extends Error {
  constructor(readonly code: OrganizerAudiencePreviewErrorCode) {
    super(code);
    this.name = 'OrganizerAudiencePreviewError';
  }
}

function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJsonText(value))));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function equalAscii(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

function canonicalDraft(input: OrganizerPreviewDraft): OrganizerPreviewDraft {
  try {
    const draftId = organizerCommunicationOpaqueIdSchema.parse(input.draftId);
    const version = organizerCommunicationVersionSchema.parse(input.version);
    const purposeRevision = organizerCommunicationPurposeRevisionRefSchema.parse(input.purposeRevision);
    const audience = organizerCommunicationAudienceDraftSchema.parse(input.audience);
    const templateRevision = input.templateRevision === undefined
      ? undefined
      : organizerMessageTemplateRevisionRefSchema.parse(input.templateRevision);
    if (!sameJson(purposeRevision, audience.purposeRevision)) {
      throw new OrganizerAudiencePreviewError('purpose_mismatch');
    }
    return Object.freeze({
      draftId,
      version,
      purposeRevision: Object.freeze({ ...purposeRevision }),
      ...(templateRevision === undefined
        ? {}
        : { templateRevision: Object.freeze({ ...templateRevision }) }),
      audience: Object.freeze({
        ...audience,
        purposeRevision: Object.freeze({ ...audience.purposeRevision }),
        source: Object.freeze({ ...audience.source })
      })
    });
  } catch (error) {
    if (error instanceof OrganizerAudiencePreviewError) throw error;
    throw new OrganizerAudiencePreviewError('invalid_input');
  }
}

function canonicalProfile(input: OrganizerPreviewDigestProfile): OrganizerPreviewDigestProfile {
  try {
    return Object.freeze({
      key: organizerCommunicationStableKeySchema.parse(input.key),
      version: organizerCommunicationVersionSchema.parse(input.version)
    });
  } catch {
    throw new OrganizerAudiencePreviewError('invalid_input');
  }
}

function redactedAddress(address: OrganizerClassifiedEmailAddress | undefined): unknown {
  if (address === undefined) return null;
  return {
    addressRefId: address.addressRefId,
    addressVersion: address.addressVersion,
    contactRefId: address.contactRefId,
    channel: address.channel,
    lifecycle: address.lifecycle,
    lifecycleEvidence: address.lifecycleEvidence,
    lookupFingerprint: address.lookupFingerprint,
    classifiedValueRef: {
      payloadRefId: address.classifiedValue.payloadRefId,
      payloadRefVersion: address.classifiedValue.payloadRefVersion,
      classification: address.classifiedValue.classification
    }
  };
}

function redactedMember(member: OrganizerResolvedAudienceMember): unknown {
  return {
    state: member.state,
    candidate: member.candidate,
    address: redactedAddress(member.address),
    addressPolicy: member.addressPolicy ?? null,
    evidence: member.evidence,
    policyEvidence: member.policyEvidence,
    ...(member.state === 'excluded' ? { reasonCode: member.reasonCode } : {})
  };
}

function freezeRender(render: OrganizerServerRenderedEmail): OrganizerServerRenderedEmail {
  return Object.freeze({
    ...render,
    renderer: Object.freeze({
      reference: Object.freeze({ ...render.renderer.reference }),
      definitionDigestSha256: render.renderer.definitionDigestSha256
    }),
    mergeRegistry: Object.freeze({
      reference: Object.freeze({ ...render.mergeRegistry.reference }),
      definitionDigestSha256: render.mergeRegistry.definitionDigestSha256
    }),
    attachments: render.attachments.map((attachment) => Object.freeze({ ...attachment })),
    warningCodes: [...render.warningCodes]
  });
}

function canonicalFallbackKeys(values: readonly string[]): readonly string[] {
  let result: string[];
  try {
    if (!Array.isArray(values) || values.length > 100) throw new TypeError();
    result = values.map((value) => organizerCommunicationStableKeySchema.parse(value));
  } catch {
    throw new OrganizerAudiencePreviewError('render_contract_mismatch');
  }
  result.sort(compareText);
  if (new Set(result).size !== result.length) {
    throw new OrganizerAudiencePreviewError('render_contract_mismatch');
  }
  return Object.freeze(result);
}

function validateRenderedResult(input: {
  readonly raw: OrganizerPreviewRenderResult;
  readonly recipientResolutionId: string;
  readonly releaseId: string;
  readonly renderer: OrganizerDefinitionRef;
  readonly mergeRegistry: OrganizerDefinitionRef;
}): OrganizerPreviewRenderResult {
  const mergeFallbackFieldKeys = canonicalFallbackKeys(input.raw.mergeFallbackFieldKeys);
  if (input.raw.kind === 'blocked') {
    try {
      return Object.freeze({
        kind: 'blocked',
        reasonCode: organizerCommunicationStableKeySchema.parse(input.raw.reasonCode),
        mergeFallbackFieldKeys
      });
    } catch {
      throw new OrganizerAudiencePreviewError('render_contract_mismatch');
    }
  }
  let render: OrganizerServerRenderedEmail;
  try {
    render = organizerServerRenderedEmailSchema.parse(input.raw.render);
  } catch {
    throw new OrganizerAudiencePreviewError('render_contract_mismatch');
  }
  if (render.recipientResolutionId !== input.recipientResolutionId
      || render.releaseId !== input.releaseId
      || !sameJson(render.renderer, input.renderer)
      || !sameJson(render.mergeRegistry, input.mergeRegistry)) {
    throw new OrganizerAudiencePreviewError('render_contract_mismatch');
  }
  return Object.freeze({ kind: 'rendered', render: freezeRender(render), mergeFallbackFieldKeys });
}

function memberResolutionId(input: {
  readonly opaqueTokens: OrganizerPreviewOpaqueTokenCodec;
  readonly audienceSpecId: string;
  readonly draft: OrganizerPreviewDraft;
  readonly previewGeneration: number;
  readonly member: OrganizerResolvedAudienceMember;
  readonly ordinal: number;
}): string {
  try {
    return organizerCommunicationRecipientResolutionIdSchema.parse(
      input.opaqueTokens.issueRecipientResolutionId({
        audienceSpecId: input.audienceSpecId,
        draftId: input.draft.draftId,
        draftVersion: input.draft.version,
        previewGeneration: input.previewGeneration,
        subjectRefId: input.member.candidate.subjectRefId,
        ordinal: input.ordinal
      })
    );
  } catch {
    throw new OrganizerAudiencePreviewError('opaque_identity_invalid');
  }
}

/** Builds an inert exact preview. It never writes authority, effects, jobs, or provider work. */
export async function prepareOrganizerMessageBatchPreview(
  input: OrganizerPrepareMessageBatchPreviewInput
): Promise<OrganizerPreparedMessageBatchPreview> {
  const draft = canonicalDraft(input.draft);
  const digestProfile = canonicalProfile(input.digestProfile);
  let scope: OrganizerAudienceScope;
  let previewGeneration: number;
  let renderer: OrganizerDefinitionRef;
  let mergeRegistry: OrganizerDefinitionRef;
  try {
    scope = Object.freeze({
      workspaceId: parseWorkspaceId(input.scope.workspaceId),
      eventId: parseEventId(input.scope.eventId)
    });
    previewGeneration = organizerCommunicationVersionSchema.parse(input.previewGeneration);
    renderer = organizerCommunicationDefinitionRefSchema.parse(input.renderer);
    mergeRegistry = organizerCommunicationDefinitionRefSchema.parse(input.mergeRegistry);
  } catch {
    throw new OrganizerAudiencePreviewError('invalid_input');
  }
  let audienceSpecId: string;
  try {
    audienceSpecId = organizerCommunicationOpaqueIdSchema.parse(input.opaqueTokens.issueAudienceSpecId({
      scope,
      draft,
      previewGeneration
    }));
  } catch {
    throw new OrganizerAudiencePreviewError('opaque_identity_invalid');
  }
  const resolved = await resolveOrganizerAudience({
    scope,
    audience: draft.audience,
    asOf: input.asOf,
    source: input.source,
    addressPolicy: input.addressPolicy
  });
  const rows: OrganizerPreparedPreviewRow[] = [];
  const seenResolutionIds = new Set<string>();
  const seenReleaseIds = new Set<string>();

  for (let ordinal = 0; ordinal < resolved.members.length; ordinal += 1) {
    const member = resolved.members[ordinal]!;
    const recipientResolutionId = memberResolutionId({
      opaqueTokens: input.opaqueTokens,
      audienceSpecId,
      draft,
      previewGeneration,
      member,
      ordinal
    });
    if (seenResolutionIds.has(recipientResolutionId)) {
      throw new OrganizerAudiencePreviewError('opaque_identity_collision');
    }
    seenResolutionIds.add(recipientResolutionId);
    const base = {
      recipientResolutionId,
      candidate: member.candidate,
      ...(member.address === undefined ? {} : { address: member.address }),
      evidence: member.evidence,
      mergeFallbackFieldKeys: Object.freeze([] as string[])
    };
    if (member.state === 'excluded') {
      rows.push(Object.freeze({ ...base, state: 'excluded', reasonCode: member.reasonCode }));
      continue;
    }
    let releaseId: string;
    try {
      releaseId = organizerCommunicationOpaqueIdSchema.parse(input.opaqueTokens.issueReleaseId({
        recipientResolutionId,
        addressRefId: member.address.addressRefId,
        addressVersion: member.address.addressVersion
      }));
    } catch {
      throw new OrganizerAudiencePreviewError('opaque_identity_invalid');
    }
    if (seenReleaseIds.has(releaseId)) {
      throw new OrganizerAudiencePreviewError('opaque_identity_collision');
    }
    seenReleaseIds.add(releaseId);
    const rendered = validateRenderedResult({
      raw: await input.render.render({
        scope,
        draft,
        member,
        recipientResolutionId,
        releaseId,
        renderer,
        mergeRegistry
      }),
      recipientResolutionId,
      releaseId,
      renderer,
      mergeRegistry
    });
    if (rendered.kind === 'blocked') {
      rows.push(Object.freeze({
        ...base,
        state: 'blocked',
        reasonCode: rendered.reasonCode,
        mergeFallbackFieldKeys: rendered.mergeFallbackFieldKeys
      }));
      continue;
    }
    rows.push(Object.freeze({
      ...base,
      state: 'included',
      releaseId,
      releaseDigestSha256: rendered.render.releaseDigestSha256,
      render: rendered.render,
      mergeFallbackFieldKeys: rendered.mergeFallbackFieldKeys
    }));
  }

  const counts = Object.freeze({
    visibleCandidateCount: rows.length,
    includedCount: rows.filter((row) => row.state === 'included').length,
    excludedCount: rows.filter((row) => row.state === 'excluded').length,
    blockedCount: rows.filter((row) => row.state === 'blocked').length
  });
  const reasonCodes = Object.freeze([...new Set(rows.flatMap((row) =>
    row.state === 'included' ? [] : [row.reasonCode]
  ))].sort(compareText));
  const membershipDigestSha256 = digest({
    schemaVersion: 1,
    audience: resolved.audience,
    sourceVersions: resolved.sourceVersions,
    members: resolved.members.map((member) => ({
      subjectRefId: member.candidate.subjectRefId,
      subjectVersion: member.candidate.subjectVersion,
      personRefId: member.candidate.personRefId,
      contactRefId: member.candidate.contactRefId,
      membershipEvidence: member.candidate.membershipEvidence
    }))
  });
  const evidenceDigestSha256 = digest({
    schemaVersion: 1,
    members: resolved.members.map(redactedMember),
    releases: rows.map((row) => row.state === 'included'
      ? {
          recipientResolutionId: row.recipientResolutionId,
          releaseId: row.releaseId,
          releaseDigestSha256: row.releaseDigestSha256,
          outputDigestSha256: row.render.outputDigestSha256,
          resolvedInputDigestSha256: row.render.resolvedInputDigestSha256,
          attachmentManifestDigestSha256: row.render.attachmentManifestDigestSha256
        }
      : {
          recipientResolutionId: row.recipientResolutionId,
          state: row.state,
          reasonCode: row.reasonCode
        })
  });
  const previewDigestSha256 = digest({
    schemaVersion: 1,
    digestProfile,
    audienceSpecId,
    draftId: draft.draftId,
    draftVersion: draft.version,
    previewGeneration,
    purposeRevision: draft.purposeRevision,
    templateRevision: draft.templateRevision ?? null,
    audience: draft.audience,
    counts,
    membershipDigestSha256,
    evidenceDigestSha256,
    reasonCodes,
    sourceVersions: resolved.sourceVersions,
    renderer,
    mergeRegistry
  });
  const summary = organizerMessagePreviewSummarySchema.parse({
    schemaVersion: 1,
    identity: {
      audienceSpecId,
      draftId: draft.draftId,
      draftVersion: draft.version,
      previewGeneration,
      previewDigestProfile: digestProfile.key,
      previewDigestVersion: digestProfile.version,
      previewDigestSha256
    },
    purposeRevision: draft.purposeRevision,
    ...(draft.templateRevision === undefined ? {} : { templateRevision: draft.templateRevision }),
    counts,
    membershipDigestSha256,
    evidenceDigestSha256,
    reasonCodes,
    sourceVersions: resolved.sourceVersions,
    renderer,
    mergeRegistry
  });
  return Object.freeze({
    scope,
    draft,
    previewGeneration,
    digestProfile,
    summary: Object.freeze(summary),
    rows: Object.freeze(rows)
  });
}

function exactIdentity(
  snapshot: OrganizerPreparedMessageBatchPreview,
  input: unknown
): OrganizerMessagePreviewIdentity {
  let identity: OrganizerMessagePreviewIdentity;
  try {
    identity = organizerMessagePreviewIdentitySchema.parse(input);
  } catch {
    throw new OrganizerAudiencePreviewError('invalid_input');
  }
  if (!sameJson(identity, snapshot.summary.identity)) {
    throw new OrganizerAudiencePreviewError('stale_preview');
  }
  return identity;
}

export type OrganizerContactDisclosure = 'masked' | 'exact_authorized' | 'withheld';

function maskEmail(value: string): string {
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) return '***@***';
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  const dot = domain.lastIndexOf('.');
  const domainName = dot > 0 ? domain.slice(0, dot) : domain;
  const suffix = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${domainName.slice(0, 1)}***${suffix}`;
}

function channelProjection(
  row: OrganizerPreparedPreviewRow,
  disclosure: OrganizerContactDisclosure
): OrganizerMessagePreviewRecipientRow['channel'] {
  if (row.address === undefined) {
    return Object.freeze({ disclosure: 'absent', reasonCode: 'address.no_eligible' });
  }
  if (disclosure === 'withheld') {
    return Object.freeze({ disclosure: 'absent', reasonCode: 'contact.disclosure_denied' });
  }
  const maskedValue = maskEmail(row.address.classifiedValue.value);
  return disclosure === 'exact_authorized'
    ? Object.freeze({ disclosure: 'exact_authorized', maskedValue, exactValue: row.address.classifiedValue.value })
    : Object.freeze({ disclosure: 'masked', maskedValue });
}

export function projectOrganizerPreviewRecipientRow(
  row: OrganizerPreparedPreviewRow,
  disclosure: OrganizerContactDisclosure = 'masked'
): OrganizerMessagePreviewRecipientRow {
  const base = {
    recipientResolutionId: row.recipientResolutionId,
    safeLabel: row.candidate.safeLabel,
    channel: channelProjection(row, disclosure),
    mergeFallbackFieldKeys: row.mergeFallbackFieldKeys
  };
  return organizerMessagePreviewRecipientRowSchema.parse(row.state === 'included'
    ? {
        ...base,
        state: 'included',
        releaseId: row.releaseId,
        releaseDigestSha256: row.releaseDigestSha256
      }
    : { ...base, state: row.state, reasonCode: row.reasonCode });
}

export function getOrganizerMessageBatchPreview(input: {
  readonly snapshot: OrganizerPreparedMessageBatchPreview;
  readonly query: unknown;
}): OrganizerMessageBatchPreviewDetail {
  let query: ReturnType<typeof organizerMessageBatchPreviewGetInputSchema.parse>;
  try {
    query = organizerMessageBatchPreviewGetInputSchema.parse(input.query);
  } catch {
    throw new OrganizerAudiencePreviewError('invalid_input');
  }
  exactIdentity(input.snapshot, {
    audienceSpecId: query.audienceSpecId,
    draftId: query.draftId,
    draftVersion: query.draftVersion,
    previewGeneration: query.previewGeneration,
    previewDigestProfile: query.previewDigestProfile,
    previewDigestVersion: query.previewDigestVersion,
    previewDigestSha256: query.previewDigestSha256
  });
  if (query.selectedRecipientResolutionId === undefined) {
    return organizerMessageBatchPreviewDetailSchema.parse({
      schemaVersion: 1,
      summary: input.snapshot.summary,
      selected: { kind: 'none' }
    });
  }
  const row = input.snapshot.rows.find((candidate) =>
    candidate.recipientResolutionId === query.selectedRecipientResolutionId
  );
  if (row === undefined || row.state !== 'included') {
    throw new OrganizerAudiencePreviewError('recipient_not_available');
  }
  return organizerMessageBatchPreviewDetailSchema.parse({
    schemaVersion: 1,
    summary: input.snapshot.summary,
    selected: { kind: 'rendered_email', render: row.render }
  });
}

export function listOrganizerMessagePreviewRecipients(input: {
  readonly snapshot: OrganizerPreparedMessageBatchPreview;
  readonly query: unknown;
  readonly disclosure?: OrganizerContactDisclosure;
  readonly opaqueTokens: OrganizerPreviewOpaqueTokenCodec;
}): ReturnType<typeof organizerMessagePreviewRecipientPageSchema.parse> {
  let query: ReturnType<typeof organizerMessagePreviewRecipientListInputSchema.parse>;
  try {
    query = organizerMessagePreviewRecipientListInputSchema.parse(input.query);
  } catch {
    throw new OrganizerAudiencePreviewError('invalid_input');
  }
  exactIdentity(input.snapshot, {
    audienceSpecId: query.audienceSpecId,
    draftId: query.draftId,
    draftVersion: query.draftVersion,
    previewGeneration: query.previewGeneration,
    previewDigestProfile: query.previewDigestProfile,
    previewDigestVersion: query.previewDigestVersion,
    previewDigestSha256: query.previewDigestSha256
  });
  const disclosure = input.disclosure ?? 'masked';
  const filtered = input.snapshot.rows.filter((row) => {
    if (query.state !== undefined && row.state !== query.state) return false;
    if (query.reasonCode !== undefined
        && (row.state === 'included' || row.reasonCode !== query.reasonCode)) return false;
    return true;
  });
  const bindingDigestSha256 = digest({
    schemaVersion: 1,
    identity: input.snapshot.summary.identity,
    state: query.state ?? null,
    reasonCode: query.reasonCode ?? null,
    disclosure
  });
  const offset = query.cursor === undefined
    ? 0
    : input.opaqueTokens.readCursor({ bindingDigestSha256, cursor: query.cursor });
  if (offset === undefined || offset < 0 || offset > filtered.length) {
    throw new OrganizerAudiencePreviewError('invalid_cursor');
  }
  const limit = query.limit ?? 50;
  const rows = filtered.slice(offset, offset + limit).map((row) =>
    projectOrganizerPreviewRecipientRow(row, disclosure)
  );
  const nextOffset = offset + rows.length;
  const hasMore = nextOffset < filtered.length;
  return organizerMessagePreviewRecipientPageSchema.parse({
    schemaVersion: 1,
    identity: input.snapshot.summary.identity,
    rows,
    page: hasMore
      ? {
          hasMore: true,
          nextCursor: input.opaqueTokens.issueCursor({ bindingDigestSha256, offset: nextOffset })
        }
      : { hasMore: false }
  });
}

/** Re-resolves and re-renders the same tuple; any changed source/address/policy/content fails closed. */
export async function isOrganizerMessageBatchPreviewCurrent(input: {
  readonly expected: OrganizerPreparedMessageBatchPreview;
  readonly current: OrganizerPrepareMessageBatchPreviewInput;
}): Promise<boolean> {
  try {
    const current = await prepareOrganizerMessageBatchPreview(input.current);
    return sameJson(current.summary.identity, input.expected.summary.identity)
      && current.summary.membershipDigestSha256 === input.expected.summary.membershipDigestSha256
      && current.summary.evidenceDigestSha256 === input.expected.summary.evidenceDigestSha256;
  } catch {
    return false;
  }
}

function hmacHex(key: Uint8Array, profile: OrganizerPreviewDigestProfile, namespace: string, value: unknown): string {
  return bytesToHex(hmac(
    sha256,
    key,
    new TextEncoder().encode(canonicalJsonText({ schemaVersion: 1, profile, namespace, value }))
  ));
}

/** Portable deterministic HMAC codec; source/contact/address text never appears in issued tokens. */
export function createHmacOrganizerPreviewOpaqueTokenCodec(input: {
  readonly keyBytes: Uint8Array;
  readonly profile: OrganizerPreviewDigestProfile;
}): OrganizerPreviewOpaqueTokenCodec {
  if (!(input.keyBytes instanceof Uint8Array) || input.keyBytes.byteLength < 32) {
    throw new OrganizerAudiencePreviewError('invalid_input');
  }
  const key = Uint8Array.from(input.keyBytes);
  const profile = canonicalProfile(input.profile);
  const token = (prefix: string, namespace: string, value: unknown) =>
    `${prefix}${hmacHex(key, profile, namespace, value).slice(0, 40)}`;
  return Object.freeze({
    issueAudienceSpecId(value: Parameters<OrganizerPreviewOpaqueTokenCodec['issueAudienceSpecId']>[0]) {
      return token('aud1_', 'audience-spec', value);
    },
    issueRecipientResolutionId(
      value: Parameters<OrganizerPreviewOpaqueTokenCodec['issueRecipientResolutionId']>[0]
    ) {
      return token('rr1_', 'recipient-resolution', value);
    },
    issueReleaseId(value: Parameters<OrganizerPreviewOpaqueTokenCodec['issueReleaseId']>[0]) {
      return token('rel1_', 'message-release', value);
    },
    issueCursor({ bindingDigestSha256, offset }:
      Parameters<OrganizerPreviewOpaqueTokenCodec['issueCursor']>[0]) {
      const binding = organizerCommunicationDigestSchema.parse(bindingDigestSha256);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new OrganizerAudiencePreviewError('invalid_cursor');
      }
      const encodedOffset = offset.toString(36);
      const tag = hmacHex(key, profile, 'preview-cursor', { binding, offset }).slice(0, 40);
      return `cur1_${encodedOffset}_${tag}`;
    },
    readCursor({ bindingDigestSha256, cursor }:
      Parameters<OrganizerPreviewOpaqueTokenCodec['readCursor']>[0]) {
      let binding: string;
      try {
        binding = organizerCommunicationDigestSchema.parse(bindingDigestSha256);
      } catch {
        return undefined;
      }
      const match = /^cur1_([0-9a-z]+)_([0-9a-f]{40})$/u.exec(cursor);
      if (match === null) return undefined;
      const offset = Number.parseInt(match[1]!, 36);
      if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
      const expected = hmacHex(key, profile, 'preview-cursor', { binding, offset }).slice(0, 40);
      return equalAscii(expected, match[2]!) ? offset : undefined;
    }
  });
}

export interface DeterministicOrganizerPreviewRenderFixture {
  readonly subjectRefId: string;
  readonly outcome:
    | {
        readonly kind: 'rendered';
        readonly subject: string;
        readonly sanitizedHtml: string;
        readonly plainText: string;
        readonly attachments?: readonly OrganizerRenderedAttachment[];
        readonly warningCodes?: readonly string[];
        readonly mergeFallbackFieldKeys?: readonly string[];
      }
    | {
        readonly kind: 'blocked';
        readonly reasonCode: string;
        readonly mergeFallbackFieldKeys?: readonly string[];
      };
}

/** Deterministic provider-neutral render fake for exact-preview contract tests and demos. */
export function createDeterministicOrganizerPreviewRenderPort(
  fixtures: readonly DeterministicOrganizerPreviewRenderFixture[]
): OrganizerPreviewRenderPort {
  const bySubject = new Map<string, DeterministicOrganizerPreviewRenderFixture['outcome']>();
  for (const fixture of fixtures) {
    if (bySubject.has(fixture.subjectRefId)) {
      throw new OrganizerAudiencePreviewError('render_contract_mismatch');
    }
    bySubject.set(fixture.subjectRefId, fixture.outcome);
  }
  return Object.freeze({
    render({ member, recipientResolutionId, releaseId, renderer, mergeRegistry }:
      Parameters<OrganizerPreviewRenderPort['render']>[0]) {
      const outcome = bySubject.get(member.candidate.subjectRefId);
      if (outcome === undefined) {
        return Object.freeze({
          kind: 'blocked' as const,
          reasonCode: 'render.not_registered',
          mergeFallbackFieldKeys: Object.freeze([] as string[])
        });
      }
      if (outcome.kind === 'blocked') {
        return Object.freeze({
          kind: 'blocked' as const,
          reasonCode: outcome.reasonCode,
          mergeFallbackFieldKeys: Object.freeze([...(outcome.mergeFallbackFieldKeys ?? [])])
        });
      }
      const attachments = (outcome.attachments ?? []).map((attachment) =>
        organizerRenderedAttachmentSchema.parse(attachment)
      );
      attachments.sort((left, right) => compareText(left.slotKey, right.slotKey));
      const warningCodes = [...(outcome.warningCodes ?? [])].sort(compareText);
      const releaseDigestSha256 = digest({
        schemaVersion: 1,
        recipientResolutionId,
        releaseId,
        member: redactedMember(member),
        subject: outcome.subject,
        sanitizedHtml: outcome.sanitizedHtml,
        plainText: outcome.plainText,
        attachments,
        renderer,
        mergeRegistry
      });
      const resolvedInputDigestSha256 = digest({
        schemaVersion: 1,
        subjectRefId: member.candidate.subjectRefId,
        subjectVersion: member.candidate.subjectVersion,
        evidence: member.evidence
      });
      const attachmentManifestDigestSha256 = digest(attachments);
      const unsigned = {
        recipientResolutionId,
        releaseId,
        releaseDigestSha256,
        resolvedInputDigestSha256,
        attachmentManifestDigestSha256,
        renderer,
        mergeRegistry,
        subject: outcome.subject,
        sanitizedHtml: outcome.sanitizedHtml,
        plainText: outcome.plainText,
        attachments,
        warningCodes
      };
      const render = organizerServerRenderedEmailSchema.parse({
        ...unsigned,
        outputDigestSha256: digest({ schemaVersion: 1, ...unsigned })
      });
      return Object.freeze({
        kind: 'rendered' as const,
        render,
        mergeFallbackFieldKeys: Object.freeze([...(outcome.mergeFallbackFieldKeys ?? [])])
      });
    }
  });
}
