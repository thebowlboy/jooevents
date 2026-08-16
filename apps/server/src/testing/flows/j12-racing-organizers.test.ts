import { test } from 'bun:test';
import { flowWorld } from './flow-world';
import { runJ12RacingOrganizers } from './j12-racing-organizers.flow';

test('J12 — racing organizers get one settings winner and one typed stale refusal', async () => {
  const world = await flowWorld();
  try {
    await runJ12RacingOrganizers(world);
  } finally {
    world.close();
  }
});
