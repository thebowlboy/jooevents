import { describe, expect, test } from 'bun:test';
import type {
	PublicSpeakerCard,
	ScheduleState,
	SessionItem,
	Track
} from '$lib/api/types';
import {
	SESSION_SEARCH_SCOPE,
	SPEAKER_SEARCH_SCOPE,
	adjacentDayKey,
	collectPublishedFacets,
	describeSessionResults,
	describeSpeakerResults,
	filterPlacedSessions,
	hrefWithParams,
	narrowSchedule,
	orderRosterBySurname,
	parseSchedulePresentation,
	parseSpeakerOrder,
	parseSpeakerPresentation,
	presentRoster,
	publishedFormatName,
	sessionDetailView,
	sessionMatchesSearch,
	speakerMatchesSearch
} from './program-discovery';

const tracks: Track[] = [
	{
		id: 'released-track:Craft',
		name: 'Craft',
		accent: 'sea',
		status: 'active',
		usage: { submissions: 0, sessions: 0, placements: 0 }
	},
	{
		id: 'released-track:Ops',
		name: 'Ops',
		accent: 'lavender',
		status: 'active',
		usage: { submissions: 0, sessions: 0, placements: 0 }
	}
];

function session(input: Partial<SessionItem> & Pick<SessionItem, 'id' | 'title'>): SessionItem {
	return {
		speakers: [],
		trackId: 'released-track:Craft',
		formatId: 'released-format:Talk',
		durationMin: 45,
		state: 'programmed',
		...input
	};
}

function schedule(): ScheduleState {
	return {
		days: [
			{ key: '2027-05-04', label: 'Tue 4 May' },
			{ key: '2027-05-05', label: 'Wed 5 May' }
		],
		rooms: [
			{
				id: 'room-main',
				name: 'Main Hall',
				capacity: null,
				status: 'active',
				usage: { submissions: 0, sessions: 0, placements: 0 }
			},
			{
				id: 'room-studio',
				name: 'Studio',
				capacity: null,
				status: 'active',
				usage: { submissions: 0, sessions: 0, placements: 0 }
			}
		],
		dayStart: '00:00',
		slotMinutes: 30,
		slotsPerDay: 48,
		sessions: [
			session({
				id: 's-craft',
				title: 'Agent Product Craft',
				speakers: [{ name: 'Ada Alpha', email: '' }],
				trackId: 'released-track:Craft',
				formatId: 'released-format:Talk'
			}),
			session({
				id: 's-ops',
				title: 'Runtime Operations',
				speakers: [{ name: 'Bea Beta', email: '' }],
				trackId: 'released-track:Ops',
				formatId: 'released-format:Workshop',
				durationMin: 90
			}),
			session({
				id: 's-draft',
				title: 'Hidden draft',
				state: 'collecting',
				speakers: [{ name: 'Ada Alpha', email: '' }]
			})
		],
		placements: [
			{ sessionId: 's-craft', dayKey: '2027-05-04', roomId: 'room-main', startMin: 9 * 60, conflicts: [] },
			{ sessionId: 's-ops', dayKey: '2027-05-05', roomId: 'room-studio', startMin: 11 * 60, conflicts: [] }
		],
		breaks: [],
		published: true
	};
}

function card(
	input: Partial<PublicSpeakerCard> & Pick<PublicSpeakerCard, 'id' | 'name'>
): PublicSpeakerCard {
	return {
		links: [],
		sessions: [],
		provisional: false,
		...input
	};
}

describe('session search', () => {
	test('matches a published title and states the searched fields', () => {
		expect(sessionMatchesSearch(schedule().sessions[0]!, 'craft')).toBe(true);
		expect(sessionMatchesSearch(schedule().sessions[0]!, 'runtime')).toBe(false);
		expect(SESSION_SEARCH_SCOPE).toBe('session title and speaker name');
	});

	test('matches a published speaker name across the same query', () => {
		expect(sessionMatchesSearch(schedule().sessions[0]!, 'ada')).toBe(true);
		expect(sessionMatchesSearch(schedule().sessions[0]!, 'bea')).toBe(false);
	});

	test('ANDs terms so adding a word narrows', () => {
		expect(sessionMatchesSearch(schedule().sessions[0]!, 'agent ada')).toBe(true);
		expect(sessionMatchesSearch(schedule().sessions[0]!, 'agent bea')).toBe(false);
	});

	test('an empty query keeps every programmed session', () => {
		expect(sessionMatchesSearch(schedule().sessions[0]!, '   ')).toBe(true);
	});
});

describe('facets', () => {
	test('offers only vocabulary already present on placed programmed sessions', () => {
		const facets = collectPublishedFacets(schedule(), tracks);
		expect(facets.tracks.map((entry) => entry.label)).toEqual(['Craft', 'Ops']);
		expect(facets.formats.map((entry) => entry.label)).toEqual(['Talk', 'Workshop']);
		expect(facets.rooms.map((entry) => entry.label)).toEqual(['Main Hall', 'Studio']);
	});

	test('narrowing by track keeps the other facet selections available', () => {
		const selected = { trackId: 'released-track:Craft', formatId: 'released-format:Workshop', roomId: null };
		const matched = filterPlacedSessions(schedule(), '', selected);
		expect(matched).toEqual([]);
		const facets = collectPublishedFacets(schedule(), tracks);
		expect(facets.formats.some((entry) => entry.id === selected.formatId)).toBe(true);
	});

	test('search plus a room facet does not expose collecting sessions', () => {
		const matched = filterPlacedSessions(schedule(), 'ada', {
			trackId: null,
			formatId: null,
			roomId: 'room-main'
		});
		expect(matched.map((entry) => entry.session.id)).toEqual(['s-craft']);
		expect(matched.some((entry) => entry.session.state !== 'programmed')).toBe(false);
	});
});

describe('narrowed schedule', () => {
	test('drops unmatched sessions so the renderer receives one projection', () => {
		const narrowed = narrowSchedule(schedule(), 'runtime', {
			trackId: null,
			formatId: null,
			roomId: null
		});
		expect(narrowed.sessions.map((entry) => entry.id)).toEqual(['s-ops']);
		expect(narrowed.placements.map((entry) => entry.sessionId)).toEqual(['s-ops']);
	});

	test('an idle query leaves the released schedule untouched', () => {
		const source = schedule();
		expect(narrowSchedule(source, '', { trackId: null, formatId: null, roomId: null })).toBe(source);
	});
});

describe('result copy', () => {
	test('search copy names the fields and the count', () => {
		const copy = describeSessionResults({
			matched: 1,
			scanned: 2,
			query: 'craft',
			hasFacets: false
		});
		expect(copy.headline).toBe('1 of 2 sessions match “craft”');
		expect(copy.scope).toBe(SESSION_SEARCH_SCOPE);
	});

	test('unmatched search is an empty state, not an error', () => {
		const copy = describeSessionResults({
			matched: 0,
			scanned: 2,
			query: 'keynote',
			hasFacets: true
		});
		expect(copy.headline).toBe('No session matches “keynote” and these filters');
	});

	test('speaker search copy names speaker name as the field', () => {
		const copy = describeSpeakerResults({ matched: 0, scanned: 3, query: 'zeta' });
		expect(copy.headline).toBe('No speaker matches “zeta”');
		expect(copy.scope).toBe(SPEAKER_SEARCH_SCOPE);
	});
});

describe('speaker search and surname order', () => {
	const roster = [
		card({ id: '2', name: 'Bea Beta' }),
		card({ id: '1', name: 'Ada Alpha' }),
		card({ id: '3', name: 'Cara Alpha' })
	];

	test('searches the published speaker name only', () => {
		expect(speakerMatchesSearch(roster[0]!, 'bea')).toBe(true);
		expect(speakerMatchesSearch(roster[0]!, 'alpha')).toBe(false);
		expect(presentRoster(roster, 'alpha', 'lineup').map((entry) => entry.id)).toEqual(['1', '3']);
	});

	test('surname order is a named presentation over a copy', () => {
		const ordered = orderRosterBySurname(roster);
		expect(ordered.map((entry) => entry.name)).toEqual(['Ada Alpha', 'Cara Alpha', 'Bea Beta']);
		expect(roster.map((entry) => entry.name)).toEqual(['Bea Beta', 'Ada Alpha', 'Cara Alpha']);
	});

	test('surname ties break on the rest of the name, then id', () => {
		const tied = [card({ id: 'b', name: 'Zed' }), card({ id: 'a', name: 'Zed' })];
		expect(orderRosterBySurname(tied).map((entry) => entry.id)).toEqual(['a', 'b']);
	});
});

describe('day movement and presentation vocabulary', () => {
	test('chevrons walk the published days and stop at the ends', () => {
		const days = schedule().days;
		expect(adjacentDayKey(days, '2027-05-04', 1)).toBe('2027-05-05');
		expect(adjacentDayKey(days, '2027-05-04', -1)).toBeNull();
		expect(adjacentDayKey(days, '2027-05-05', 1)).toBeNull();
		expect(adjacentDayKey(days, null, 1)).toBe('2027-05-04');
	});

	test('unknown presentation values fall back to the accepted defaults', () => {
		expect(parseSchedulePresentation('agenda')).toBe('agenda');
		expect(parseSchedulePresentation('itinerary')).toBe('list');
		expect(parseSpeakerPresentation('list')).toBe('list');
		expect(parseSpeakerPresentation('kanban', 'gallery')).toBe('gallery');
		expect(parseSpeakerOrder('surname')).toBe('surname');
		expect(parseSpeakerOrder('priority')).toBe('lineup');
	});
});

describe('session detail', () => {
	test('uses only released fields and names the missing description', () => {
		const detail = sessionDetailView(schedule(), tracks, 's-ops');
		expect(detail).toMatchObject({
			title: 'Runtime Operations',
			speakerNames: ['Bea Beta'],
			trackName: 'Ops',
			formatName: 'Workshop',
			dayLabel: 'Wed 5 May',
			timeLabel: '11:00–12:30',
			roomName: 'Studio',
			durationMin: 90
		});
		expect(detail?.description).toEqual({
			kind: 'missing',
			message: 'A description has not been published yet.'
		});
	});

	test('refuses collecting sessions instead of projecting them', () => {
		expect(sessionDetailView(schedule(), tracks, 's-draft')).toBeNull();
	});
});

describe('joined discovery slice', () => {
	test('search, one facet, a detail address, and back keep one released projection', () => {
		const source = schedule();
		const query = 'ada';
		const facets = { trackId: 'released-track:Craft', formatId: null, roomId: null };
		const matched = filterPlacedSessions(source, query, facets);
		expect(matched.map((entry) => entry.session.id)).toEqual(['s-craft']);
		expect(matched.every((entry) => entry.session.state === 'programmed')).toBe(true);

		const list = hrefWithParams('/s/schedule', '', { q: query, track: facets.trackId });
		const open = hrefWithParams('/s/schedule', '?q=ada&track=released-track%3ACraft', {
			session: 's-craft'
		});
		const closed = hrefWithParams('/s/schedule', '?q=ada&track=released-track%3ACraft&session=s-craft', {
			session: null
		});
		expect(list).toBe('/s/schedule?q=ada&track=released-track%3ACraft');
		expect(open).toContain('session=s-craft');
		expect(open).toContain('q=ada');
		expect(closed).toBe(list);

		const detail = sessionDetailView(source, tracks, 's-craft');
		expect(detail?.title).toBe('Agent Product Craft');
		expect(detail?.description.kind).toBe('missing');
	});
});

describe('address helpers', () => {
	test('writes discovery state without dropping the rest of the address', () => {
		expect(hrefWithParams('/s/schedule', 'scope=day:2027-05-04', { q: 'craft', session: 's-craft' })).toBe(
			'/s/schedule?scope=day%3A2027-05-04&q=craft&session=s-craft'
		);
		expect(hrefWithParams('/s/speakers', 'q=ada&scope=speaker:1', { scope: null })).toBe(
			'/s/speakers?q=ada'
		);
	});

	test('published format names come from the released id, not a second vocab', () => {
		expect(publishedFormatName('released-format:Talk')).toBe('Talk');
		expect(publishedFormatName('released-format:')).toBeNull();
	});
});
