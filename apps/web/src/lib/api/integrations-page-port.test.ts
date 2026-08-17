import { describe, expect, test } from 'bun:test';
import {
	createDisconnectedIntegrationsPagePort,
	createSampleIntegrationsPagePort
} from './integrations-page-port';

describe('Airtable integrations page port', () => {
	test('keeps direction consequences, boundary history, and revert available together', async () => {
		const now = Date.parse('2026-08-17T12:00:00.000Z');
		const port = createSampleIntegrationsPagePort(true, () => now);
		const initial = await port.readAirtable();
		expect(initial.attention).toHaveLength(2);
		expect(initial.areas.find((area) => area.key === 'tasks')).toMatchObject({
			direction: 'work_from_airtable', editableFields: 1
		});
		expect(initial.history[0]).toMatchObject({
			before: 'Scaling Postgres',
			after: 'Scaling PostgreSQL',
			occurredAt: '2026-08-17T10:00:00.000Z'
		});
		expect(initial.history.map((item) => item.occurredAt)).toEqual([
			'2026-08-17T10:00:00.000Z',
			'2026-08-16T06:00:00.000Z',
			'2026-08-13T12:00:00.000Z'
		]);

		const narrowed = await port.setAreaDirection('tasks', 'keep_airtable_updated');
		expect(narrowed.state).toBe('pending');
		expect(narrowed.history[0]?.occurredAt).toBe('2026-08-17T12:00:00.000Z');
		expect(narrowed.areas.find((area) => area.key === 'tasks')?.direction)
			.toBe('keep_airtable_updated');

		const reverted = await port.revertHistory('history-1');
		expect(reverted.history.find((item) => item.id === 'history-1')?.revertLabel)
			.toBeUndefined();
	});

	test('does not pretend OAuth operations exist in an unconfigured live runtime', async () => {
		const port = createDisconnectedIntegrationsPagePort();
		expect((await port.readAirtable()).state).toBe('not_connected');
		await expect(port.connectAirtable()).rejects.toThrow('airtable_connection_operations_unavailable');
	});
});
