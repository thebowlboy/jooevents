import { test } from 'bun:test';
import { flowWorld } from './flow-world';
import { runJ6DeadlinesAndTasks } from './j6-deadlines-and-tasks.flow';

test('J6 — deadlines and tasks ride alongside CFP and review work', async () => {
  const world = await flowWorld();
  try {
    await runJ6DeadlinesAndTasks(world);
  } finally {
    world.close();
  }
});
