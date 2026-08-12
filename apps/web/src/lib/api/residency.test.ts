import { describe, expect, test } from 'bun:test';
import { createListSource, type ListPorts, type Residency } from './residency';

interface Row {
	id: string;
	tray: string;
	title: string;
}

interface Query {
	tray: string;
	search?: string;
}

type Page = { rows: Row[]; scanned: number };

const ROWS: Row[] = [
	{ id: 'a', tray: 'inbox', title: 'Scaling Kubernetes' },
	{ id: 'b', tray: 'inbox', title: 'Durable queues' },
	{ id: 'c', tray: 'late', title: 'Kubernetes at the edge' }
];

function harness(
	overrides: Partial<ListPorts<Row, Query, Page>> = {},
	options: { residency?: Residency; allowResident?: boolean } = {}
) {
	const calls = { loadScope: 0, queryServer: 0, applyLocally: 0 };
	let residency: Residency = options.residency ?? 'resident';

	const select = (rows: readonly Row[], query: Query) => {
		const hit = rows.filter(
			(row) =>
				row.tray === query.tray &&
				(!query.search || row.title.toLowerCase().includes(query.search.toLowerCase()))
		);
		return { rows: hit, scanned: rows.filter((row) => row.tray === query.tray).length };
	};

	const ports: ListPorts<Row, Query, Page> = {
		scopeKey: (query) => query.tray,
		async loadScope(query) {
			calls.loadScope += 1;
			return {
				rows: ROWS.filter((row) => row.tray === query.tray),
				complete: true,
				version: 'v1'
			};
		},
		async queryServer(query) {
			calls.queryServer += 1;
			return select(ROWS, query);
		},
		applyLocally(rows, query) {
			calls.applyLocally += 1;
			return select(rows, query);
		},
		...overrides
	};

	const source = createListSource(ports, {
		residency: () => residency,
		allowResident: options.allowResident
	});
	return { source, calls, setResidency: (next: Residency) => (residency = next) };
}

describe('paged mode', () => {
	test('asks the server every time and never loads a scope', async () => {
		const { source, calls } = harness({}, { residency: 'paged' });
		await source.list({ tray: 'inbox' });
		await source.list({ tray: 'inbox', search: 'kube' });
		expect(calls.queryServer).toBe(2);
		expect(calls.loadScope).toBe(0);
		expect(source.lastMode()).toBe('paged');
	});
});

describe('resident mode', () => {
	test('loads the scope once, then answers locally', async () => {
		const { source, calls } = harness();
		await source.list({ tray: 'inbox' });
		await source.list({ tray: 'inbox', search: 'kube' });
		await source.list({ tray: 'inbox', search: 'queue' });
		expect(calls.loadScope).toBe(1);
		expect(calls.queryServer).toBe(0);
		expect(calls.applyLocally).toBe(3);
		expect(source.lastMode()).toBe('resident');
	});

	test('answers identically to the server', async () => {
		const resident = harness();
		const paged = harness({}, { residency: 'paged' });
		for (const query of [{ tray: 'inbox' }, { tray: 'inbox', search: 'kube' }, { tray: 'late' }]) {
			expect(await resident.source.list(query)).toEqual(await paged.source.list(query));
		}
	});

	// The hazard the scope key exists to avoid: a snapshot of one population
	// must never be filtered as though it were another.
	test('reloads when the scope changes, and does not filter the stale one', async () => {
		const { source, calls } = harness();
		const inbox = await source.list({ tray: 'inbox' });
		expect(inbox.rows.map((r) => r.id)).toEqual(['a', 'b']);
		const late = await source.list({ tray: 'late' });
		expect(late.rows.map((r) => r.id)).toEqual(['c']);
		expect(calls.loadScope).toBe(2);
	});

	test('a burst of queries causes one load, not one per query', async () => {
		const { source, calls } = harness();
		await Promise.all([
			source.list({ tray: 'inbox' }),
			source.list({ tray: 'inbox', search: 'k' }),
			source.list({ tray: 'inbox', search: 'ku' })
		]);
		expect(calls.loadScope).toBe(1);
	});

	test('invalidate forces the next read to reload', async () => {
		const { source, calls } = harness();
		await source.list({ tray: 'inbox' });
		source.invalidate();
		await source.list({ tray: 'inbox' });
		expect(calls.loadScope).toBe(2);
	});
});

describe('the ceiling', () => {
	// A partial load filtered as if it were the scope would report "3 matches"
	// out of a fraction of the population — the same untruth as an empty state
	// claiming absence over rows it never saw.
	test('an incomplete load is discarded, not filtered', async () => {
		const { source, calls } = harness({
			async loadScope() {
				calls.loadScope += 1;
				return { rows: ROWS.slice(0, 1), complete: false, version: 'v1' };
			}
		});
		const page = await source.list({ tray: 'inbox' });
		expect(page.rows.map((r) => r.id)).toEqual(['a', 'b']);
		expect(source.lastMode()).toBe('paged');
		expect(source.declinedReason()).toMatch(/larger than a resident copy/);
	});

	test('a scope proven too large is not retried on every read', async () => {
		const { source, calls } = harness({
			async loadScope() {
				calls.loadScope += 1;
				return { rows: [], complete: false, version: 'v1' };
			}
		});
		await source.list({ tray: 'inbox' });
		await source.list({ tray: 'inbox', search: 'kube' });
		await source.list({ tray: 'inbox', search: 'queue' });
		expect(calls.loadScope).toBe(1);
		expect(calls.queryServer).toBe(3);
	});
});

describe('the authority refusal', () => {
	// Not a preference weighed against the residency setting: a surface whose
	// rows are filtered by authority never holds them, whatever the config says.
	test('allowResident false outranks a resident setting', async () => {
		const { source, calls } = harness({}, { residency: 'resident', allowResident: false });
		await source.list({ tray: 'inbox' });
		await source.list({ tray: 'inbox', search: 'kube' });
		expect(calls.loadScope).toBe(0);
		expect(calls.queryServer).toBe(2);
		expect(source.lastMode()).toBe('paged');
		expect(source.declinedReason()).toMatch(/filters by authority/);
	});
});

describe('switching', () => {
	test('the mode is read per call, so it can change mid-session', async () => {
		const { source, calls, setResidency } = harness();
		await source.list({ tray: 'inbox' });
		expect(source.lastMode()).toBe('resident');

		setResidency('paged');
		await source.list({ tray: 'inbox' });
		expect(source.lastMode()).toBe('paged');
		expect(calls.queryServer).toBe(1);

		setResidency('resident');
		await source.list({ tray: 'inbox' });
		expect(source.lastMode()).toBe('resident');
		// The snapshot survived the excursion; switching back costs nothing.
		expect(calls.loadScope).toBe(1);
	});
});
