import { describe, expect, test } from 'bun:test';
import { sampleWorkspaceGateway } from './sample/gateway';
import { createSampleCommunicationsPagePort } from './communications-page-port.sample';

describe('sample tuned Communications page port', () => {
	test('keeps message history, readiness, templates, theme, and event summary behind one boundary', async () => {
		const port = createSampleCommunicationsPagePort(sampleWorkspaceGateway.api);
		const [messages, readiness, templates, theme, summary] = await Promise.all([
			port.communications.list(),
			port.communications.readiness(),
			port.templates.list(),
			port.theme.get(),
			port.workspace.summary()
		]);

		expect(messages.length).toBeGreaterThan(0);
		expect(readiness.provider.length).toBeGreaterThan(0);
		expect(templates.messages.length).toBeGreaterThan(0);
		expect(theme).toHaveProperty('markText');
		expect(summary.event).not.toBeNull();
	});
});
