import { test } from 'bun:test';
import { flowWorld } from './flow-world';
import { runJ8VocabularyMerge } from './j8-vocabulary-merge.flow';

test('J8 — program vocabulary edits and reviewed merge retain live references', async () => {
  const world = await flowWorld();
  try {
    await runJ8VocabularyMerge(world);
  } finally {
    world.close();
  }
});
