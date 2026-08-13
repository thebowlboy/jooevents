import { describe, expect, test } from 'bun:test';
import {
	workspaceCapabilityIds,
	type WorkspaceCapabilityManifest,
	type WorkspaceCapabilityState,
	type WorkspaceComposition
} from './capabilities';
import { pureLiveUnavailableComposition } from './pure-live-unavailable';

describe('workspace capability composition contract', () => {
	test('keeps the aggregate catalog closed, unique, and dependency-shaped', () => {
		expect(workspaceCapabilityIds).toEqual([
			'workspace_shell',
			'event',
			'program_vocabulary',
			'schedule',
			'forms_submissions',
			'review_decisions',
			'speaker_operations',
			'templates_surfaces',
			'communications'
		]);
		expect(new Set(workspaceCapabilityIds).size).toBe(workspaceCapabilityIds.length);
		expect(Object.isFrozen(workspaceCapabilityIds)).toBe(true);
	});

	test('makes a real port mandatory only for the available branch', () => {
		const port = Object.freeze({ read: async () => 'current' as const });
		const available: WorkspaceCapabilityState<typeof port, 'live'> = {
			kind: 'available',
			source: 'live',
			port
		};
		const unavailable: WorkspaceCapabilityState<typeof port, 'live'> = {
			kind: 'unavailable',
			reason: 'not_enabled',
			remedy: 'return_to_overview'
		};
		const locked: WorkspaceCapabilityState<typeof port, 'live'> = {
			kind: 'prerequisite_locked',
			prerequisite: 'current_event',
			reason: 'current_event_required',
			remedy: 'create_event'
		};

		expect(available.port).toBe(port);
		expect('port' in unavailable).toBe(false);
		expect('port' in locked).toBe(false);

		// A pure-live composition cannot silently source an available aggregate
		// from sample data.
		const sampleInLive: WorkspaceCapabilityState<typeof port, 'live'> = {
			kind: 'available',
			// @ts-expect-error sample is not a valid source in the live branch
			source: 'sample',
			port
		};
		void sampleInLive;

		// Unavailable capabilities cannot hide a throwing or partial API.
		const unavailableWithPort: WorkspaceCapabilityState<typeof port, 'live'> = {
			kind: 'unavailable',
			reason: 'not_enabled',
			remedy: 'return_to_overview',
			// @ts-expect-error only the available branch owns a port
			port
		};
		void unavailableWithPort;
	});

	test('represents the initial pure-live runtime without any callable facade', () => {
		expect(pureLiveUnavailableComposition).toMatchObject({
			schemaVersion: 1,
			kind: 'live'
		});
		expect(Object.keys(pureLiveUnavailableComposition.capabilities).sort()).toEqual(
			[...workspaceCapabilityIds].sort()
		);
		for (const capability of workspaceCapabilityIds) {
			const state = pureLiveUnavailableComposition.capabilities[capability];
			expect(state).toEqual({
				kind: 'unavailable',
				reason: 'not_enabled',
				remedy: 'return_to_overview'
			});
			expect('port' in state).toBe(false);
			expect('api' in state).toBe(false);
		}
		expect(Object.isFrozen(pureLiveUnavailableComposition)).toBe(true);
		expect(Object.isFrozen(pureLiveUnavailableComposition.capabilities)).toBe(true);
	});
});

// Compile-time completeness canary: a manifest cannot omit an aggregate or
// add an undeclared one. This alias is intentionally never constructed at run
// time; the checker proves the mapped contract stays exact.
type ProofPorts = Readonly<{
	[Capability in (typeof workspaceCapabilityIds)[number]]: { readonly proof: Capability };
}>;
type ProofManifest = WorkspaceCapabilityManifest<ProofPorts, 'live'>;
type ProofComposition = WorkspaceComposition<ProofPorts, 'live'>;
void (null as unknown as ProofManifest);
void (null as unknown as ProofComposition);
