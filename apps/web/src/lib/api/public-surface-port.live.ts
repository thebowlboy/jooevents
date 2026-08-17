import {
	createReadOperationResultSchema,
	formatDate,
	operationTransportErrorSchema,
	servedPublicFormSchema,
	servedPublicPresentationSchema,
	servedPublicRosterSchema,
	servedPublicScheduleSchema,
	type ServedPublicFormDto,
	type ServedPublicPresentationDto,
	type ServedPublicRosterDto,
	type ServedPublicScheduleDto
} from '@jooevents/contracts';
import { defaultThemeRecipe } from '$lib/theme/theme-contract';
import { createPublicApplicationClient } from './public-application-client';
import { createPublicApplicationSession } from './public-application-session';
import type { PublicSurfacePort } from './public-surface-port';
import type { PublicApplicationFormAvailability } from './public-surface-port';
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
 * Presentation comes from the active immutable surface release and its exact
 * style-set pin. The pages consume the same stable port whether standalone or
 * embedded.
 */

const PUBLIC_SCHEDULE_PATH = '/api/public/schedule/current';
const PUBLIC_SPEAKERS_PATH = '/api/public/speakers/current';
const PUBLIC_FORM_PATH = '/api/public/forms/current';
const PUBLIC_PRESENTATION_PATHS = Object.freeze({
	schedule: '/api/public/schedule/presentation',
	speakers: '/api/public/speakers/presentation',
	apply: '/api/public/forms/presentation'
});

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
const presentationResultSchema = createReadOperationResultSchema(servedPublicPresentationSchema);

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The typed-absence outcome kinds the public lane serves for "nothing published". */
const ABSENCE_OUTCOME_KINDS = new Set(['release.not_published', 'intake.not_found']);

type PublicReadState<Data> =
	| { readonly kind: 'served'; readonly data: Data }
	| { readonly kind: 'not_published' }
	| { readonly kind: 'closed' };

async function readPublicState<Data>(
	fetcher: FetchLike,
	path: string,
	schema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false } }
): Promise<PublicReadState<Data>> {
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
	if (result.kind === 'success') return { kind: 'served', data: result.data };
	const outcome = result.outcome;
	if (outcome.class === 'conflict' && outcome.kind === 'intake.form_closed') {
		return { kind: 'closed' };
	}
	if (outcome.class === 'conflict' && ABSENCE_OUTCOME_KINDS.has(outcome.kind)) {
		return { kind: 'not_published' };
	}
	throw new PublicSurfaceLiveError({ code: outcome.kind, retryable: outcome.retryable });
}

async function readPublic<Data>(
	fetcher: FetchLike,
	path: string,
	schema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false } }
): Promise<Data | null> {
	const state = await readPublicState<Data>(fetcher, path, schema);
	return state.kind === 'served' ? state.data : null;
}

// ---------------------------------------------------------------------------
// Released data → render-state mappings (pure, exported for tests)

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});
/**
 * A day tab, in the product's one date vocabulary and derived from the same
 * key the tab is grouped by — so the visitor's tab and the operator's grid can
 * no longer read `Thu, Mar 18` and `Thu Mar 18` for the same day. The year is
 * dropped because every tab in one event would otherwise repeat it.
 */
function dayLabel(dayKey: string): string {
	return formatDate(dayKey, { weekday: true, year: false });
}

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
			if (!dayKeys.has(key)) dayKeys.set(key, dayLabel(key));
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
// Released presentation

function scheduleTemplate(presentation: ServedPublicPresentationDto): SurfaceTemplate {
	return {
		id: 'live-public-schedule',
		kind: 'schedule',
		name: 'Schedule',
		purpose: 'The published programme, straight from the current release.',
		blocks: [
			{
				type: 'hero',
				title: presentation.manifest.heading ?? 'Schedule',
				intro: presentation.manifest.intro ?? ''
			},
			{
				type: 'schedule-days',
				grouping: 'day',
				showRoom: true,
				showTrack: true,
				showSpeakers: true,
				density: 'cozy'
			}
		],
		revision: presentation.surfaceReleaseNumber,
		revisions: [],
		usedBy: ['Hosted schedule page', 'Schedule embed']
	};
}

function rosterTemplate(presentation: ServedPublicPresentationDto): SurfaceTemplate {
	return {
		id: 'live-public-speakers',
		kind: 'speaker-roster',
		name: 'Speakers',
		purpose: 'The published lineup, straight from the current release.',
		blocks: [
			{
				type: 'hero',
				title: presentation.manifest.heading ?? 'Speakers',
				intro: presentation.manifest.intro ?? ''
			},
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
		revision: presentation.surfaceReleaseNumber,
		revisions: [],
		usedBy: ['Hosted speakers page', 'Speakers embed']
	};
}

function applyFormTemplate(
	served: ServedPublicFormDto,
	presentation: ServedPublicPresentationDto
): SurfaceTemplate {
	return {
		id: 'live-public-apply',
		kind: 'application-form',
		name: served.name,
		purpose: 'The published call for proposals, exactly as it asks.',
		blocks: [
			{
				type: 'hero',
				title: presentation.manifest.heading ?? served.name,
				intro: presentation.manifest.intro ?? ''
			},
			{
				type: 'form-section',
				title: 'Your proposal',
				fieldRefs: served.fields.map((field) => field.id)
			}
		],
		fields: mapServedFormFields(served),
		revision: presentation.surfaceReleaseNumber,
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

	function currentSurfaceKind(): keyof typeof PUBLIC_PRESENTATION_PATHS {
		try {
			const path = new URL(currentHref()).pathname;
			if (path.includes('speakers')) return 'speakers';
			if (path.includes('apply')) return 'apply';
		} catch {
			// A malformed location cannot widen publication. Schedule is only the
			// deterministic presentation lookup used by the shared shell.
		}
		return 'schedule';
	}

	const schedule = () =>
		shared('schedule', () =>
			readPublic<ServedPublicScheduleDto>(fetcher, PUBLIC_SCHEDULE_PATH, scheduleResultSchema)
		);
	const roster = () =>
		shared('roster', () =>
			readPublic<ServedPublicRosterDto>(fetcher, PUBLIC_SPEAKERS_PATH, rosterResultSchema)
		);
	const presentation = (kind: keyof typeof PUBLIC_PRESENTATION_PATHS) =>
		shared(`presentation:${kind}`, () =>
			readPublic<ServedPublicPresentationDto>(
				fetcher,
				PUBLIC_PRESENTATION_PATHS[kind],
				presentationResultSchema
			)
		);
	const form = (): Promise<PublicApplicationFormAvailability> => {
		const formId = scopedFormId();
		if (formId === null) return Promise.resolve({ kind: 'not_published' });
		return shared(`form:${formId}`, () =>
			readPublicState<ServedPublicFormDto>(
				fetcher,
				`${PUBLIC_FORM_PATH}?formId=${encodeURIComponent(formId)}`,
				formResultSchema
			)
		).then((state) => state.kind === 'served'
			? { kind: 'open' as const, form: state.data }
			: state
		);
	};

	return Object.freeze({
			templates: {
			async list() {
				const [servedSchedule, servedRoster, servedForm, schedulePresentation,
					rosterPresentation, applyPresentation] = await Promise.all([
					schedule(),
					roster(),
					form(),
					presentation('schedule'),
					presentation('speakers'),
					presentation('apply')
				]);
				const surfaces: SurfaceTemplate[] = [];
				if (servedSchedule !== null && schedulePresentation !== null) {
					surfaces.push(scheduleTemplate(schedulePresentation));
				}
				if (servedRoster !== null && rosterPresentation !== null) {
					surfaces.push(rosterTemplate(rosterPresentation));
				}
				if (servedForm.kind === 'open' && applyPresentation !== null) {
					surfaces.push(applyFormTemplate(servedForm.form, applyPresentation));
				}
				return { surfaces };
			}
		},
		theme: {
			get: async (): Promise<EventTheme> => {
				const released = await presentation(currentSurfaceKind());
				return released === null
					? { ...defaultThemeRecipe, markText: '' }
					: { ...released.style, markText: '' };
			}
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
				return served.kind === 'open' ? [mapServedFormSummary(served.form)] : [];
			}
		},
		application: {
			// The served DTO for the answering surface, sharing the one
			// in-flight form read with `templates.list()` so both agree on one
			// served answer.
			served: (input: { readonly formId: string }) =>
				shared(`form:${input.formId}`, () =>
					readPublicState<ServedPublicFormDto>(
						fetcher,
						`${PUBLIC_FORM_PATH}?formId=${encodeURIComponent(input.formId)}`,
						formResultSchema
					)
				).then((state) => state.kind === 'served'
					? { kind: 'open' as const, form: state.data }
					: state
				),
			// The ceremony lane over the same fetcher: mint + begin on start,
			// autosave while editing, one idempotent submit. Whether the server
			// actually takes answers is the published apply surface's decision —
			// an unpublished or rolled-back surface stops the session, and the
			// page renders that refusal instead of a silently dead form.
			session: (input: {
				readonly formId: string;
				readonly target?: ServedPublicFormDto['target'];
				readonly continuation?: string;
			}) =>
				createPublicApplicationSession({
					client: createPublicApplicationClient({ fetcher }),
					formId: input.formId,
					...(input.target === undefined ? {} : { target: input.target }),
					...(input.continuation === undefined
						? {}
						: { continuation: input.continuation })
				}),
			// No public POST exchange serves a handed-off continuation yet.
			continuationHandoff: { kind: 'not_served' as const }
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
