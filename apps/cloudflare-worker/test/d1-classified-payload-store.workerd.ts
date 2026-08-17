import { env } from 'cloudflare:workers';
import {
  createClassifiedPayloadProfileRef
} from '@jooevents/application';
import {
  adoptSynchronousClassifiedPayload,
  issueSynchronousClassifiedPayloadEncryptionProfile,
  openSynchronousClassifiedPayloadAdoptionReceipt,
  SynchronousClassifiedPayloadStoreError
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  createPayloadRef,
  parseInstant,
  parsePayloadRefId
} from '@jooevents/kernel';
import { describe, expect, test } from 'vitest';
import { runD1BufferedUnitOfWork } from '../src/d1-atomic-batch';
import {
  D1BufferedClassifiedPayloadStore,
  readD1ClassifiedPayloadRecords
} from '../src/d1-classified-payload-store';

const payloadRefId = parsePayloadRefId('019c35e4-4624-7db0-8e6e-6c6989e00001');
const createdAt = parseInstant('2026-08-17T13:00:00.000Z');
const plaintext = new TextEncoder().encode('D1 classified canary: never persist this plaintext');
const encryptionProfile = issueSynchronousClassifiedPayloadEncryptionProfile({
  reference: { key: 'encryption.d1-classified-payload-test', version: 1 },
  keyBytes: Uint8Array.from({ length: 32 }, (_, index) => index * 3 + 7)
});
const binding = Object.freeze({
  profiles: Object.freeze({
    classification: createClassifiedPayloadProfileRef(
      'classification',
      'classification.communication-private',
      1
    ),
    schema: createClassifiedPayloadProfileRef('schema', 'schema.communication-template', 1),
    content: createClassifiedPayloadProfileRef('content', 'content.communication-template', 1),
    integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
    descriptorAuth: createClassifiedPayloadProfileRef(
      'descriptor_auth',
      'descriptor-auth.inline',
      1
    )
  }),
  scopeBinding: 'workspace:019c35e4-4624-7db0-8e6e-6c6989e00100/event:019c35e4-4624-7db0-8e6e-6c6989e00101',
  contentType: 'application/json'
});

function bytes(value: ArrayBuffer | readonly number[]): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value);
}

describe('D1 buffered classified-payload store', () => {
  test('bounds retained ciphertext reads below the D1 parameter ceiling', async () => {
    const boundBatches: unknown[][] = [];
    const session = {
      prepare() {
        return {
          bind(...values: unknown[]) {
            boundBatches.push(values);
            return {
              async all() {
                return { results: [] };
              }
            };
          }
        };
      }
    } as unknown as D1DatabaseSession;
    const payloadRefIds = Array.from({ length: 101 }, (_, index) => parsePayloadRefId(
      `019c35e4-4624-7db0-8e6e-${(index + 1).toString(16).padStart(12, '0')}`
    ));

    expect(await readD1ClassifiedPayloadRecords(session, payloadRefIds)).toEqual([]);
    expect(boundBatches.map((batch) => batch.length)).toEqual([50, 50, 1]);
  });

  test('atomically adopts ciphertext, reads it through the shared codec, and replays exactly', async () => {
    await runD1BufferedUnitOfWork({
      database: env.DB,
      async work(unitOfWork) {
        const store = new D1BufferedClassifiedPayloadStore({
          unitOfWork,
          encryptionProfile,
          nonceSource: (size) => Uint8Array.from({ length: size }, (_, index) => index + 1)
        });
        const receipt = adoptSynchronousClassifiedPayload({
          store,
          put: {
            payloadRefId,
            binding,
            purpose: 'communication.template-content',
            bytes: plaintext,
            createdAt
          }
        });
        expect(openSynchronousClassifiedPayloadAdoptionReceipt({
          receipt,
          expectedStore: store
        })).toMatchObject({ kind: 'inserted', payloadRef: { id: payloadRefId } });
      }
    });

    const raw = await env.DB.prepare(`SELECT ciphertext,nonce,authentication_tag
      FROM classified_payload_records WHERE payload_ref_id = ?`)
      .bind(payloadRefId).first<{
        ciphertext: ArrayBuffer | readonly number[];
        nonce: ArrayBuffer | readonly number[];
        authentication_tag: ArrayBuffer | readonly number[];
      }>();
    expect(raw).not.toBeNull();
    expect(new TextDecoder().decode(bytes(raw!.ciphertext))).not.toContain('D1 classified canary');
    expect(bytes(raw!.nonce).byteLength).toBe(12);
    expect(bytes(raw!.authentication_tag).byteLength).toBe(16);

    await runD1BufferedUnitOfWork({
      database: env.DB,
      async work(unitOfWork) {
        const records = await readD1ClassifiedPayloadRecords(
          unitOfWork.readSession,
          [payloadRefId]
        );
        const store = new D1BufferedClassifiedPayloadStore({
          unitOfWork,
          encryptionProfile,
          preloadedRecords: records
        });
        expect(store.put({
          payloadRefId,
          binding,
          purpose: 'communication.template-content',
          bytes: plaintext,
          createdAt
        })).toMatchObject({ kind: 'replay', payloadRef: { id: payloadRefId } });
        expect(store.read({
          payloadRef: createPayloadRef(payloadRefId),
          expectedBinding: binding,
          purpose: 'communication.template-content'
        })).toEqual(plaintext);
        expect(() => store.put({
          payloadRefId,
          binding,
          purpose: 'communication.template-content',
          bytes: new TextEncoder().encode('different'),
          createdAt
        })).toThrow(SynchronousClassifiedPayloadStoreError);
      }
    });
  });
});
