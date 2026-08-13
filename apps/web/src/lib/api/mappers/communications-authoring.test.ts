import { describe, expect, test } from 'bun:test';
import {
	ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID,
	ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
	organizerCommunicationDraftProjectionSchema
} from '@jooevents/contracts';
import { mapCommunicationDraft } from './communications-authoring';

const digest = (character: string) => character.repeat(64);
const purposeRevision = Object.freeze({
	purposeId: 'purpose-1',
	purposeKey: 'decision.notice',
	revisionId: 'purpose-revision-1',
	revisionNumber: 1,
	digestSha256: digest('a')
});
const contentPayload = Object.freeze({
	payloadRefId: 'payload-content-1',
	payloadRefVersion: 1,
	payloadKind: 'message_content' as const,
	schemaKey: 'communication.message-content',
	schemaVersion: 1,
	classification: 'classified.message-content'
});
const audiencePayload = Object.freeze({
	payloadRefId: 'payload-audience-1',
	payloadRefVersion: 1,
	payloadKind: 'message_audience_draft' as const,
	schemaKey: 'communication.message-audience-draft',
	schemaVersion: 1,
	classification: 'classified.message-audience'
});

describe('communication authoring view mappers', () => {
	test('keeps uninitialized authoring distinct from a ready classified projection', () => {
		const uninitialized = organizerCommunicationDraftProjectionSchema.parse({
			schemaVersion: 1,
			draftId: 'draft-empty',
			version: 1,
			state: 'active',
			channel: 'email',
			purposeRevision,
			provenance: { kind: 'human' },
			updatedAt: '2026-08-13T00:00:00.000Z',
			authoring: {
				state: 'uninitialized',
				contentRefId: ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
				audienceRefId: ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID
			},
			allowedNextActions: ['revise', 'discard']
		});
		const ready = organizerCommunicationDraftProjectionSchema.parse({
			schemaVersion: 1,
			draftId: 'draft-ready',
			version: 3,
			state: 'active',
			channel: 'email',
			purposeRevision,
			provenance: { kind: 'human' },
			updatedAt: '2026-08-13T01:00:00.000Z',
			authoring: {
				state: 'ready',
				subject: 'Decision update',
				audienceLabel: 'Accepted speakers',
				recipientEstimate: { knowledge: 'known', value: 1 },
				contentPayload,
				audiencePayload
			},
			content: {
				kind: 'email/v1',
				subject: 'Decision update',
				body: { kind: 'plain_text/v1', text: 'Hello from the event.' }
			},
			audience: {
				schemaVersion: 1,
				binding: 'current_snapshot',
				purposeRevision,
				source: { kind: 'explicit_contacts', contactRefIds: ['person-1'] }
			},
			allowedNextActions: ['revise', 'preview', 'discard', 'propose']
		});

		const emptyView = mapCommunicationDraft(uninitialized);
		const readyView = mapCommunicationDraft(ready);

		expect(emptyView.authoring).toEqual({
			state: 'uninitialized',
			contentRefId: ORGANIZER_COMMUNICATION_EMPTY_CONTENT_REF_ID,
			audienceRefId: ORGANIZER_COMMUNICATION_EMPTY_AUDIENCE_REF_ID
		});
		expect(readyView.authoring).toMatchObject({
			state: 'ready',
			contentPayload: { payloadRefId: 'payload-content-1', payloadKind: 'message_content' },
			audiencePayload: {
				payloadRefId: 'payload-audience-1',
				payloadKind: 'message_audience_draft'
			}
		});
		expect(readyView.content).toEqual(ready.content);
		expect(readyView.audience).toEqual(ready.audience);
		expect(Object.isFrozen(readyView)).toBe(true);
		expect(Object.isFrozen(readyView.authoring)).toBe(true);
		expect(Object.isFrozen(readyView.allowedNextActions)).toBe(true);
		expect(readyView).not.toBe(ready);
		expect(readyView.authoring).not.toBe(ready.authoring);
	});
});
