import type { MutationOutcome, WorkspaceSummary } from './types';
import {
	overviewAvailable,
	type OverviewCreateEventInput,
	type OverviewPagePort,
	type OverviewPageSummary
} from './overview-page-port';

export interface SampleOverviewPageApi {
	readonly workspace: {
		summary(): Promise<WorkspaceSummary>;
		summarySnapshot(): WorkspaceSummary | null;
		createEvent(input: Omit<OverviewCreateEventInput, 'idempotencyKey'>): Promise<MutationOutcome>;
	};
}

function mapSampleSummary(summary: WorkspaceSummary): OverviewPageSummary {
	return {
		...summary,
		pipeline: summary.pipeline.map((stage) => ({
			...stage,
			availability: overviewAvailable
		})),
		sections: {
			attention: overviewAvailable,
			pipeline: overviewAvailable,
			deadlines: overviewAvailable,
			activity: overviewAvailable,
			trays: overviewAvailable
		}
	};
}

/** Keeps the resettable sample story byte-for-byte at the presentation boundary. */
export function createSampleOverviewPagePort(input: {
	readonly api: SampleOverviewPageApi;
	readonly scenario: Extract<OverviewPagePort['source'], { readonly kind: 'sample' }>['scenario'];
}): OverviewPagePort {
	const port: OverviewPagePort = {
		source: Object.freeze({
			kind: 'sample' as const,
			scenario: Object.freeze({ ...input.scenario })
		}),
		snapshot() {
			const summary = input.api.workspace.summarySnapshot();
			return summary ? mapSampleSummary(summary) : null;
		},
		async read() {
			return { kind: 'success' as const, data: mapSampleSummary(await input.api.workspace.summary()) };
		},
		createEvent({ idempotencyKey: _idempotencyKey, ...event }) {
			return input.api.workspace.createEvent(event);
		}
	};
	return Object.freeze(port);
}
