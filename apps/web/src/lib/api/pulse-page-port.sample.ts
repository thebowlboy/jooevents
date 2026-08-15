import type { WorkspaceSummary } from './types';
import type { PulsePagePort, PulsePageSummary } from './pulse-page-port';
import { samplePulseSummary } from './sample/pulse';

export interface SamplePulsePageApi {
	readonly workspace: {
		summary(): Promise<WorkspaceSummary>;
		summarySnapshot(): WorkspaceSummary | null;
	};
}

/**
 * Serves the authored per-scenario Pulse story over the active workspace
 * summary. Event identity always comes from the summary, so the page and the
 * shell can never disagree about whether an event exists.
 */
export function createSamplePulsePagePort(input: {
	readonly api: SamplePulsePageApi;
	readonly scenario: Extract<PulsePagePort['source'], { readonly kind: 'sample' }>['scenario'];
}): PulsePagePort {
	const build = (summary: WorkspaceSummary): PulsePageSummary =>
		samplePulseSummary({ scenarioKey: input.scenario.key, summary, now: Date.now() });
	const port: PulsePagePort = {
		source: Object.freeze({
			kind: 'sample' as const,
			scenario: Object.freeze({ ...input.scenario })
		}),
		snapshot() {
			const summary = input.api.workspace.summarySnapshot();
			return summary ? build(summary) : null;
		},
		async read() {
			return { kind: 'success' as const, data: build(await input.api.workspace.summary()) };
		}
	};
	return Object.freeze(port);
}
