import { describe, expect, test } from 'bun:test';
import { createLiveTemplatesPagePort } from './templates-page-port.live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

function artifacts() {
	return [{
		head: {
			artifactId: id(1), artifactKind: 'theme', currentRevisionNumber: 1
		},
		current: {
			document: {
				kind: 'theme',
				markText: 'JE',
				recipe: {
					name: 'Studio', canvas: '#fff', surface: '#fff', text: '#111',
					action: '#00f', radius: 8, controlHeight: 36
				}
			}
		},
		history: [{ number: 1, createdAt: 'Just now', author: 'organizer', note: 'Seed' }]
	}];
}

function port(list: () => Promise<unknown>) {
	return createLiveTemplatesPagePort({
		artifacts: {
			async list() {
				return { kind: 'success', data: await list() };
			}
		},
		model: {
			async choices() { return []; },
			async classify() { throw new Error('unused'); },
			async revise() { throw new Error('unused'); }
		},
		event: { async get() { return null; } },
		schedule: { async state() { return { days: [], rooms: [], dayStart: '09:00', slotMinutes: 30, slotsPerDay: 0, sessions: [], placements: [], breaks: [], published: false }; } },
		vocabulary: { async tracks() { return []; }, async speakerCategories() { return []; } },
		speakers: { async list() { return []; } },
		forms: { async list() { return []; } },
		fields: {
			async list() { return []; },
			async update() { return { ok: true }; },
			async remove() { return { ok: true }; }
		}
	} as never);
}

describe('live Templates page port', () => {
	test('library and brand share one in-flight artifact catalogue and re-read after it settles', async () => {
		let lists = 0;
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const page = port(async () => {
			lists += 1;
			started.resolve();
			await gate.promise;
			return artifacts();
		});
		const library = page.templates.list();
		await started.promise;
		const brand = page.theme.get();
		expect(lists).toBe(1);
		gate.resolve();
		expect((await library).messages).toEqual([]);
		expect((await brand).name).toBe('Studio');
		await page.templates.list();
		expect(lists).toBe(2);
	});
});
