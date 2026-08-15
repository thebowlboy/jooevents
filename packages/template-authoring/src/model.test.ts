import { describe, expect, test } from 'bun:test';
import type {
  TemplateArtifactDocumentDto,
  TemplateArtifactMutationPlanDto,
  TemplateArtifactScopeDto,
  TemplateArtifactSnapshotDto
} from '@jooevents/contracts';
import {
  TemplateArtifactPlanningError,
  applyTemplateArtifactMutation,
  createInitialTemplateArtifact,
  parseTemplateArtifactSnapshot,
  planTemplateArtifactMutation,
  type TemplateArtifactTransactionPort
} from './model';

const scope: TemplateArtifactScopeDto = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  eventId: '00000000-0000-4000-8000-000000000002'
};
const actor = '00000000-0000-4000-8000-000000000003';
const artifactId = '00000000-0000-4000-8000-000000000004';
const firstRevisionId = '00000000-0000-4000-8000-000000000005';

function message(subject = 'Welcome'): TemplateArtifactDocumentDto {
  return {
    kind: 'message', key: 'welcome-message', name: 'Welcome', purpose: 'Welcomes a participant.',
    subject, blocks: [{ type: 'paragraph', text: 'Hello {{person.name}}' }],
    mergeFields: [{ key: 'person.name', label: 'Name', sample: 'Ada' }], usedBy: ['Invitations']
  };
}

function initial(): TemplateArtifactSnapshotDto {
  return createInitialTemplateArtifact({
    scope, artifactId, revisionId: firstRevisionId, document: message(), createdByUserId: actor,
    createdAt: '2026-08-15T00:00:00.000Z'
  });
}

describe('template authoring revisions', () => {
  test('creates a digest-verified baseline and a forward-only replacement', () => {
    const before = initial();
    const plan = planTemplateArtifactMutation({
      scope, current: before,
      mutation: {
        action: 'replace', artifactId, expectedRevisionNumber: 1,
        document: message('A warmer welcome'), author: 'organizer', note: 'Adjusted subject'
      },
      revisionId: '00000000-0000-4000-8000-000000000006', actorUserId: actor,
      occurredAt: '2026-08-15T00:01:00.000Z'
    });
    expect(plan.before.number).toBe(1);
    expect(plan.after.number).toBe(2);
    expect(plan.after.predecessor?.digestSha256).toBe(plan.before.digestSha256);

    let stored = before;
    const transaction: TemplateArtifactTransactionPort = {
      readArtifact: () => stored,
      applyMutation(received: TemplateArtifactMutationPlanDto) {
        stored = parseTemplateArtifactSnapshot({
          head: {
            ...stored.head,
            currentRevisionId: received.after.revisionId,
            currentRevisionNumber: received.after.number,
            version: stored.head.version + 1
          },
          current: received.after,
          history: [...stored.history, received.after]
        });
        return stored;
      }
    };
    expect(applyTemplateArtifactMutation({ plan, transaction }).current.document).toEqual(
      message('A warmer welcome')
    );
  });

  test('revert restores content as a new successor and never rewinds the chain', () => {
    const first = initial();
    const replacement = planTemplateArtifactMutation({
      scope, current: first,
      mutation: {
        action: 'replace', artifactId, expectedRevisionNumber: 1,
        document: message('Changed'), author: 'agent', note: 'Draft applied'
      },
      revisionId: '00000000-0000-4000-8000-000000000006', actorUserId: actor,
      occurredAt: '2026-08-15T00:01:00.000Z'
    });
    const second = parseTemplateArtifactSnapshot({
      head: {
        ...first.head, currentRevisionId: replacement.after.revisionId,
        currentRevisionNumber: 2, version: 2
      },
      current: replacement.after, history: [...first.history, replacement.after]
    });
    const revert = planTemplateArtifactMutation({
      scope, current: second,
      mutation: { action: 'revert', artifactId, expectedRevisionNumber: 2, targetRevisionNumber: 1 },
      revisionId: '00000000-0000-4000-8000-000000000007', actorUserId: actor,
      occurredAt: '2026-08-15T00:02:00.000Z'
    });
    expect(revert.after.number).toBe(3);
    expect(revert.after.document).toEqual(first.current.document);
    expect(revert.restoredFromRevisionNumber).toBe(1);
  });

  test('refuses stale, kind-changing, and no-op replacements', () => {
    const before = initial();
    const base = {
      scope, current: before, revisionId: '00000000-0000-4000-8000-000000000006',
      actorUserId: actor, occurredAt: '2026-08-15T00:01:00.000Z'
    };
    expect(() => planTemplateArtifactMutation({
      ...base,
      mutation: {
        action: 'replace', artifactId, expectedRevisionNumber: 9,
        document: message('Changed'), author: 'organizer', note: 'Stale'
      }
    })).toThrow(new TemplateArtifactPlanningError('stale_revision'));
    expect(() => planTemplateArtifactMutation({
      ...base,
      mutation: {
        action: 'replace', artifactId, expectedRevisionNumber: 1,
        document: message(), author: 'organizer', note: 'No change'
      }
    })).toThrow(new TemplateArtifactPlanningError('no_changes'));
  });
});
