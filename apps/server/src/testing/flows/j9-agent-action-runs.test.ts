import { test } from 'bun:test';
import { flowWorld } from './flow-world';
import { runJ9AgentActionRuns } from './j9-agent-action-runs.flow';

test('J9 — approved action run pauses, recovers a crash, resumes, and cancels its remainder', async () => {
  const world = await flowWorld();
  try {
    await runJ9AgentActionRuns(world);
  } finally {
    world.close();
  }
});
