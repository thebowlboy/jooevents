import { canonicalJsonSha256 } from '@jooevents/kernel';
import type { SyncAreaKey } from './mapping';

export interface ProjectionImpact {
  readonly areaKey: SyncAreaKey;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly projectionVersion: number;
}

export interface ProjectionImpactDescriptor<Input = unknown, Result = unknown> {
  readonly operationName: string;
  readonly operationVersion: number;
  resolve(input: {
    readonly businessInput: Input;
    readonly canonicalResult: Result;
  }): readonly ProjectionImpact[];
}

export interface ProjectionImpactCatalog {
  readonly digestSha256: string;
  resolve(input: {
    readonly operationName: string;
    readonly operationVersion: number;
    readonly businessInput: unknown;
    readonly canonicalResult: unknown;
  }): readonly ProjectionImpact[];
}

function descriptorKey(name: string, version: number): string {
  return `${name}@${version}`;
}

function parseImpact(value: ProjectionImpact): ProjectionImpact {
  if (
    typeof value.subjectKind !== 'string' || value.subjectKind.length < 1
    || typeof value.subjectId !== 'string' || value.subjectId.length < 1
    || !Number.isInteger(value.projectionVersion) || value.projectionVersion < 1
  ) {
    throw new TypeError('projection_impact_invalid');
  }
  return Object.freeze({ ...value });
}

export function createProjectionImpactCatalog(
  descriptors: readonly ProjectionImpactDescriptor[]
): ProjectionImpactCatalog {
  const registrations = new Map<string, ProjectionImpactDescriptor>();
  for (const descriptor of descriptors) {
    if (
      typeof descriptor.operationName !== 'string' || descriptor.operationName.length < 1
      || !Number.isInteger(descriptor.operationVersion) || descriptor.operationVersion < 1
      || typeof descriptor.resolve !== 'function'
    ) {
      throw new TypeError('projection_impact_descriptor_invalid');
    }
    const key = descriptorKey(descriptor.operationName, descriptor.operationVersion);
    if (registrations.has(key)) throw new TypeError(`projection_impact_descriptor_duplicate:${key}`);
    registrations.set(key, Object.freeze({
      operationName: descriptor.operationName,
      operationVersion: descriptor.operationVersion,
      resolve: descriptor.resolve.bind(descriptor)
    }));
  }
  const manifest = [...registrations.values()]
    .map(({ operationName, operationVersion }) => ({ operationName, operationVersion }))
    .sort((left, right) =>
      left.operationName.localeCompare(right.operationName)
      || left.operationVersion - right.operationVersion
    );
  return Object.freeze({
    digestSha256: canonicalJsonSha256(manifest),
    resolve(input: {
      readonly operationName: string;
      readonly operationVersion: number;
      readonly businessInput: unknown;
      readonly canonicalResult: unknown;
    }) {
      const descriptor = registrations.get(descriptorKey(input.operationName, input.operationVersion));
      if (!descriptor) return Object.freeze([]);
      const impacts = descriptor.resolve({
        businessInput: input.businessInput,
        canonicalResult: input.canonicalResult
      }).map(parseImpact);
      const unique = new Set<string>();
      for (const impact of impacts) {
        const key = `${impact.areaKey}\u0000${impact.subjectKind}\u0000${impact.subjectId}`;
        if (unique.has(key)) throw new TypeError('projection_impact_duplicate');
        unique.add(key);
      }
      return Object.freeze(impacts.sort((left, right) =>
        left.areaKey.localeCompare(right.areaKey)
        || left.subjectKind.localeCompare(right.subjectKind)
        || left.subjectId.localeCompare(right.subjectId)
      ));
    }
  });
}
