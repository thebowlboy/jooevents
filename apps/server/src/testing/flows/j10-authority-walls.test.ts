import { test } from 'bun:test';
import { flowWorld } from './flow-world';
import { runJ10aAuthorityWalls } from './j10-authority-walls.flow';

test('J10a authority walls refuse every admitted-actor J2 mutation without writes or success logs', async () => {
  const world = await flowWorld();
  try {
    await runJ10aAuthorityWalls(world);
  } catch (error) {
    throw new Error(`${world.trace()}\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    world.close();
  }
}, 45_000);
