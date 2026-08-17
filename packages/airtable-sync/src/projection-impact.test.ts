import { describe, expect, test } from 'bun:test';
import { createProjectionImpactCatalog } from './projection-impact';

describe('projection impact catalog', () => {
  test('resolves stable affected subjects without provider data', () => {
    const catalog = createProjectionImpactCatalog([{
      operationName: 'task.set_status',
      operationVersion: 1,
      resolve: ({ canonicalResult }) => {
        const result = canonicalResult as { taskId: string; version: number };
        return [{
          areaKey: 'tasks',
          subjectKind: 'task',
          subjectId: result.taskId,
          projectionVersion: result.version
        }];
      }
    }]);
    expect(catalog.resolve({
      operationName: 'task.set_status',
      operationVersion: 1,
      businessInput: { ignored: true },
      canonicalResult: { taskId: 'task-1', version: 4 }
    })).toEqual([{
      areaKey: 'tasks',
      subjectKind: 'task',
      subjectId: 'task-1',
      projectionVersion: 4
    }]);
    expect(catalog.resolve({
      operationName: 'event.rename',
      operationVersion: 1,
      businessInput: {},
      canonicalResult: {}
    })).toEqual([]);
  });

  test('refuses ambiguous duplicate registration and duplicate subject output', () => {
    const descriptor = {
      operationName: 'task.set_status',
      operationVersion: 1,
      resolve: () => [{
        areaKey: 'tasks' as const,
        subjectKind: 'task',
        subjectId: 'task-1',
        projectionVersion: 1
      }]
    };
    expect(() => createProjectionImpactCatalog([descriptor, descriptor])).toThrow(
      'projection_impact_descriptor_duplicate'
    );
    const duplicateOutput = createProjectionImpactCatalog([{
      ...descriptor,
      resolve: () => [descriptor.resolve()[0]!, descriptor.resolve()[0]!]
    }]);
    expect(() => duplicateOutput.resolve({
      operationName: descriptor.operationName,
      operationVersion: 1,
      businessInput: {},
      canonicalResult: {}
    })).toThrow('projection_impact_duplicate');
  });
});
