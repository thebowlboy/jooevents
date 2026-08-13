import {
  compareScopeRef,
  type ReviewerRosterScopeDto,
  type ReviewerScopeTargetFactDto,
  type ReviewerScopeTargetSetDto
} from '@jooevents/contracts/reviewer-roster';
import { isApplicationId } from '@jooevents/kernel';
import type { ProgramTrack, ProgramFormat } from '@jooevents/program';
import {
  parseReviewerRosterScope,
  parseReviewerScopeTargetSet,
  reviewerScopeTargetFactDigest,
  reviewerScopeTargetSetDigest,
  type ReviewerScopeTargetSource
} from '@jooevents/review/roster';
import { SQLiteProgramVocabularyRepository } from './program-vocabulary';

/**
 * Track/Format scope targets for reviewer-roster authorization, projected from
 * the authenticated Program Vocabulary read. Active items are `assignable`;
 * retired items remain `retained_only`, so existing reviewer scopes survive a
 * retirement while new references are refused. Each target carries the item's
 * current version, and the set version is the vocabulary set version. Session
 * targets are contributed by a separate session-aware wrapper over this base;
 * this source stands alone and never emits session refs. An unknown event scope
 * reads as undefined rather than an empty target set.
 */
export class SQLiteReviewerScopeTargetSource implements ReviewerScopeTargetSource {
  constructor(private readonly vocabulary: SQLiteProgramVocabularyRepository) {
    if (!(vocabulary instanceof SQLiteProgramVocabularyRepository)) {
      throw new TypeError('reviewer_scope_target_vocabulary_source_invalid');
    }
  }

  readReviewerScopeTargets(
    scopeValue: ReviewerRosterScopeDto
  ): ReviewerScopeTargetSetDto | undefined {
    const scope = parseReviewerRosterScope(scopeValue);
    const state = this.vocabulary.readVocabulary(scope);
    if (!state) return undefined;
    const targets = [
      ...state.tracks.map((item) => targetFact(scope, 'track', item)),
      ...state.formats.map((item) => targetFact(scope, 'format', item))
    ].sort((left, right) => compareScopeRef(left.ref, right.ref));
    const unsigned = {
      schemaVersion: 1 as const,
      scope,
      version: state.setVersion,
      targets
    };
    return parseReviewerScopeTargetSet({
      ...unsigned,
      digestSha256: reviewerScopeTargetSetDigest(unsigned)
    });
  }
}

function targetFact(
  scope: ReviewerRosterScopeDto,
  kind: 'track' | 'format',
  item: ProgramTrack | ProgramFormat
): ReviewerScopeTargetFactDto {
  const unsigned = {
    schemaVersion: 1 as const,
    scope,
    ref: { kind, id: targetId(item.id) },
    version: item.version,
    assignability: item.status === 'active' ? 'assignable' as const : 'retained_only' as const
  };
  return { ...unsigned, digestSha256: reviewerScopeTargetFactDigest(unsigned) };
}

function targetId(value: string): ReviewerScopeTargetFactDto['ref']['id'] {
  if (!isApplicationId(value)) throw new TypeError('reviewer_scope_target_id_invalid');
  return value;
}
