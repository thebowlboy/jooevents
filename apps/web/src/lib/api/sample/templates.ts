import type {
	EventTheme,
	FieldGroup,
	MessageTemplate,
	SurfaceTemplate,
	TemplateRevisionMeta
} from '../types';
import { defaultThemeRecipe } from '../../theme/theme-contract';
import { asSurfaceField, contextFields, sectionFieldIds } from '../fields';
import { baselineFieldRegistry } from './fields';

/**
 * The base template set every event starts with. A factory rather than a
 * constant so each dataset seeds its own copy and scenario-local edits (a
 * revision here, a rewrite there) never bleed across scenarios.
 */
export function starterTemplates(): MessageTemplate[] {
	return [
		{
			id: 'tpl-decision-accepted',
			key: 'decision-accepted',
			name: 'Decision — accepted',
			purpose: 'Tells a submitter their proposal is in the program and opens onboarding.',
			subject: 'Good news about “{{submission.title}}”',
			blocks: [
				{ type: 'heading', text: 'You’re in, {{speaker.name}}', suggestedVars: ['speaker.name'] },
				{
					type: 'paragraph',
					text: '“{{submission.title}}” is confirmed for {{event.name}}. The program team read it closely, and we think it belongs on this stage.',
					suggestedVars: ['submission.title', 'event.name']
				},
				{
					type: 'details',
					rows: [
						{ label: 'Session', value: '{{submission.title}}' },
						{ label: 'Format', value: '{{submission.format}}' }
					],
					suggestedVars: ['submission.format']
				},
				{
					type: 'paragraph',
					text: 'Confirm below and your speaker checklist opens — a short bio, a headshot, and your AV needs. None of it takes long, and we’ll only nudge you when something is due.',
					suggestedVars: ['submission.title', 'event.name']
				},
				{ type: 'button', label: 'Confirm your session', href: 'portal.tasks' },
				{ type: 'divider' }
			],
			mergeFields: [
				{ key: 'speaker.name', label: 'Speaker name', sample: 'Maya Lindqvist' },
				{ key: 'submission.title', label: 'Submission title', sample: 'Context Caching Without Tears' },
				{ key: 'submission.format', label: 'Session format', sample: 'Talk' },
				{ key: 'event.name', label: 'Event name', sample: 'AI Engineer NYC 2026' }
			],
			revision: 1,
			revisions: [starterRevision()],
			usedBy: ['Decision notification']
		},
		{
			id: 'tpl-decision-waitlisted',
			key: 'decision-waitlisted',
			name: 'Decision — waitlisted',
			purpose: 'Tells a submitter their proposal is on the waitlist and what happens next.',
			subject: 'An update on “{{submission.title}}”',
			blocks: [
				{ type: 'heading', text: 'You’re on the waitlist', suggestedVars: ['speaker.name'] },
				{
					type: 'paragraph',
					text: 'Thank you for sending “{{submission.title}}” to {{event.name}}, {{speaker.name}}. We couldn’t place it in the program yet, and we didn’t want to let it go either — it’s on our waitlist.',
					suggestedVars: ['submission.title', 'event.name']
				},
				{
					type: 'details',
					rows: [
						{ label: 'Session', value: '{{submission.title}}' },
						{ label: 'Format', value: '{{submission.format}}' }
					]
				},
				{
					type: 'paragraph',
					text: 'If a slot opens, we’ll write to you straight away with a firm offer and a clear deadline. You don’t need to do anything to stay on the list.'
				},
				{ type: 'button', label: 'See where you stand', href: 'portal.waitlist' },
				{ type: 'divider' }
			],
			mergeFields: [
				{ key: 'speaker.name', label: 'Speaker name', sample: 'Tomás Ferreira' },
				{ key: 'submission.title', label: 'Submission title', sample: 'Prompt Caching at the Edge' },
				{ key: 'submission.format', label: 'Session format', sample: 'Talk' },
				{ key: 'event.name', label: 'Event name', sample: 'AI Engineer NYC 2026' }
			],
			revision: 1,
			revisions: [starterRevision()],
			usedBy: ['Decision notification']
		},
		{
			id: 'tpl-decision-declined',
			key: 'decision-declined',
			name: 'Decision — declined',
			purpose: 'Tells a submitter their proposal did not make the program, kindly and plainly.',
			subject: 'About “{{submission.title}}”',
			blocks: [
				{ type: 'heading', text: 'Thank you for submitting', suggestedVars: ['speaker.name'] },
				{
					type: 'paragraph',
					text: 'We read “{{submission.title}}” with care, {{speaker.name}}, and we’re sorry to say it won’t be part of {{event.name}} this time. The program came down to fit as much as quality, and this says more about our constraints than about your work.',
					suggestedVars: ['submission.title', 'event.name']
				},
				{
					type: 'details',
					rows: [
						{ label: 'Session', value: '{{submission.title}}' },
						{ label: 'Format', value: '{{submission.format}}' }
					]
				},
				{
					type: 'paragraph',
					text: 'We’d genuinely like to see you submit again — and you’re warmly invited to join us in the audience this year.'
				},
				{ type: 'button', label: 'Explore the program', href: 'event.schedule' },
				{ type: 'divider' }
			],
			mergeFields: [
				{ key: 'speaker.name', label: 'Speaker name', sample: 'Elif Aydın' },
				{ key: 'submission.title', label: 'Submission title', sample: 'YAML-Driven Agent Pipelines' },
				{ key: 'submission.format', label: 'Session format', sample: 'Workshop' },
				{ key: 'event.name', label: 'Event name', sample: 'AI Engineer NYC 2026' }
			],
			revision: 1,
			revisions: [starterRevision()],
			usedBy: ['Decision notification']
		},
		{
			id: 'tpl-speaker-invitation',
			key: 'speaker-invitation',
			name: 'Speaker invitation',
			purpose: 'Invites a speaker the team reached out to directly, before any submission.',
			subject: 'An invitation to speak at {{event.name}}',
			blocks: [
				{ type: 'heading', text: 'We’d like you on stage', suggestedVars: ['speaker.name'] },
				{
					type: 'paragraph',
					text: '{{speaker.name}}, we’re putting together {{event.name}} — {{event.dates}} in {{event.location}} — and we’d like you to be part of it.',
					suggestedVars: ['event.name', 'event.dates']
				},
				{
					type: 'paragraph',
					text: 'Accept below and we’ll take care of the rest: your session page, a short checklist, and a real person to write to whenever anything is unclear.'
				},
				{ type: 'button', label: 'Accept the invitation', href: 'portal.invitation' },
				{ type: 'divider' }
			],
			mergeFields: [
				{ key: 'speaker.name', label: 'Speaker name', sample: 'Ravi Chandran' },
				{ key: 'event.name', label: 'Event name', sample: 'AI Engineer NYC 2026' },
				{ key: 'event.dates', label: 'Event dates', sample: 'Oct 12–14, 2026' },
				{ key: 'event.location', label: 'Event location', sample: 'New York City' }
			],
			revision: 1,
			revisions: [starterRevision()],
			usedBy: ['Speaker onboarding']
		},
		{
			id: 'tpl-task-reminder',
			key: 'task-reminder',
			name: 'Task reminder',
			purpose: 'Nudges a speaker about one open checklist task, with its due date in view.',
			subject: 'A nudge on your {{task.name}}',
			blocks: [
				{ type: 'heading', text: 'One thing still open', suggestedVars: ['speaker.name'] },
				{
					type: 'paragraph',
					text: 'Hi {{speaker.name}} — a small reminder that your {{task.name}} for {{event.name}} is still open.',
					suggestedVars: ['task.name', 'task.due']
				},
				{
					type: 'details',
					rows: [
						{ label: 'Task', value: '{{task.name}}' },
						{ label: 'Due', value: '{{task.due}}' }
					],
					suggestedVars: ['task.due']
				},
				{
					type: 'paragraph',
					text: 'It usually takes a few minutes. If something is blocking you, reply to this email and a human will sort it out.'
				},
				{ type: 'button', label: 'Open your checklist', href: 'portal.tasks' },
				{ type: 'divider' }
			],
			mergeFields: [
				{ key: 'speaker.name', label: 'Speaker name', sample: 'Maya Lindqvist' },
				{ key: 'task.name', label: 'Task name', sample: 'AV requirements form' },
				{ key: 'task.due', label: 'Task due', sample: 'Sep 11, 23:59 EDT' },
				{ key: 'event.name', label: 'Event name', sample: 'AI Engineer NYC 2026' }
			],
			revision: 1,
			revisions: [starterRevision()],
			usedBy: ['Task reminders']
		},
		{
			id: 'tpl-schedule-announcement',
			key: 'schedule-announcement',
			name: 'Schedule announcement',
			purpose: 'Announces the published schedule to speakers and subscribers.',
			subject: 'The {{event.name}} schedule is live',
			blocks: [
				{ type: 'heading', text: 'The schedule is out', suggestedVars: ['event.name'] },
				{
					type: 'paragraph',
					text: 'The full program for {{event.name}} is now published — every session, room, and time for {{event.dates}} in {{event.location}}.',
					suggestedVars: ['event.name', 'event.dates']
				},
				{
					type: 'paragraph',
					text: 'Times can still shift a little as the days approach; the schedule page always shows the current truth.'
				},
				{ type: 'button', label: 'See the schedule', href: 'event.schedule' },
				{ type: 'divider' }
			],
			mergeFields: [
				{ key: 'event.name', label: 'Event name', sample: 'AI Engineer NYC 2026' },
				{ key: 'event.dates', label: 'Event dates', sample: 'Oct 12–14, 2026' },
				{ key: 'event.location', label: 'Event location', sample: 'New York City' }
			],
			revision: 1,
			revisions: [starterRevision()],
			usedBy: ['Schedule publish']
		}
	];
}

function starterRevision(): TemplateRevisionMeta {
	return { number: 1, at: 'At event creation', by: 'you', note: 'Starter' };
}

/** The ladder groups each starter form section asks; consent renders at the end of the talk section. */
const aboutYouGroups: FieldGroup[] = ['identity', 'contact', 'presence'];
const yourTalkGroups: FieldGroup[] = ['talk', 'logistics', 'materials', 'other', 'consent'];

/**
 * The public surface templates every event starts with: the published schedule
 * page and the CFP application form. A factory for the same reason as
 * `starterTemplates`; the event name titles each hero.
 *
 * The application form's sections and field pool are seeded from the baseline
 * field registry — the same derivation the API applies on every serve — so a
 * raw dataset is coherent on its own and stays coherent as the registry moves.
 */
export function starterSurfaceTemplates(eventName: string): SurfaceTemplate[] {
	const registry = baselineFieldRegistry();
	return [
		{
			id: 'srf-schedule',
			kind: 'schedule',
			name: 'Public schedule',
			purpose: 'The published program, rendered standalone and embedded from the same template.',
			blocks: [
				{
					type: 'hero',
					title: `${eventName} schedule`,
					intro:
						'Every session, room, and time in one place. Times can still shift a little as the days approach — this page always shows the current program.'
				},
				{
					type: 'schedule-days',
					grouping: 'day',
					showRoom: true,
					showTrack: true,
					showSpeakers: true,
					density: 'cozy'
				},
				{
					type: 'note',
					text: 'Sessions are recorded. Recordings go out to attendees a few days after the event.'
				}
			],
			revision: 1,
			revisions: [starterRevision()],
			usedBy: ['Public schedule · standalone & embed']
		},
		{
			id: 'srf-speaker-roster',
			kind: 'speaker-roster',
			name: 'Speaker roster',
			purpose: 'Who is speaking, in the order you set — the whole lineup or any one person.',
			blocks: [
				{
					type: 'hero',
					title: `Speaking at ${eventName}`,
					intro:
						'The people taking the stage this year. More join as sessions are confirmed, so this page keeps changing until the doors open.'
				},
				{
					type: 'roster-list',
					layout: 'grid',
					grouping: 'category',
					showHeadline: true,
					showSessions: true,
					showLinks: true,
					density: 'cozy'
				}
			],
			revision: 1,
			revisions: [starterRevision()],
			usedBy: ['Speaker roster · standalone & embed']
		},
		{
			id: 'srf-application-form',
			kind: 'application-form',
			name: 'Speaker application form',
			purpose: 'The public call-for-proposals form, standalone and embedded.',
			blocks: [
				{
					type: 'hero',
					title: `Speak at ${eventName}`,
					intro:
						'Tell us about yourself and the session you have in mind. It takes about ten minutes, and you can edit your application until the call closes.'
				},
				{
					type: 'form-section',
					title: 'About you',
					description: 'Who you are and where to reach you.',
					groups: aboutYouGroups,
					fieldRefs: sectionFieldIds(registry, aboutYouGroups, 'apply')
				},
				{
					type: 'form-section',
					title: 'Your talk',
					description: 'What you want to present. A working title is enough to start.',
					groups: yourTalkGroups,
					fieldRefs: sectionFieldIds(registry, yourTalkGroups, 'apply')
				},
				{
					type: 'note',
					text: 'We read every application. Decisions go out by email once the review round closes.'
				}
			],
			fields: contextFields(registry, 'apply').map((field) => asSurfaceField(field, 'apply')),
			revision: 1,
			revisions: [starterRevision()],
			usedBy: ['CFP form · standalone & embed']
		}
	];
}

/**
 * The same set with one template carrying an extra agent revision, for
 * scenarios where an agent has already touched the copy. Metadata only: the
 * seeded history does not carry the earlier body.
 */
export function withAgentRevision(
	templates: MessageTemplate[],
	key: string,
	note: string,
	at: string
): MessageTemplate[] {
	return templates.map((template) => {
		if (template.key !== key) return template;
		const number = template.revision + 1;
		return {
			...template,
			revision: number,
			revisions: [...template.revisions, { number, at, by: 'agent' as const, note }]
		};
	});
}

/** The short initials mark an event name yields by default ('AI Engineer NYC 2026' → 'AE'). */
export function eventMarkText(eventName: string): string {
	return eventName
		.split(/\s+/)
		.filter((word) => /^[a-z]/i.test(word))
		.slice(0, 2)
		.map((word) => word[0].toUpperCase())
		.join('');
}

/**
 * The brand an event starts with: the warm preset recipe plus the initials
 * mark derived from the event name. Null name (no event yet) leaves the mark
 * empty; the renderer owns the fallback.
 */
export function defaultEventTheme(eventName: string | null): EventTheme {
	return { ...defaultThemeRecipe, markText: eventName ? eventMarkText(eventName) : '' };
}
