import {
	createEventLiveClient,
	type EventLiveRequester
} from '../operations/event-live';
import {
	createProgramVocabularyLiveClient,
	type ProgramVocabularyLiveRequester
} from '../operations/program-vocabulary-live';
import type { EventProgramPort } from './port';

export function createLiveEventProgramPort(input: {
	readonly manifest: unknown;
	readonly eventRequest?: EventLiveRequester;
	readonly programVocabularyRequest?: ProgramVocabularyLiveRequester;
}): EventProgramPort {
	const eventClient = createEventLiveClient({
		manifest: input.manifest,
		...(input.eventRequest ? { request: input.eventRequest } : {})
	});
	const vocabularyClient = createProgramVocabularyLiveClient({
		manifest: input.manifest,
		...(input.programVocabularyRequest ? { request: input.programVocabularyRequest } : {})
	});

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		event: Object.freeze({
			read: eventClient.read,
			create: eventClient.create
		}),
		vocabulary: Object.freeze({
			read: vocabularyClient.read,
			create: vocabularyClient.create,
			edit: vocabularyClient.edit,
			retire: vocabularyClient.retire,
			restore: vocabularyClient.restore,
			delete: vocabularyClient.delete,
			draftMerge: vocabularyClient.draftMerge,
			publishMerge: vocabularyClient.publishMerge
		})
	});
}
