import { expect } from 'bun:test';
import {
  INTAKE_PUBLIC_CONTINUATION_HEADER,
  INTAKE_PUBLIC_CONTINUATION_MINT_PATH,
  INTAKE_PUBLIC_FORM_SELECTOR_HEADER
} from '@jooevents/persistence/intake-public-ceremony';
import { runJ2Spine } from './j2-spine.flow';
import { type FlowWorld } from './flow-world';
import { J10_PUBLIC_EFFECT_BINDING } from './j10b-public-caller-wall.pending';

type PublicDraft = {
  readonly draftVersion: number;
  readonly status: string;
};

type PublicResult =
  | { readonly kind: 'success'; readonly data: { readonly action: 'begin'; readonly draft: PublicDraft } }
  | { readonly kind: 'outcome'; readonly outcome: { readonly class: string; readonly kind: string; readonly retryable: boolean } };

type Triage = { readonly rows: readonly unknown[] };

function key(): string {
  return `j10-public-${crypto.randomUUID()}`;
}

async function mintContinuation(world: FlowWorld, formId: string): Promise<string> {
  const response = await world.runtime.app.request(INTAKE_PUBLIC_CONTINUATION_MINT_PATH, {
    method: 'POST',
    headers: {
      [INTAKE_PUBLIC_FORM_SELECTOR_HEADER]: formId,
      'content-type': 'application/json',
      'x-correlation-id': crypto.randomUUID()
    },
    body: JSON.stringify({ schemaVersion: 1, bootstrap: `${crypto.randomUUID()}${crypto.randomUUID()}` })
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { readonly continuation?: unknown };
  if (typeof body.continuation !== 'string') throw new Error('J10b continuation mint omitted its continuation');
  return body.continuation;
}

async function mutateBegin(world: FlowWorld, formId: string, continuation: string): Promise<PublicResult> {
  const response = await world.runtime.app.request(J10_PUBLIC_EFFECT_BINDING.path, {
    method: J10_PUBLIC_EFFECT_BINDING.method,
    headers: {
      [INTAKE_PUBLIC_FORM_SELECTOR_HEADER]: formId,
      [INTAKE_PUBLIC_CONTINUATION_HEADER]: continuation,
      'content-type': 'application/json',
      'idempotency-key': key(),
      'x-correlation-id': crypto.randomUUID()
    },
    body: JSON.stringify({ action: 'begin', input: { formId } })
  });
  expect(response.status).toBe(200);
  return await response.json() as PublicResult;
}

async function resume(world: FlowWorld, formId: string, continuation: string): Promise<PublicDraft> {
  const response = await world.runtime.app.request('/api/public/forms/application', {
    headers: {
      [INTAKE_PUBLIC_FORM_SELECTOR_HEADER]: formId,
      [INTAKE_PUBLIC_CONTINUATION_HEADER]: continuation,
      'x-correlation-id': crypto.randomUUID()
    }
  });
  expect(response.status).toBe(200);
  const body = await response.json() as {
    readonly kind?: unknown;
    readonly data?: { readonly draft?: PublicDraft };
  };
  if (body.kind !== 'success' || !body.data?.draft) throw new Error('J10b public draft resume refused');
  return body.data.draft;
}

/** J10b — public writes are confined to the one registry-owned ceremony binding. */
export async function runJ10bPublicCallerWall(world: FlowWorld): Promise<void> {
  const organizer = world.as('organizer');
  const spine = await runJ2Spine(world);

  // Exact equality makes the absence claim structural: no other committed
  // operation is public_http-bound in the composed production registry.
  expect(world.support().publicEffectBindings()).toEqual([J10_PUBLIC_EFFECT_BINDING]);

  const continuation = await mintContinuation(world, spine.formId);
  const begun = await mutateBegin(world, spine.formId, continuation);
  expect(begun.kind).toBe('success');
  if (begun.kind !== 'success') throw new Error('J10b first public begin was refused');
  expect(begun.data.action).toBe('begin');
  const draftAfterBegin = await resume(world, spine.formId, continuation);
  expect(draftAfterBegin).toMatchObject({
    draftVersion: 1,
    status: 'in_progress'
  });
  let submissionsBeforeSecondBegin!: Triage;
  await organizer.expectRead('submission.triage.list', (projection) => {
    submissionsBeforeSecondBegin = projection as Triage;
    return true;
  });
  const historyBeforeSecondBegin = await world.historyIds(organizer.actor);

  const secondBegin = await mutateBegin(world, spine.formId, continuation);
  expect(secondBegin.kind).toBe('outcome');
  if (secondBegin.kind !== 'outcome') throw new Error('J10b second public begin unexpectedly succeeded');
  expect(secondBegin.outcome).toMatchObject({
    class: 'conflict', kind: 'intake.changed', retryable: false
  });

  // Both projections are real registered reads: the draft remains exactly at
  // its first begin revision and no public submission or operator log exists.
  expect(await resume(world, spine.formId, continuation)).toEqual(draftAfterBegin);
  await organizer.expectRead('submission.triage.list', (projection) =>
    (projection as Triage).rows.length === submissionsBeforeSecondBegin.rows.length
  );
  expect(await world.historyIds(organizer.actor)).toEqual(historyBeforeSecondBegin);
  world.record('application.public.mutate@1 → refused intake.changed without a second write');
}
