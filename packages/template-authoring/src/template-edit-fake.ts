import { createHash } from 'node:crypto';
import {
  templateArtifactDocumentSchema,
  templateEditClassificationSchema,
  templateEditReviseDataSchema,
  type TemplateArtifactDocumentDto,
  type TemplateEditClassificationDto,
  type TemplateEditModelChoiceDto,
  type TemplateEditReviseDataDto
} from '@jooevents/contracts';
import {
  canonicalJsonText,
  parseAgentRunId,
  parseModelAttemptId
} from '@jooevents/kernel';
import {
  DeterministicFakeAdapter,
  MemoryDeterministicFakeStore,
  calculateModelProfileDigest,
  calculateModelScaffoldDigest,
  createModelRegistry,
  modelProviderIdempotencyKeyFor,
  parseModelRequestBinding,
  type ModelAttemptRequest,
  type ModelProfileRevision,
  type ModelScaffoldRevision
} from '@jooevents/model-adapter';

const capabilities = Object.freeze({
  structuredOutput: true, tools: true, batch: true, fast: true,
  lookup: true, cancellation: true, idempotency: true
});

function profile(key: string, mode: 'fast' | 'batch', maxOutputTokens: number): ModelProfileRevision {
  const body = {
    key, version: 1,
    adapter: { key: 'deterministic_fake', version: 1 },
    modelId: `deterministic-template-${mode}-v1`,
    controls: { maxOutputTokens, requireStructuredOutput: true },
    defaultExecutionMode: mode,
    budget: {
      maximumAttempts: 1, maxInputTokens: 50_000, maxOutputTokens,
      maxCostMicros: 0, timeoutMs: 10_000
    },
    capabilities
  } as const;
  return Object.freeze({ ...body, digest: calculateModelProfileDigest(body as ModelProfileRevision) });
}

function scaffold(): ModelScaffoldRevision {
  const body = {
    key: 'template_edit.typed_document', version: 1,
    purpose: 'template_edit.typed_document',
    outputSchema: { key: 'template_edit.typed_document.output', version: 1 },
    allowedTools: []
  } as const;
  return Object.freeze({
    ...body,
    digest: calculateModelScaffoldDigest(body as unknown as ModelScaffoldRevision)
  });
}

const quickProfile = profile('template_edit.quick', 'fast', 4_000);
const thoroughProfile = profile('template_edit.thorough', 'batch', 12_000);
const editScaffold = scaffold();

const choices: readonly TemplateEditModelChoiceDto[] = Object.freeze([
  Object.freeze({
    id: 'auto', label: 'Auto', sub: 'Routes each instruction to the lightest fitting profile.',
    profile: { key: quickProfile.key, version: quickProfile.version },
    profileDigestSha256: quickProfile.digest
  }),
  Object.freeze({
    id: 'quick', label: 'Deterministic quick pass', sub: 'A fast typed-document edit for wording and small display changes.',
    profile: { key: quickProfile.key, version: quickProfile.version },
    profileDigestSha256: quickProfile.digest
  }),
  Object.freeze({
    id: 'thorough', label: 'Deterministic full pass', sub: 'A broader typed-document pass for structural instructions.',
    profile: { key: thoroughProfile.key, version: thoroughProfile.version },
    profileDigestSha256: thoroughProfile.digest
  })
]);

function route(instruction: string, modelChoiceId: string): {
  readonly classification: TemplateEditClassificationDto;
  readonly profile: ModelProfileRevision;
} {
  const normalized = instruction.toLocaleLowerCase('en');
  const comprehensive = instruction.length > 180
    || /\b(add|remove|reorder|structure|section|block|layout|group|whole|rewrite)\b/u.test(normalized);
  const chosen = modelChoiceId === 'auto'
    ? (comprehensive ? choices[2]! : choices[1]!)
    : choices.find((choice) => choice.id === modelChoiceId);
  if (!chosen || chosen.id === 'auto') throw new TypeError('template_edit_model_choice_unknown');
  const selected = chosen.id === 'quick' ? quickProfile : thoroughProfile;
  return {
    profile: selected,
    classification: templateEditClassificationSchema.parse({
      scope: comprehensive ? 'comprehensive' : 'quick',
      profileLabel: chosen.label,
      reason: modelChoiceId === 'auto'
        ? (comprehensive
          ? 'A structural instruction uses the full typed-document profile.'
          : 'A bounded wording instruction uses the quick typed-document profile.')
        : `You selected ${chosen.label}.`,
      chosenBy: modelChoiceId === 'auto' ? 'auto' : 'you',
      profile: { key: selected.key, version: selected.version },
      profileDigestSha256: selected.digest
    })
  };
}

function shortened(value: string): string {
  const first = value.split(/(?<=[.!?])\s+/u)[0]?.trim() ?? value.trim();
  return first || value;
}

function reviseDocument(document: TemplateArtifactDocumentDto, instruction: string): TemplateArtifactDocumentDto {
  const next = structuredClone(document);
  const words = instruction.toLocaleLowerCase('en');
  if (next.kind === 'message') {
    if (/subject/u.test(words)) {
      next.subject = /short|tight/u.test(words)
        ? shortened(next.subject)
        : `A quick update: ${next.subject}`.slice(0, 2_000);
    } else {
      const block = next.blocks.find((candidate) => candidate.type === 'paragraph');
      if (block?.type === 'paragraph') block.text = /short|tight/u.test(words)
        ? shortened(block.text)
        : `${block.text} We’re glad you’re part of it.`.slice(0, 40_000);
      else next.subject = `Update: ${next.subject}`.slice(0, 2_000);
    }
  } else if (next.kind === 'surface') {
    const schedule = next.blocks.find((candidate) => candidate.type === 'schedule-days');
    const roster = next.blocks.find((candidate) => candidate.type === 'roster-list');
    const hero = next.blocks.find((candidate) => candidate.type === 'hero');
    if (schedule?.type === 'schedule-days' && /group.*track|by track/u.test(words)) {
      schedule.grouping = 'track';
    } else if (schedule?.type === 'schedule-days' && /compact|denser/u.test(words)) {
      schedule.density = 'compact';
    } else if (roster?.type === 'roster-list' && /list/u.test(words)) {
      roster.layout = 'list';
    } else if (hero?.type === 'hero') {
      hero.intro = /short|tight/u.test(words)
        ? shortened(hero.intro)
        : `${hero.intro} Everything important is easy to find.`.slice(0, 10_000);
    } else {
      next.blocks.push({ type: 'note', text: 'Updated for clarity.' });
    }
  } else {
    next.recipe.name = `${next.recipe.name} revised`.slice(0, 300);
  }
  return templateArtifactDocumentSchema.parse(next);
}

interface FakePayload {
  readonly task: 'classify' | 'revise';
  readonly artifactId: string;
  readonly instruction: string;
  readonly modelChoiceId: string;
  readonly baseRevisionNumber?: number;
  readonly document?: TemplateArtifactDocumentDto;
}

function requestBinding(payload: FakePayload) {
  const digest = createHash('sha256').update(canonicalJsonText(payload)).digest('hex');
  return parseModelRequestBinding(`mrb1_${digest}`);
}

function scenario(request: ModelAttemptRequest) {
  const payload = JSON.parse(request.messages.at(-1)?.content ?? 'null') as FakePayload;
  const routed = route(payload.instruction, payload.modelChoiceId);
  if (payload.task === 'classify') return {
    kind: 'success' as const,
    output: routed.classification,
    inputTokens: Math.max(1, Math.ceil(payload.instruction.length / 4)),
    outputTokens: 24,
    costMicros: 0
  };
  if (!payload.document || payload.baseRevisionNumber === undefined) {
    return { kind: 'known_failure' as const, safeCode: 'template_edit_input_missing', retryability: 'never' as const };
  }
  const document = reviseDocument(payload.document, payload.instruction);
  return {
    kind: 'success' as const,
    output: { document, note: routed.classification.scope === 'quick'
      ? 'Applied a deterministic quick typed-document edit.'
      : 'Applied a deterministic full typed-document edit.' },
    inputTokens: Math.max(1, Math.ceil(canonicalJsonText(payload).length / 4)),
    outputTokens: Math.max(1, Math.ceil(canonicalJsonText(document).length / 4)),
    costMicros: 0
  };
}

export class DeterministicTemplateEditService {
  readonly #adapter = new DeterministicFakeAdapter(new MemoryDeterministicFakeStore(), scenario);
  readonly #registry = createModelRegistry({
    adapters: [{ adapter: this.#adapter, implementationDigestSha256: createHash('sha256').update('template-edit-fake-v1').digest('hex') }],
    profiles: [quickProfile, thoroughProfile],
    scaffolds: [editScaffold],
    purposes: [
      { purpose: editScaffold.purpose, profile: { key: quickProfile.key, version: 1, digest: quickProfile.digest }, scaffold: { key: editScaffold.key, version: 1, digest: editScaffold.digest } }
    ]
  });

  choices(): readonly TemplateEditModelChoiceDto[] { return choices; }

  classifySynchronous(input: {
    readonly artifactId: string; readonly instruction: string; readonly modelChoiceId: string;
  }): TemplateEditClassificationDto {
    void input.artifactId;
    return route(input.instruction, input.modelChoiceId).classification;
  }

  reviseSynchronous(input: {
    readonly artifactId: string; readonly baseRevisionNumber: number;
    readonly document: TemplateArtifactDocumentDto; readonly instruction: string;
    readonly modelChoiceId: string;
  }): TemplateEditReviseDataDto {
    const routed = route(input.instruction, input.modelChoiceId);
    const revised = reviseDocument(input.document, input.instruction);
    return templateEditReviseDataSchema.parse({
      schemaVersion: 1, artifactId: input.artifactId,
      baseRevisionNumber: input.baseRevisionNumber,
      document: revised,
      note: routed.classification.scope === 'quick'
        ? 'Applied a deterministic quick typed-document edit.'
        : 'Applied a deterministic full typed-document edit.',
      classification: routed.classification,
      usage: {
        inputTokens: Math.max(1, Math.ceil(canonicalJsonText(input).length / 4)),
        outputTokens: Math.max(1, Math.ceil(canonicalJsonText(revised).length / 4))
      },
      scaffold: { key: editScaffold.key, version: editScaffold.version },
      scaffoldDigestSha256: editScaffold.digest
    });
  }

  async classify(input: {
    readonly runId: string; readonly attemptId: string; readonly artifactId: string;
    readonly instruction: string; readonly modelChoiceId: string;
  }): Promise<TemplateEditClassificationDto> {
    const routed = route(input.instruction, input.modelChoiceId);
    const payload: FakePayload = { task: 'classify', artifactId: input.artifactId, instruction: input.instruction, modelChoiceId: input.modelChoiceId };
    const observation = await this.execute(input.runId, input.attemptId, routed.profile, payload);
    if (observation.kind !== 'succeeded') throw new TypeError('template_edit_fake_classify_failed');
    return templateEditClassificationSchema.parse(observation.output);
  }

  async revise(input: {
    readonly runId: string; readonly attemptId: string; readonly artifactId: string;
    readonly baseRevisionNumber: number; readonly document: TemplateArtifactDocumentDto;
    readonly instruction: string; readonly modelChoiceId: string;
  }): Promise<TemplateEditReviseDataDto> {
    const routed = route(input.instruction, input.modelChoiceId);
    const payload: FakePayload = {
      task: 'revise', artifactId: input.artifactId, instruction: input.instruction,
      modelChoiceId: input.modelChoiceId, baseRevisionNumber: input.baseRevisionNumber,
      document: input.document
    };
    const observation = await this.execute(input.runId, input.attemptId, routed.profile, payload);
    if (observation.kind !== 'succeeded') throw new TypeError('template_edit_fake_revise_failed');
    const output = observation.output as { readonly document: unknown; readonly note: unknown };
    return templateEditReviseDataSchema.parse({
      schemaVersion: 1, artifactId: input.artifactId,
      baseRevisionNumber: input.baseRevisionNumber,
      document: output.document, note: output.note,
      classification: routed.classification,
      usage: {
        inputTokens: observation.usage.inputTokens ?? 0,
        outputTokens: observation.usage.outputTokens ?? 0
      },
      scaffold: { key: editScaffold.key, version: editScaffold.version },
      scaffoldDigestSha256: editScaffold.digest
    });
  }

  private execute(runId: string, attemptId: string, profile: ModelProfileRevision, payload: FakePayload) {
    const binding = requestBinding(payload);
    const registered = this.#registry.getProfile({ key: profile.key, version: profile.version });
    if (!registered) throw new TypeError('template_edit_profile_missing');
    return this.#adapter.execute({
      runId: parseAgentRunId(runId), attemptId: parseModelAttemptId(attemptId),
      requestBinding: binding, profile: registered, scaffold: editScaffold,
      messages: [{ role: 'user', content: canonicalJsonText(payload) }], tools: [],
      outputJsonSchema: { name: 'template_edit_output', schema: { type: 'object' }, strict: true },
      providerIdempotencyKey: modelProviderIdempotencyKeyFor(binding)
    });
  }
}
