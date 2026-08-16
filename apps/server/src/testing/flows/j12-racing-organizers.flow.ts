import { expect } from 'bun:test';
import { runJ2Spine } from './j2-spine.flow';
import type { FlowWorld } from './flow-world';

type Settings = {
  readonly eventId: string; readonly eventSetVersion: number; readonly eventVersion: number;
  readonly name: string; readonly timezone: string; readonly startDate: string; readonly endDate: string;
  readonly location: string | null; readonly venueNote: string | null;
  readonly dayStart: string | null; readonly dayEnd: string | null; readonly slotMinutes: number | null;
};

/** J12 — two admitted organizers race the same settings guard; only the winner writes. */
export async function runJ12RacingOrganizers(world: FlowWorld): Promise<void> {
  const organizer = world.as('organizer');
  const secondOrganizer = world.as('second-organizer');
  await runJ2Spine(world);
  let settings!: Settings;
  await organizer.expectRead('event.settings.current.read', (projection) => {
    settings = projection as Settings;
    return settings.eventVersion > 0;
  });
  const update = {
    expectedEventId: settings.eventId, expectedEventSetVersion: settings.eventSetVersion,
    expectedEventVersion: settings.eventVersion, name: settings.name, timezone: settings.timezone,
    startDate: settings.startDate, endDate: settings.endDate, location: settings.location,
    venueNote: 'Organizer one won this guard.', dayStart: settings.dayStart,
    dayEnd: settings.dayEnd, slotMinutes: settings.slotMinutes
  };
  const won = await organizer.do('event.settings.update', update);
  await organizer.expectLog('Updated event settings');
  await secondOrganizer.expectRefusal('event.settings.update', {
    ...update, venueNote: 'Organizer two stale write.'
  }, 'event.settings_changed');
  await organizer.replay(won);
  await organizer.expectRead('event.settings.current.read', (projection) =>
    (projection as Settings).venueNote === 'Organizer one won this guard.'
  );
}
