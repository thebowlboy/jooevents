import { describe, expect, test } from 'bun:test';
import type {
	ServedPublicPresentationDto,
	ServedPublicRosterDto,
	ServedPublicScheduleDto,
	SurfaceKind
} from '@jooevents/contracts';
import {
	PublicSurfaceLiveError,
	createLivePublicSurfacePort,
	mapServedFormSummary,
	mapServedRoster,
	mapServedScheduleState,
	mapServedSpeakerCategories,
	mapServedTracks
} from './public-surface-port.live';

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

function success(data: unknown): unknown {
	return { kind: 'success', data, correlationId: crypto.randomUUID() };
}

function conflict(kind: string): unknown {
	return {
		kind: 'outcome',
		outcome: {
			class: 'conflict',
			kind,
			retryable: false,
			subjects: [],
			detail: null,
			detailSchemaVersion: 1
		},
		correlationId: crypto.randomUUID()
	};
}

const notPublished = () => conflict('release.not_published');
const formNotFound = () => conflict('intake.not_found');
const formClosed = () => conflict('intake.form_closed');

const ids = {
	room: '018f6f00-0000-7000-8000-00000000000a',
	sessionA: '018f6f00-0000-7000-8000-0000000000aa',
	sessionB: '018f6f00-0000-7000-8000-0000000000ab',
	occurrenceA: '018f6f00-0000-7000-8000-0000000000ba',
	speaker: '018f6f00-0000-7000-8000-0000000000ca',
	category: '018f6f00-0000-7000-8000-0000000000da'
} as const;

function servedSchedule(): ServedPublicScheduleDto {
	return {
		schemaVersion: 1,
		releaseNumber: 2,
		rooms: [{ id: ids.room, name: 'Main Hall' }],
		sessions: [
			{
				sessionId: ids.sessionA,
				title: 'Agent Product Craft',
				plannedDurationMinutes: 45,
				format: 'Talk',
				track: { name: 'Craft', accent: 'sea' },
				occurrences: [
					{
						occurrenceId: ids.occurrenceA,
						roomId: ids.room,
						startAt: '2027-05-04T07:30:00.000Z',
						endAt: '2027-05-04T08:15:00.000Z'
					}
				],
				speakers: ['Ada Alpha']
			},
			{
				sessionId: ids.sessionB,
				title: 'Unplaced but programmed',
				plannedDurationMinutes: 30,
				format: 'Talk',
				track: null,
				occurrences: [],
				speakers: []
			}
		]
	};
}

function servedRoster(): ServedPublicRosterDto {
	return {
		schemaVersion: 1,
		releaseNumber: 2,
		speakers: [
			{ name: 'Ada Alpha', sessions: [{ sessionId: ids.sessionA, title: 'Agent Product Craft' }] }
		]
	};
}

function lineupRoster(): ServedPublicRosterDto {
	return {
		schemaVersion: 1,
		releaseNumber: 3,
		categories: [{
			id: ids.category,
			name: 'Keynotes',
			accent: 'lavender',
			position: 0
		}],
		speakers: [{
			id: ids.speaker,
			name: 'Ada Alpha',
			categoryId: ids.category,
			headline: 'Engineer',
			biography: 'Builds dependable systems.',
			location: 'Singapore',
			links: [{ kind: 'website', label: 'Website', href: 'https://example.com/ada' }],
			sessions: []
		}]
	};
}

function servedPresentation(
	surfaceKind: SurfaceKind,
	heading: string
): ServedPublicPresentationDto {
	return {
		schemaVersion: 1,
		surfaceKind,
		surfaceReleaseNumber: 2,
		manifest: { schemaVersion: 1, heading, intro: `${heading} introduction` },
		styleSetReleaseNumber: 1,
		style: {
			name: 'Released brand', canvas: '#f4f1ed', surface: '#ffffff', text: '#29231f',
			action: '#a14e42', radius: 8, controlHeight: 38
		}
	};
}

function fetcherFor(routes: Record<string, () => Response>): (
	input: string
) => Promise<Response> {
	return async (input: string) => {
		const route = routes[input];
		if (!route && input.endsWith('/presentation')) return json(notPublished());
		if (!route) throw new Error(`Unexpected fetch: ${input}`);
		return route();
	};
}

describe('live public-surface port', () => {
	test('typed absence serves the honest empty world: no surfaces, no error', async () => {
		const port = createLivePublicSurfacePort(
			fetcherFor({
				'/api/public/schedule/current': () => json(notPublished()),
				'/api/public/speakers/current': () => json(notPublished()),
				'/api/public/forms/current': () => json(formNotFound())
			})
		);
		const { surfaces } = await port.templates.list();
		expect(surfaces).toEqual([]);
		expect((await port.schedule.state()).sessions).toEqual([]);
		expect(await port.speakers.publicRoster()).toEqual([]);
		expect(await port.forms.list()).toEqual([]);
		expect(await port.settings.get()).toBeNull();
		expect((await port.workspace.summary()).event).toBeNull();
	});

	test('a published release maps into the render state without widening', async () => {
		let scheduleReads = 0;
		const port = createLivePublicSurfacePort(
			fetcherFor({
				'/api/public/schedule/current': () => {
					scheduleReads += 1;
					return json(success(servedSchedule()));
				},
				'/api/public/speakers/current': () => json(success(servedRoster())),
				'/api/public/schedule/presentation': () =>
					json(success(servedPresentation('schedule', 'Released schedule'))),
				'/api/public/speakers/presentation': () =>
					json(success(servedPresentation('speakers', 'Released speakers'))),
				'/api/public/forms/current': () => json(formNotFound())
			})
		);
		const { surfaces } = await port.templates.list();
		expect(surfaces.map((surface) => surface.kind).sort()).toEqual([
			'schedule',
			'speaker-roster'
		]);
		expect(surfaces.find((surface) => surface.kind === 'schedule')?.blocks[0]).toMatchObject({
			type: 'hero', title: 'Released schedule', intro: 'Released schedule introduction'
		});
		expect(await port.theme.get()).toMatchObject({ name: 'Released brand', action: '#a14e42' });

		const state = await port.schedule.state();
		expect(state.published).toBe(true);
		expect(state.sessions.map((session) => session.id)).toEqual([ids.sessionA, ids.sessionB]);
		expect(state.sessions[0]?.speakers).toEqual([{ name: 'Ada Alpha', email: '' }]);
		expect(state.sessions[0]?.state).toBe('programmed');
		expect(state.placements).toHaveLength(1);
		const placement = state.placements[0];
		expect(placement?.roomId).toBe(ids.room);
		const start = new Date(Date.parse('2027-05-04T07:30:00.000Z'));
		expect(placement?.startMin).toBe(start.getHours() * 60 + start.getMinutes());
		expect(state.days).toHaveLength(1);
		expect(state.rooms).toEqual([
			{
				id: ids.room,
				name: 'Main Hall',
				capacity: null,
				status: 'active',
				usage: { submissions: 0, sessions: 0, placements: 0 }
			}
		]);

		const tracks = await port.vocab.tracks();
		expect(tracks).toHaveLength(1);
		expect(tracks[0]).toMatchObject({ name: 'Craft', accent: 'sea' });
		expect(tracks[0]?.id).toBe(state.sessions[0]?.trackId ?? '');

		const roster = await port.speakers.publicRoster();
		expect(roster).toHaveLength(1);
		expect(roster[0]).toMatchObject({ name: 'Ada Alpha', provisional: true, links: [] });
		expect(roster[0]?.sessions).toEqual([{ id: ids.sessionA, title: 'Agent Product Craft' }]);
		// No person key survives the mapping: the card id is positional.
		expect(JSON.stringify(roster)).not.toContain('personId');

		// One in-flight schedule read serves templates.list, state, and tracks.
		expect(scheduleReads).toBe(1);
	});

	test('a transport failure throws instead of fabricating absence', async () => {
		const port = createLivePublicSurfacePort(async () => {
			throw new Error('network down');
		});
		expect(port.templates.list()).rejects.toBeInstanceOf(PublicSurfaceLiveError);
		let failure: unknown;
		try {
			await port.schedule.state();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(PublicSurfaceLiveError);
		expect((failure as PublicSurfaceLiveError).retryable).toBe(true);
	});

	test('a response outside the served contract refuses as invalid_contract', async () => {
		const port = createLivePublicSurfacePort(
			fetcherFor({
				'/api/public/schedule/current': () =>
					json(success({ smuggled: true })),
				'/api/public/speakers/current': () => json(notPublished()),
				'/api/public/forms/current': () => json(formNotFound())
			})
		);
		let failure: unknown;
		try {
			await port.schedule.state();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(PublicSurfaceLiveError);
		expect((failure as PublicSurfaceLiveError).code).toBe('invalid_contract');
	});

	test('a failed read clears the shared memo so the next call retries', async () => {
		let calls = 0;
		const port = createLivePublicSurfacePort(async () => {
			calls += 1;
			if (calls === 1) throw new Error('first attempt fails');
			return json(success(servedSchedule()));
		});
		await expect(port.schedule.state()).rejects.toBeInstanceOf(PublicSurfaceLiveError);
		const state = await port.schedule.state();
		expect(state.sessions).toHaveLength(2);
	});

	test('mapping helpers keep released facts exact', () => {
		const state = mapServedScheduleState(servedSchedule());
		// The unplaced programmed session exists in state but has no placement.
		expect(state.placements.every((placement) => placement.sessionId === ids.sessionA)).toBe(
			true
		);
		// Occurrence duration wins over planned minutes when placed.
		expect(state.sessions[0]?.durationMin).toBe(45);
		expect(mapServedTracks(servedSchedule()).map((track) => track.name)).toEqual(['Craft']);
		expect(mapServedRoster(servedRoster())[0]?.id).toBe('released-speaker:0');
		expect(mapServedRoster(lineupRoster())[0]).toMatchObject({
			id: ids.speaker,
			categoryId: ids.category,
			headline: 'Engineer',
			biography: 'Builds dependable systems.',
			location: 'Singapore',
			links: [{ kind: 'website', label: 'Website', href: 'https://example.com/ada' }],
			provisional: false,
			sessions: []
		});
		expect(mapServedSpeakerCategories(lineupRoster())).toEqual([{
			id: ids.category,
			name: 'Keynotes',
			accent: 'lavender',
			status: 'active',
			speakerCount: 1
		}]);
	});

	test('the published form maps into an apply surface and summary', async () => {
		const field = {
			id: '018f6f00-0000-7000-8000-0000000000f1',
			label: 'Talk title',
			help: null,
			required: true,
			initiallyVisible: true,
			position: 0,
			kind: 'text' as const,
			maximumLength: 500
		};
		const served = {
			schemaVersion: 1,
			formId: '018f6f00-0000-7000-8000-0000000000f0',
			formVersionId: '018f6f00-0000-7000-8000-0000000000f2',
			formVersionNumber: 3,
			name: 'Call for proposals',
			confirmation: 'Thanks! We received it.',
			target: { kind: 'general_pool' as const },
			availability: { kind: 'evergreen' as const },
			fields: [field],
			rules: []
		};
		// The form read is form-addressed: the id rides the page's own scope
		// parameter, and the port asks for exactly that form's current version.
		const port = createLivePublicSurfacePort(
			fetcherFor({
				'/api/public/schedule/current': () => json(notPublished()),
				'/api/public/speakers/current': () => json(notPublished()),
				'/api/public/forms/presentation': () =>
					json(success(servedPresentation('apply', 'Apply now'))),
				[`/api/public/forms/current?formId=${served.formId}`]: () => json(success(served))
			}),
			() => `http://127.0.0.1/s/apply?scope=form%3A${served.formId}`
		);
		const { surfaces } = await port.templates.list();
		expect(surfaces).toHaveLength(1);
		const apply = surfaces[0];
		expect(apply?.kind).toBe('application-form');
		expect(apply?.name).toBe('Call for proposals');
		expect(apply?.blocks[0]).toMatchObject({ type: 'hero', title: 'Apply now' });
		expect(apply?.fields?.map((entry) => entry.label)).toEqual(['Talk title']);
		const summaries = await port.forms.list();
		expect(summaries[0]).toMatchObject({
			name: 'Call for proposals',
			status: 'open',
			version: 3,
			fieldCount: 1
		});
		expect(mapServedFormSummary(served as never).target).toEqual({ kind: 'general' });
	});

	test('the application capability serves the exact DTO from the one in-flight form read', async () => {
		const field = {
			id: '018f6f00-0000-7000-8000-0000000000f1',
			label: 'Talk title',
			help: null,
			required: true,
			initiallyVisible: true,
			position: 0,
			kind: 'text' as const,
			maximumLength: 500
		};
		const served = {
			schemaVersion: 1,
			formId: '018f6f00-0000-7000-8000-0000000000f0',
			formVersionId: '018f6f00-0000-7000-8000-0000000000f2',
			formVersionNumber: 3,
			name: 'Call for proposals',
			confirmation: 'Thanks! We received it.',
			target: { kind: 'general_pool' as const },
			availability: { kind: 'evergreen' as const },
			fields: [field],
			rules: []
		};
		let formReads = 0;
		const port = createLivePublicSurfacePort(
			fetcherFor({
				'/api/public/schedule/current': () => json(notPublished()),
				'/api/public/speakers/current': () => json(notPublished()),
				'/api/public/forms/presentation': () =>
					json(success(servedPresentation('apply', 'Apply now'))),
				[`/api/public/forms/current?formId=${served.formId}`]: () => {
					formReads += 1;
					return json(success(served));
				}
			}),
			() => `http://127.0.0.1/s/apply?scope=form%3A${served.formId}`
		);
		const [{ surfaces }, dto] = await Promise.all([
			port.templates.list(),
			port.application!.served({ formId: served.formId })
		]);
		expect(surfaces).toHaveLength(1);
		// The served DTO keeps what the flattened template drops: field
		// constraints and option identities.
		expect(dto).toEqual({ kind: 'open', form: served as never });
		expect(formReads).toBe(1);
		// The embed ↔ standalone handoff exchange is not served yet: typed
		// absence, never a query-string fallback.
		expect(port.application?.continuationHandoff).toEqual({ kind: 'not_served' });
	});

	test('a closed form remains a typed marker without serving its questions', async () => {
		const formId = '018f6f00-0000-7000-8000-0000000000f0';
		const port = createLivePublicSurfacePort(
			fetcherFor({
				'/api/public/schedule/current': () => json(notPublished()),
				'/api/public/speakers/current': () => json(notPublished()),
				'/api/public/forms/presentation': () =>
					json(success(servedPresentation('apply', 'Apply now'))),
				[`/api/public/forms/current?formId=${formId}`]: () => json(formClosed())
			}),
			() => `http://127.0.0.1/s/apply?scope=form%3A${formId}`
		);
		expect(await port.application!.served({ formId })).toEqual({ kind: 'closed' });
		expect((await port.templates.list()).surfaces).toEqual([]);
		expect(await port.forms.list()).toEqual([]);
	});

	test('a port session carries the served target into the recorded re-offer', async () => {
		const formId = '018f6f00-0000-7000-8000-0000000000f0';
		const continuation = `gsr_${'a'.repeat(43)}`;
		const receipt = {
			id: '018f6f00-0000-7000-8000-0000000000ee',
			operationName: 'intake.public.application',
			operationVersion: 1
		};
		const draft = {
			schemaVersion: 1,
			formId,
			formVersionId: '018f6f00-0000-7000-8000-0000000000f2',
			draftVersion: 1,
			status: 'in_progress',
			answeredFieldIds: [],
			submittedSubmissionId: null,
			updatedAt: '2026-08-14T12:00:00.000Z'
		};
		const port = createLivePublicSurfacePort(async (input, init) => {
			if (input === '/api/public/forms/application/continuations') {
				return json({ kind: 'issued', continuation, expiresAt: '2026-08-14T12:05:00.000Z' });
			}
			if (input === '/api/public/forms/application/mutate') {
				const body = JSON.parse(String(init?.body)) as { action: string };
				if (body.action === 'begin') {
					return json({
						kind: 'success',
						data: { action: 'begin', draft },
						receipt,
						correlationId: crypto.randomUUID()
					});
				}
				return json({
					kind: 'outcome',
					outcome: {
						class: 'policy_violation',
						kind: 'intake.refused',
						retryable: false,
						subjects: [],
						detail: { reason: 'target_closed' },
						detailSchemaVersion: 1
					},
					terminal: false,
					correlationId: crypto.randomUUID()
				});
			}
			throw new Error(`Unexpected fetch: ${input}`);
		});
		const session = port.application!.session({
			formId,
			target: {
				kind: 'session',
				sessionId: '018f6f00-0000-7000-8000-0000000000ab',
				title: 'Collecting Panel'
			}
		});
		await session.start();
		const state = await session.submit();
		expect(state.refusal).toMatchObject({
			kind: 'target_no_longer_collecting',
			reasonCode: 'target_closed',
			reason: 'Its call has closed.'
		});
	});

	test('a bare apply address carries no form id and stays honestly absent, fetch-free', async () => {
		let formFetches = 0;
		const port = createLivePublicSurfacePort(
			fetcherFor({
				'/api/public/schedule/current': () => json(notPublished()),
				'/api/public/speakers/current': () => json(notPublished()),
				'/api/public/forms/current': () => {
					formFetches += 1;
					return json(formNotFound());
				}
			}),
			() => 'http://127.0.0.1/s/apply'
		);
		expect((await port.templates.list()).surfaces).toEqual([]);
		expect(await port.forms.list()).toEqual([]);
		expect(formFetches).toBe(0);
	});
});
