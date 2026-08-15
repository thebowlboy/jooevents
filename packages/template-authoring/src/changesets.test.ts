import { describe, expect, test } from 'bun:test';
import {
  planChangesetOperation,
  type ChangesetPlanningSnapshot,
  type ChangesetReadPortKey
} from '@jooevents/changesets';
import { createInitialTemplateArtifact } from './model';
import { issueTemplateAuthoringPolicy } from './policy';
import {
  createTemplateArtifactChangesetBundle,
  templateArtifactReadPort
} from './changesets';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const eventId = '20000000-0000-4000-8000-000000000002';
const userId = '30000000-0000-4000-8000-000000000003';
const artifactId = '40000000-0000-4000-8000-000000000004';

describe('template artifact changeset definition', () => {
  test('plans one exact diff fenced on the artifact head', async () => {
    const baseline = createInitialTemplateArtifact({
      scope: { workspaceId, eventId },
      artifactId,
      revisionId: '50000000-0000-4000-8000-000000000005',
      document: {
        kind: 'message', key: 'welcome-message', name: 'Welcome',
        purpose: 'Welcomes a participant.', subject: 'Welcome',
        blocks: [{ type: 'paragraph', text: 'Hello' }], mergeFields: [], usedBy: ['Invitation']
      },
      createdByUserId: userId,
      createdAt: '2026-08-15T00:00:00.000Z'
    });
    const bundle = createTemplateArtifactChangesetBundle({
      policy: issueTemplateAuthoringPolicy({
        key: 'template.artifact.ordinary', version: 1, risk: 'low', approval: 'none'
      })
    });
    const port = { readArtifact: () => baseline };
    const snapshot: ChangesetPlanningSnapshot = {
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== templateArtifactReadPort) throw new TypeError('undeclared_test_port');
        return port as unknown as Port;
      }
    };
    const operation = await planChangesetOperation({
      registry: bundle.registry,
      kind: 'template.artifact.change',
      version: 1,
      authorInput: {
        scope: { workspaceId, eventId },
        mutation: {
          action: 'replace', artifactId, expectedRevisionNumber: 1,
          document: { ...baseline.current.document, subject: 'A warmer welcome' },
          author: 'organizer', note: 'Adjusted subject'
        },
        revisionId: '60000000-0000-4000-8000-000000000006',
        actorUserId: userId,
        occurredAt: '2026-08-15T00:01:00.000Z'
      },
      dependencyGroup: 'template_artifact',
      snapshot
    });
    expect(operation).toMatchObject({
      riskTier: 'low',
      aggregateRefs: [{ id: `template_artifact:${artifactId}`, version: 1 }],
      guardRefs: [],
      consequences: ['template_artifact_changed'],
      safeDiff: {
        action: 'replace', artifactId, artifactKind: 'message',
        before: { number: 1, document: { subject: 'Welcome' } },
        after: { number: 2, document: { subject: 'A warmer welcome' } }
      }
    });
  });
});
