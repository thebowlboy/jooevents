import type {
	OrganizerCommunicationAuthoringPayloadInput,
	OrganizerCommunicationPurposeRevisionRef,
	OrganizerMessageTemplateRevisionRef,
	StructuredOutcome
} from '@jooevents/contracts';
import type { CommunicationsAuthoringPort } from './communications-authoring-port';
import type { CommunicationsPagePort } from './communications-page-port';
import type { CommunicationsReadinessPagePort } from './communications-readiness-page-port';
import type {
	AudienceOption,
	AudiencePreview,
	CommunicationAttentionItem,
	CommunicationDeliveryTimeline,
	CommunicationMessage,
	CommunicationState,
	CommunicationThread,
	EmailReadiness,
	MessageReview,
	MessageTemplate,
	MutationOutcome,
	RenderedEmailPreview,
	TemplateBlock
} from './types';
import { templateKind } from './template-kinds';
import type {
	CommunicationAudienceOptionPageView,
	CommunicationPurposePageView,
	MessagePreviewIdentityView,
	MessagePreviewRecipientPageView,
	MessageTemplateDetailView
} from './view-models/communications-authoring';

export class CommunicationsPageLiveError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'CommunicationsPageLiveError';
	}
}

function idempotencyKey(stage: string): string {
	return `je.communications.page.${stage}.${globalThis.crypto.randomUUID()}`;
}

function safeOutcome(outcome: StructuredOutcome, action: 'read' | 'change'): string {
	if (outcome.class === 'access_denied') {
		return action === 'read'
			? 'You no longer have permission to read Communications.'
			: 'You no longer have permission to send this message.';
	}
	if (outcome.class === 'stale_revision' || outcome.class === 'conflict') {
		return 'The message or its audience changed while you were working. Review the current version before sending.';
	}
	return action === 'read'
		? 'Communications could not be loaded.'
		: 'The message could not be prepared. Nothing was sent.';
}

function failure(
	result: Exclude<{ readonly kind: string }, { readonly kind: 'success' }> & {
		readonly outcome?: StructuredOutcome;
		readonly error?: { readonly retryable: boolean };
		readonly reason?: string;
	},
	subject: string,
	action: 'read' | 'change'
): CommunicationsPageLiveError {
	if (result.kind === 'outcome' && result.outcome) {
		return new CommunicationsPageLiveError(result.outcome.kind, safeOutcome(result.outcome, action));
	}
	if (result.kind === 'unavailable') {
		return new CommunicationsPageLiveError('communications_unavailable', `${subject} is not available in this workspace.`);
	}
	return new CommunicationsPageLiveError(
		'communications_transport',
		result.error?.retryable
			? `${subject} could not be reached. Try again.`
			: `This ${subject.toLowerCase()} request is not valid.`
	);
}

function requireSuccess<Data>(
	result: { readonly kind: string; readonly data?: Data; readonly outcome?: StructuredOutcome;
		readonly error?: { readonly retryable: boolean }; readonly reason?: string },
	subject: string,
	action: 'read' | 'change' = 'read'
): Data {
	if (result.kind === 'success' && result.data !== undefined) return result.data;
	throw failure(result as never, subject, action);
}

function count(value: { readonly knowledge: string; readonly value?: number }): number | undefined {
	return value.knowledge === 'known' ? value.value : undefined;
}

function actor(value: {
	readonly kind: 'human' | 'agent' | 'standing_policy';
	readonly displayLabel: string;
}) {
	return value.kind === 'human'
		? { kind: 'human' as const, displayLabel: value.displayLabel }
		: value.kind === 'agent' ? 'agent' as const : 'policy' as const;
}

function messageState(value: string): CommunicationState {
	switch (value) {
		case 'delivered': return 'sent';
		case 'accepted': return 'accepted';
		case 'acceptance_unknown': return 'acceptance_unknown';
		case 'known_failed': return 'failed';
		case 'attempting': return 'sending';
		case 'authorized':
		case 'deferred':
		case 'materialized': return 'scheduled';
		default: return 'held';
	}
}

function inlineText(nodes: readonly ({ readonly kind: string; readonly value?: string;
	readonly fieldKey?: string })[]): string {
	return nodes.map((node) => node.kind === 'merge_field'
		? `{{${node.fieldKey}}}`
		: node.value ?? '').join('');
}

function blocks(detail: MessageTemplateDetailView): TemplateBlock[] {
	if (detail.content.body.mode !== 'composed') return [];
	return detail.content.body.blocks.flatMap((block): TemplateBlock[] => {
		switch (block.kind) {
			case 'heading': return [{ type: 'heading', text: inlineText(block.content) }];
			case 'paragraph': return [{ type: 'paragraph', text: inlineText(block.content) }];
			case 'detail_rows': return [{
				type: 'details',
				rows: block.rows.map((row) => ({
					label: inlineText(row.label), value: inlineText(row.value)
				}))
			}];
			case 'action_link': return [{
				type: 'button', label: inlineText(block.label), href: block.hrefFieldKey
			}];
			case 'list': return [{
				type: 'paragraph',
				text: block.items.map((item, index) =>
					`${block.style === 'ordered' ? `${index + 1}.` : '•'} ${inlineText(item)}`
				).join('\n')
			}];
		}
	});
}

const mergeSamples: Readonly<Record<string, string>> = Object.freeze({
	'person.name': 'Avery Chen',
	'speaker.name': 'Avery Chen',
	'submission.title': 'Their submission',
	'decision.status': 'Current result',
	'event.name': 'Your event'
});

function messageTemplate(detail: MessageTemplateDetailView): MessageTemplate {
	const fieldKeys = [...new Set([
		...detail.fieldBindings.map((entry) => entry.fieldKey),
		...(detail.content.body.mode === 'open_canvas' ? detail.content.body.parameterKeys : [])
	])];
	return {
		id: detail.revision.templateId,
		key: detail.key,
		name: detail.name,
		purpose: detail.purposeRevision.purposeKey,
		subject: inlineText(detail.content.subject),
		blocks: blocks(detail),
		mergeFields: fieldKeys.map((key) => ({
			key, label: key.split('.').join(' '), sample: mergeSamples[key] ?? 'Example'
		})),
		revision: detail.revision.revisionNumber,
		revisions: [],
		usedBy: detail.purposeRevision.purposeKey === 'decision_notification' ? ['Decisions'] : []
	};
}

function plainText(document: MessageTemplate): string {
	return document.blocks.map((block) => {
		switch (block.type) {
			case 'heading':
			case 'paragraph': return block.text;
			case 'details': return block.rows.map((row) => `${row.label}: ${row.value}`).join('\n');
			case 'button': return block.label;
			case 'divider': return '—';
		}
	}).join('\n\n').trim();
}

function inlineNodes(value: string) {
	const nodes: Array<
		{ readonly kind: 'text'; readonly value: string }
		| { readonly kind: 'merge_field'; readonly fieldKey: string }
	> = [];
	let offset = 0;
	for (const match of value.matchAll(/\{\{([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)\}\}/gu)) {
		const index = match.index ?? 0;
		if (index > offset) nodes.push({ kind: 'text', value: value.slice(offset, index) });
		nodes.push({ kind: 'merge_field', fieldKey: match[1]! });
		offset = index + match[0].length;
	}
	if (offset < value.length) nodes.push({ kind: 'text', value: value.slice(offset) });
	return nodes;
}

type OrganizerTemplateContent = Extract<
	OrganizerCommunicationAuthoringPayloadInput,
	{ readonly payloadKind: 'template_content' }
>['value'];

function authoredTemplateContent(document: MessageTemplate): OrganizerTemplateContent {
	return {
		kind: 'email/v1' as const,
		subject: inlineNodes(document.subject),
		body: {
			mode: 'composed' as const,
			blocks: document.blocks.flatMap((block): Extract<
				OrganizerTemplateContent['body'], { readonly mode: 'composed' }
			>['blocks'] => {
				switch (block.type) {
					case 'heading': return [{
						kind: 'heading' as const, level: 2 as const, content: inlineNodes(block.text)
					}];
					case 'paragraph': return [{ kind: 'paragraph' as const, content: inlineNodes(block.text) }];
					case 'details': return [{
						kind: 'detail_rows' as const,
						rows: block.rows.map((row) => ({
							label: inlineNodes(row.label), value: inlineNodes(row.value)
						}))
					}];
					case 'button': return [{
						kind: 'action_link' as const,
						label: inlineNodes(block.label),
						hrefFieldKey: block.href
					}];
					case 'divider': return [];
				}
			})
		},
		plainTextPolicy: 'derive_v1' as const,
		attachmentSlotKeys: []
	};
}

function stableTemplateKey(name: string, kind: string): string {
	const stem = name.toLocaleLowerCase('en-US').replaceAll(/[^a-z0-9]+/gu, '.').replaceAll(/^\.|\.$/gu, '')
		.slice(0, 80) || kind;
	return `custom.${stem}.${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** One live message-template mint used by both the composer and Templates doors. */
export function createLiveMessageTemplateMint(input: {
	readonly communications: CommunicationsAuthoringPort;
	readonly newIdempotencyKey?: (stage: string) => string;
	readonly onDetail?: (detail: MessageTemplateDetailView) => void;
}) {
	const mutationKey = input.newIdempotencyKey ?? idempotencyKey;
	return async (value: { name: string; kind: string }): Promise<MessageTemplate> => {
		const scaffold = templateKind(value.kind);
		if (!scaffold) throw new CommunicationsPageLiveError(
			'communication_template_kind_invalid',
			'This template starting point is no longer available.'
		);
		const available = requireSuccess(
			await input.communications.listTemplates({ channel: 'email', lifecycle: 'active' }),
			'Message templates'
		);
		const baseRow = available.rows[0];
		if (!baseRow) throw new CommunicationsPageLiveError(
			'communication_template_definition_unavailable',
			'A renderer definition must be available before creating a template.'
		);
		const base = requireSuccess(await input.communications.getTemplate({
			templateId: baseRow.revision.templateId,
			revisionNumber: baseRow.revision.revisionNumber
		}), 'Message template');
		const document: MessageTemplate = {
			id: 'pending', key: stableTemplateKey(value.name, value.kind), name: value.name.trim(),
			purpose: scaffold.purpose, subject: scaffold.subject,
			blocks: structuredClone(scaffold.blocks), mergeFields: structuredClone(scaffold.mergeFields),
			revision: 1, revisions: [], usedBy: []
		};
		const content = requireSuccess(await input.communications.storeAuthoringPayload({
			payloadKind: 'template_content', schemaVersion: 1,
			value: authoredTemplateContent(document)
		}, mutationKey('template-content')), 'Template content', 'change');
		const fieldKeys = new Set(document.mergeFields.map((field) => field.key));
		for (const block of document.blocks) if (block.type === 'button') fieldKeys.add(block.href);
		const bindings = requireSuccess(await input.communications.storeAuthoringPayload({
			payloadKind: 'template_field_bindings', schemaVersion: 1,
			value: [...fieldKeys].sort().map((fieldKey) => ({
				fieldKey, requirement: 'optional' as const, fallback: { kind: 'none' as const }
			}))
		}, mutationKey('template-bindings')), 'Template fields', 'change');
		const created = requireSuccess(await input.communications.createTemplate({
			templateKey: document.key,
			templateName: document.name,
			purposeRevision: base.purposeRevision,
			contentPayload: content as typeof content & { readonly payloadKind: 'template_content' },
			fieldBindingsPayload: bindings as typeof bindings & {
				readonly payloadKind: 'template_field_bindings'
			},
			renderer: base.renderer,
			mergeRegistry: base.mergeRegistry
		}, mutationKey('template-create')), 'Message template', 'change');
		const detail = requireSuccess(await input.communications.getTemplate({
			templateId: created.revision.templateId,
			revisionNumber: created.revision.revisionNumber
		}), 'Message template');
		input.onDetail?.(detail);
		return messageTemplate(detail);
	};
}

type AudienceRecord = CommunicationAudienceOptionPageView['rows'][number];

type PendingDraft = Readonly<{
	draftId: string;
	draftVersion: number;
	identity: MessagePreviewIdentityView;
	message: CommunicationMessage;
}>;

export function createLiveCommunicationsPagePort(input: {
	readonly communications: CommunicationsAuthoringPort;
	readonly readiness: CommunicationsReadinessPagePort;
	readonly presentation: Pick<CommunicationsPagePort, 'theme' | 'workspace'>;
	readonly newIdempotencyKey?: (stage: string) => string;
}): CommunicationsPagePort {
	if (input.communications.source.kind !== 'live' || input.readiness.source.kind !== 'live') {
		throw new TypeError('live_communications_page_source_required');
	}
	const key = input.newIdempotencyKey ?? idempotencyKey;
	const audienceRecords = new Map<string, AudienceRecord>();
	const audiencePersonIds = new Map<string, string>();
	const selectionPreviews = new Map<string, NonNullable<CommunicationAudienceOptionPageView['selectionPreview']>>();
	const templateDetails = new Map<string, MessageTemplateDetailView>();
	const pendingDrafts = new Map<string, PendingDraft>();
	const previewIdentityByRecipient = new Map<string, MessagePreviewIdentityView>();
	let purposesCache: CommunicationPurposePageView | null = null;
	const mintTemplate = createLiveMessageTemplateMint({
		communications: input.communications,
		newIdempotencyKey: key,
		onDetail: (detail) => templateDetails.set(detail.revision.templateId, detail)
	});

	async function purposes() {
		if (purposesCache) return purposesCache;
		purposesCache = requireSuccess(
			await input.communications.listPurposes({ channel: 'email', lifecycle: 'active' }),
			'Communication purposes'
		);
		return purposesCache;
	}

	async function templates(): Promise<MessageTemplate[]> {
		const page = requireSuccess(
			await input.communications.listTemplates({ channel: 'email', lifecycle: 'active' }),
			'Message templates'
		);
		const details = await Promise.all(page.rows.map(async (row) => requireSuccess(
			await input.communications.getTemplate({
				templateId: row.revision.templateId,
				revisionNumber: row.revision.revisionNumber
			}),
			'Message template'
		)));
		for (const detail of details) templateDetails.set(detail.revision.templateId, detail);
		return details.map(messageTemplate);
	}

	async function audiences(personId?: string): Promise<AudienceOption[]> {
		const page = requireSuccess(
			await input.communications.listAudienceOptions(personId ? { personRefId: personId } : {}),
			'Audience list'
		);
		for (const row of page.rows) audienceRecords.set(row.optionId, row);
		if (personId) for (const row of page.rows) audiencePersonIds.set(row.optionId, personId);
		return page.rows.map((row) => ({
			id: row.optionId,
			label: row.label,
			...(row.recipientEstimate.knowledge === 'known'
				? { count: row.recipientEstimate.value }
				: {}),
			...(personId ? { personId } : {})
		}));
	}

	async function readiness(): Promise<EmailReadiness> {
		const result = await input.readiness.read();
		if (result.kind !== 'success') throw failure(result as never, 'Email readiness', 'read');
		return {
			provider: result.data.provider?.displayName ?? 'No outbound provider configured',
			outbound: result.data.outbound.state,
			callbacks: 'not_applicable',
			inbound: 'not_applicable'
		};
	}

	async function list(): Promise<CommunicationMessage[]> {
		const [purposePage, drafts, history] = await Promise.all([
			purposes(),
			input.communications.listDrafts({ state: 'active' }),
			input.communications.getDeliveryHistory()
		]);
		const draftPage = requireSuccess(drafts, 'Message drafts');
		const historyPage = requireSuccess(history, 'Delivery history');
		const purposeLabels = new Map(purposePage.rows.map((row) => [row.revision.revisionId, row.label]));
		const draftRows: CommunicationMessage[] = draftPage.rows.map((draft) => {
			const pending = pendingDrafts.get(draft.draftId);
			if (pending) return pending.message;
			return {
				id: draft.draftId,
				subject: draft.authoring.state === 'ready' ? draft.authoring.subject : 'Untitled message draft',
				audience: draft.authoring.state === 'ready'
					? draft.authoring.audienceLabel ?? 'Audience counted when reviewed'
					: 'Audience not selected',
				...(draft.authoring.state === 'ready'
					&& draft.authoring.recipientEstimate.knowledge === 'known'
					? { audienceCount: draft.authoring.recipientEstimate.value }
					: {}),
				state: 'draft',
				purpose: purposeLabels.get(draft.purposeRevision.revisionId)
					?? draft.purposeRevision.purposeKey,
				cause: 'Saved as a draft in this workspace.',
				actor: draft.provenance.kind === 'agent' ? 'agent' : 'you',
				...(draft.templateRevision ? { templateId: draft.templateRevision.templateId } : {})
			};
		});
		const historyRows: CommunicationMessage[] = historyPage.rows.map((row) => ({
			id: row.historyItemId,
			messageRefId: row.messageRefId,
			subject: row.subject,
			audience: row.audienceLabel,
			...(count(row.counts.audience) === undefined ? {} : { audienceCount: count(row.counts.audience) }),
			state: messageState(row.state),
			purpose: purposeLabels.get(row.purposeRevision.revisionId) ?? row.purposeRevision.purposeKey,
			cause: row.cause.summary,
			actor: actor(row.actor),
			...(row.templateRevision ? { templateId: row.templateRevision.templateId } : {}),
			sentAt: row.authorizedAt,
			deliveryEvidence: {
				...(count(row.counts.materialized) === undefined ? {} : { materialized: count(row.counts.materialized) }),
				...(count(row.counts.accepted) === undefined ? {} : { accepted: count(row.counts.accepted) }),
				...(count(row.counts.delivered) === undefined ? {} : { delivered: count(row.counts.delivered) }),
				...(count(row.counts.acceptanceUnknown) === undefined
					? {} : { acceptanceUnknown: count(row.counts.acceptanceUnknown) }),
				...(count(row.counts.knownFailed) === undefined ? {} : { knownFailed: count(row.counts.knownFailed) }),
				...(row.stateReasonCode ? { stateReason: row.stateReasonCode } : {})
			},
			...(row.bounces === undefined ? {} : {
				bouncedCount: row.bounces.length,
				bounces: row.bounces.map((bounce) => ({
					deliveryId: bounce.deliveryId,
					deliveryVersion: bounce.deliveryVersion,
					email: bounce.safeLabel,
					reason: 'The provider reported a permanent bounce for this address.'
				}))
			})
		}));
		return [...draftRows, ...historyRows];
	}

	async function attention(): Promise<CommunicationAttentionItem[]> {
		const page = requireSuccess(await input.communications.listAttentionItems(), 'Message attention');
		return page.rows.map((row) => {
			const recommended = row.recommendedAction;
			if (recommended.kind === 'review_draft') return {
				id: row.attentionItemId, severity: row.severity, reason: row.summary,
				detail: row.detail, ...(count(row.affectedCount ?? { knowledge: 'not_supported' }) === undefined
					? {} : { count: count(row.affectedCount!) }),
				messageId: recommended.draftId,
				action: { label: 'Review draft', kind: 'review' as const }
			};
			if (recommended.kind === 'open_history') return {
				id: row.attentionItemId, severity: row.severity, reason: row.summary,
				detail: row.detail, ...(count(row.affectedCount ?? { knowledge: 'not_supported' }) === undefined
					? {} : { count: count(row.affectedCount!) }),
				messageId: recommended.historyItemId,
				action: { label: 'Open delivery evidence', kind: 'open-message' as const }
			};
			if (recommended.kind === 'open_schedule') return {
				id: row.attentionItemId, severity: row.severity, reason: row.summary,
				detail: row.detail, ...(count(row.affectedCount ?? { knowledge: 'not_supported' }) === undefined
					? {} : { count: count(row.affectedCount!) }),
				action: { label: 'Open Schedule', kind: 'open-schedule' as const }
			};
			return {
				id: row.attentionItemId, severity: row.severity, reason: row.summary,
				detail: row.detail,
				action: { label: 'Continue setup', kind: 'setup' as const }
			};
		});
	}

	async function thread(personId: string): Promise<CommunicationThread | null> {
		const purposePage = await purposes();
		const result = await input.communications.getPersonThread({ personRefId: personId });
		if (result.kind === 'outcome' && result.outcome.kind === 'communication.not_found') return null;
		const page = requireSuccess(result, 'Communication thread');
		const labels = new Map(purposePage.rows.map((row) => [row.revision.revisionId, row.label]));
		return {
			personId: page.personRefId,
			personName: page.personLabel,
			entries: page.rows.map((row) => ({
				id: row.entryId,
				...(row.historyItemId ? { messageId: row.historyItemId } : {}),
				at: row.occurredAt,
				purpose: labels.get(row.purposeRevision.revisionId) ?? row.purposeRevision.purposeKey,
				subject: row.subject,
				outcome: row.deliveryDisposition === 'delivered' ? 'delivered'
					: row.deliveryDisposition === 'permanent_bounce' ? 'bounced'
					: row.state === 'accepted' ? 'accepted'
					: row.state === 'acceptance_unknown' ? 'acceptance_unknown'
						: row.state === 'known_failed' ? 'failed'
							: row.state === 'attempting' ? 'attempting' : 'scheduled',
				actor: actor(row.actor)
			}))
		};
	}

	async function timeline(
		messageId: string,
		resendDeliveryId?: string
	): Promise<CommunicationDeliveryTimeline | null> {
		const result = await input.communications.getDeliveryTimeline({
			deliveryId: messageId,
			...(resendDeliveryId ? { resendDeliveryId } : {})
		});
		if (result.kind === 'outcome' && result.outcome.kind === 'communication.not_found') return null;
		const page = requireSuccess(result, 'Delivery evidence');
		return {
			messageId,
			resendPreviews: page.resendPreviews.map((preview) => ({
				deliveryId: preview.deliveryId,
				subject: preview.subject,
				plainText: preview.plainText,
				warningCodes: []
			})),
			entries: page.rows.flatMap((row) => row.recipient ? [{
				id: row.factId,
				deliveryId: row.recipient.deliveryId,
				recipient: row.recipient.safeLabel,
				actor: actor(row.actor),
				state: row.recipient.state === 'pending' ? 'pending' as const
					: row.recipient.state === 'request_started' ? 'attempting' as const
						: row.recipient.state === 'accepted' ? 'accepted' as const
							: row.recipient.state === 'delivered' ? 'delivered' as const
								: row.recipient.state === 'permanent_bounce' ? 'bounced' as const
							: row.recipient.state === 'acceptance_unknown' ? 'acceptance_unknown' as const
								: 'failed' as const,
				at: row.attempt?.completedAt ?? row.attempt?.startedAt ?? row.occurredAt,
				...(row.attempt ? {
					attemptNumber: row.attempt.attemptNumber,
					attemptKind: row.attempt.attemptKind,
					...(row.attempt.recoveryCode
						? { reason: 'The provider boundary did not return a conclusive result.' }
						: row.attempt.providerOutcomeReason
							? { reason: 'The provider rejected this attempt.' }
							: {})
				} : {})
			}] : [])
		};
	}

	async function previewResend(
		messageId: string,
		safeLabel: string
	): Promise<RenderedEmailPreview> {
		const history = requireSuccess(
			await input.communications.getDeliveryHistory(),
			'Delivery history'
		);
		const row = history.rows.find((entry) => entry.historyItemId === messageId);
		const matches = row?.bounces?.filter((bounce) => bounce.safeLabel === safeLabel) ?? [];
		if (!row || matches.length !== 1) {
			throw new CommunicationsPageLiveError(
				'communication_resend_preview_changed',
				'This bounced recipient changed. Reload and review the current delivery.'
			);
		}
		const detail = await timeline(row.messageRefId, matches[0]!.deliveryId);
		const preview = detail?.resendPreviews.find(
			(candidate) => candidate.deliveryId === matches[0]!.deliveryId
		);
		if (!preview) {
			throw new CommunicationsPageLiveError(
				'communication_resend_preview_unavailable',
				'The exact resend copy could not be loaded. Nothing can be resent until it is visible.'
			);
		}
		return {
			subject: preview.subject,
			plainText: preview.plainText,
			warningCodes: preview.warningCodes
		};
	}

	async function compose(value: {
		subject: string; audienceIds: readonly string[]; templateId?: string; document?: MessageTemplate;
	}): Promise<CommunicationMessage> {
		if (value.audienceIds.length === 0 || value.audienceIds.some((id) => !audienceRecords.has(id))) {
			throw new CommunicationsPageLiveError('communication_audience_stale',
				'The audience changed. Reopen the composer and choose it again.');
		}
		const audience = await resolveSelection(value.audienceIds);
		let templateDetail = value.templateId ? templateDetails.get(value.templateId) : undefined;
		if (value.templateId && !templateDetail) {
			templateDetail = requireSuccess(await input.communications.getTemplate({
				templateId: value.templateId
			}), 'Message template');
			templateDetails.set(value.templateId, templateDetail);
		}
		if (templateDetail
			&& templateDetail.purposeRevision.revisionId !== audience.audienceDraft.purposeRevision.revisionId) {
			throw new CommunicationsPageLiveError('communication_template_audience_mismatch',
				'This template and audience serve different message purposes. Choose a matching audience.');
		}
		const purposeRevision: OrganizerCommunicationPurposeRevisionRef = structuredClone(
			templateDetail?.purposeRevision ?? audience.audienceDraft.purposeRevision
		) as OrganizerCommunicationPurposeRevisionRef;
		const content = requireSuccess(await input.communications.storeAuthoringPayload({
			payloadKind: 'message_content', schemaVersion: 1,
			value: {
				kind: 'email/v1', subject: value.subject,
				body: templateDetail
					? { kind: 'template_revision/v1', templateRevision: structuredClone(templateDetail.revision) as OrganizerMessageTemplateRevisionRef }
					: { kind: 'plain_text/v1', text: plainText(value.document ?? {
						id: 'blank', key: 'blank', name: 'One-off message', purpose: '', subject: '',
						blocks: [], mergeFields: [], revision: 1, revisions: [], usedBy: []
					}) }
			}
		}, key('content')), 'Message content', 'change');
		const audiencePayload = requireSuccess(await input.communications.storeAuthoringPayload({
			payloadKind: 'message_audience_draft', schemaVersion: 1,
			value: structuredClone(audience.audienceDraft) as never
		}, key('audience')), 'Message audience', 'change');
		const draft = requireSuccess(await input.communications.createDraft({
			channel: 'email',
			purposeRevision,
			...(templateDetail ? { templateRevision: structuredClone(templateDetail.revision) as never } : {}),
			initial: {
				kind: 'adopted_payload_refs',
				contentPayload: structuredClone(content) as never,
				audiencePayload: structuredClone(audiencePayload) as never
			}
		}, key('draft')), 'Message draft', 'change');
		requireSuccess(await input.communications.prepareBatchPreview({
			draftId: draft.draftId, expectedDraftVersion: draft.version
		}), 'Message preview', 'change');
		const preview = requireSuccess(await input.communications.adoptBatchPreview({
			draftId: draft.draftId, expectedDraftVersion: draft.version
		}, key('preview')), 'Message preview', 'change');
		const recipients = requireSuccess(await input.communications.listPreviewRecipients(
			structuredClone(preview.identity) as never
		), 'Preview recipients');
		const included = recipients.rows.filter((row) => row.state === 'included');
		if (included.length !== preview.counts.includedCount) {
			throw new CommunicationsPageLiveError('communication_audience_changed',
				'The audience changed while the preview was prepared. Reopen the composer to review the current recipients; nothing was sent.');
		}
		for (const row of included) previewIdentityByRecipient.set(row.recipientResolutionId, preview.identity);
		const purposePage = await purposes();
		const purposeLabel = purposePage.rows.find((row) =>
			row.revision.revisionId === purposeRevision.revisionId)?.label ?? purposeRevision.purposeKey;
		const review: MessageReview = {
			templateLabel: templateDetail?.name ?? 'Start blank',
			audienceLabel: `${audience.label} (current snapshot)`,
			binding: 'current_snapshot',
			recipients: recipients.rows.map((row) => ({
				name: row.safeLabel,
				email: row.channel.disclosure === 'exact_authorized'
					? row.channel.exactValue
					: row.channel.disclosure === 'masked' ? row.channel.maskedValue : 'Address unavailable',
				state: row.state,
				...(row.state === 'included'
					? { mergeSample: 'Open this recipient’s email', recipientResolutionId: row.recipientResolutionId }
					: { reason: row.reasonCode })
			})),
			irreversibleNote: 'Email cannot be recalled after the provider accepts it.'
		};
		const message: CommunicationMessage = {
			id: draft.draftId,
			subject: value.subject,
				audience: audience.label,
			audienceCount: preview.counts.includedCount,
			state: 'draft',
			purpose: purposeLabel,
			cause: 'Composed by Workspace operator on the Communications page.',
			actor: 'you',
			...(templateDetail ? { templateId: templateDetail.revision.templateId } : {}),
			...(value.document && !templateDetail ? { document: value.document } : {}),
			review
		};
		pendingDrafts.set(draft.draftId, {
			draftId: draft.draftId, draftVersion: draft.version, identity: preview.identity, message
		});
		return message;
	}

	async function reviewDraft(draftId: string): Promise<CommunicationMessage> {
		const cached = pendingDrafts.get(draftId);
		if (cached) return cached.message;
		const draft = requireSuccess(await input.communications.getDraft({ draftId }), 'Message draft');
		if (draft.authoring.state !== 'ready' || !draft.audience || !draft.content) {
			throw new CommunicationsPageLiveError(
				'communication_draft_not_ready',
				'Finish the message and choose its audience before reviewing it.'
			);
		}
		requireSuccess(await input.communications.prepareBatchPreview({
			draftId, expectedDraftVersion: draft.version
		}), 'Message preview', 'change');
		const preview = requireSuccess(await input.communications.adoptBatchPreview({
			draftId, expectedDraftVersion: draft.version
		}, key('preview-existing')), 'Message preview', 'change');
		const recipients = requireSuccess(await input.communications.listPreviewRecipients(
			structuredClone(preview.identity) as never
		), 'Preview recipients');
		for (const row of recipients.rows) {
			if (row.state === 'included') {
				previewIdentityByRecipient.set(row.recipientResolutionId, preview.identity);
			}
		}
		let detail: MessageTemplateDetailView | undefined;
		if (draft.templateRevision) {
			detail = templateDetails.get(draft.templateRevision.templateId)
				?? requireSuccess(await input.communications.getTemplate({
					templateId: draft.templateRevision.templateId,
					revisionNumber: draft.templateRevision.revisionNumber
				}), 'Message template');
			templateDetails.set(detail.revision.templateId, detail);
		}
		const purposePage = await purposes();
		const message: CommunicationMessage = {
			id: draft.draftId,
			subject: draft.authoring.subject,
			audience: draft.authoring.audienceLabel ?? 'Current audience',
			audienceCount: preview.counts.includedCount,
			state: 'draft',
			purpose: purposePage.rows.find((row) =>
				row.revision.revisionId === draft.purposeRevision.revisionId)?.label
				?? draft.purposeRevision.purposeKey,
			cause: 'Saved as a draft in this workspace.',
			actor: draft.provenance.kind === 'agent' ? 'agent' : 'you',
			...(detail ? { templateId: detail.revision.templateId } : {}),
			review: {
				templateLabel: detail?.name ?? 'One-off message',
				audienceLabel: `${draft.authoring.audienceLabel ?? 'Current audience'} (current snapshot)`,
				binding: 'current_snapshot',
				recipients: recipients.rows.map((row) => ({
					name: row.safeLabel,
					email: row.channel.disclosure === 'exact_authorized'
						? row.channel.exactValue
						: row.channel.disclosure === 'masked' ? row.channel.maskedValue : 'Address unavailable',
					state: row.state,
					...(row.state === 'included'
						? { mergeSample: 'Open this recipient’s email', recipientResolutionId: row.recipientResolutionId }
						: { reason: row.reasonCode })
				})),
				irreversibleNote: 'Email cannot be recalled after the provider accepts it.'
			}
		};
		pendingDrafts.set(draftId, {
			draftId, draftVersion: draft.version, identity: preview.identity, message
		});
		return message;
	}

	async function send(draftId: string): Promise<MutationOutcome> {
		const pending = pendingDrafts.get(draftId);
		if (!pending) return {
			ok: false,
			reason: 'Reopen this draft to prepare and review its current audience before sending.'
		};
		const sent = await input.communications.sendMessages({
			audienceSpecId: pending.identity.audienceSpecId,
			batchId: `batch.${globalThis.crypto.randomUUID()}`,
			subject: pending.message.subject,
			audienceLabel: pending.message.audience
		}, key('send'));
		if (sent.kind !== 'success') return { ok: false, reason: failure(sent as never, 'Message send', 'change').message };
		pendingDrafts.delete(draftId);
		return { ok: true };
	}

	async function previewRecipient(recipientResolutionId: string): Promise<RenderedEmailPreview> {
		const identity = previewIdentityByRecipient.get(recipientResolutionId);
		if (!identity) throw new CommunicationsPageLiveError(
			'communication_preview_required', 'Review the current audience before opening this copy.'
		);
		const detail = requireSuccess(await input.communications.getPreview({
			...structuredClone(identity),
			selectedRecipientResolutionId: recipientResolutionId
		}), 'Recipient preview');
		if (detail.selected.kind !== 'rendered_email') throw new CommunicationsPageLiveError(
			'communication_preview_unavailable', 'This recipient has no rendered copy in the current preview.'
		);
		return {
			subject: detail.selected.render.subject,
			plainText: detail.selected.render.plainText,
			warningCodes: [...detail.selected.render.warningCodes]
		};
	}

	function selectionKey(ids: readonly string[]): string {
		return JSON.stringify(ids);
	}

	async function resolveSelection(ids: readonly string[]) {
		const cached = selectionPreviews.get(selectionKey(ids));
		if (cached) return cached;
		const personIds = [...new Set(ids.flatMap((id) => {
			const personId = audiencePersonIds.get(id);
			return personId ? [personId] : [];
		}))];
		const page = requireSuccess(await input.communications.listAudienceOptions({
			selectionOptionIds: [...ids],
			...(personIds.length === 1 ? { personRefId: personIds[0] } : {})
		}), 'Audience preview');
		if (!page.selectionPreview) {
			throw new CommunicationsPageLiveError(
				'communication_audience_preview_unavailable',
				'The selected audience could not be counted. Choose it again.'
			);
		}
		selectionPreviews.set(selectionKey(ids), page.selectionPreview);
		return page.selectionPreview;
	}

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		communications: Object.freeze({
			list, readiness, attention, thread, timeline, previewResend, audiences,
			async previewRecipients(audienceIds: readonly string[]): Promise<AudiencePreview> {
				if (audienceIds.length === 0) return { rows: [], reach: 0, overlap: 0, label: '' };
				const preview = await resolveSelection(audienceIds);
				return {
					rows: preview.rows.map((row) => ({
						name: row.safeLabel,
						state: row.state,
						speakerId: row.personRefId,
						...(row.via ? { via: row.via } : {}),
						...(row.reasonCode ? { reason: 'This recipient is excluded by the current communication policy.' } : {})
					})),
					reach: preview.reach,
					overlap: preview.overlap,
					label: preview.label
				};
			},
			compose,
			reviewDraft,
			send,
			previewRecipient,
			async resendBounced(
				messageId: string,
				safeLabel: string,
				correctedEmail: string
			): Promise<MutationOutcome> {
				const history = await input.communications.getDeliveryHistory();
				if (history.kind !== 'success') {
					return { ok: false, reason: failure(history as never, 'Delivery history', 'read').message };
				}
				const row = history.data.rows.find((entry) => entry.historyItemId === messageId);
				const matches = row?.bounces?.filter((bounce) => bounce.safeLabel === safeLabel) ?? [];
				if (matches.length !== 1) {
					return { ok: false, reason: 'This bounced recipient changed. Reload and review the current delivery.' };
				}
				const bounce = matches[0]!;
				const retried = await input.communications.retryDelivery({
					deliveryId: bounce.deliveryId,
					expectedDeliveryVersion: bounce.deliveryVersion,
					correctedEmail: correctedEmail.trim()
				}, key('retry-delivery'));
				if (retried.kind !== 'success') {
					return { ok: false, reason: failure(retried as never, 'Delivery retry', 'change').message };
				}
				return { ok: true };
			}
		}),
		templates: Object.freeze({
			async list() { return { messages: await templates() }; },
			create: mintTemplate,
			async commitInline(): Promise<MutationOutcome> {
				return { ok: false, reason: 'Editing message templates is not available in this workspace.' };
			}
		}),
		theme: input.presentation.theme,
		workspace: input.presentation.workspace
	});
}
