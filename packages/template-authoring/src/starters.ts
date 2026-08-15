import { createHash } from 'node:crypto';
import type {
  MessageTemplateDocumentDto,
  SurfaceTemplateDocumentDto,
  TemplateArtifactDocumentDto,
  TemplateArtifactScopeDto
} from '@jooevents/contracts';

export interface StarterTemplateArtifact {
  readonly key: string;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly document: TemplateArtifactDocumentDto;
}

function deterministicUuid(namespace: string, scope: TemplateArtifactScopeDto, key: string): string {
  const hex = createHash('sha256')
    .update(`${namespace}\u0000${scope.workspaceId}\u0000${scope.eventId}\u0000${key}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function message(input: Omit<MessageTemplateDocumentDto, 'kind'>): MessageTemplateDocumentDto {
  return { kind: 'message', ...input };
}

function surface(input: Omit<SurfaceTemplateDocumentDto, 'kind'>): SurfaceTemplateDocumentDto {
  return { kind: 'surface', ...input };
}

export function starterTemplateDocuments(eventName: string): readonly {
  readonly key: string;
  readonly document: TemplateArtifactDocumentDto;
}[] {
  const event = eventName.normalize('NFC').trim();
  if (event.length === 0 || event.length > 200) throw new TypeError('starter_event_name_invalid');
  return Object.freeze([
    {
      key: 'decision-accepted',
      document: message({
        key: 'decision-accepted', name: 'Decision — accepted',
        purpose: 'Tells a submitter their proposal is in the program and opens onboarding.',
        subject: 'Good news about “{{submission.title}}”',
        blocks: [
          { type: 'heading', text: 'You’re in, {{speaker.name}}', suggestedVars: ['speaker.name'] },
          { type: 'paragraph', text: '“{{submission.title}}” is confirmed for {{event.name}}.', suggestedVars: ['submission.title', 'event.name'] },
          { type: 'details', rows: [
            { label: 'Session', value: '{{submission.title}}' },
            { label: 'Format', value: '{{submission.format}}' }
          ], suggestedVars: ['submission.format'] },
          { type: 'paragraph', text: 'Confirm below and your speaker checklist opens.' },
          { type: 'button', label: 'Confirm your session', href: 'portal.tasks' },
          { type: 'divider' }
        ],
        mergeFields: [
          { key: 'speaker.name', label: 'Speaker name', sample: 'Maya Lindqvist' },
          { key: 'submission.title', label: 'Submission title', sample: 'Context Caching Without Tears' },
          { key: 'submission.format', label: 'Session format', sample: 'Talk' },
          { key: 'event.name', label: 'Event name', sample: event }
        ],
        usedBy: ['Decision notification']
      })
    },
    {
      key: 'decision-waitlisted',
      document: message({
        key: 'decision-waitlisted', name: 'Decision — waitlisted',
        purpose: 'Tells a submitter their proposal is on the waitlist and what happens next.',
        subject: 'An update on “{{submission.title}}”',
        blocks: [
          { type: 'heading', text: 'You’re on the waitlist' },
          { type: 'paragraph', text: 'Thank you for sending “{{submission.title}}” to {{event.name}}, {{speaker.name}}.' },
          { type: 'paragraph', text: 'If a slot opens, we’ll write with a firm offer and a clear deadline.' },
          { type: 'button', label: 'See where you stand', href: 'portal.waitlist' },
          { type: 'divider' }
        ],
        mergeFields: [
          { key: 'speaker.name', label: 'Speaker name', sample: 'Tomás Ferreira' },
          { key: 'submission.title', label: 'Submission title', sample: 'Prompt Caching at the Edge' },
          { key: 'submission.format', label: 'Session format', sample: 'Talk' },
          { key: 'event.name', label: 'Event name', sample: event }
        ],
        usedBy: ['Decision notification']
      })
    },
    {
      key: 'decision-declined',
      document: message({
        key: 'decision-declined', name: 'Decision — declined',
        purpose: 'Tells a submitter their proposal did not make the program, kindly and plainly.',
        subject: 'About “{{submission.title}}”',
        blocks: [
          { type: 'heading', text: 'Thank you for submitting' },
          { type: 'paragraph', text: 'We read “{{submission.title}}” with care, {{speaker.name}}, and it won’t be part of {{event.name}} this time.' },
          { type: 'paragraph', text: 'We’d genuinely like to see you submit again.' },
          { type: 'button', label: 'Explore the program', href: 'event.schedule' },
          { type: 'divider' }
        ],
        mergeFields: [
          { key: 'speaker.name', label: 'Speaker name', sample: 'Elif Aydın' },
          { key: 'submission.title', label: 'Submission title', sample: 'YAML-Driven Agent Pipelines' },
          { key: 'submission.format', label: 'Session format', sample: 'Workshop' },
          { key: 'event.name', label: 'Event name', sample: event }
        ],
        usedBy: ['Decision notification']
      })
    },
    {
      key: 'speaker-invitation',
      document: message({
        key: 'speaker-invitation', name: 'Speaker invitation',
        purpose: 'Invites a speaker the team reached out to directly, before any submission.',
        subject: 'An invitation to speak at {{event.name}}',
        blocks: [
          { type: 'heading', text: 'We’d like you on stage' },
          { type: 'paragraph', text: '{{speaker.name}}, we’re putting together {{event.name}} — {{event.dates}} in {{event.location}} — and we’d like you to be part of it.' },
          { type: 'button', label: 'Accept the invitation', href: 'portal.invitation' },
          { type: 'divider' }
        ],
        mergeFields: [
          { key: 'speaker.name', label: 'Speaker name', sample: 'Ravi Chandran' },
          { key: 'event.name', label: 'Event name', sample: event },
          { key: 'event.dates', label: 'Event dates', sample: 'Oct 12–14, 2026' },
          { key: 'event.location', label: 'Event location', sample: 'New York City' }
        ],
        usedBy: ['Speaker onboarding']
      })
    },
    {
      key: 'task-reminder',
      document: message({
        key: 'task-reminder', name: 'Task reminder',
        purpose: 'Nudges a speaker about one open checklist task, with its due date in view.',
        subject: 'A nudge on your {{task.name}}',
        blocks: [
          { type: 'heading', text: 'One thing still open' },
          { type: 'paragraph', text: 'Hi {{speaker.name}} — your {{task.name}} for {{event.name}} is still open.' },
          { type: 'details', rows: [
            { label: 'Task', value: '{{task.name}}' }, { label: 'Due', value: '{{task.due}}' }
          ] },
          { type: 'button', label: 'Open your checklist', href: 'portal.tasks' },
          { type: 'divider' }
        ],
        mergeFields: [
          { key: 'speaker.name', label: 'Speaker name', sample: 'Maya Lindqvist' },
          { key: 'task.name', label: 'Task name', sample: 'AV requirements form' },
          { key: 'task.due', label: 'Task due', sample: 'Sep 11, 23:59 EDT' },
          { key: 'event.name', label: 'Event name', sample: event }
        ],
        usedBy: ['Task reminders']
      })
    },
    {
      key: 'schedule-announcement',
      document: message({
        key: 'schedule-announcement', name: 'Schedule announcement',
        purpose: 'Announces the published schedule to speakers and subscribers.',
        subject: 'The {{event.name}} schedule is live',
        blocks: [
          { type: 'heading', text: 'The schedule is out' },
          { type: 'paragraph', text: 'The full program for {{event.name}} is now published.' },
          { type: 'button', label: 'See the schedule', href: 'event.schedule' },
          { type: 'divider' }
        ],
        mergeFields: [
          { key: 'event.name', label: 'Event name', sample: event },
          { key: 'event.dates', label: 'Event dates', sample: 'Oct 12–14, 2026' },
          { key: 'event.location', label: 'Event location', sample: 'New York City' }
        ],
        usedBy: ['Schedule publish']
      })
    },
    {
      key: 'surface-schedule',
      document: surface({
        surfaceKind: 'schedule', name: 'Public schedule',
        purpose: 'The published program, standalone and embedded from the same template.',
        blocks: [
          { type: 'hero', title: `${event} schedule`, intro: 'Plan your days and find every session.' },
          { type: 'schedule-days', grouping: 'day', showRoom: true, showTrack: true, showSpeakers: true, density: 'cozy' }
        ],
        usedBy: ['Public schedule', 'Schedule embeds']
      })
    },
    {
      key: 'surface-application-form',
      document: surface({
        surfaceKind: 'application-form', name: 'Speaker application',
        purpose: 'The public call for proposals, standalone and embedded from one form definition.',
        blocks: [
          { type: 'hero', title: `Speak at ${event}`, intro: 'Share the work you want this community to learn from.' },
          { type: 'form-section', title: 'About you', groups: ['identity', 'contact', 'presence'], fieldRefs: [] },
          { type: 'form-section', title: 'Your talk', groups: ['talk', 'logistics', 'materials', 'other', 'consent'], fieldRefs: [] }
        ],
        submitLabel: 'Send application', usedBy: ['Speaker application', 'Application embeds']
      })
    },
    {
      key: 'surface-speaker-roster',
      document: surface({
        surfaceKind: 'speaker-roster', name: 'Speaker lineup',
        purpose: 'The public speaker roster, standalone and embedded from the same release.',
        blocks: [
          { type: 'hero', title: `${event} speakers`, intro: 'Meet the people joining the program.' },
          { type: 'roster-list', layout: 'grid', grouping: 'category', showHeadline: true, showSessions: true, showLinks: true, density: 'cozy' }
        ],
        usedBy: ['Public speakers', 'Speaker embeds']
      })
    },
    {
      key: 'event-theme',
      document: {
        kind: 'theme',
        recipe: {
          name: 'My event theme', canvas: '#faf8f5', surface: '#ffffff', text: '#2a2522',
          action: '#b05a4f', radius: 6, controlHeight: 36
        },
        markText: event.split(/\s+/u).filter(Boolean).slice(0, 2)
          .map((part) => [...part][0]?.toUpperCase() ?? '').join('').slice(0, 3)
      }
    }
  ]);
}

export function starterTemplateArtifacts(input: {
  readonly scope: TemplateArtifactScopeDto;
  readonly eventName: string;
}): readonly StarterTemplateArtifact[] {
  return Object.freeze(starterTemplateDocuments(input.eventName).map(({ key, document }) => ({
    key,
    artifactId: deterministicUuid('template-artifact', input.scope, key),
    revisionId: deterministicUuid('template-artifact-revision', input.scope, `${key}:1`),
    document
  })));
}
