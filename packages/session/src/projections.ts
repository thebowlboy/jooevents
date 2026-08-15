import {
  compareScopeRef,
  reviewerScopeTargetFactSchema,
  reviewerScopeTargetSetSchema,
  type ReviewerRosterScopeDto,
  type ReviewerScopeTargetFactDto,
  type ReviewerScopeTargetSetDto
} from '@jooevents/contracts/reviewer-roster';
import { canonicalJsonSha256 } from '@jooevents/changesets';
import type { IntakeFormReferenceSource } from '@jooevents/intake';
import type { ReviewerScopeTargetSource } from '@jooevents/review/roster';
import type {
  PlaceableSessionIdentityPort,
  SchedulePlacementScope,
  ScheduleSessionId
} from '@jooevents/schedule';
import { findSession, sameSessionScope, type SessionReadPort, type SessionScope } from './model';

export function createSessionFormTargetPort(
  source: SessionReadPort
): Pick<IntakeFormReferenceSource, 'resolveCollectingSession'> {
  return Object.freeze({
    resolveCollectingSession(scope, target) {
      const catalog = source.readSessionCatalog(scope);
      const session = catalog && findSession(catalog, target.sessionId);
      return session?.lifecycle === 'collecting'
        ? Object.freeze({
            kind: 'session' as const,
            id: session.id,
            title: session.title,
            version: session.version,
            lifecycle: 'collecting' as const
          })
        : undefined;
    }
  });
}

/** Canonical Sessions are the only source; Schedule occurrences are never consulted. */
export function createSchedulePlaceableSessionPort(
  source: SessionReadPort
): Required<Pick<PlaceableSessionIdentityPort, 'readPlaceableSession'>> {
  return Object.freeze({
    readPlaceableSession(scope: SchedulePlacementScope, sessionId: ScheduleSessionId) {
      const catalog = source.readSessionCatalog(scope);
      const session = catalog && findSession(catalog, sessionId);
      if (!session || (session.lifecycle !== 'collecting' && session.lifecycle !== 'programmed')) return undefined;
      return Object.freeze({
        scope,
        id: sessionId,
        lifecycle: session.lifecycle,
        trackId: session.programTarget.track?.id ?? null
      });
    }
  });
}

/** Adds canonical Session targets to an existing Track/Format target source. */
export function createSessionAwareReviewerScopeTargetSource(
  base: ReviewerScopeTargetSource,
  sessions: SessionReadPort
): ReviewerScopeTargetSource {
  return Object.freeze({
    readReviewerScopeTargets(scope: ReviewerRosterScopeDto) {
      const baseSet = base.readReviewerScopeTargets(scope);
      const catalog = sessions.readSessionCatalog(scope);
      if (!baseSet || !catalog || !sameSessionScope(baseSet.scope, catalog.scope)) return undefined;
      const sessionTargets = catalog.sessions.map((session): ReviewerScopeTargetFactDto => {
        const unsigned = {
          schemaVersion: 1 as const,
          scope,
          ref: { kind: 'session' as const, id: session.id },
          version: session.version,
          assignability: session.lifecycle === 'draft' ? 'retained_only' as const : 'assignable' as const
        };
        return reviewerScopeTargetFactSchema.parse({
          ...unsigned,
          digestSha256: canonicalJsonSha256(unsigned)
        });
      });
      const targets = [...baseSet.targets.filter((target) => target.ref.kind !== 'session'), ...sessionTargets]
        .sort((left, right) => compareScopeRef(left.ref, right.ref));
      const version = baseSet.version + catalog.version - 1;
      if (!Number.isSafeInteger(version)) throw new TypeError('session_review_target_version_overflow');
      const unsigned: Omit<ReviewerScopeTargetSetDto, 'digestSha256'> = {
        schemaVersion: 1,
        scope,
        version,
        targets
      };
      return reviewerScopeTargetSetSchema.parse({
        ...unsigned,
        digestSha256: canonicalJsonSha256(unsigned)
      });
    }
  });
}
