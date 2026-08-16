import { test } from 'bun:test';
import { flowWorld } from './flow-world';
import { runJ4ManualPaths } from './j4-manual-paths.flow';

test('J4 — manual entry and organizer-created sessions stay beside the pipeline', async () => {
  const world = await flowWorld();
  try {
    await runJ4ManualPaths(world);
  } finally {
    world.close();
  }
});
