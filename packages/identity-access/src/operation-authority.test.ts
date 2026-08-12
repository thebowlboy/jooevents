import { expect, test } from 'bun:test';
import { parseContractVersion } from '@jooevents/kernel';
import {
  OPERATION_ACCESS_LANE_KINDS,
  parseOperationAccessLane
} from './operation-authority';

test('access lanes form a closed kind-to-surface vocabulary', () => {
  const surfaces = {
    operator: 'operator_http',
    participant: 'participant_http',
    public_open: 'public_http',
    public_ceremony: 'public_http',
    external_mcp: 'external_mcp',
    app_model: 'app_model',
    registered_job: 'application_job',
    registered_consumer: 'application_job',
    registered_scheduler: 'application_job',
    verified_intake: 'provider_ingress',
    verified_inbox: 'provider_ingress'
  } as const;

  expect(OPERATION_ACCESS_LANE_KINDS.map((kind) => parseOperationAccessLane({
    kind,
    surface: surfaces[kind],
    policy: { key: `authority.${kind}`, version: parseContractVersion(1) }
  }).kind)).toEqual([...OPERATION_ACCESS_LANE_KINDS]);

  expect(() => parseOperationAccessLane({
    kind: 'registered_job',
    surface: 'operator_http',
    policy: { key: 'authority.job', version: 1 }
  })).toThrow('does not match its surface');
  expect(() => parseOperationAccessLane({
    kind: 'operator',
    surface: 'operator_http',
    policy: { key: 'authority.operator', version: 1 },
    permissionsFromCaller: ['admin']
  })).toThrow('unknown fields');
});
