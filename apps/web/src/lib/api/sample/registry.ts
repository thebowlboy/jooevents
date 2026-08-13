import type { WorkspaceDataset } from './dataset';
import { formatDateRange } from './dataset';
import type { Residency } from '../residency';
import type { WorkspaceEventOption } from '../types';
import type { WorkspaceViewer } from '../workspace-gateway';
import { newEventDataset, type CreatedEventSeed } from './new-event';
import flight from './flight';
import opening from './opening';
import crunch from './crunch';
import quiet from './quiet';
import fresh from './fresh';

/**
 * Sample-data scenarios. The build ships with the default scenario as its data
 * source until the real transport lands. The scenario cookie stopped being a
 * dev-only aid when the sidebar event switcher started writing it (an event's
 * data lives in the scenario that renders it), so it is honored in any sample
 * build; the key is still validated against the known scenarios.
 */
export const scenarios: WorkspaceDataset[] = [flight, opening, crunch, quiet, fresh];

export const defaultScenarioKey = 'crunch';

const COOKIE_NAME = 'je-scenario';

export function activeScenarioKey(): string {
	if (typeof document === 'undefined') {
		// Unit runs pin the classic mid-flight fixture: tests assert specific
		// scenario rows through the ambient workspace, and which story the
		// hosted demo opens on must never decide what they see. Tests that want
		// another scenario import its dataset directly. SSR and builds keep the
		// shipped default.
		const env = typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;
		return env === 'test' ? 'flight' : defaultScenarioKey;
	}
	const match = document.cookie.match(/(?:^|;\s*)je-scenario=([^;]+)/);
	const key = match?.[1];
	if (!key) return defaultScenarioKey;
	if (scenarios.some((scenario) => scenario.key === key)) return key;
	if (createdEventSeeds().some((seed) => `created:${seed.id}` === key)) return key;
	return defaultScenarioKey;
}

export function resolveDataset(): WorkspaceDataset {
	const key = activeScenarioKey();
	if (key.startsWith('created:')) {
		const seed = createdEventSeeds().find((entry) => `created:${entry.id}` === key);
		if (seed) return newEventDataset(seed);
	}
	return scenarios.find((scenario) => scenario.key === key) ?? scenarios[0];
}

// ---------------------------------------------------------------------------
// Events created in this browser. They live client-side so they survive the
// reload an event switch performs; the real backend replaces this store with
// the event-creation operation and serves the list from the workspace.

const CREATED_EVENTS_KEY = 'je-created-events';

export function createdEventSeeds(): CreatedEventSeed[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const raw = localStorage.getItem(CREATED_EVENTS_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is CreatedEventSeed =>
				typeof entry === 'object' &&
				entry !== null &&
				typeof (entry as CreatedEventSeed).id === 'string' &&
				typeof (entry as CreatedEventSeed).name === 'string' &&
				typeof (entry as CreatedEventSeed).timezone === 'string' &&
				typeof (entry as CreatedEventSeed).startDate === 'string' &&
				typeof (entry as CreatedEventSeed).endDate === 'string'
		);
	} catch {
		return [];
	}
}

export function persistCreatedEvent(seed: CreatedEventSeed): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(CREATED_EVENTS_KEY, JSON.stringify([...createdEventSeeds(), seed]));
}

export function setScenarioCookie(key: string): void {
	document.cookie = `${COOKIE_NAME}=${key}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * The workspace's events, one entry per distinct event id across the sample
 * scenarios. Several scenarios are moments in the life of one event, so the
 * active scenario represents its own event and the first scenario carrying an
 * event represents it otherwise — dev scenario switching and the product event
 * switcher compose instead of fighting.
 */
export function workspaceEvents(): WorkspaceEventOption[] {
	const activeKey = activeScenarioKey();
	const byEvent = new Map<string, WorkspaceEventOption>();
	for (const scenario of scenarios) {
		const event = scenario.summary.event;
		if (!event) continue;
		const existing = byEvent.get(event.id);
		if (existing && scenario.key !== activeKey) continue;
		byEvent.set(event.id, {
			id: event.id,
			name: event.name,
			dates: event.dates,
			location: event.location,
			scenarioKey: scenario.key,
			current: scenario.key === activeKey
		});
	}
	const options = [...byEvent.values()];
	for (const seed of createdEventSeeds()) {
		options.push({
			id: seed.id,
			name: seed.name,
			dates: formatDateRange(seed.startDate, seed.endDate),
			location: '',
			scenarioKey: `created:${seed.id}`,
			current: `created:${seed.id}` === activeKey
		});
	}
	return options;
}

const VIEWER_COOKIE = 'je-viewer';

/**
 * Whose eyes the workspace is seen through. A reviewer projection borrows a
 * real roster entry from the loaded scenario, so a scenario with nobody
 * reviewing yields the organizer projection rather than a reviewer who does
 * not exist. Live builds will derive the same projection server-side.
 */
export function sampleViewer(): WorkspaceViewer {
	if (!import.meta.env.DEV || typeof document === 'undefined') return { kind: 'organizer' };
	const match = document.cookie.match(/(?:^|;\s*)je-viewer=(organizer|reviewer)/);
	if (match?.[1] !== 'reviewer') return { kind: 'organizer' };
	const reviewerId = resolveDataset().reviewers.find((reviewer) => reviewer.status === 'active')?.id;
	return reviewerId ? { kind: 'reviewer', reviewerId } : { kind: 'organizer' };
}

export function setViewerCookie(kind: WorkspaceViewer['kind']): void {
	document.cookie = `${VIEWER_COOKIE}=${kind}; path=/; max-age=31536000; samesite=lax`;
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
