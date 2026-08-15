import { expect, test } from 'bun:test';
import { templateArtifactDocumentSchema } from '@jooevents/contracts';
import { starterTemplateArtifacts } from './starters';

test('starter artifacts are deterministic, complete, and contract-valid', () => {
  const input = {
    scope: {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      eventId: '00000000-0000-4000-8000-000000000002'
    },
    eventName: 'AI Engineer NYC 2026'
  };
  const first = starterTemplateArtifacts(input);
  const second = starterTemplateArtifacts(input);
  expect(first).toEqual(second);
  expect(first).toHaveLength(10);
  expect(new Set(first.map((entry) => entry.artifactId)).size).toBe(10);
  expect(first.map((entry) => entry.document.kind)).toEqual([
    'message', 'message', 'message', 'message', 'message', 'message',
    'surface', 'surface', 'surface', 'theme'
  ]);
  for (const artifact of first) {
    expect(templateArtifactDocumentSchema.safeParse(artifact.document).success).toBe(true);
  }
});
