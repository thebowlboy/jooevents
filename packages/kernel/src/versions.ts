import type { Brand } from './brand';

export type AggregateVersion = Brand<number, 'AggregateVersion'>;
export type PolicyVersion = Brand<number, 'PolicyVersion'>;
export type ContractVersion = Brand<number, 'ContractVersion'>;

function positiveVersion<Name extends string>(value: unknown, name: Name): Brand<number, Name> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value as Brand<number, Name>;
}

export function parseAggregateVersion(value: unknown): AggregateVersion {
  return positiveVersion(value, 'AggregateVersion');
}

export function parsePolicyVersion(value: unknown): PolicyVersion {
  return positiveVersion(value, 'PolicyVersion');
}

export function parseContractVersion(value: unknown): ContractVersion {
  return positiveVersion(value, 'ContractVersion');
}

export interface VersionedRef<Id extends string> {
  readonly id: Id;
  readonly expectedVersion: AggregateVersion;
}
