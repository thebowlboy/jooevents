import { test } from 'bun:test';
import { flowWorld } from './flow-world';
import { runJ7ForwardCorrections } from './j7-forward-corrections.flow';

test('J7 — forward-only corrections retain truthful successors and omit removed compensations', async () => {
  const world = await flowWorld();
  try {
    await runJ7ForwardCorrections(world);
  } catch (error) {
    throw new Error(`${world.trace()}\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    world.close();
  }
}, 45_000);
