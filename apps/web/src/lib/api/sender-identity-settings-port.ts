import {
	workspaceSenderIdentityRefusalDetailSchema,
	workspaceSenderIdentityStaleDetailSchema,
	type StructuredOutcome,
	type WorkspaceSenderIdentityDto,
	type WorkspaceSenderIdentityRefusalCode
} from '@jooevents/contracts';
import type { SafeApiError } from './client';
import type {
	WorkspaceSenderIdentityLiveClient,
	WorkspaceSenderIdentityLiveReadResult,
	WorkspaceSenderIdentityLiveUpdateResult
} from './operations/workspace-sender-identity-live';

/**
 * The Settings-facing seam for the workspace's outbound sender presentation.
 *
 * The from-address is present as read-only effective context and absent from
 * every write shape: it is per-installation configuration, because a
 * per-workspace from-address breaks SPF/DKIM alignment.
 */

export type SenderIdentitySource = 'installation' | 'workspace';

export type SenderIdentityField = 'display_name' | 'reply_to_address';

export interface SenderIdentityEffective {
	readonly fromAddress: string;
	readonly fromDisplayName: string | null;
	readonly replyToAddress: string | null;
	readonly source: SenderIdentitySource;
}

export interface SenderIdentityView {
	/** Feed straight back as `expectedHeadVersion`; a commit advances it by one. */
	readonly headVersion: number;
	/** The workspace's own value; `null` means the installation's is in force. */
	readonly displayName: string | null;
	readonly replyToAddress: string | null;
	readonly effective: SenderIdentityEffective;
}

export type SenderIdentityReadResult =
	| { readonly kind: 'success'; readonly data: SenderIdentityView }
	| { readonly kind: 'denied'; readonly supportCode?: string }
	| { readonly kind: 'unavailable'; readonly supportCode?: string }
	| { readonly kind: 'failure'; readonly retryable: boolean; readonly supportCode?: string };

export type SenderIdentitySaveResult =
	| { readonly kind: 'saved'; readonly data: SenderIdentityView }
	| {
			readonly kind: 'refused';
			readonly field: SenderIdentityField;
			readonly code: WorkspaceSenderIdentityRefusalCode;
			readonly supportCode?: string;
	  }
	/** Someone else committed first; `headVersion` is the server's current head. */
	| { readonly kind: 'stale'; readonly headVersion: number; readonly supportCode?: string }
	| { readonly kind: 'in_progress'; readonly supportCode?: string }
	| { readonly kind: 'request_changed'; readonly supportCode?: string }
	| { readonly kind: 'intervened'; readonly supportCode?: string }
	| { readonly kind: 'denied'; readonly supportCode?: string }
	| { readonly kind: 'unavailable'; readonly supportCode?: string }
	| { readonly kind: 'failure'; readonly retryable: boolean; readonly supportCode?: string };

/** `null` clears a field back to the installation value; `''` is never sent. */
export interface SenderIdentityUpdate {
	readonly expectedHeadVersion: number;
	readonly displayName: string | null;
	readonly replyToAddress: string | null;
}

export interface SettingsPageSenderIdentityPort {
	read(options?: { readonly signal?: AbortSignal }): Promise<SenderIdentityReadResult>;
	save(
		input: SenderIdentityUpdate,
		options?: { readonly signal?: AbortSignal }
	): Promise<SenderIdentitySaveResult>;
}

/**
 * RFC-shaped: a named sender is `Name <address>`, an unnamed one the address
 * alone. One definition, because the panel's live preview and the sample
 * transport's own message previews must not disagree about how a sender reads.
 */
export function senderLine(displayName: string | null, address: string): string {
	return displayName ? `${displayName} <${address}>` : address;
}

export function senderIdentityView(dto: WorkspaceSenderIdentityDto): SenderIdentityView {
	return Object.freeze({
		headVersion: dto.headVersion,
		displayName: dto.displayName,
		replyToAddress: dto.replyToAddress,
		effective: Object.freeze({ ...dto.effective })
	});
}

function transportFailure(error: SafeApiError): {
	readonly kind: 'failure';
	readonly retryable: boolean;
	readonly supportCode?: string;
} {
	return {
		kind: 'failure',
		retryable: error.retryable,
		...(error.correlationId ? { supportCode: error.correlationId } : {})
	};
}

/** Present only for a real server correlation id; the sample transport has none. */
function support(correlationId: string | undefined): { readonly supportCode?: string } {
	return correlationId ? { supportCode: correlationId } : {};
}

function readOutcome(
	outcome: StructuredOutcome,
	correlationId: string
): SenderIdentityReadResult {
	return outcome.class === 'access_denied'
		? { kind: 'denied', ...support(correlationId) }
		: { kind: 'failure', retryable: outcome.retryable, ...support(correlationId) };
}

/**
 * One declared outcome to one typed result. An outcome whose detail does not
 * parse is a contract failure, not a refusal to narrate: it lands on the
 * generic failure arm rather than being rendered from an unknown code.
 */
function updateOutcome(
	outcome: StructuredOutcome,
	correlationId: string | undefined
): SenderIdentitySaveResult {
	const code = support(correlationId);
	if (outcome.class === 'access_denied') return { kind: 'denied', ...code };
	if (outcome.class === 'conflict') return { kind: 'in_progress', ...code };
	if (outcome.class === 'idempotency_conflict') return { kind: 'request_changed', ...code };
	if (outcome.class === 'stale_revision') {
		const detail = workspaceSenderIdentityStaleDetailSchema.safeParse(outcome.detail);
		return detail.success
			? { kind: 'stale', headVersion: detail.data.headVersion, ...code }
			: { kind: 'failure', retryable: false, ...code };
	}
	if (outcome.class === 'policy_violation') {
		if (outcome.kind === 'communication.sender_identity_refused') {
			const detail = workspaceSenderIdentityRefusalDetailSchema.safeParse(outcome.detail);
			return detail.success
				? { kind: 'refused', field: detail.data.field, code: detail.data.code, ...code }
				: { kind: 'failure', retryable: false, ...code };
		}
		return { kind: 'intervened', ...code };
	}
	return { kind: 'failure', retryable: outcome.retryable, ...code };
}

function liveRead(result: WorkspaceSenderIdentityLiveReadResult): SenderIdentityReadResult {
	if (result.kind === 'success') return { kind: 'success', data: senderIdentityView(result.data) };
	if (result.kind === 'outcome') return readOutcome(result.outcome, result.correlationId);
	if (result.kind === 'unavailable') return { kind: 'unavailable' };
	return transportFailure(result.error);
}

function liveUpdate(result: WorkspaceSenderIdentityLiveUpdateResult): SenderIdentitySaveResult {
	if (result.kind === 'success') return { kind: 'saved', data: senderIdentityView(result.data) };
	if (result.kind === 'outcome') return updateOutcome(result.outcome, result.correlationId);
	if (result.kind === 'unavailable') return { kind: 'unavailable' };
	return transportFailure(result.error);
}

export function createLiveSenderIdentitySettingsPort(input: {
	readonly client: WorkspaceSenderIdentityLiveClient;
}): SettingsPageSenderIdentityPort {
	return Object.freeze({
		async read(options = {}) {
			return liveRead(await input.client.read(options));
		},
		async save(update: SenderIdentityUpdate, options = {}) {
			return liveUpdate(await input.client.update(update, options));
		}
	});
}

/** What the sample gateway serves in place of the two mounted operations. */
export interface SampleSenderIdentitySource {
	read(): Promise<WorkspaceSenderIdentityDto>;
	update(input: SenderIdentityUpdate): Promise<
		| { readonly kind: 'success'; readonly data: WorkspaceSenderIdentityDto }
		| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome }
	>;
}

export function createSampleSenderIdentitySettingsPort(
	source: SampleSenderIdentitySource
): SettingsPageSenderIdentityPort {
	// The sample transport carries no correlation id, so no support code is
	// offered: a fabricated one would send someone hunting a record that has
	// never existed.
	return Object.freeze({
		async read(): Promise<SenderIdentityReadResult> {
			return { kind: 'success', data: senderIdentityView(await source.read()) };
		},
		async save(update: SenderIdentityUpdate): Promise<SenderIdentitySaveResult> {
			const result = await source.update(update);
			return result.kind === 'success'
				? { kind: 'saved', data: senderIdentityView(result.data) }
				: updateOutcome(result.outcome, undefined);
		}
	});
}
