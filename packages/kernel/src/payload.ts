import type { PayloadRefId } from './ids';

/** Safe reference to classified content; storage and content metadata stay elsewhere. */
export interface PayloadRef {
  readonly id: PayloadRefId;
}

export function createPayloadRef(id: PayloadRefId): PayloadRef {
  return Object.freeze({ id });
}
