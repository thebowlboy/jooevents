import type { CurrentEventProjection, EventDto } from '@jooevents/contracts';
import type { CurrentEventView, EventView } from '../view-models/event';

type HandledEventKey = 'id' | 'name' | 'timezone' | 'startDate' | 'endDate' | 'version';
const handledEventKeys: Record<Exclude<keyof EventDto, HandledEventKey>, never> = {};
void handledEventKeys;

function unreachable(value: never): never {
	throw new TypeError(`Unsupported Event contract variant: ${JSON.stringify(value)}`);
}

export function mapEvent(event: EventDto): EventView {
	return Object.freeze({
		id: event.id,
		name: event.name,
		timezone: event.timezone,
		startDate: event.startDate,
		endDate: event.endDate,
		version: event.version
	});
}

export function mapCurrentEvent(projection: CurrentEventProjection): CurrentEventView {
	switch (projection.kind) {
		case 'no_event':
			return Object.freeze({
				kind: 'no_event',
				eventSetVersion: projection.eventSetVersion
			});
		case 'current_event':
			return Object.freeze({
				kind: 'current_event',
				eventSetVersion: projection.eventSetVersion,
				event: mapEvent(projection.event)
			});
		default:
			return unreachable(projection);
	}
}

