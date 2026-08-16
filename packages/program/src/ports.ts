import type { ProgramVocabularyScope, ProgramVocabularyState } from './model';
import type { ProgramReferenceSnapshotSource } from './references';
import type { ProgramVocabularyChangeResult } from '@jooevents/contracts';
import type { ProgramVocabularyMutationPlan } from './domain';

/** Read-only owner port shared by the snapshot operation and persistence. */
export interface ProgramVocabularyReadPort extends ProgramReferenceSnapshotSource {
  readVocabulary(scope: ProgramVocabularyScope): ProgramVocabularyState | undefined;
}

export interface ProgramVocabularyTransactionPort extends ProgramVocabularyReadPort {
  applyVocabularyPlan(plan: ProgramVocabularyMutationPlan): ProgramVocabularyChangeResult;
}
