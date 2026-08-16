import { test } from 'bun:test';
import { flowWorld } from './flow-world';
import { runJ10bPublicCallerWall } from './j10-public-caller-wall.flow';

test('J10b — public mutation boundary is structurally singular and duplicate begin is non-writing', async () => {
  const world = await flowWorld();
  try {
    await runJ10bPublicCallerWall(world);
  } catch (error) {
    throw new Error(`${world.trace()}\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    world.close();
  }
}, 45_000);
