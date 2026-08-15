import { describe, expect, test } from 'bun:test';
import { starterTemplateDocuments } from './starters';
import { DeterministicTemplateEditService } from './template-edit-fake';

const runId = '019c1df7-86b5-769b-bba4-5f7097bfa401';
const attempt1 = '019c1df7-86b5-769b-bba4-5f7097bfa402';
const attempt2 = '019c1df7-86b5-769b-bba4-5f7097bfa403';
const artifactId = '019c1df7-86b5-769b-bba4-5f7097bfa404';

describe('deterministic Template edit service', () => {
  test('serves versioned choices and executes a typed full-document draft through the fake adapter', async () => {
    const service = new DeterministicTemplateEditService();
    expect(service.choices().map((choice) => choice.id)).toEqual(['auto', 'quick', 'thorough']);
    const classification = await service.classify({
      runId, attemptId: attempt1, artifactId,
      instruction: 'Make the subject warmer.', modelChoiceId: 'auto'
    });
    expect(classification).toMatchObject({ scope: 'quick', chosenBy: 'auto' });

    const source = starterTemplateDocuments('JooConf')[0]!.document;
    const revised = await service.revise({
      runId, attemptId: attempt2, artifactId, baseRevisionNumber: 1,
      document: source, instruction: 'Make the subject warmer.', modelChoiceId: 'auto'
    });
    expect(revised).toMatchObject({
      artifactId, baseRevisionNumber: 1,
      classification: { scope: 'quick', chosenBy: 'auto' },
      scaffold: { key: 'template_edit.typed_document', version: 1 }
    });
    expect(revised.document).not.toEqual(source);
    expect(revised.usage.inputTokens).toBeGreaterThan(0);
    expect(revised.usage.outputTokens).toBeGreaterThan(0);
  });
});
