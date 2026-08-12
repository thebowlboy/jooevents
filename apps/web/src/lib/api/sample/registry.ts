import type { WorkspaceDataset } from './dataset';
import type { Residency } from '../residency';
import flight from './flight';
import opening from './opening';
import crunch from './crunch';
import quiet from './quiet';
import fresh from './fresh';

/**
 * Sample-data scenarios. The build always ships with the default scenario as
 * its data source until the real transport lands; alternative scenarios are a
 * development aid and are only selectable in dev builds (cookie-driven).
 */
export const scenarios: WorkspaceDataset[] = [flight, opening, crunch, quiet, fresh];

export const defaultScenarioKey = 'flight';

const COOKIE_NAME = 'je-scenario';

export function activeScenarioKey(): string {
	if (!import.meta.env.DEV || typeof document === 'undefined') return defaultScenarioKey;
	const match = document.cookie.match(/(?:^|;\s*)je-scenario=([^;]+)/);
	const key = match?.[1];
	return key && scenarios.some((scenario) => scenario.key === key) ? key : defaultScenarioKey;
}

export function resolveDataset(): WorkspaceDataset {
	const key = activeScenarioKey();
	return scenarios.find((scenario) => scenario.key === key) ?? scenarios[0];
}

export function setScenarioCookie(key: string): void {
	document.cookie = `${COOKIE_NAME}=${key}; path=/; max-age=31536000; samesite=lax`;
}

const RESIDENCY_COOKIE = 'je-residency';

/**
 * Whether list surfaces hold their scope or ask the server per query.
 *
 * `resident` is the default because at the sizes this product targets it is the
 * better answer — a scoped submission list is well under the ceiling, so every
 * search, filter, and tray switch becomes local. The setting exists so the two
 * can be compared on identical data: both paths answer through the same
 * selection function, so a difference in results is a bug rather than a
 * trade-off.
 */
export function sampleResidency(): Residency {
	if (!import.meta.env.DEV || typeof document === 'undefined') return 'resident';
	const match = document.cookie.match(/(?:^|;\s*)je-residency=(resident|paged)/);
	return (match?.[1] as Residency) ?? 'resident';
}

export function setResidencyCookie(value: Residency): void {
	document.cookie = `${RESIDENCY_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
}

const LATENCY_COOKIE = 'je-latency';
const DEFAULT_LATENCY_MS = 160;

/**
 * Sample-transport latency, overridable in dev builds (cookie, milliseconds) so
 * pending-tier treatments can be experienced and asserted; production always
 * uses the default.
 */
export function sampleLatencyMs(): number {
	if (!import.meta.env.DEV || typeof document === 'undefined') return DEFAULT_LATENCY_MS;
	const match = document.cookie.match(/(?:^|;\s*)je-latency=(\d{1,5})/);
	const value = match ? Number(match[1]) : DEFAULT_LATENCY_MS;
	return Math.min(5000, Math.max(0, value));
}

export function setLatencyCookie(ms: number): void {
	document.cookie = `${LATENCY_COOKIE}=${ms}; path=/; max-age=31536000; samesite=lax`;
}
