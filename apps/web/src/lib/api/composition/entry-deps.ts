import '../../crypto-uuid-fallback';
import type { AccessContext, ParticipantContext } from '@jooevents/contracts';
import type { ApiResult } from '../client';
import { resolveDataset, sampleLatencyMs } from '../sample/registry';
import {
	portalAuthState,
	portalLinkOutcome,
	resolvePortalDataset,
	setPortalAuthCookie
} from '../portal/sample/registry';
import type { EntryDependencies } from './entry-dependencies';

/**
 * Sample entry fulfillment. It simulates outcomes rather than shortcutting
 * them: a link request always answers the same way whoever asks, a followed
 * link produces whichever real outcome is selected, and signing in is a state
 * the next page load reads back — the same sequence the served operations will
 * produce.
 */

const latency = () => new Promise((resolve) => setTimeout(resolve, sampleLatencyMs()));

/**
 * Which access state the sample operator entry answers with.
 *
 * Two kinds of cookie are read in this fulfillment and they are guarded
 * differently on purpose. A cookie a sample operation itself writes — this one
 * and the participant's — is session memory: signing in has to be readable by
 * the next page load in every sample build, or the journey it just completed
 * would not have happened. A cookie only the development switcher writes —
 * scenario, followed-link outcome, viewer, latency — is a development aid and
 * is read under `import.meta.env.DEV` alone. Neither reaches a live build: the
 * live composition resolves to `entry-deps.live.ts` and cannot import this
 * module or any sample module.
 */
export type OperatorEntryAuthState = 'anonymous' | 'active';

const OPERATOR_AUTH_COOKIE = 'je-entry-auth';
const DEFAULT_OPERATOR_AUTH_STATE: OperatorEntryAuthState = 'anonymous';

export function operatorEntryAuthState(): OperatorEntryAuthState {
	if (typeof document === 'undefined') return DEFAULT_OPERATOR_AUTH_STATE;
	const match = document.cookie.match(/(?:^|;\s*)je-entry-auth=(anonymous|active)/);
	return (match?.[1] as OperatorEntryAuthState) ?? DEFAULT_OPERATOR_AUTH_STATE;
}

export function setOperatorEntryAuthCookie(state: OperatorEntryAuthState): void {
	document.cookie = `${OPERATOR_AUTH_COOKIE}=${state}; path=/; max-age=31536000; samesite=lax`;
}

function operatorContext(): AccessContext {
	if (operatorEntryAuthState() === 'anonymous') return { state: 'anonymous' };
	const dataset = resolveDataset();
	const member = dataset.members.find((candidate) => candidate.status === 'active');
	return {
		state: 'active',
		user: {
			id: member?.id ?? 'mem-sample',
			displayName: member?.name ?? 'Sample organizer',
			...(member?.email ? { primaryEmail: member.email } : {})
		},
		workspace: { id: `wsp-${dataset.key}`, name: dataset.settings?.name ?? dataset.name }
	};
}

function participantContext(): ParticipantContext {
	const state = portalAuthState();
	if (state === 'anonymous') return { state: 'anonymous' };
	if (state === 'expired') return { state: 'expired' };
	const dataset = resolvePortalDataset();
	return { state: 'active', participant: dataset.participant, event: dataset.event };
}

function assign(path: string): void {
	if (typeof window !== 'undefined') window.location.assign(path);
}

/** Cookies are how this fulfillment remembers; off a document it stays read-only. */
function remember(write: () => void): void {
	if (typeof document !== 'undefined') write();
}

export const entryDependencies: EntryDependencies = {
	operator: {
		async getContext(): Promise<ApiResult<AccessContext>> {
			await latency();
			return { kind: 'success', data: operatorContext() };
		},
		async startGoogle(input): Promise<ApiResult<{ readonly redirecting: true }>> {
			await latency();
			remember(() => setOperatorEntryAuthCookie('active'));
			assign(input.returnTo);
			return { kind: 'success', data: { redirecting: true } };
		},
		async startReviewOrganizer(): Promise<ApiResult<{ readonly redirecting: true }>> {
			await latency();
			remember(() => setOperatorEntryAuthCookie('active'));
			assign('/app');
			return { kind: 'success', data: { redirecting: true } };
		},
		async signOut(): Promise<ApiResult<{ readonly signedOut: true }>> {
			await latency();
			remember(() => setOperatorEntryAuthCookie('anonymous'));
			return { kind: 'success', data: { signedOut: true } };
		},
		async requestSignInLink(_input) {
			await latency();
			return { kind: 'success', data: { outcome: 'link_requested' } };
		}
	},
	participant: {
		async getContext(): Promise<ApiResult<ParticipantContext>> {
			await latency();
			return { kind: 'success', data: participantContext() };
		},
		async requestLink(_input) {
			await latency();
			return { kind: 'success', data: { outcome: 'link_requested' } };
		},
		async completeLink(_input) {
			await latency();
			const outcome = portalLinkOutcome();
			if (outcome === 'signed_in') remember(() => setPortalAuthCookie('active'));
			return { kind: 'success', data: { outcome } };
		},
		async signOut(): Promise<ApiResult<{ readonly signedOut: true }>> {
			await latency();
			remember(() => setPortalAuthCookie('anonymous'));
			return { kind: 'success', data: { signedOut: true } };
		}
	}
};
