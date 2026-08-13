import type { ProgramVocabularySnapshotView } from '$lib/api/view-models/program-vocabulary';

export type ScheduleVocabularyKind = 'room' | 'track' | 'format';

export interface ScheduleVocabularyOption {
	readonly id: string;
	readonly label: string;
	readonly status: 'active' | 'retired';
	readonly selectable: boolean;
	readonly capacity?: number | null;
}

export interface ScheduleVocabulary {
	readonly rooms: readonly ScheduleVocabularyOption[];
	readonly tracks: readonly ScheduleVocabularyOption[];
	readonly formats: readonly ScheduleVocabularyOption[];
	resolve(kind: ScheduleVocabularyKind, id: string): ScheduleVocabularyOption | undefined;
}

function byName(left: ScheduleVocabularyOption, right: ScheduleVocabularyOption): number {
	return left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}

export function buildScheduleVocabulary(snapshot: ProgramVocabularySnapshotView): ScheduleVocabulary {
	const rooms = Object.freeze(snapshot.rooms.map((room) => Object.freeze({
		id: room.id,
		label: room.name,
		status: room.status,
		selectable: room.status === 'active',
		capacity: room.capacity
	})).sort(byName));
	const tracks = Object.freeze(snapshot.tracks.map((track) => Object.freeze({
		id: track.id,
		label: track.name,
		status: track.status,
		selectable: track.status === 'active'
	})).sort(byName));
	const formats = Object.freeze(snapshot.formats.map((format) => Object.freeze({
		id: format.id,
		label: format.name,
		status: format.status,
		selectable: format.status === 'active'
	})).sort(byName));
	const byKind = { room: rooms, track: tracks, format: formats } as const;
	return Object.freeze({
		rooms,
		tracks,
		formats,
		resolve(kind: ScheduleVocabularyKind, id: string) {
			return byKind[kind].find((option) => option.id === id);
		}
	});
}
