import type { DurableCryptoProfileComposition } from '@jooevents/application/durable-crypto-profiles';
import type {
  OrganizerAudiencePreviewReadPort,
  OrganizerCommunicationCanonicalResult,
  OrganizerCommunicationScope,
  OrganizerPreviewContactDisclosure
} from '@jooevents/communication-operations';
import {
  organizerCommunicationAudienceOptionListInputSchema,
  organizerCommunicationAudienceOptionPageSchema,
  organizerCommunicationAudienceOptionSchema
} from '@jooevents/contracts';
import {
  canonicalJsonText,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';

interface RecipeRow {
  readonly recipe_id: string;
  readonly recipe_version: number;
  readonly recipe_digest_sha256: string;
  readonly source_definition_key: string;
  readonly source_definition_version: number;
  readonly source_definition_digest_sha256: string;
  readonly option_id: string;
  readonly option_version: number;
  readonly purpose_id: string;
  readonly option_json: string;
}

function outcome(): OrganizerCommunicationCanonicalResult {
  return Object.freeze({
    kind: 'outcome' as const,
    outcome: Object.freeze({
      class: 'policy_violation' as const,
      kind: 'communication.preview_invalid',
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    })
  });
}

async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJsonText(value));
  try {
    const digest = new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    ));
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } finally {
    bytes.fill(0);
  }
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function importCursorKeys(
  cryptoProfiles: DurableCryptoProfileComposition
): Promise<readonly CryptoKey[]> {
  const copies = cryptoProfiles.withPersistentHmacKeySelection(
    'security.communication-audience-cursor',
    (selection) => [selection.active, ...selection.retained]
      .map((profile) => Uint8Array.from(profile.keyBytes))
  );
  try {
    return Object.freeze(await Promise.all(copies.map((keyBytes) => crypto.subtle.importKey(
      'raw',
      keyBytes.buffer.slice(
        keyBytes.byteOffset,
        keyBytes.byteOffset + keyBytes.byteLength
      ) as ArrayBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    ))));
  } finally {
    for (const bytes of copies) bytes.fill(0);
  }
}

class D1OrganizerAudienceOptionReadPort implements OrganizerAudiencePreviewReadPort {
  readonly #workspaceId: WorkspaceId;

  constructor(private readonly input: {
    readonly database: D1Database;
    readonly workspaceId: WorkspaceId;
    readonly cursorKeys: readonly CryptoKey[];
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    if (input.cursorKeys.length === 0) {
      throw new TypeError('d1_organizer_audience_cursor_keys_missing');
    }
  }

  async #cursorTag(key: CryptoKey, bindingDigestSha256: string, offset: number): Promise<string> {
    const bytes = new TextEncoder().encode(canonicalJsonText({
      namespace: 'communication.audience-options.cursor',
      bindingDigestSha256,
      offset
    }));
    try {
      const signature = new Uint8Array(await crypto.subtle.sign(
        'HMAC',
        key,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      ));
      return [...signature]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 40);
    } finally {
      bytes.fill(0);
    }
  }

  async #readCursor(bindingDigestSha256: string, cursor: string | undefined): Promise<number> {
    if (cursor === undefined) return 0;
    const match = /^cur1_([0-9a-z]+)_([a-f0-9]{40})$/u.exec(cursor);
    if (match === null) throw new TypeError('d1_organizer_audience_cursor_invalid');
    const offset = Number.parseInt(match[1]!, 36);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError('d1_organizer_audience_cursor_invalid');
    }
    const tags = await Promise.all(this.input.cursorKeys.map((key) =>
      this.#cursorTag(key, bindingDigestSha256, offset)));
    if (!tags.some((tag) => constantTimeHexEqual(tag, match[2]!))) {
      throw new TypeError('d1_organizer_audience_cursor_invalid');
    }
    return offset;
  }

  async #issueCursor(bindingDigestSha256: string, offset: number): Promise<string> {
    return `cur1_${offset.toString(36)}_${await this.#cursorTag(
      this.input.cursorKeys[0]!,
      bindingDigestSha256,
      offset
    )}`;
  }

  async listAudienceOptions(
    scope: OrganizerCommunicationScope,
    authorityPrincipalKey: string,
    rawInput: unknown
  ): Promise<OrganizerCommunicationCanonicalResult> {
    if (scope.workspaceId !== this.#workspaceId
        || typeof authorityPrincipalKey !== 'string'
        || authorityPrincipalKey.length === 0) {
      throw new TypeError('d1_organizer_audience_scope_invalid');
    }
    let request: ReturnType<typeof organizerCommunicationAudienceOptionListInputSchema.parse>;
    let bindingDigestSha256: string;
    let offset: number;
    try {
      request = organizerCommunicationAudienceOptionListInputSchema.parse(rawInput);
      bindingDigestSha256 = await sha256Hex({
        schemaVersion: 1,
        scope,
        personRefId: request.personRefId ?? null,
        purposeId: request.purposeId ?? null
      });
      offset = await this.#readCursor(bindingDigestSha256, request.cursor);
    } catch {
      return outcome();
    }
    const limit = request.limit ?? 50;
    const bindings: Array<string | number> = [scope.workspaceId, scope.eventId];
    let filters = '';
    if (request.purposeId !== undefined) {
      filters += ' AND r.purpose_id=?';
      bindings.push(request.purposeId);
    }
    if (request.personRefId !== undefined) {
      filters += ` AND EXISTS (
        SELECT 1 FROM communication_registered_audience_members m
        JOIN communication_current_audience_contacts c
          ON c.workspace_id=m.workspace_id AND c.event_id=m.event_id
         AND c.subject_ref_id=m.subject_ref_id
        WHERE m.workspace_id=r.workspace_id AND m.event_id=r.event_id
          AND m.recipe_id=r.recipe_id AND m.recipe_version=r.recipe_version
          AND c.person_ref_id=?)`;
      bindings.push(request.personRefId);
    }
    bindings.push(limit + 1, offset);
    const rows = (await this.input.database.prepare(`
      SELECT r.recipe_id,r.recipe_version,r.recipe_digest_sha256,
             r.source_definition_key,r.source_definition_version,
             r.source_definition_digest_sha256,r.option_id,r.option_version,
             r.purpose_id,r.option_json
        FROM communication_registered_audience_recipes r
       WHERE r.workspace_id=? AND r.event_id=?
         AND r.option_version=(
           SELECT MAX(newer.option_version)
             FROM communication_registered_audience_recipes newer
            WHERE newer.workspace_id=r.workspace_id AND newer.event_id=r.event_id
              AND newer.option_id=r.option_id
         )${filters}
       ORDER BY r.option_id,r.option_version LIMIT ? OFFSET ?
    `).bind(...bindings).all<RecipeRow>()).results;
    const chosen = rows.slice(0, limit).map((row) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.option_json);
      } catch (error) {
        throw new TypeError('d1_organizer_audience_option_corrupt', { cause: error });
      }
      const option = organizerCommunicationAudienceOptionSchema.parse(parsed);
      const source = option.audienceDraft.source;
      if (source.kind !== 'registered_query'
          || option.optionId !== row.option_id
          || option.optionVersion !== row.option_version
          || option.audienceDraft.purposeRevision.purposeId !== row.purpose_id
          || source.recipeId !== row.recipe_id
          || source.recipeVersion !== row.recipe_version
          || source.recipeDigestSha256 !== row.recipe_digest_sha256
          || source.sourceDefinition.reference.key !== row.source_definition_key
          || source.sourceDefinition.reference.version !== row.source_definition_version
          || source.sourceDefinition.definitionDigestSha256
            !== row.source_definition_digest_sha256
          || canonicalJsonText(option) !== row.option_json) {
        throw new TypeError('d1_organizer_audience_option_corrupt');
      }
      return option;
    });
    const hasMore = rows.length > limit;
    return Object.freeze({
      kind: 'success' as const,
      data: organizerCommunicationAudienceOptionPageSchema.parse({
        schemaVersion: 1,
        rows: chosen,
        page: hasMore
          ? {
              hasMore: true,
              nextCursor: await this.#issueCursor(
                bindingDigestSha256,
                offset + chosen.length
              )
            }
          : { hasMore: false }
      })
    });
  }

  getMessageBatchPreview(): never {
    throw new TypeError('d1_organizer_message_preview_read_unmounted');
  }

  listMessagePreviewRecipients(
    _scope: OrganizerCommunicationScope,
    _authorityPrincipalKey: string,
    _input: unknown,
    _disclosure: OrganizerPreviewContactDisclosure
  ): never {
    throw new TypeError('d1_organizer_message_preview_recipient_read_unmounted');
  }
}

/** Supplies only the read port; the operation module controls which reads are advertised. */
export async function createD1OrganizerAudiencePreviewReadPort(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
  readonly cryptoProfiles: DurableCryptoProfileComposition;
}): Promise<OrganizerAudiencePreviewReadPort> {
  return new D1OrganizerAudienceOptionReadPort({
    database: input.database,
    workspaceId: input.workspaceId,
    cursorKeys: await importCursorKeys(input.cryptoProfiles)
  });
}
