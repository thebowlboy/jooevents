import {
	createReadOperationResultSchema,
	operationTransportErrorSchema,
	servedPublicFormSchema,
	servedPublicRosterSchema,
	servedPublicScheduleSchema,
	type ServedPublicFormDto,
	type ServedPublicRosterDto,
	type ServedPublicScheduleDto
} from '@jooevents/contracts';
import { defaultThemeRecipe } from '$lib/theme/theme-contract';
import type { PublicSurfacePort } from './public-surface-port';
import type {
	EventTheme,
	FormSummary,
	PublicSpeakerCard,
	ScheduleState,
	SurfaceTemplate,
	Track
} from './types';

/**
 * The hosted public pages over the anonymous public reads.
 *
 * Three GET paths exist on the public lane — the published form, the published
 * schedule, the published speakers — and everything the pages render derives
 * from those served release DTOs. Publication state is a server fact: the
 * typed `release.not_published` / `intake.not_found` outcome is the only thing
 * that renders as "not published yet", and a transport failure throws instead,
 * leaving the page's loading shell rather than fabricating an absent or empty
 * world.
 *
 * Presentation is the compiled default: no style-set or surface-manifest read
 * is served publicly yet, so the templates below are the product's own default
 * composition and the brand is the default recipe. When surface releases gain
 * a public read, this port swaps presentation sources without the pages
 * changing.
 */

const PUBLIC_SCHEDULE_PATH = '/api/public/schedule/current';
const PUBLIC_SPEAKERS_PATH = '/api/public/speakers/current';
const PUBLIC_FORM_PATH = '/api/public/forms/current';

/** Typed failure at the public-surface boundary; absence is never an error. */
export class PublicSurfaceLiveError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(input: { readonly code: string; readonly retryable: boolean }) {
		super(`Public surface read failed (${input.code}).`);
		this.name = 'PublicSurfaceLiveError';
		this.code = input.code;
		this.retryable = input.retryable;
	}
}

const scheduleResultSchema = createReadOperationResultSchema(servedPublicScheduleSchema);
const rosterResultSchema = createReadOperationResultSchema(servedPublicRosterSchema);
const formResultSchema = createReadOperationResultSchema(servedPublicFormSchema);

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The typed-absence outcome kinds the public lane serves for "nothing published". */
const ABSENCE_OUTCOME_KINDS = new Set(['release.not_published', 'intake.not_found']);

async function readPublic<Data>(
	fetcher: FetchLike,
	path: string,
	schema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false } }
): Promise<Data | null> {
	let response: Response;
	try {
		response = await fetcher(path, { headers: { accept: 'application/json' } });
	} catch {
		throw new PublicSurfaceLiveError({ code: 'network_unreachable', retryable: true });
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new PublicSurfaceLiveError({ code: 'invalid_contract', retryable: true });
	}
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		const transport = operationTransportErrorSchema.safeParse(body);
		if (transport.success) {
			throw new PublicSurfaceLiveError({
				code: transport.data.code,
				retryable: transport.data.retryable
			});
		}
		throw new PublicSurfaceLiveError({ code: 'invalid_contract', retryable: true });
	}
	const result = parsed.data as
		| { kind: 'success'; data: Data }
		| { kind: 'outcome'; outcome: { class: string; kind: string; retryable: boolean } };
	if (result.kind === 'success') return result.data;
	const outcome = result.outcome;
	if (outcome.class === 'conflict' && ABSENCE_OUTCOME_KINDS.has(outcome.kind)) return null;
	throw new PublicSurfaceLiveError({ code: outcome.kind, retryable: outcome.retryable });
}

// ---------------------------------------------------------------------------
// Released data → render-state mappings (pure, exported for tests)

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});
const dayLabelFormat = new Intl.DateTimeFormat('en-US', {
	weekday: 'short',
	month: 'short',
	day: 'numeric'
});

function localDayKey(instant: Date): string {
	return dayKeyFormat.format(instant);
}

function minutesSinceLocalMidnight(instant: Date): number {
	return instant.getHours() * 60 + instant.getMinutes();
}

function trackIdFor(track: { readonly name: string }): string {
	return `released-track:${track.name}`;
}

/**
 * The released program as the schedule surface renders it. Occurrence instants
 * are absolute; the visitor's own clock lays them out (no timezone is served),
 * and only released content exists here — the release already enforced
 * confirmed-and-visible, so this mapping may only reshape, never widen.
 */
export function mapServedScheduleState(served: ServedPublicScheduleDto): ScheduleState {
	const dayKeys = new Map<string, string>();
	const placements: ScheduleState['placements'] = [];
	const sessions: ScheduleState['sessions'] = [];
	for (const session of served.sessions) {
		const first = session.occurrences[0];
		const durationMin = first
			? Math.max(
					5,
					Math.round((Date.parse(first.endAt) - Date.parse(first.startAt)) / 60_000)
				)
			: session.plannedDurationMinutes;
		sessions.push({
			id: session.sessionId,
			title: session.title,
			// The public schedule names people; it never keys or addresses them.
			speakers: session.speakers.map((name) => ({ name, email: '' })),
			trackId: session.track ? trackIdFor(session.track) : 'released-track:none',
			formatId: `released-format:${session.format}`,
			durationMin,
			state: 'programmed'
		});
		for (const occurrence of session.occurrences) {
			const start = new Date(Date.parse(occurrence.startAt));
			const key = localDayKey(start);
			if (!dayKeys.has(key)) dayKeys.set(key, dayLabelFormat.format(start));
			placements.push({
				sessionId: session.sessionId,
				dayKey: key,
				roomId: occurrence.roomId,
				startMin: minutesSinceLocalMidnight(start),
				conflicts: []
			});
		}
	}
	const days = [...dayKeys.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, label]) => ({ key, label }));
	return {
		days,
		rooms: served.rooms.map((room) => ({
			id: room.id,
			name: room.name,
			capacity: null,
			status: 'active',
			usage: { submissions: 0, sessions: 0, placements: 0 }
		})),
		dayStart: '00:00',
		slotMinutes: 30,
		slotsPerDay: 48,
		sessions,
		placements,
		breaks: [],
		published: true
	};
}

/** The track vocabulary the released sessions carry, as name+accent pairs. */
export function mapServedTracks(served: ServedPublicScheduleDto): Track[] {
	const tracks = new Map<string, Track>();
	for (const session of served.sessions) {
		if (!session.track) continue;
		const id = trackIdFor(session.track);
		if (!tracks.has(id)) {
			tracks.set(id, {
				id,
				name: session.track.name,
				accent: session.track.accent,
				status: 'active',
				usage: { submissions: 0, sessions: 0, placements: 0 }
			});
		}
	}
	return [...tracks.values()];
}

/**
 * Released speaker cards. A served card carries no person identifier at all,
 * so the card id is positional within this response — stable for one render,
 * never an address for a person.
 */
export function mapServedRoster(served: ServedPublicRosterDto): PublicSpeakerCard[] {
	return served.speakers.map((speaker, index) => ({
		id: `released-speaker:${index}`,
		name: speaker.name,
		links: [],
		sessions: speaker.sessions.map((session) => ({ id: session.sessionId, title: session.title })),
		provisional: false
	}));
}

/** The published form as the forms list the apply page consumes. */
export function mapServedFormSummary(served: ServedPublicFormDto): FormSummary {
	return {
		id: served.formId,
		name: served.name,
		target:
			served.target.kind === 'general_pool'
				? { kind: 'general' }
				: served.target.kind === 'category'
					? {
							kind: 'category',
							category: served.target.category.kind,
							id: served.target.category.id
						}
					: { kind: 'session', sessionId: served.target.sessionId },
		status: 'open',
		...(served.availability.kind === 'closes'
			? { closesAt: served.availability.effectiveAt.slice(0, 10) }
			: {}),
		version: served.formVersionNumber,
		submissionCount: 0,
		fieldCount: served.fields.length,
		composition: { excludedFieldIds: [], requiredOverrides: {}, optionExposure: {} }
	};
}

/** The published form's questions as the surface's own field pool. */
export function mapServedFormFields(served: ServedPublicFormDto): SurfaceTemplate['fields'] {
	return served.fields.map((field) => ({
		id: field.id,
		label: field.label,
		kind: field.kind,
		required: field.required,
		...(field.help === null ? {} : { help: field.help }),
		...('options' in field ? { options: field.options.map((option) => option.label) } : {}),
		group: 'other' as const
	}));
}

// ---------------------------------------------------------------------------
// Default presentation (no public surface-manifest read exists yet)

function defaultScheduleTemplate(): SurfaceTemplate {
	return {
		id: 'live-public-schedule',
		kind: 'schedule',
		name: 'Schedule',
		purpose: 'The published programme, straight from the current release.',
		blocks: [
			{ type: 'hero', title: 'Schedule', intro: '' },
			{
				type: 'schedule-days',
				grouping: 'day',
				showRoom: true,
				showTrack: true,
				showSpeakers: true,
				density: 'cozy'
			}
		],
		revision: 1,
		revisions: [],
		usedBy: ['Hosted schedule page', 'Schedule embed']
	};
}

function defaultRosterTemplate(): SurfaceTemplate {
	return {
		id: 'live-public-speakers',
		kind: 'speaker-roster',
		name: 'Speakers',
		purpose: 'The published lineup, straight from the current release.',
		blocks: [
			{ type: 'hero', title: 'Speakers', intro: '' },
			{
				type: 'roster-list',
				layout: 'grid',
				grouping: 'none',
				showHeadline: true,
				showSessions: true,
				showLinks: false,
				density: 'cozy'
			}
		],
		revision: 1,
		revisions: [],
		usedBy: ['Hosted speakers page', 'Speakers embed']
	};
}

function applyFormTemplate(served: ServedPublicFormDto): SurfaceTemplate {
	return {
		id: 'live-public-apply',
		kind: 'application-form',
		name: served.name,
		purpose: 'The published call for proposals, exactly as it asks.',
		blocks: [
			{ type: 'hero', title: served.name, intro: '' },
			{
				type: 'form-section',
				title: 'Your proposal',
				fieldRefs: served.fields.map((field) => field.id)
			}
		],
		fields: mapServedFormFields(served),
		revision: served.formVersionNumber,
		revisions: [],
		usedBy: ['Hosted application page']
	};
}

// ---------------------------------------------------------------------------
// The port

export function createLivePublicSurfacePort(
	fetcher: FetchLike = (input, init) => fetch(input, init),
	currentHref: () => string = () =>
		typeof window === 'undefined' ? 'http://localhost/' : window.location.href
): PublicSurfacePort {
	// One in-flight read per public resource per composition: the page reads
	// `templates.list()` and its kind's data in the same mount, and both must
	// agree on one served answer. A failed read clears itself so the next
	// navigation retries instead of caching the failure.
	const memo = new Map<string, Promise<unknown>>();
	function shared<Value>(key: string, read: () => Promise<Value>): Promise<Value> {
		const existing = memo.get(key);
		if (existing) return existing as Promise<Value>;
		const pending = read().catch((error: unknown) => {
			memo.delete(key);
			throw error;
		});
		memo.set(key, pending);
		return pending;
	}

	/**
	 * The public form read is form-addressed (`?formId=`): "current" names the
	 * form's current published version, not an id-less lookup. The only public
	 * carrier of that id is the page's own scope parameter (`scope=form:<id>`),
	 * so a bare apply address honestly has no published form to serve until an
	 * id-less current-form read exists on the public lane.
	 */
	function scopedFormId(): string | null {
		try {
			const scope = new URL(currentHref()).searchParams.get('scope');
			if (!scope || !scope.startsWith('form:')) return null;
			const id = scope.slice('form:'.length);
			return id.length > 0 ? id : null;
		} catch {
			return null;
		}
	}

	const schedule = () =>
		shared('schedule', () =>
			readPublic<ServedPublicScheduleDto>(fetcher, PUBLIC_SCHEDULE_PATH, scheduleResultSchema)
		);
	const roster = () =>
		shared('roster', () =>
			readPublic<ServedPublicRosterDto>(fetcher, PUBLIC_SPEAKERS_PATH, rosterResultSchema)
		);
	const form = () => {
		const formId = scopedFormId();
		if (formId === null) return Promise.resolve(null);
		return shared(`form:${formId}`, () =>
			readPublic<ServedPublicFormDto>(
				fetcher,
				`${PUBLIC_FORM_PATH}?formId=${encodeURIComponent(formId)}`,
				formResultSchema
			)
		);
	};

	return Object.freeze({
		templates: {
			async list() {
				const [servedSchedule, servedRoster, servedForm] = await Promise.all([
					schedule(),
					roster(),
					form()
				]);
				const surfaces: SurfaceTemplate[] = [];
				if (servedSchedule !== null) surfaces.push(defaultScheduleTemplate());
				if (servedRoster !== null) surfaces.push(defaultRosterTemplate());
				if (servedForm !== null) surfaces.push(applyFormTemplate(servedForm));
				return { surfaces };
			}
		},
		theme: {
			// No style-set release is publicly served yet: the brand is the
			// product's default recipe, never a guess at the event's own.
			get: async (): Promise<EventTheme> => ({ ...defaultThemeRecipe, markText: '' })
		},
		workspace: {
			// No public event-identity read exists; the pages render without a
			// name rather than inventing one.
			summary: async () => ({ event: null })
		},
		settings: {
			// Hidden from search always: no served indexing opt-in exists, and a
			// page that was never crawled is the only one easy to withdraw.
			get: async () => null
		},
		schedule: {
			state: async () => {
				const served = await schedule();
				return served === null ? emptyScheduleState() : mapServedScheduleState(served);
			}
		},
		vocab: {
			tracks: async () => {
				const served = await schedule();
				return served === null ? [] : mapServedTracks(served);
			},
			speakerCategories: async () => []
		},
		speakers: {
			publicRoster: async () => {
				const served = await roster();
				return served === null ? [] : mapServedRoster(served);
			}
		},
		forms: {
			list: async () => {
				const served = await form();
				return served === null ? [] : [mapServedFormSummary(served)];
			}
		}
	});
}

/**
 * The shape a kind's data read resolves to while that kind is not published.
 * The page never renders it — `templates.list()` already reported the absence
 * and the honest gate takes the frame — but the read must still resolve.
 */
function emptyScheduleState(): ScheduleState {
	return {
		days: [],
		rooms: [],
		dayStart: '00:00',
		slotMinutes: 30,
		slotsPerDay: 48,
		sessions: [],
		placements: [],
		breaks: [],
		published: false
	};
}
