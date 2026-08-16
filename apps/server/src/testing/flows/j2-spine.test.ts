import { test } from 'bun:test';
import { flowWorld } from './flow-world';
import { runJ2Spine } from './j2-spine.flow';

test('J2 — submitter becomes a session', async () => {
  const world = await flowWorld();
  try {
    await runJ2Spine(world);
  } catch (error) {
    const suffix = error instanceof Error ? error.message : String(error);
    throw new Error(`${world.trace()}\n${suffix}`);
  } finally {
    world.close();
  }
}, 30_000);
