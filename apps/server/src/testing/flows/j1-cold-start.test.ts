import { test } from 'bun:test';
import { flowWorld } from './flow-world';

test('J1 — cold start reaches an open CFP', async () => {
  const world = await flowWorld({ database: 'migration-initialized-empty' });
  try {
    const organizer = world.as('organizer');
    const reviewer = world.as('reviewer');

    const event = await organizer.do<{
      readonly event: { readonly id: string; readonly version: number };
    }>('event.create', {
      expectedEventSetVersion: 1,
      name: 'Cold Start Conference',
      timezone: 'Asia/Singapore',
      startDate: '2027-06-10',
      endDate: '2027-06-12'
    });
    await organizer.expectLog('Created an event');

    let settings!: {
      readonly eventId: string;
      readonly eventSetVersion: number;
      readonly eventVersion: number;
      readonly name: string;
      readonly timezone: string;
      readonly startDate: string;
      readonly endDate: string;
    };
    await organizer.expectRead('event.settings.current.read', (projection) => {
      settings = projection as typeof settings;
      return settings.eventId === event.data.event.id;
    });
    const update = await organizer.do('event.settings.update', {
      expectedEventId: settings.eventId,
      expectedEventSetVersion: settings.eventSetVersion,
      expectedEventVersion: settings.eventVersion,
      name: settings.name,
      timezone: settings.timezone,
      startDate: settings.startDate,
      endDate: settings.endDate,
      location: 'Suntec Convention Centre',
      venueNote: 'Registration opens on Level 2.',
      dayStart: '09:00',
      dayEnd: '18:00',
      slotMinutes: 30
    });
    await organizer.expectLog('Updated event settings');
    await organizer.replay(update);
    await reviewer.expectRefusal('event.settings.update', {
      expectedEventId: settings.eventId,
      expectedEventSetVersion: 2,
      expectedEventVersion: 2,
      name: settings.name,
      timezone: settings.timezone,
      startDate: settings.startDate,
      endDate: settings.endDate,
      location: 'Unauthorized location',
      venueNote: '', dayStart: '09:00', dayEnd: '18:00', slotMinutes: 30
    }, 'authority.not_authorized');

    let registry!: { readonly version: number };
    await organizer.expectRead('field_registry.snapshot.read', (projection) => {
      registry = projection as typeof registry;
      return registry.version === 1;
    });
    const form = await organizer.do<{
      readonly formId: string;
      readonly formDefinitionVersion: number;
    }>('form.definition.create', {
      expectedCatalogVersion: 1,
      expectedRegistryVersion: registry.version,
      definition: {
        kind: 'cfp', name: 'Main Call for Proposals',
        target: { kind: 'general_pool' },
        availability: { kind: 'evergreen' },
        confirmation: 'Application received.',
        composition: { excludedFieldIds: [], requiredOverrides: {}, optionExposure: {} },
        rules: []
      }
    });
    await organizer.expectLog('Created a form');
    const draft = await organizer.do<{
      readonly draftId: string;
      readonly revision: { readonly id: string; readonly digestSha256: string };
    }>('form.version.publish.draft', {
      action: 'publish_and_open',
      formId: form.data.formId,
      expectedDefinitionVersion: form.data.formDefinitionVersion,
      expectedRegistryVersion: registry.version
    });
    await organizer.do('form.version.publish', {
      draftId: draft.data.draftId,
      revisionId: draft.data.revision.id,
      revisionDigestSha256: draft.data.revision.digestSha256
    });
    await organizer.expectLog('Published and opened a form');
    await organizer.expectRead('form.list', (projection) => {
      const catalog = projection as { readonly forms: readonly { readonly id: string; readonly status: string }[] };
      return catalog.forms.some((entry) => entry.id === form.data.formId && entry.status === 'open');
    });
  } catch (error) {
    const suffix = error instanceof Error ? error.message : String(error);
    throw new Error(`${world.trace()}\n${suffix}`);
  } finally {
    world.close();
  }
}, 30_000);
