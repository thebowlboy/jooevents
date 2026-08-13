import type { PortalDataset } from './dataset';
import submitted from './submitted';
import accepted from './accepted';
import declined from './declined';
import mixed from './mixed';

/**
 * Participant-portal scenarios. Each is one person's coherent world, separate
 * from the operator scenarios: the two lanes are different people looking at
 * the same event, never two views of one dataset.
 */
export const portalScenarios: PortalDataset[] = [submitted, accepted, declined, mixed];

export const defaultPortalScenarioKey = 'submitted';

const SCENARIO_COOKIE = 'je-portal-scenario';

export function activePortalScenarioKey(): string {
	if (!import.meta.env.DEV || typeof document === 'undefined') return defaultPortalScenarioKey;
	const match = document.cookie.match(/(?:^|;\s*)je-portal-scenario=([^;]+)/);
	const key = match?.[1];
	return key && portalScenarios.some((scenario) => scenario.key === key)
		? key
		: defaultPortalScenarioKey;
}

export function resolvePortalDataset(): PortalDataset {
	const key = activePortalScenarioKey();
	return portalScenarios.find((scenario) => scenario.key === key) ?? portalScenarios[0];
}

export function setPortalScenarioCookie(key: string): void {
	document.cookie = `${SCENARIO_COOKIE}=${key}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * Which participant access state the sample entry answers with. The portal is
 * the surface being built, so a sample build with no cookie lands signed in;
 * signing out and following a sample link move it from there.
 *
 * This is session memory the sample operations write themselves, so it is read
 * wherever they run rather than in development alone — a build where signing
 * out could not be read back would be showing a journey it did not make. The
 * cookies below, which only the development switcher writes, stay development
 * aids. Neither is reachable from a live build.
 */
export type PortalAuthState = 'anonymous' | 'active' | 'expired';

const AUTH_COOKIE = 'je-portal-auth';
const DEFAULT_AUTH_STATE: PortalAuthState = 'active';

export function portalAuthState(): PortalAuthState {
	if (typeof document === 'undefined') return DEFAULT_AUTH_STATE;
	const match = document.cookie.match(/(?:^|;\s*)je-portal-auth=(anonymous|active|expired)/);
	return (match?.[1] as PortalAuthState) ?? DEFAULT_AUTH_STATE;
}

export function setPortalAuthCookie(state: PortalAuthState): void {
	document.cookie = `${AUTH_COOKIE}=${state}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * What the sample entry makes of a followed link. Every failure mode is a real
 * server answer elsewhere; here it is chosen, so each one can be built against.
 */
export type PortalLinkOutcome = 'signed_in' | 'link_expired' | 'link_used' | 'link_invalid';

const LINK_COOKIE = 'je-portal-link';
const DEFAULT_LINK_OUTCOME: PortalLinkOutcome = 'signed_in';

export function portalLinkOutcome(): PortalLinkOutcome {
	if (!import.meta.env.DEV || typeof document === 'undefined') return DEFAULT_LINK_OUTCOME;
	const match = document.cookie.match(
		/(?:^|;\s*)je-portal-link=(signed_in|link_expired|link_used|link_invalid)/
	);
	return (match?.[1] as PortalLinkOutcome) ?? DEFAULT_LINK_OUTCOME;
}

export function setPortalLinkCookie(outcome: PortalLinkOutcome): void {
	document.cookie = `${LINK_COOKIE}=${outcome}; path=/; max-age=31536000; samesite=lax`;
}
