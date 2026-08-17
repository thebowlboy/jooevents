export type AirtableAreaDirection = 'not_connected' | 'keep_airtable_updated' | 'work_from_airtable';

export interface AirtableIntegrationArea {
	readonly key: 'people' | 'submissions' | 'sessions' | 'schedule' | 'tasks';
	readonly label: string;
	readonly direction: AirtableAreaDirection;
	readonly sharedFields: number;
	readonly editableFields: number;
	readonly requestFields: number;
}

export interface AirtableAttentionItem {
	readonly id: string;
	readonly kind: 'conflict' | 'request' | 'reconnect';
	readonly title: string;
	readonly href: string;
	readonly actionLabel: string;
}

export interface AirtableHistoryItem {
	readonly id: string;
	readonly kind: 'applied' | 'refused' | 'sharing' | 'connection';
	readonly summary: string;
	readonly occurredAt: string;
	readonly actorLabel?: string;
	readonly before?: string;
	readonly after?: string;
	readonly revertLabel?: string;
}

export interface AirtableIntegrationView {
	readonly state: 'not_connected' | 'provisioning' | 'current' | 'pending' | 'needs_review' | 'delayed' | 'catching_up' | 'paused' | 'needs_reconnect';
	readonly setupStage?: 'choose_base' | 'adding_tables';
	readonly baseName?: string;
	readonly baseUrl?: string;
	readonly accountLabel?: string;
	readonly lastOutbound?: string;
	readonly lastInbound?: string;
	readonly lastFullCheck?: string;
	readonly lastFullCheckSummary?: string;
	readonly supportCode?: string;
	readonly areas: readonly AirtableIntegrationArea[];
	readonly attention: readonly AirtableAttentionItem[];
	readonly history: readonly AirtableHistoryItem[];
}

export interface AirtableSelectableBase {
	readonly id: string;
	readonly name: string;
	readonly permissionLevel: 'none' | 'read' | 'comment' | 'edit' | 'create';
}

export interface IntegrationsPagePort {
	readAirtable(): Promise<AirtableIntegrationView>;
	connectAirtable(): Promise<AirtableIntegrationView>;
	listAirtableBases(): Promise<readonly AirtableSelectableBase[]>;
	activateAirtable(baseId: string, directions: readonly Readonly<{
		areaKey: AirtableIntegrationArea['key']; direction: AirtableAreaDirection;
	}>[]): Promise<AirtableIntegrationView>;
	setAreaDirection(key: AirtableIntegrationArea['key'], direction: AirtableAreaDirection): Promise<AirtableIntegrationView>;
	syncNow(): Promise<AirtableIntegrationView>;
	setPaused(paused: boolean): Promise<AirtableIntegrationView>;
	revertHistory(id: string): Promise<AirtableIntegrationView>;
	disconnect(): Promise<AirtableIntegrationView>;
}

function areas(): AirtableIntegrationArea[] {
	return [
		{ key: 'people', label: 'People and speakers', direction: 'work_from_airtable', sharedFields: 14, editableFields: 0, requestFields: 2 },
		{ key: 'submissions', label: 'Submissions', direction: 'keep_airtable_updated', sharedFields: 8, editableFields: 0, requestFields: 0 },
		{ key: 'sessions', label: 'Sessions', direction: 'keep_airtable_updated', sharedFields: 9, editableFields: 0, requestFields: 0 },
		{ key: 'schedule', label: 'Schedule', direction: 'keep_airtable_updated', sharedFields: 6, editableFields: 0, requestFields: 0 },
		{ key: 'tasks', label: 'Speaker tasks', direction: 'work_from_airtable', sharedFields: 10, editableFields: 1, requestFields: 0 }
	];
}

function disconnected(): AirtableIntegrationView {
	return { state: 'not_connected', areas: areas(), attention: [], history: [] };
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export function createSampleIntegrationsPagePort(
	connected = true,
	now: () => number = Date.now
): IntegrationsPagePort {
	const ago = (distance: number) => new Date(now() - distance).toISOString();
	let view: AirtableIntegrationView = connected ? {
		state: 'needs_review',
		baseName: 'Riverside Conf 2027 base',
		baseUrl: 'https://airtable.com/',
		accountLabel: 'Maya Chen <maya@example.com>',
		lastOutbound: '12:04',
		lastInbound: '11:58',
		lastFullCheck: 'Yesterday 03:00',
		lastFullCheckSummary: 'Every managed record matched.',
		supportCode: 'airtable-riverside-7K3P',
		areas: areas(),
		attention: [
			{ id: 'conflict-1', kind: 'conflict', title: "Both sides changed Maya Chen's session title", href: '/app/integrations/airtable?panel=conflicts', actionLabel: 'Resolve' },
			{ id: 'request-1', kind: 'request', title: "Airtable asks to cancel Jonas Weber's session", href: '/app/speakers?request=cancellation', actionLabel: 'Review there' }
		],
		history: [
			{ id: 'history-1', kind: 'applied', summary: "Dana Ryu changed Maya Chen's session title in Airtable", actorLabel: 'Dana Ryu', before: 'Scaling Postgres', after: 'Scaling PostgreSQL', occurredAt: ago(2 * HOUR_MS), revertLabel: 'Change back to “Scaling Postgres”' },
			{ id: 'history-2', kind: 'refused', summary: "Dana Ryu edited Keynote's room in Airtable, but that value is view-only. JooEvents put it back.", actorLabel: 'Dana Ryu', before: 'Room 4', after: 'Room 7', occurredAt: ago(30 * HOUR_MS) },
			{ id: 'history-3', kind: 'sharing', summary: 'Sharing changed: Speaker tasks now update JooEvents (1 field).', actorLabel: 'Maya Chen', occurredAt: ago(4 * DAY_MS) }
		]
	} : disconnected();
	const copy = () => structuredClone(view);
	return {
		async readAirtable() { return copy(); },
		async connectAirtable() {
			view = { ...disconnected(), state: 'provisioning', setupStage: 'choose_base', accountLabel: 'Airtable account' };
			return copy();
		},
		async listAirtableBases() { return [{ id: 'appSampleBase', name: 'Riverside Conf 2027', permissionLevel: 'create' }]; },
		async activateAirtable(_baseId, directions) {
			view = {
				...view, state: 'provisioning', setupStage: 'adding_tables', baseName: 'Riverside Conf 2027',
				areas: view.areas.map((area) => ({
					...area, direction: directions.find((item) => item.areaKey === area.key)?.direction ?? 'not_connected'
				}))
			};
			return copy();
		},
		async setAreaDirection(key, direction) {
			view = {
				...view,
				areas: view.areas.map((area) => area.key === key ? { ...area, direction } : area),
				state: 'pending',
				history: [{ id: `sharing-${key}`, kind: 'sharing', summary: `${view.areas.find((area) => area.key === key)?.label ?? key} sharing changed.`, occurredAt: new Date(now()).toISOString() }, ...view.history]
			};
			return copy();
		},
		async syncNow() { view = { ...view, state: 'pending' }; return copy(); },
		async setPaused(paused) { view = { ...view, state: paused ? 'paused' : 'pending' }; return copy(); },
		async revertHistory(id) {
			const target = view.history.find((item) => item.id === id);
			view = {
				...view,
				state: 'pending',
				history: view.history.map((item) => item.id === id ? { ...item, revertLabel: undefined } : item),
				...(target ? { lastOutbound: 'Checking now' } : {})
			};
			return copy();
		},
		async disconnect() { view = disconnected(); return copy(); }
	};
}

/** Live environments show only capabilities actually mounted by the server. */
export function createDisconnectedIntegrationsPagePort(): IntegrationsPagePort {
	const view = disconnected();
	const unavailable = async (): Promise<AirtableIntegrationView> => {
		throw new Error('airtable_connection_operations_unavailable');
	};
	return {
		async readAirtable() { return structuredClone(view); },
		connectAirtable: unavailable,
		async listAirtableBases() { throw new Error('airtable_connection_operations_unavailable'); },
		async activateAirtable() { return unavailable(); },
		async setAreaDirection() { return unavailable(); },
		syncNow: unavailable,
		async setPaused() { return unavailable(); },
		async revertHistory() { return unavailable(); },
		disconnect: unavailable
	};
}

const areaKeySchema = z.enum(['people', 'submissions', 'sessions', 'schedule', 'tasks']);
const directionSchema = z.enum(['not_connected', 'keep_airtable_updated', 'work_from_airtable']);
const airtableViewSchema: z.ZodType<AirtableIntegrationView> = z.object({
	state: z.enum(['not_connected', 'provisioning', 'current', 'pending', 'needs_review', 'delayed', 'catching_up', 'paused', 'needs_reconnect']),
	setupStage: z.enum(['choose_base', 'adding_tables']).optional(),
	baseName: z.string().optional(),
	baseUrl: z.url().optional(),
	accountLabel: z.string().optional(),
	lastOutbound: z.string().optional(),
	lastInbound: z.string().optional(),
	lastFullCheck: z.string().optional(),
	lastFullCheckSummary: z.string().optional(),
	supportCode: z.string().optional(),
	areas: z.array(z.object({
		key: areaKeySchema,
		label: z.string(),
		direction: directionSchema,
		sharedFields: z.number().int().nonnegative(),
		editableFields: z.number().int().nonnegative(),
		requestFields: z.number().int().nonnegative()
	})),
	attention: z.array(z.object({
		id: z.string(),
		kind: z.enum(['conflict', 'request', 'reconnect']),
		title: z.string(),
		href: z.string(),
		actionLabel: z.string()
	})),
	history: z.array(z.object({
		id: z.string(),
		kind: z.enum(['applied', 'refused', 'sharing', 'connection']),
		summary: z.string(),
		occurredAt: z.iso.datetime({ offset: true }),
		actorLabel: z.string().optional(),
		before: z.string().optional(),
		after: z.string().optional(),
		revertLabel: z.string().optional()
	}))
});

async function liveView(input: Readonly<{
	path: string;
	method: 'GET' | 'POST';
	body?: unknown;
}>): Promise<AirtableIntegrationView> {
	const result = await requestJson({
		path: input.path,
		method: input.method,
		...(input.body === undefined ? {} : { body: input.body }),
		schema: airtableViewSchema,
		timeoutMs: 25_000
	});
	if (result.kind === 'error') throw new Error(result.error.code);
	return result.data;
}

/** Same-origin live adapter; the server remains the sole OAuth and mutation authority. */
export function createLiveIntegrationsPagePort(input: Readonly<{
	navigate?: (url: string) => void;
}> = {}): IntegrationsPagePort {
	let latest: AirtableIntegrationView = disconnected();
	const read = async () => {
		try {
			latest = await liveView({ path: '/api/integrations/airtable', method: 'GET' });
		} catch (error) {
			if (error instanceof Error && error.message === 'http_404') latest = disconnected();
			else throw error;
		}
		return structuredClone(latest);
	};
	return Object.freeze({
		readAirtable: read,
		async connectAirtable() {
			const result = await requestJson({
				path: '/api/integrations/airtable/oauth/start',
				method: 'POST',
				schema: z.object({ authorizationUrl: z.url() }),
				timeoutMs: 15_000
			});
			if (result.kind === 'error') throw new Error(result.error.code);
			(input.navigate ?? ((url: string) => globalThis.location.assign(url)))(result.data.authorizationUrl);
			latest = { ...latest, state: 'provisioning' };
			return structuredClone(latest);
		},
		async listAirtableBases() {
			const result = await requestJson({
				path: '/api/integrations/airtable/bases', method: 'GET',
				schema: z.object({ bases: z.array(z.object({
					id: z.string(), name: z.string(),
					permissionLevel: z.enum(['none', 'read', 'comment', 'edit', 'create'])
				})) }), timeoutMs: 25_000
			});
			if (result.kind === 'error') throw new Error(result.error.code);
			return structuredClone(result.data.bases);
		},
		async activateAirtable(baseId, directions) {
			latest = await liveView({
				path: '/api/integrations/airtable/activate', method: 'POST',
				body: { baseId, directions }
			});
			return structuredClone(latest);
		},
		async setAreaDirection(key, direction) {
			latest = await liveView({
				path: '/api/integrations/airtable/sharing',
				method: 'POST',
				body: { areaKey: areaKeySchema.parse(key), direction: directionSchema.parse(direction) }
			});
			return structuredClone(latest);
		},
		async syncNow() {
			latest = await liveView({ path: '/api/integrations/airtable/sync', method: 'POST' });
			return structuredClone(latest);
		},
		async setPaused(paused) {
			latest = await liveView({ path: '/api/integrations/airtable/pause', method: 'POST', body: { paused } });
			return structuredClone(latest);
		},
		async revertHistory(id) {
			latest = await liveView({ path: '/api/integrations/airtable/history/revert', method: 'POST', body: { id } });
			return structuredClone(latest);
		},
		async disconnect() {
			latest = await liveView({ path: '/api/integrations/airtable/disconnect', method: 'POST' });
			return structuredClone(latest);
		}
	} satisfies IntegrationsPagePort);
}
import { z } from 'zod';
import { requestJson } from './client';
