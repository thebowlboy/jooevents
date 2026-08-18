import { describe, expect, test } from 'bun:test';
import type { CommunicationsAuthoringPort } from './communications-authoring-port';
import type { CommunicationsReadinessPagePort } from './communications-readiness-page-port';
import { createLiveCommunicationsPagePort } from './communications-page-port.live';

const digest = (value: string) => value.repeat(64);
const purposeRevision = {
	purposeId: 'purpose-1', purposeKey: 'decision_notification', revisionId: 'purpose-revision-1',
	revisionNumber: 1, digestSha256: digest('a')
};
const identity = {
	audienceSpecId: 'audience-spec-1', draftId: 'draft-1', draftVersion: 1,
	previewGeneration: 1, previewDigestProfile: 'communication.preview.sha256',
	previewDigestVersion: 1, previewDigestSha256: digest('b')
};

function success<T>(data: T) {
	return { kind: 'success' as const, data, correlationId: 'correlation-1' };
}

function effect<T>(data: T) {
	return {
		...success(data),
		receipt: { id: '00000000-0000-4000-8000-000000000001', operationName: 'fixture', operationVersion: 1 }
	};
}

function compose() {
	const calls: string[] = [];
	const communications = {
		source: { kind: 'live' as const },
		async listPurposes() { return success({ schemaVersion: 1, rows: [{
			schemaVersion: 1, revision: purposeRevision, label: 'Decision notice', channel: 'email',
			communicationClass: 'event.transactional', lifecycle: 'active', policyDigestSha256: digest('c')
		}], page: { hasMore: false } }); },
		async listTemplates() { return success({ schemaVersion: 1, rows: [], page: { hasMore: false } }); },
		async listDrafts() { return success({ schemaVersion: 1, rows: [], page: { hasMore: false } }); },
		async getDeliveryHistory() { return success({
			schemaVersion: 1, visibility: 'organizer_non_security', rows: [{
				schemaVersion: 1, visibility: 'organizer_non_security', historyItemId: 'history-1',
				messageRefId: 'batch-1', purposeRevision, subject: 'Decision update',
				audienceLabel: 'Accepted submissions', state: 'known_failed',
				actor: { kind: 'human', displayLabel: 'Workspace operator' },
				cause: { summary: 'Committed from a reviewed preview.', subjectKind: 'communication_preview', subjectRefId: 'audience-spec-1', subjectVersion: 1 },
				counts: {
					audience: { knowledge: 'known', value: 1 }, materialized: { knowledge: 'known', value: 1 },
					accepted: { knowledge: 'known', value: 0 }, delivered: { knowledge: 'not_supported' },
					acceptanceUnknown: { knowledge: 'known', value: 0 }, knownFailed: { knowledge: 'known', value: 1 }
				}, authorizedAt: '2026-08-18T01:00:00.000Z', availableActions: ['continue_provider_setup']
			}], page: { hasMore: false }
		}); },
		async listAttentionItems() { return success({ schemaVersion: 1, visibility: 'organizer_non_security', rows: [], page: { hasMore: false } }); },
		async getPersonThread() { return success({
			schemaVersion: 1, visibility: 'organizer_non_security', personRefId: 'person-1', personLabel: 'Ada Speaker',
			rows: [{ entryId: 'release-1', historyItemId: 'history-1', occurredAt: '2026-08-18T01:00:00.000Z', purposeRevision,
				subject: 'Decision update', state: 'known_failed', actor: { kind: 'human', displayLabel: 'Workspace operator' } }],
			page: { hasMore: false }
		}); },
		async getDeliveryTimeline() { return success({
			schemaVersion: 1, visibility: 'organizer_non_security', deliveryId: 'batch-1', currentState: 'known_failed',
			rows: [{ factId: 'attempt-1', sequence: 1, occurredAt: '2026-08-18T01:00:00.000Z', kind: 'known_failed',
				actor: { kind: 'human', displayLabel: 'Casey Organizer' },
				summaryCode: 'communication.outbound-email.known-rejected-terminal', recipient: {
					deliveryId: 'delivery-1', safeLabel: 'Ada Speaker', state: 'known_rejected_terminal'
				}, attempt: { attemptNumber: 1, attemptKind: 'original', state: 'known_rejected_terminal',
					providerOutcomeReason: 'delivery.rejected_terminal', startedAt: '2026-08-18T00:59:00.000Z', completedAt: '2026-08-18T01:00:00.000Z' } }],
			page: { hasMore: false }
		}); },
		async listAudienceOptions(request: { selectionOptionIds?: string[] } = {}) {
			const audienceDraft = { schemaVersion: 1 as const, binding: 'current_snapshot' as const, purposeRevision,
				source: { kind: 'explicit_contacts' as const, contactRefIds: ['contact-1'] } };
			return success({ schemaVersion: 1, rows: [{
			schemaVersion: 1, optionId: 'audience-1', optionVersion: 1, optionDigestSha256: digest('d'),
			label: 'Accepted submissions', recipientEstimate: { knowledge: 'known' as const, value: 1 },
			audienceDraft
		}], page: { hasMore: false }, ...(request.selectionOptionIds ? { selectionPreview: {
			schemaVersion: 1, optionIds: request.selectionOptionIds, label: 'Accepted submissions',
			reach: 1, overlap: 0, rows: [{ personRefId: 'person-1', safeLabel: 'Ada Speaker', state: 'included' as const }],
			audienceDraft
		} } : {}) }); },
		async storeAuthoringPayload(input: { payloadKind: string }) {
			calls.push(`store:${input.payloadKind}`);
			return effect({ payloadRefId: `payload-${input.payloadKind}`, payloadRefVersion: 1,
				payloadKind: input.payloadKind, schemaKey: 'fixture', schemaVersion: 1, classification: 'classified.fixture' });
		},
		async createDraft() { calls.push('create'); return effect({ schemaVersion: 1, draftId: 'draft-1', version: 1,
			state: 'active', authoring: { state: 'ready', subject: 'Hello', audienceLabel: 'Accepted submissions',
				recipientEstimate: { knowledge: 'unknown', reasonCode: 'audience.resolved_at_preview' },
				contentPayload: { payloadRefId: 'content', payloadRefVersion: 1, payloadKind: 'message_content', schemaKey: 'fixture', schemaVersion: 1, classification: 'classified.fixture' },
				audiencePayload: { payloadRefId: 'audience', payloadRefVersion: 1, payloadKind: 'message_audience_draft', schemaKey: 'fixture', schemaVersion: 1, classification: 'classified.fixture' } },
			nextRead: { operationName: 'get_message_draft', draftId: 'draft-1', expectedVersion: 1 } }); },
		async prepareBatchPreview() { calls.push('prepare'); return success({ schemaVersion: 1, draftId: 'draft-1', draftVersion: 1, state: 'prepared' }); },
		async adoptBatchPreview() { calls.push('adopt'); return effect({ schemaVersion: 1, identity, purposeRevision,
			counts: { visibleCandidateCount: 1, includedCount: 1, excludedCount: 0, blockedCount: 0 },
			membershipDigestSha256: digest('e'), evidenceDigestSha256: digest('f'), reasonCodes: [], sourceVersions: [],
			renderer: { reference: { key: 'renderer', version: 1 }, definitionDigestSha256: digest('1') },
			mergeRegistry: { reference: { key: 'merge', version: 1 }, definitionDigestSha256: digest('2') } }); },
		async listPreviewRecipients() { calls.push('recipients'); return success({ schemaVersion: 1, identity, rows: [{
			recipientResolutionId: 'recipient-1', safeLabel: 'Ada Speaker', channel: { disclosure: 'masked', maskedValue: 'a***@example.test' },
			mergeFallbackFieldKeys: [], state: 'included', releaseId: 'release-1', releaseDigestSha256: digest('3')
		}], page: { hasMore: false } }); },
		async getPreview() { return success({ schemaVersion: 1, summary: { identity }, selected: { kind: 'rendered_email',
			render: { recipientResolutionId: 'recipient-1', releaseId: 'release-1', releaseDigestSha256: digest('3'),
				outputDigestSha256: digest('4'), resolvedInputDigestSha256: digest('5'), attachmentManifestDigestSha256: digest('6'),
				renderer: { reference: { key: 'renderer', version: 1 }, definitionDigestSha256: digest('1') },
				mergeRegistry: { reference: { key: 'merge', version: 1 }, definitionDigestSha256: digest('2') },
				subject: 'Hello', sanitizedHtml: '<p>Hello Ada</p>', plainText: 'Hello Ada', attachments: [], warningCodes: [] } } }); },
		async sendMessages() { calls.push('send'); return effect({ schemaVersion: 1, batchId: 'batch-2', releaseCommitId: 'commit-2', dispatchGeneration: 1, releaseCount: 1, deliveryCount: 1 }); }
	} as unknown as CommunicationsAuthoringPort;
	const readiness = {
		source: { kind: 'live' as const },
		async read() { return success({ provider: null, outbound: { state: 'action_required' } }); }
	} as unknown as CommunicationsReadinessPagePort;
	const port = createLiveCommunicationsPagePort({
		communications, readiness,
		presentation: {
			theme: { async get() { return { accent: '#000' } as never; } },
			workspace: { async summary() { return { event: null }; } }
		}
	});
	return { port, calls };
}

describe('live Communications page port', () => {
	test('maps ledger evidence without claiming delivery and serves thread/timeline reads', async () => {
		const { port } = compose();
		const [messages, thread, timeline] = await Promise.all([
			port.communications.list(), port.communications.thread('person-1'), port.communications.timeline('batch-1')
		]);
		expect(messages[0]).toMatchObject({ state: 'failed', deliveryEvidence: { accepted: 0, knownFailed: 1 } });
		expect(messages[0]).not.toHaveProperty('deliveredCount');
		expect(thread?.entries[0]).toMatchObject({ outcome: 'failed', messageId: 'history-1' });
		expect(timeline?.entries[0]).toMatchObject({ recipient: 'Ada Speaker', state: 'failed', attemptNumber: 1 });
		expect(JSON.stringify({ messages, thread, timeline })).not.toContain('@example.test');
	});

	test('prepares, adopts, rechecks, previews, and sends one canonical audience', async () => {
		const { port, calls } = compose();
		const [audience] = await port.communications.audiences();
		const draft = await port.communications.compose({
			subject: 'Hello', audienceIds: [audience!.id],
			document: { id: 'one-off', key: 'one-off', name: 'One-off', purpose: '', subject: 'Hello',
				blocks: [{ type: 'paragraph', text: 'Hello there' }], mergeFields: [], revision: 1, revisions: [], usedBy: [] }
		});
		expect(draft.review?.recipients).toEqual([expect.objectContaining({ name: 'Ada Speaker', recipientResolutionId: 'recipient-1' })]);
		expect(await port.communications.previewRecipient!('recipient-1')).toEqual({ subject: 'Hello', plainText: 'Hello Ada', warningCodes: [] });
		expect(await port.communications.send(draft.id)).toEqual({ ok: true });
		expect(calls).toEqual(['store:message_content', 'store:message_audience_draft', 'create', 'prepare', 'adopt', 'recipients', 'send']);
	});
});
