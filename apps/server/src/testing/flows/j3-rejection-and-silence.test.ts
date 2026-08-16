import { test } from 'bun:test';
import { flowWorld } from './flow-world';
import { runJ3RejectionAndSilence } from './j3-rejection-and-silence.flow';

test('J3 — rejection leaves no engagement, session, or placement', async () => {
  const world = await flowWorld();
  try {
    await runJ3RejectionAndSilence(world);
  } catch (error) {
    throw new Error(`${world.trace()}\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    world.close();
  }
}, 45_000);
