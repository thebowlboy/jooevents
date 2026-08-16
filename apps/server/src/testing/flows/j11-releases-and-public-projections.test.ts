import { test } from 'bun:test';
import { flowWorld } from './flow-world';
import { runJ11ReleasesAndPublicProjections } from './j11-releases-and-public-projections.flow';

test('J11 — publication keeps draft program changes out of public projections until release', async () => {
  const world = await flowWorld();
  try {
    await runJ11ReleasesAndPublicProjections(world);
  } finally {
    world.close();
  }
});
