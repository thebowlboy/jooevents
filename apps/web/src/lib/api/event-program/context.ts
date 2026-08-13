import { getContext, setContext } from 'svelte';
import type { EventProgramPort } from './port';

const EVENT_PROGRAM_PORT_CONTEXT = Symbol('jooevents.event-program-port');

export function setEventProgramPort(port: EventProgramPort): EventProgramPort {
	setContext(EVENT_PROGRAM_PORT_CONTEXT, port);
	return port;
}

export function useEventProgramPort(): EventProgramPort {
	const port = getContext<EventProgramPort | undefined>(EVENT_PROGRAM_PORT_CONTEXT);
	if (!port) throw new TypeError('event_program_port_context_missing');
	return port;
}
