import { describe, expect, test } from 'bun:test';
import type { EffectAuthorityRecheckSource } from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';
import { Database } from 'bun:sqlite';
import { installFoundationTrialUnitOfWorkSchema } from './foundation-trial-uow';
import {
  SQLiteEffectUnitOfWorkPort,
  createSQLiteEffectDomainAdapterRegistry,
  type SQLiteEffectDomainAdapter
} from './sqlite-effect-unit-of-work';

const authorityRecheck: EffectAuthorityRecheckSource = Object.freeze({
  resolveAuthority: () => {
    throw new Error('unexpected_authority_recheck');
  },
  now: () => {
    throw new Error('unexpected_authority_recheck_clock');
  }
});

const capabilityA: VersionedDefinitionRef = Object.freeze({
  key: 'capability.domain-a-write',
  version: 1
});
const capabilityB: VersionedDefinitionRef = Object.freeze({
  key: 'capability.domain-b-write',
  version: 2
});

function openHarness() {
  const sqlite = new Database(':memory:', { strict: true });
  installFoundationTrialUnitOfWorkSchema(sqlite);
  sqlite.exec(`
    CREATE TABLE effect_domain_a (value TEXT NOT NULL);
    CREATE TABLE effect_domain_b (value TEXT NOT NULL);
  `);
  const commits: string[] = [];
  const finishes: string[] = [];
  const adapter = (table: 'effect_domain_a' | 'effect_domain_b', label: string): SQLiteEffectDomainAdapter => ({
    openHandlerSnapshot: (capability) => Object.freeze({
      capability: `${capability.key}@${capability.version}`
    }),
    applyDomainContribution(contribution) {
      if (typeof contribution !== 'string') throw new TypeError('invalid_test_contribution');
      sqlite.query<never, [string]>(`INSERT INTO ${table} (value) VALUES (?)`).run(contribution);
    },
    afterUnitOfWorkCommitted() {
      commits.push(label);
    },
    afterUnitOfWorkFinished(outcome) {
      finishes.push(`${label}:${outcome.committed}`);
    }
  });
  const adapterA = adapter('effect_domain_a', 'a');
  const adapterB = adapter('effect_domain_b', 'b');
  const sourceCapabilityA = { ...capabilityA };
  const registry = createSQLiteEffectDomainAdapterRegistry([
    { capability: capabilityB, adapter: adapterB },
    { capability: sourceCapabilityA, adapter: adapterA }
  ]);
  const port = new SQLiteEffectUnitOfWorkPort(sqlite, registry, authorityRecheck);
  return { sqlite, adapterA, adapterB, sourceCapabilityA, registry, port, commits, finishes };
}

function values(sqlite: Database, table: 'effect_domain_a' | 'effect_domain_b'): readonly string[] {
  return sqlite.query<{ readonly value: string }, []>(`SELECT value FROM ${table} ORDER BY rowid`)
    .all()
    .map((row) => row.value);
}

describe('capability-routed SQLite effect unit of work', () => {
  test('closes an immutable exact-capability registry and routes each transaction to one adapter', async () => {
    const test = openHarness();
    try {
      expect(Object.isFrozen(test.registry)).toBe(true);
      expect(Object.isFrozen(test.registry.capabilities)).toBe(true);
      expect(test.registry.capabilities).toEqual([capabilityA, capabilityB]);
      expect(test.registry.capabilities.every(Object.isFrozen)).toBe(true);

      test.adapterA.applyDomainContribution = () => {
        throw new Error('mutated_adapter_method');
      };
      test.sourceCapabilityA.key = 'capability.mutated';

      await test.port.runInUnitOfWork(async (unitOfWork) => {
        await unitOfWork.applyDomainContribution(
          { key: 'capability.domain-a-write', version: 1 },
          'a-1'
        );
      });
      await test.port.runInUnitOfWork(async (unitOfWork) => {
        await unitOfWork.applyDomainContribution(capabilityB, 'b-1');
      });

      expect(values(test.sqlite, 'effect_domain_a')).toEqual(['a-1']);
      expect(values(test.sqlite, 'effect_domain_b')).toEqual(['b-1']);
      expect(test.commits).toEqual(['a', 'b']);
      expect(test.finishes).toEqual(['a:true', 'b:true']);
    } finally {
      test.sqlite.close();
    }
  });

  test('rejects duplicate, unregistered, and capability-substituted writes without partial state', async () => {
    const duplicateAdapter: SQLiteEffectDomainAdapter = {
      openHandlerSnapshot: () => Object.freeze({}),
      applyDomainContribution: () => undefined
    };
    expect(() => createSQLiteEffectDomainAdapterRegistry([
      { capability: capabilityB, adapter: duplicateAdapter },
      { capability: { ...capabilityB }, adapter: duplicateAdapter }
    ])).toThrow('sqlite_effect_domain_capability_duplicate');

    const test = openHarness();
    try {
      await expect(test.port.runInUnitOfWork(async (unitOfWork) => {
        await unitOfWork.applyDomainContribution(
          { key: 'capability.not-registered', version: 1 },
          'unknown'
        );
      })).rejects.toThrow('sqlite_effect_domain_capability_unregistered');

      await expect(test.port.runInUnitOfWork(async (unitOfWork) => {
        await unitOfWork.applyDomainContribution(
          { key: 'capability.domain-a-write', version: 1 },
          'must-roll-back'
        );
        await unitOfWork.applyDomainContribution(capabilityB, 'substituted');
      })).rejects.toThrow('sqlite_effect_domain_capability_changed_in_unit_of_work');

      expect(values(test.sqlite, 'effect_domain_a')).toEqual([]);
      expect(values(test.sqlite, 'effect_domain_b')).toEqual([]);
      expect(test.commits).toEqual([]);
      expect(test.finishes).toEqual(['a:false']);
    } finally {
      test.sqlite.close();
    }
  });

  test('rejects a registry-shaped object that was not created by the registry factory', () => {
    const sqlite = new Database(':memory:', { strict: true });
    installFoundationTrialUnitOfWorkSchema(sqlite);
    try {
      const forged = Object.freeze({ capabilities: Object.freeze([] as VersionedDefinitionRef[]) });
      expect(() => new SQLiteEffectUnitOfWorkPort(sqlite, forged, authorityRecheck))
        .toThrow('sqlite_effect_domain_adapter_registry_unsealed');
    } finally {
      sqlite.close();
    }
  });
});
