import { describe, expect, test } from 'bun:test';
import {
	organizerCommunicationAudienceOptionPageOperationResultSchema,
	organizerCommunicationAuthoringPayloadOperationResultSchema,
	organizerCommunicationDraftMutationOperationResultSchema,
	organizerCommunicationDraftOperationResultSchema,
	organizerCommunicationDraftPageOperationResultSchema,
	organizerCommunicationPurposeDetailOperationResultSchema,
	organizerCommunicationPurposePageOperationResultSchema,
	organizerMessageBatchPreviewDetailOperationResultSchema,
	organizerMessagePreviewRecipientPageOperationResultSchema,
	organizerMessageTemplateDetailOperationResultSchema,
	organizerMessageTemplatePageOperationResultSchema,
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import type { ExpectedOperatorHttpOperation } from './operator-http-binding';
import {
	COMMUNICATIONS_AUTHORING_OPERATIONS,
	createCommunicationsAuthoringLivePort,
	type CommunicationsAuthoringRequestInput,
	type CommunicationsAuthoringRequester
} from './communications-authoring-live';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (character: string) => character.repeat(64);
const correlationId = id(900);

const paths = Object.freeze({
	listPurposes: '/api/events/current/communications/purposes',
	getPurpose: '/api/events/current/communications/purposes/detail',
	listTemplates: '/api/events/current/communications/templates',
	getTemplate: '/api/events/current/communications/templates/detail',
	listDrafts: '/api/events/current/communications/drafts',
	getDraft: '/api/events/current/communications/drafts/detail',
	storeAuthoringPayload: '/api/events/current/communications/authoring-payloads',
	createDraft: '/api/events/current/communications/drafts/create',
	reviseDraft: '/api/events/current/communications/drafts/revise',
	discardDraft: '/api/events/current/communications/drafts/discard',
	listAudienceOptions: '/api/events/current/communications/audiences/options',
	getPreview: '/api/events/current/communications/previews/detail',
	listPreviewRecipients: '/api/events/current/communications/previews/recipients'
} as const);

const purposeRevision = Object.freeze({
	purposeId: 'purpose-1',
	purposeKey: 'decision.notice',
	revisionId: 'purpose-revision-1',
	revisionNumber: 1,
	digestSha256: digest('a')
});
const purposeSummary = Object.freeze({
	schemaVersion: 1 as const,
	revision: purposeRevision,
	label: 'Decision notice',
	channel: 'email' as const,
	communicationClass: 'event.transactional',
	lifecycle: 'active' as const,
	policyDigestSha256: digest('b')
});
const purposeDetail = Object.freeze({
	...purposeSummary,
	description: 'Tell speakers the result of a decision.',
	allowedAudienceSources: []
});

const templateRevision = Object.freeze({
	templateId: 'template-1',
	templateRevisionId: 'template-revision-1',
	revisionNumber: 1,
	digestSha256: digest('c')
});
const templateSummary = Object.freeze({
	schemaVersion: 1 as const,
	revision: templateRevision,
	key: 'decision.accepted',
	name: 'Accepted proposal',
	purposeRevision,
	channel: 'email' as const,
	lifecycle: 'active' as const,
	bodyMode: 'composed' as const,
	subjectPreview: 'Your proposal was accepted'
});
const renderer = Object.freeze({
	reference: { key: 'renderer.email-v1', version: 1 },
	definitionDigestSha256: digest('d')
});
const mergeRegistry = Object.freeze({
	reference: { key: 'merge-registry.event-v1', version: 1 },
	definitionDigestSha256: digest('e')
});
const templateDetail = Object.freeze({
	...templateSummary,
	content: {
		kind: 'email/v1' as const,
		subject: [{ kind: 'text' as const, value: 'Your proposal was accepted' }],
		body: {
			mode: 'composed' as const,
			blocks: [{
				kind: 'paragraph' as const,
				content: [{ kind: 'text' as const, value: 'We would love to have you join us.' }]
			}]
		},
		plainTextPolicy: 'derive_v1' as const,
		attachmentSlotKeys: []
	},
	fieldBindings: [],
	renderer,
	mergeRegistry
});

const audience = Object.freeze({
	schemaVersion: 1 as const,
	binding: 'current_snapshot' as const,
	purposeRevision,
	source: { kind: 'explicit_contacts' as const, contactRefIds: ['person-1'] }
});
const audienceOption = Object.freeze({
	schemaVersion: 1 as const,
	optionId: 'audience-option-1',
	optionVersion: 1,
	optionDigestSha256: digest('f'),
	label: 'One selected speaker',
	recipientEstimate: { knowledge: 'known' as const, value: 1 },
	audienceDraft: audience
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
const content = Object.freeze({
	kind: 'email/v1' as const,
	subject: 'Your proposal was accepted',
	body: { kind: 'plain_text/v1' as const, text: 'We would love to have you join us.' }
});
const readyAuthoring = Object.freeze({
	state: 'ready' as const,
	subject: content.subject,
	audienceLabel: audienceOption.label,
	recipientEstimate: { knowledge: 'known' as const, value: 1 },
	contentPayload,
	audiencePayload
});

function draftProjection(version = 1) {
	return Object.freeze({
		schemaVersion: 1 as const,
		draftId: 'draft-1',
		version,
		state: 'active' as const,
		channel: 'email' as const,
		purposeRevision,
		templateRevision,
		provenance: { kind: 'human' as const },
		updatedAt: '2026-08-13T01:00:00.000Z',
		authoring: readyAuthoring,
		content,
		audience,
		allowedNextActions: ['revise', 'preview', 'discard', 'propose'] as const
	});
}

function draftSummary(version = 1) {
	const { content: _content, audience: _audience, allowedNextActions: _allowedNextActions, ...summary } =
		draftProjection(version);
	return Object.freeze(summary);
}

function mutationResult(version: number, state: 'active' | 'discarded') {
	return Object.freeze({
		schemaVersion: 1 as const,
		draftId: 'draft-1',
		version,
		state,
		authoring: readyAuthoring,
		nextRead: {
			operationName: 'get_message_draft' as const,
			draftId: 'draft-1',
			expectedVersion: version
		}
	});
}

const previewIdentity = Object.freeze({
	audienceSpecId: 'audience-spec-1',
	draftId: 'draft-1',
	draftVersion: 1,
	previewGeneration: 2,
	previewDigestProfile: 'communication.preview.sha256',
	previewDigestVersion: 1,
	previewDigestSha256: digest('1')
});
const previewSummary = Object.freeze({
	schemaVersion: 1 as const,
	identity: previewIdentity,
	purposeRevision,
	templateRevision,
	counts: { visibleCandidateCount: 1, includedCount: 1, excludedCount: 0, blockedCount: 0 },
	membershipDigestSha256: digest('2'),
	evidenceDigestSha256: digest('3'),
	reasonCodes: [],
	sourceVersions: [],
	renderer,
	mergeRegistry
});
const previewDetail = Object.freeze({
	schemaVersion: 1 as const,
	summary: previewSummary,
	selected: { kind: 'none' as const }
});
const recipientPage = Object.freeze({
	schemaVersion: 1 as const,
	identity: previewIdentity,
	rows: [{
		recipientResolutionId: 'rr1_0000000000000001',
		safeLabel: 'Ada Speaker',
		channel: { disclosure: 'masked' as const, maskedValue: 'a***@example.test' },
		mergeFallbackFieldKeys: [],
		state: 'included' as const,
		releaseId: 'release-1',
		releaseDigestSha256: digest('4')
	}],
	page: { hasMore: false as const }
});

function manifestEntry(
	key: keyof typeof paths,
	expected: ExpectedOperatorHttpOperation
): SafeOperationManifestEntry {
	const effect = expected.effect as OperationEffect;
	return {
		name: expected.name,
		version: expected.version,
		lifecycle: { status: 'active' },
		summary: `Execute ${expected.name}.`,
		effect,
		maxRisk: effect === 'read' ? 'low' : 'normal',
		autonomy: {
			policy: { key: `autonomy.${expected.name}`, version: 1 },
			riskFloor: 'low',
			unattendedRiskCeiling: 'normal',
			requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'],
			triggerDispositions: {
				authority_lost: 'block',
				unattended_bounds_exceeded: 'block',
				approval_required: 'block',
				known_retryable_failure: 'block',
				ambiguous_external_effect: 'block',
				stale_plan: 'block',
				compensation_required: 'block',
				terminal_failure: 'block'
			}
		},
		consequenceTags: [],
		inputSchema: expected.inputSchema,
		idempotency: expected.idempotencyRequired
			? {
					required: true,
					keySource: { key: 'idempotency.operator-header', version: 1 },
					credentialVerifierProfile: { key: 'credential.idempotency', version: 1 },
					requestHashProfile: { key: `request-hash.${expected.name}`, version: 1 }
				}
			: { required: false },
		concurrency: effect === 'read'
			? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: `concurrency.${expected.name}`, version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http',
			protocol: 'http',
			method: expected.method,
			path: paths[key],
			input: expected.input,
			resultSchema: expected.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	};
}

function manifest(omit: readonly (keyof typeof paths)[] = []): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('9'),
		operations: Object.entries(COMMUNICATIONS_AUTHORING_OPERATIONS)
			.filter(([key]) => !omit.includes(key as keyof typeof paths))
			.map(([key, expected]) => manifestEntry(key as keyof typeof paths, expected))
	});
}

function readSuccess(data: unknown) {
	return { kind: 'success' as const, data, correlationId };
}

function effectSuccess(operationName: string, receiptNumber: number, data: unknown) {
	return {
		kind: 'success' as const,
		data,
		correlationId,
		receipt: { id: id(receiptNumber), operationName, operationVersion: 1 }
	};
}

function successPayloads(): Readonly<Record<string, unknown>> {
	return Object.freeze({
		[paths.listPurposes]: organizerCommunicationPurposePageOperationResultSchema.parse(
			readSuccess({ schemaVersion: 1, rows: [purposeSummary], page: { hasMore: false } })
		),
		[paths.getPurpose]: organizerCommunicationPurposeDetailOperationResultSchema.parse(
			readSuccess(purposeDetail)
		),
		[paths.listTemplates]: organizerMessageTemplatePageOperationResultSchema.parse(
			readSuccess({ schemaVersion: 1, rows: [templateSummary], page: { hasMore: false } })
		),
		[paths.getTemplate]: organizerMessageTemplateDetailOperationResultSchema.parse(
			readSuccess(templateDetail)
		),
		[paths.listDrafts]: organizerCommunicationDraftPageOperationResultSchema.parse(
			readSuccess({ schemaVersion: 1, rows: [draftSummary()], page: { hasMore: false } })
		),
		[paths.getDraft]: organizerCommunicationDraftOperationResultSchema.parse(
			readSuccess(draftProjection())
		),
		[paths.storeAuthoringPayload]: organizerCommunicationAuthoringPayloadOperationResultSchema.parse(
			effectSuccess('store_communication_authoring_payload', 901, contentPayload)
		),
		[paths.createDraft]: organizerCommunicationDraftMutationOperationResultSchema.parse(
			effectSuccess('create_message_draft', 902, mutationResult(1, 'active'))
		),
		[paths.reviseDraft]: organizerCommunicationDraftMutationOperationResultSchema.parse(
			effectSuccess('revise_message_batch', 903, mutationResult(2, 'active'))
		),
		[paths.discardDraft]: organizerCommunicationDraftMutationOperationResultSchema.parse(
			effectSuccess('discard_message_draft', 904, mutationResult(2, 'discarded'))
		),
		[paths.listAudienceOptions]: organizerCommunicationAudienceOptionPageOperationResultSchema.parse(
			readSuccess({ schemaVersion: 1, rows: [audienceOption], page: { hasMore: false } })
		),
		[paths.getPreview]: organizerMessageBatchPreviewDetailOperationResultSchema.parse(
			readSuccess(previewDetail)
		),
		[paths.listPreviewRecipients]: organizerMessagePreviewRecipientPageOperationResultSchema.parse(
			readSuccess(recipientPage)
		)
	});
}

function requester(
	payloads: Readonly<Record<string, unknown>>,
	calls: CommunicationsAuthoringRequestInput[] = []
): CommunicationsAuthoringRequester {
	return async (request) => {
		calls.push(request);
		const base = request.path.split('?')[0] ?? request.path;
		const payload = payloads[base];
		return payload === undefined
			? { kind: 'error', error: { code: 'unexpected_request', retryable: false } }
			: { kind: 'success', data: payload };
	};
}

describe('pure-live Communications authoring browser port', () => {
	test('resolves every mounted B1/B2 operation and preserves factual authoring evidence', async () => {
		const calls: CommunicationsAuthoringRequestInput[] = [];
		const port = createCommunicationsAuthoringLivePort({
			manifest: manifest(),
			request: requester(successPayloads(), calls)
		});

		const purposes = await port.listPurposes({ lifecycle: 'active', limit: 20 });
		const purpose = await port.getPurpose({ purposeId: 'purpose-1', revisionNumber: 1 });
		const templates = await port.listTemplates({ purposeId: 'purpose-1', lifecycle: 'active' });
		const template = await port.getTemplate({ templateId: 'template-1', revisionNumber: 1 });
		const drafts = await port.listDrafts({ state: 'active' });
		const draft = await port.getDraft({ draftId: 'draft-1', expectedVersion: 1 });
		const stored = await port.storeAuthoringPayload({
			payloadKind: 'message_content',
			schemaVersion: 1,
			value: content
		}, 'store-content-1');
		const created = await port.createDraft({
			channel: 'email',
			purposeRevision,
			templateRevision,
			initial: { kind: 'adopted_payload_refs', contentPayload, audiencePayload }
		}, 'create-draft-1');
		const revised = await port.reviseDraft({
			draftId: 'draft-1',
			expectedVersion: 1,
			contentPayload,
			audiencePayload
		}, 'revise-draft-1');
		const discarded = await port.discardDraft({
			draftId: 'draft-1', expectedVersion: 1, reasonCode: 'author.cancelled'
		}, 'discard-draft-1');
		const audiences = await port.listAudienceOptions({ purposeId: 'purpose-1' });
		const preview = await port.getPreview(previewIdentity);
		const recipients = await port.listPreviewRecipients({ ...previewIdentity, state: 'included' });

		expect(port.source).toEqual({ kind: 'live' });
		expect(purposes).toMatchObject({
			kind: 'success', data: { rows: [{ label: 'Decision notice', revision: purposeRevision }] }
		});
		expect(purpose).toMatchObject({ kind: 'success', data: { description: purposeDetail.description } });
		expect(templates).toMatchObject({
			kind: 'success', data: { rows: [{ name: 'Accepted proposal', purposeRevision }] }
		});
		expect(template).toMatchObject({
			kind: 'success', data: { content: { body: { mode: 'composed' } }, renderer, mergeRegistry }
		});
		expect(drafts).toMatchObject({
			kind: 'success', data: { rows: [{ authoring: { state: 'ready', contentPayload } }] }
		});
		expect(draft).toMatchObject({
			kind: 'success', data: { version: 1, content, audience, allowedNextActions: ['revise', 'preview', 'discard', 'propose'] }
		});
		expect(stored).toMatchObject({
			kind: 'success', data: contentPayload,
			receipt: { operationName: 'store_communication_authoring_payload' }
		});
		expect(created).toMatchObject({
			kind: 'success', data: { state: 'active', authoring: { state: 'ready' } }
		});
		expect(revised).toMatchObject({ kind: 'success', data: { version: 2, state: 'active' } });
		expect(discarded).toMatchObject({ kind: 'success', data: { version: 2, state: 'discarded' } });
		expect(audiences).toMatchObject({
			kind: 'success', data: { rows: [{ recipientEstimate: { knowledge: 'known', value: 1 } }] }
		});
		expect(preview).toMatchObject({
			kind: 'success', data: { summary: { identity: previewIdentity }, selected: { kind: 'none' } }
		});
		expect(recipients).toMatchObject({
			kind: 'success',
			data: {
				identity: previewIdentity,
				rows: [{ state: 'included', channel: { disclosure: 'masked' } }]
			}
		});

		expect(calls.map((call) => call.path.split('?')[0])).toEqual(Object.values(paths));
		const purposeQuery = new URL(calls[0]!.path, 'https://jooevents.invalid').searchParams;
		expect(Object.fromEntries(purposeQuery)).toEqual({ lifecycle: 'active', limit: '20' });
		const previewCall = calls.find((call) => call.path.startsWith(`${paths.getPreview}?`));
		expect(previewCall).toBeDefined();
		const previewQuery = new URL(previewCall!.path, 'https://jooevents.invalid').searchParams;
		expect(previewQuery.get('draftVersion')).toBe('1');
		expect(previewQuery.get('previewGeneration')).toBe('2');
		expect(previewQuery.get('previewDigestSha256')).toBe(previewIdentity.previewDigestSha256);
		expect(calls.filter((call) => call.method === 'POST').map((call) => call.idempotencyKey))
			.toEqual(['store-content-1', 'create-draft-1', 'revise-draft-1', 'discard-draft-1']);
		expect(JSON.stringify(calls.map(({ path, method, body, idempotencyKey }) => ({
			path, method, body, idempotencyKey
		})))).not.toContain('sample');
		expect(Object.values(COMMUNICATIONS_AUTHORING_OPERATIONS).some((operation) =>
			operation.name.includes('send') || operation.name.includes('delivery')
		)).toBe(false);
	});

	test('preserves structured nonterminal outcomes and rejects a mismatched preview tuple', async () => {
		const refusal = organizerCommunicationDraftMutationOperationResultSchema.parse({
			kind: 'outcome',
			terminal: false,
			correlationId,
			outcome: {
				class: 'stale_revision',
				kind: 'communication.draft_changed',
				retryable: false,
				subjects: [{ type: 'communication_draft', id: 'draft-1', version: 2 }],
				detail: { currentVersion: 2 },
				detailSchemaVersion: 1
			}
		});
		if (refusal.kind !== 'outcome') throw new Error('Expected an outcome fixture.');
		const wrongPreview = organizerMessageBatchPreviewDetailOperationResultSchema.parse(
			readSuccess({
				...previewDetail,
				summary: {
					...previewSummary,
					identity: { ...previewIdentity, previewGeneration: 3 }
				}
			})
		);
		const port = createCommunicationsAuthoringLivePort({
			manifest: manifest(),
			request: requester({
				[paths.reviseDraft]: refusal,
				[paths.getPreview]: wrongPreview
			})
		});

		expect(await port.reviseDraft({
			draftId: 'draft-1', expectedVersion: 1, contentPayload, audiencePayload
		}, 'revise-stale-1')).toEqual({
			kind: 'outcome',
			terminal: false,
			correlationId,
			outcome: refusal.outcome
		});
		expect(await port.getPreview(previewIdentity)).toEqual({
			kind: 'transport_error',
			error: { code: 'invalid_contract', retryable: true }
		});
	});

	test('fails closed before transport when a binding or request credential is unavailable', async () => {
		const calls: CommunicationsAuthoringRequestInput[] = [];
		const port = createCommunicationsAuthoringLivePort({
			manifest: manifest(['getPreview']),
			request: requester(successPayloads(), calls)
		});

		expect(await port.getPreview(previewIdentity)).toEqual({
			kind: 'unavailable',
			operation: 'get_message_batch_preview',
			reason: 'operation_not_registered'
		});
		expect(await port.createDraft({
			channel: 'email', purposeRevision,
			initial: { kind: 'adopted_payload_refs', contentPayload, audiencePayload }
		}, 'contains,comma')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_request', retryable: false }
		});
		expect(calls).toHaveLength(0);
	});
});
