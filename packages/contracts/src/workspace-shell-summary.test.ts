import { describe, expect, test } from 'bun:test';
import {
  WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS,
  workspaceShellSummaryProjectionSchema,
  workspaceShellSummaryReadInputSchema,
  workspaceShellSummaryReadResultSchema
} from './workspace-shell-summary';

const workspace = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'Summit Operations'
} as const;

describe('workspace shell summary contract', () => {
  test('accepts exactly the fast workspace and current-event identity projection', () => {
    expect(workspaceShellSummaryProjectionSchema.parse({
      schemaVersion: 1,
      workspace,
      event: {
        id: '550e8400-e29b-41d4-a716-446655440001',
        name: 'Joo Summit',
        timezone: 'Asia/Singapore',
        startDate: '2027-01-03',
        endDate: '2027-01-04'
      }
    })).toMatchObject({ workspace, event: { name: 'Joo Summit' } });
    expect(workspaceShellSummaryProjectionSchema.parse({
      schemaVersion: 1, workspace, event: null
    }).event).toBeNull();
  });

  test('rejects overview-shaped data and impossible event dates', () => {
    expect(workspaceShellSummaryProjectionSchema.safeParse({
      schemaVersion: 1, workspace, event: null, metrics: {}
    }).success).toBe(false);
    expect(workspaceShellSummaryProjectionSchema.safeParse({
      schemaVersion: 1,
      workspace,
      event: {
        id: '550e8400-e29b-41d4-a716-446655440001',
        name: 'Joo Summit',
        timezone: 'Asia/Singapore',
        startDate: '2027-01-04',
        endDate: '2027-01-03'
      }
    }).success).toBe(false);
  });

  test('freezes an empty caller input and exact operator result schema identity', () => {
    expect(workspaceShellSummaryReadInputSchema.safeParse({ workspaceId: workspace.id }).success)
      .toBe(false);
    expect(workspaceShellSummaryReadResultSchema.safeParse({
      kind: 'success',
      data: { schemaVersion: 1, workspace, event: null },
      correlationId: '550e8400-e29b-41d4-a716-446655440002'
    }).success).toBe(true);
    expect(WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS.read.inputSchema.key)
      .toBe('schema.workspace.shell.summary.read.input');
    expect(WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS.read.resultSchema.key)
      .toBe('schema.workspace.shell.summary.read.operator-result');
  });
});
