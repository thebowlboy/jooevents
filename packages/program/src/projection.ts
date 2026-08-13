import {
  programVocabularySnapshotSchema,
  type ProgramVocabularyDeleteEligibilityDto,
  type ProgramVocabularyItemDto,
  type ProgramVocabularySnapshotDto
} from '@jooevents/contracts';
import { programVocabularyItems, type ProgramVocabularyItem, type ProgramVocabularyState } from './model';
import {
  programReferenceUsage,
  validateProgramReferenceTargets,
  type CompleteProgramReferenceSnapshot
} from './references';

function projectItem(
  item: ProgramVocabularyItem,
  references: CompleteProgramReferenceSnapshot
): ProgramVocabularyItemDto {
  const usage = programReferenceUsage(references, item);
  const deleteEligibility: ProgramVocabularyDeleteEligibilityDto = usage.current === 0 && usage.historicalPins === 0
    ? { kind: 'eligible' }
    : {
        kind: 'blocked',
        currentReferences: usage.current,
        historicalPins: usage.historicalPins
      };
  return {
    kind: item.kind,
    id: item.id,
    name: item.name,
    status: item.status,
    version: item.version,
    usage,
    deleteEligibility,
    ...(item.kind === 'room'
      ? { capacity: item.capacity }
      : item.kind === 'track'
        ? { accent: item.accent }
        : {})
  } as ProgramVocabularyItemDto;
}

export function projectProgramVocabularySnapshot(
  state: ProgramVocabularyState,
  references: CompleteProgramReferenceSnapshot
): ProgramVocabularySnapshotDto {
  validateProgramReferenceTargets(state, references);
  const items = programVocabularyItems(state).map((item) => projectItem(item, references));
  return programVocabularySnapshotSchema.parse({
    schemaVersion: 1,
    scope: state.scope,
    setVersion: state.setVersion,
    rooms: items.filter((item) => item.kind === 'room'),
    tracks: items.filter((item) => item.kind === 'track'),
    formats: items.filter((item) => item.kind === 'format')
  });
}
