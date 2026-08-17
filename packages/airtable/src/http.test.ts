import { describe, expect, test } from 'bun:test';
import {
  createAirtableAuthorizationRequest,
  createAirtableHttpProvider,
  createAirtableOAuthClient,
  parseAirtableBaseId,
  parseAirtableBaseUrl,
  parseAirtableFieldId,
  parseAirtableRecordId,
  parseAirtableTableId,
  parseAirtableWorkspaceId,
  parseAirtableWorkspaceUrl,
  type AirtableFetch
} from './index';

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

describe('Airtable OAuth and HTTP adapter', () => {
  test('builds a PKCE authorization request and parses copied Airtable resource URLs', async () => {
    const request = await createAirtableAuthorizationRequest({
      clientId: 'client_123',
      redirectUri: 'https://events.example.test/api/integrations/airtable/callback',
      scopes: ['schema.bases:write', 'data.records:write']
    });
    const url = new URL(request.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://airtable.com/oauth2/v1/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(request.codeChallenge);
    expect(request.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(parseAirtableWorkspaceUrl(
      'https://airtable.com/workspaces/wsp00000000000001?utm_source=copy'
    )).toBe(parseAirtableWorkspaceId('wsp00000000000001'));
    expect(() => parseAirtableWorkspaceUrl('https://example.test/workspaces/wsp00000000000001'))
      .toThrow('AirtableWorkspaceUrl_invalid');
    expect(parseAirtableBaseUrl(
      'https://airtable.com/app00000000000001/tbl00000000000001/viw00000000000001?blocks=hide'
    )).toBe(parseAirtableBaseId('app00000000000001'));
    expect(() => parseAirtableBaseUrl('https://example.test/app00000000000001'))
      .toThrow('AirtableBaseUrl_invalid');
  });

  test('discovers unrelated provider field types and adds managed tables and fields', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const baseId = parseAirtableBaseId('app00000000000001');
    const table = {
      id: 'tbl00000000000001',
      name: 'Starter table',
      primaryFieldId: 'fld00000000000001',
      fields: [
        { id: 'fld00000000000001', name: 'Name', type: 'singleLineText' },
        { id: 'fld00000000000002', name: 'Attachment summary', type: 'aiText' }
      ],
      views: [{ id: 'viw00000000000001', name: 'Grid view', type: 'grid' }]
    };
    const responses = [json({ tables: [table] }), json({
      id: 'tbl00000000000002', name: 'Tasks', primaryFieldId: 'fld00000000000003',
      fields: [{ id: 'fld00000000000003', name: 'Task', type: 'singleLineText' }],
      views: [{ id: 'viw00000000000002', name: 'Grid view', type: 'grid' }]
    }), json({
      id: 'fld00000000000004', name: 'Status', type: 'singleLineText',
      description: 'Edits here update JooEvents.'
    })];
    const provider = createAirtableHttpProvider({
      clientId: 'client_123',
      accessTokenLease: { withAccessToken: async (use) => use('access-secret') },
      fetch: async (url, init) => {
        calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
        return responses.shift() ?? json({}, 500);
      }
    });
    const discovered = await provider.data.getBaseSchema({ baseId });
    expect(discovered).toMatchObject({ kind: 'success', value: {
      tables: [{ fields: [{ type: 'singleLineText' }, { type: 'aiText' }] }]
    } });
    expect(await provider.data.createTable({
      baseId,
      table: { name: 'Tasks', fields: [{ name: 'Task', type: 'singleLineText' }] }
    })).toMatchObject({ kind: 'success', value: { name: 'Tasks' } });
    expect(await provider.data.createField({
      baseId,
      tableId: parseAirtableTableId('tbl00000000000002'),
      field: {
        name: 'Status', type: 'singleLineText',
        description: 'Edits here update JooEvents.'
      }
    })).toMatchObject({ kind: 'success', value: { name: 'Status' } });
    expect(calls[1]).toMatchObject({
      url: 'https://api.airtable.com/v0/meta/bases/app00000000000001/tables',
      init: { method: 'POST' }
    });
    expect(calls[2]).toMatchObject({
      url: 'https://api.airtable.com/v0/meta/bases/app00000000000001/tables/tbl00000000000002/fields',
      init: { method: 'POST' }
    });
  });

  test('lists only the bases visible to the returned grant', async () => {
    const provider = createAirtableHttpProvider({
      clientId: 'client_123',
      accessTokenLease: { withAccessToken: async (use) => use('access-secret') },
      fetch: async () => json({
        bases: [{
          id: 'app00000000000001',
          name: 'JooEvents Sync Test',
          permissionLevel: 'create'
        }]
      })
    });
    expect(await provider.data.listBases()).toEqual({
      kind: 'success',
      value: {
        bases: [{
          id: parseAirtableBaseId('app00000000000001'),
          name: 'JooEvents Sync Test',
          permissionLevel: 'create'
        }]
      }
    });
  });

  test('exchanges OAuth code with form encoding and exact returned scopes', async () => {
    let captured: RequestInit | undefined;
    const oauth = createAirtableOAuthClient({
      clientId: 'client_123',
      now: () => Date.parse('2026-08-17T00:00:00.000Z'),
      fetch: async (_url, init) => {
        captured = init;
        return json({
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          expires_in: 3_600,
          refresh_expires_in: 5_184_000,
          scope: 'data.records:write schema.bases:write'
        });
      }
    });
    const result = await oauth.exchangeAuthorizationCode({
      code: 'one-time-code',
      redirectUri: 'https://events.example.test/api/integrations/airtable/callback',
      codeVerifier: 'v'.repeat(64),
      expectedScopes: ['schema.bases:write', 'data.records:write']
    });
    expect(result).toMatchObject({
      kind: 'success',
      value: {
        accessExpiresAt: '2026-08-17T01:00:00.000Z',
        refreshExpiresAt: '2026-10-16T00:00:00.000Z'
      }
    });
    expect(String(captured?.body)).toContain('grant_type=authorization_code');
    expect(String(captured?.body)).toContain('client_id=client_123');
  });

  test('normalizes identity, schema creation, and stable-ID upsert responses', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      json({ id: 'usr00000000000001', email: 'owner@example.test', scopes: ['user.email:read'] }),
      json({
        id: 'app00000000000001',
        tables: [{
          id: 'tbl00000000000001',
          name: 'Tasks',
          primaryFieldId: 'fld00000000000001',
          fields: [
            { id: 'fld00000000000001', name: 'Task', type: 'singleLineText' },
            { id: 'fld00000000000002', name: 'JooEvents ID', type: 'singleLineText' }
          ],
          views: [{ id: 'viw00000000000001', name: 'Grid view', type: 'grid' }]
        }]
      }),
      json({
        createdRecords: ['rec00000000000001'],
        updatedRecords: [],
        records: [{
          id: 'rec00000000000001',
          createdTime: '2026-08-17T00:00:00.000Z',
          fields: {
            fld00000000000001: 'Prepare doors',
            fld00000000000002: 'task-1'
          }
        }]
      }),
      json({
        id: 'rec00000000000001',
        createdTime: '2026-08-17T00:00:00.000Z',
        fields: {
          fld00000000000001: 'Prepare doors',
          fld00000000000002: 'task-1'
        }
      })
    ];
    const fetch: AirtableFetch = async (url, init) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      const response = responses.shift();
      if (!response) throw new Error('unexpected request');
      return response;
    };
    const provider = createAirtableHttpProvider({
      clientId: 'client_123',
      accessTokenLease: {
        withAccessToken: async (use) => use('access-secret')
      },
      fetch
    });
    const identity = await provider.data.getGrantIdentity();
    expect(identity).toMatchObject({ kind: 'success', value: { email: 'owner@example.test' } });
    const created = await provider.data.createBase({
      workspaceId: parseAirtableWorkspaceId('wsp00000000000001'),
      name: 'JooEvents · Riverside',
      tables: [{
        name: 'Tasks',
        fields: [
          { name: 'Task', type: 'singleLineText' },
          { name: 'JooEvents ID', type: 'singleLineText' }
        ]
      }]
    });
    expect(created.kind).toBe('success');
    if (created.kind !== 'success') return;
    const patched = await provider.data.patchRecords({
      baseId: created.value.id,
      tableId: parseAirtableTableId('tbl00000000000001'),
      mergeOnFieldId: parseAirtableFieldId('fld00000000000002'),
      records: [{ fields: {
        [parseAirtableFieldId('fld00000000000001')]: 'Prepare doors',
        [parseAirtableFieldId('fld00000000000002')]: 'task-1'
      } }]
    });
    expect(patched).toMatchObject({
      kind: 'success',
      value: { records: [{ kind: 'created', requestIndex: 0 }] }
    });
    expect(await provider.data.getRecord({
      baseId: created.value.id,
      tableId: parseAirtableTableId('tbl00000000000001'),
      recordId: parseAirtableRecordId('rec00000000000001')
    })).toMatchObject({
      kind: 'success',
      value: { id: 'rec00000000000001' }
    });
    expect(calls[1]?.url).toBe('https://api.airtable.com/v0/meta/bases');
    expect(calls[2]?.init?.method).toBe('PATCH');
    expect(String(calls[2]?.init?.body)).toContain('fieldsToMergeOn');
    expect(calls[3]?.url).toBe(
      'https://api.airtable.com/v0/app00000000000001/tbl00000000000001/rec00000000000001?returnFieldsByFieldId=true'
    );
  });

  test('uses the documented base-wide cooldown and treats ambiguous writes conservatively', async () => {
    const rateLimited = createAirtableHttpProvider({
      clientId: 'client_123',
      accessTokenLease: { withAccessToken: async (use) => use('access-secret') },
      fetch: async () => json({ error: { type: 'TOO_MANY_REQUESTS' } }, 429, { 'retry-after': '30' })
    });
    expect(await rateLimited.data.getGrantIdentity()).toMatchObject({
      kind: 'failure',
      failure: { code: 'rate_limited', retryAfterMs: 30_000 }
    });

    const ambiguous = createAirtableHttpProvider({
      clientId: 'client_123',
      accessTokenLease: { withAccessToken: async (use) => use('access-secret') },
      fetch: async () => new Response('upstream failed', { status: 503 })
    });
    expect(await ambiguous.data.createBase({
      workspaceId: parseAirtableWorkspaceId('wsp00000000000001'),
      name: 'JooEvents',
      tables: [{ name: 'Tasks', fields: [{ name: 'Task', type: 'singleLineText' }] }]
    })).toMatchObject({
      kind: 'failure',
      failure: { code: 'acceptance_unknown', retry: 'reconcile_first' }
    });
  });
});
