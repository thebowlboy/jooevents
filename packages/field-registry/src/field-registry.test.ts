import { describe, expect, test } from 'bun:test';
import {
  planChangesetOperation,
  type ChangesetPlanningSnapshot,
  type ChangesetReadPortKey
} from '@jooevents/changesets';
import type { FieldRegistryScopeDto } from '@jooevents/contracts';
import {
  FieldRegistryPlanningError,
  applyFieldRegistryMutationPlan,
  createCanonicalFieldRegistryBaseline,
  createFieldRegistryOrdinaryChangesetBundle,
  createFieldRegistryOrdinaryPolicy,
  fieldRegistryReadPort,
  planFieldRegistryMutation,
  projectFieldRegistrySnapshot,
  suggestFieldRegistryPlacement,
  validateFieldRegistryMutationPlan,
  type FieldRegistryAuthorInput,
  type FieldRegistryFormReferenceResolver,
  type FieldRegistryLiveOptionSource,
  type FieldRegistryState
} from '.';

const workspaceId = '018f7d5a-4b3c-7abc-8def-0123456789a1';
const eventId = '018f7d5a-4b3c-7abc-8def-0123456789a2';
const formId = '018f7d5a-4b3c-7abc-8def-0123456789a3';
const userId = '018f7d5a-4b3c-7abc-8def-0123456789a4';
const customFieldId = '018f7d5a-4b3c-7abc-8def-0123456789a5';
const scope: FieldRegistryScopeDto = { workspaceId, eventId };

let idCounter = 10;
function nextId(): string {
  idCounter += 1;
  return `018f7d5a-4b3c-7abc-8def-${idCounter.toString().padStart(12, '0')}`;
}

function baseline(): FieldRegistryState {
  idCounter = 10;
  return createCanonicalFieldRegistryBaseline({
    scope,
    ids: {
      newFieldId: () => nextId(),
      newChoiceId: () => nextId()
    }
  });
}

const forms: FieldRegistryFormReferenceResolver = Object.freeze({
  resolveFormReference(requestedScope: FieldRegistryScopeDto, requestedFormId: string) {
    return requestedScope.workspaceId === workspaceId
        && requestedScope.eventId === eventId
        && requestedFormId === formId
      ? { id: formId, version: 4 }
      : undefined;
  }
});

function authorAdd(state: FieldRegistryState): FieldRegistryAuthorInput {
  return {
    action: 'add',
    scope,
    request: {
      expectedRegistryVersion: state.version,
      field: {
        kind: 'textarea',
        label: 'Session takeaway',
        help: 'What should attendees leave with?',
        answerOwner: 'talk',
        scope: { kind: 'form', formId },
        contexts: {
          apply: { visible: true, required: false },
          onboard: { visible: false, required: false },
          profile: { visible: false, required: false }
        },
        options: { kind: 'none' }
      }
    },
    identities: {
      fieldId: customFieldId,
      fieldKey: 'custom.session_takeaway',
      choices: []
    }
  };
}

describe('Field Registry canonical model', () => {
  test('builds the shared baseline with its locked structural key and inert file field', () => {
    const state = baseline();
    expect(state.version).toBe(1);
    expect(state.fields).toHaveLength(19);
    expect(state.fields.map((field) => field.position)).toEqual(
      Array.from({ length: 19 }, (_, index) => index)
    );
    expect(state.fields.find((field) => field.key === 'person.email')).toMatchObject({
      constraints: { removal: 'forbidden', applyVisibility: 'required_visible' },
      contexts: { apply: { visible: true, required: true } }
    });
    expect(state.fields.find((field) => field.key === 'person.headshot')).toMatchObject({
      kind: 'file', fileUpload: 'disabled'
    });
  });

  test('places only once, pins form scope, then preserves user-owned ordering through all mutations', () => {
    let state = baseline();
    const add = planFieldRegistryMutation({ state, author: authorAdd(state), formReferences: forms });
    expect(add).toMatchObject({
      action: 'add',
      expectedRegistryVersion: 1,
      resultingRegistryVersion: 2,
      formPin: { id: formId, version: 4 },
      placement: { index: 15, group: 'talk', reasonKey: 'field_registry.placement.after_talk' }
    });
    expect(validateFieldRegistryMutationPlan({ state, plan: add, formReferences: forms })).toBeUndefined();
    state = applyFieldRegistryMutationPlan({ state, plan: add, formReferences: forms }).state;

    const custom = state.fields.find((field) => field.id === customFieldId);
    if (!custom) throw new TypeError('custom_field_missing');
    const edit = planFieldRegistryMutation({
      state,
      formReferences: forms,
      author: {
        action: 'edit', scope,
        request: {
          fieldId: custom.id,
          expectedFieldVersion: custom.version,
          expectedRegistryVersion: state.version,
          changes: { label: 'Session outcome' }
        },
        choiceIdentities: []
      }
    });
    state = applyFieldRegistryMutationPlan({ state, plan: edit, formReferences: forms }).state;
    expect(state.fields.find((field) => field.id === customFieldId)).toMatchObject({
      label: 'Session outcome', position: 15, version: 2
    });

    const move = planFieldRegistryMutation({
      state,
      formReferences: forms,
      author: {
        action: 'move', scope,
        request: {
          fieldId: customFieldId,
          expectedFieldVersion: 2,
          expectedRegistryVersion: state.version,
          toIndex: 0
        }
      }
    });
    state = applyFieldRegistryMutationPlan({ state, plan: move, formReferences: forms }).state;
    expect(state.fields[0]).toMatchObject({ id: customFieldId, group: 'talk', version: 2 });

    const remove = planFieldRegistryMutation({
      state,
      formReferences: forms,
      author: {
        action: 'remove', scope,
        request: {
          fieldId: customFieldId,
          expectedFieldVersion: 2,
          expectedRegistryVersion: state.version
        },
        removedAt: '2026-08-13T01:00:00.000Z',
        removedByUserId: userId
      }
    });
    state = applyFieldRegistryMutationPlan({ state, plan: remove, formReferences: forms }).state;
    expect(state.fields.some((field) => field.id === customFieldId)).toBe(false);
    expect(state.removed).toMatchObject([{
      lastPosition: 0,
      removedAt: '2026-08-13T01:00:00.000Z',
      removedByUserId: userId,
      field: { id: customFieldId, version: 2 }
    }]);

    const restore = planFieldRegistryMutation({
      state,
      formReferences: forms,
      author: {
        action: 'restore', scope,
        request: {
          fieldId: customFieldId,
          expectedFieldVersion: 2,
          expectedRegistryVersion: state.version,
          toIndex: 3
        }
      }
    });
    state = applyFieldRegistryMutationPlan({ state, plan: restore, formReferences: forms }).state;
    expect(state).toMatchObject({ version: 6, removed: [] });
    expect(state.fields[3]).toMatchObject({ id: customFieldId, position: 3, version: 3 });
  });

  test('refuses stale writes, absent form scope, and changes to the locked email invariant', () => {
    const state = baseline();
    expect(() => planFieldRegistryMutation({
      state,
      formReferences: forms,
      author: {
        ...authorAdd(state),
        request: { ...authorAdd(state).request, expectedRegistryVersion: 9 }
      } as FieldRegistryAuthorInput
    })).toThrow(new FieldRegistryPlanningError('stale_registry'));

    expect(() => planFieldRegistryMutation({
      state,
      formReferences: { resolveFormReference: () => undefined },
      author: authorAdd(state)
    })).toThrow(new FieldRegistryPlanningError('form_missing'));

    const email = state.fields.find((field) => field.key === 'person.email');
    if (!email) throw new TypeError('email_field_missing');
    expect(() => planFieldRegistryMutation({
      state,
      formReferences: forms,
      author: {
        action: 'remove', scope,
        request: {
          fieldId: email.id,
          expectedFieldVersion: email.version,
          expectedRegistryVersion: state.version
        },
        removedAt: '2026-08-13T01:00:00.000Z',
        removedByUserId: userId
      }
    })).toThrow(new FieldRegistryPlanningError('locked_field'));
  });

  test('resolves vocabulary references live while keeping retired values out of the browser DTO', () => {
    const state = baseline();
    const source: FieldRegistryLiveOptionSource = {
      readLiveOptions(_scope, optionSource) {
        return optionSource === 'tracks'
          ? [
              { id: '018f7d5a-4b3c-7abc-8def-0123456789b2', label: 'Retired', version: 2, status: 'retired' },
              { id: '018f7d5a-4b3c-7abc-8def-0123456789b1', label: 'Platform', version: 3, status: 'active' }
            ]
          : [{ id: '018f7d5a-4b3c-7abc-8def-0123456789b3', label: 'Talk', version: 1, status: 'active' }];
      }
    };
    const snapshot = projectFieldRegistrySnapshot({ state, optionSource: source });
    expect(snapshot.fields.find((field) => field.key === 'talk.track')?.resolvedOptions)
      .toEqual([{ id: '018f7d5a-4b3c-7abc-8def-0123456789b1', label: 'Platform', version: 3 }]);
    expect(snapshot.fields.find((field) => field.key === 'talk.format')?.resolvedOptions)
      .toEqual([{ id: '018f7d5a-4b3c-7abc-8def-0123456789b3', label: 'Talk', version: 1 }]);
  });

  test('preserves custom choice identity by label and rejects cross-registry id reuse', () => {
    let state = baseline();
    const firstChoiceId = '018f7d5a-4b3c-7abc-8def-0123456789c1';
    const secondChoiceId = '018f7d5a-4b3c-7abc-8def-0123456789c2';
    const thirdChoiceId = '018f7d5a-4b3c-7abc-8def-0123456789c3';
    const add = planFieldRegistryMutation({
      state,
      formReferences: forms,
      author: {
        action: 'add', scope,
        request: {
          expectedRegistryVersion: 1,
          field: {
            kind: 'select', label: 'Company size', answerOwner: 'person',
            scope: { kind: 'shared' },
            contexts: {
              apply: { visible: true, required: false },
              onboard: { visible: false, required: false },
              profile: { visible: true, required: false }
            },
            options: { kind: 'custom', labels: ['Small', 'Large'] }
          }
        },
        identities: {
          fieldId: customFieldId,
          fieldKey: 'custom.company_size',
          choices: [
            { id: firstChoiceId, key: 'custom.small' },
            { id: secondChoiceId, key: 'custom.large' }
          ]
        }
      }
    });
    state = applyFieldRegistryMutationPlan({ state, plan: add, formReferences: forms }).state;
    const field = state.fields.find((candidate) => candidate.id === customFieldId);
    if (!field || field.options.kind !== 'custom') throw new TypeError('choice_field_missing');
    const edit = planFieldRegistryMutation({
      state,
      formReferences: forms,
      author: {
        action: 'edit', scope,
        request: {
          fieldId: field.id,
          expectedFieldVersion: field.version,
          expectedRegistryVersion: state.version,
          changes: { customOptionLabels: ['Large', 'Medium'] }
        },
        choiceIdentities: [
          { id: secondChoiceId, key: 'custom.large' },
          { id: thirdChoiceId, key: 'custom.medium' }
        ]
      }
    });
    expect(edit.action === 'edit' && edit.after.options.kind === 'custom'
      ? edit.after.options.choices
      : []).toEqual([
      { id: secondChoiceId, key: 'custom.large', label: 'Large', position: 0 },
      { id: thirdChoiceId, key: 'custom.medium', label: 'Medium', position: 1 }
    ]);

    expect(() => planFieldRegistryMutation({
      state,
      formReferences: forms,
      author: {
        action: 'edit', scope,
        request: {
          fieldId: field.id,
          expectedFieldVersion: field.version,
          expectedRegistryVersion: state.version,
          changes: { customOptionLabels: ['Large', 'Medium'] }
        },
        choiceIdentities: [
          { id: secondChoiceId, key: 'custom.large' },
          { id: firstChoiceId, key: 'custom.reused_small' }
        ]
      }
    })).toThrow(new FieldRegistryPlanningError('invalid_options'));

    expect(() => planFieldRegistryMutation({
      state,
      formReferences: forms,
      author: {
        action: 'add', scope,
        request: {
          expectedRegistryVersion: state.version,
          field: {
            kind: 'text', label: 'Collision', answerOwner: 'person',
            scope: { kind: 'shared' },
            contexts: {
              apply: { visible: true, required: false },
              onboard: { visible: false, required: false },
              profile: { visible: false, required: false }
            },
            options: { kind: 'none' }
          }
        },
        identities: {
          fieldId: firstChoiceId,
          fieldKey: 'custom.collision',
          choices: []
        }
      }
    })).toThrow(new FieldRegistryPlanningError('field_exists'));
  });

  test('changeset planning emits only the compact safe diff and exact guards', async () => {
    const state = baseline();
    const policy = createFieldRegistryOrdinaryPolicy({
      key: 'field_registry.default', version: 1
    });
    const bundle = createFieldRegistryOrdinaryChangesetBundle({ policy });
    const store = {
      readFieldRegistry: () => state,
      resolveFormReference: forms.resolveFormReference.bind(forms)
    };
    const snapshot: ChangesetPlanningSnapshot = {
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== fieldRegistryReadPort) throw new TypeError('undeclared_test_port');
        return store as unknown as Port;
      }
    };
    const operation = await planChangesetOperation({
      registry: bundle.registry,
      kind: 'field_registry.mutate',
      version: 1,
      authorInput: authorAdd(state),
      dependencyGroup: 'field_registry',
      snapshot
    });
    expect(operation).toMatchObject({
      riskTier: 'low',
      aggregateRefs: [{ id: `field_registry:${eventId}`, version: 1 }, { id: `intake_form:${formId}`, version: 4 }],
      guardRefs: [{ id: `field_registry_guard:${eventId}`, version: 1 }],
      safeDiff: {
        action: 'add',
        registryVersionBefore: 1,
        registryVersionAfter: 2,
        before: null,
        placement: { index: 15, group: 'talk' }
      }
    });
    expect(JSON.stringify(operation.safeDiff)).not.toContain('removedByUserId');
  });

  test('placement advisor remains deterministic and does not rewrite existing positions', () => {
    const state = baseline();
    const first = suggestFieldRegistryPlacement({ kind: 'url', label: 'Portfolio' }, state.fields);
    const second = suggestFieldRegistryPlacement({ kind: 'url', label: 'Portfolio' }, state.fields);
    expect(first).toEqual(second);
    expect(state.fields.map((field) => field.position)).toEqual(
      Array.from({ length: state.fields.length }, (_, index) => index)
    );
  });
});
