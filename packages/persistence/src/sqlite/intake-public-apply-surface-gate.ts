import type { Database } from 'bun:sqlite';
import type { FormDefinitionHeadDto } from '@jooevents/contracts';
import type {
  IntakePublicApplySurfaceGate,
  IntakePublicApplySurfaceRefusalReason,
  IntakePublicApplySurfaceResolution
} from '@jooevents/intake-operations';
import { parseEventId, parseWorkspaceId, type EventId, type WorkspaceId } from '@jooevents/kernel';
import { SQLiteReleaseSurfaceSuccessorStore } from './release';

/**
 * The gate rendered as a ceremony pin source: the gated ceremony directory
 * serves exactly the currently pinned form and nothing while the gate refuses.
 */
export function intakePublicApplySurfaceCeremonyPinSource(
  gate: IntakePublicApplySurfaceGate
): { resolveCurrentPin(): { readonly formId: string; readonly formVersionId: string } | undefined } {
  return Object.freeze({
    resolveCurrentPin() {
      const resolution = gate.resolveApplySurface();
      return resolution.kind === 'pinned'
        ? Object.freeze({
            formId: resolution.pin.formId,
            formVersionId: resolution.pin.formVersionId
          })
        : undefined;
    }
  });
}

/** The intake collaboration this gate needs; the runtime's repository satisfies it. */
export interface IntakePublicApplySurfaceFormHeadSource {
  readFormHead(
    scope: { readonly workspaceId: string; readonly eventId: string },
    formId: string
  ): FormDefinitionHeadDto | undefined;
}

function refused(reason: IntakePublicApplySurfaceRefusalReason): IntakePublicApplySurfaceResolution {
  return Object.freeze({ kind: 'refused' as const, reason });
}

/**
 * The published apply-surface gate over this database's release and intake
 * tables. Serving truth is re-read on every resolution: the current `apply`
 * surface head, its immutable active release's `formRef` pin, and the pinned
 * form's live head. A pin must still name the current published version before
 * a genuinely closed form may serve its detail-free marker. Draft, drifted,
 * absent, and malformed states fail closed; nothing is cached or inferred.
 */
export function createSQLiteIntakePublicApplySurfaceGate(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
  readonly forms: IntakePublicApplySurfaceFormHeadSource;
}): IntakePublicApplySurfaceGate {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const eventId = parseEventId(input.eventId);
  const releases = new SQLiteReleaseSurfaceSuccessorStore(input.sqlite);
  if (typeof input.forms?.readFormHead !== 'function') {
    throw new TypeError('intake_public_apply_gate_forms_invalid');
  }
  const scope = Object.freeze({ workspaceId, eventId });
  return Object.freeze({
    resolveApplySurface(): IntakePublicApplySurfaceResolution {
      let head;
      let release;
      try {
        head = releases.readSurfaceHead(scope, 'apply');
        release = head ? releases.readSurfaceRelease(scope, head.activeReleaseId) : undefined;
      } catch {
        return refused('no_published_apply_surface');
      }
      if (!head || !release || release.kind !== 'apply'
          || release.scope.workspaceId !== workspaceId
          || release.scope.eventId !== eventId) {
        return refused('no_published_apply_surface');
      }
      let formHead: FormDefinitionHeadDto | undefined;
      try {
        formHead = input.forms.readFormHead(scope, release.formRef.formId);
      } catch {
        return refused('no_published_apply_surface');
      }
      if (!formHead || formHead.id !== release.formRef.formId) {
        return refused('no_published_apply_surface');
      }
      if (formHead.currentPublishedVersionId !== release.formRef.formVersionId) {
        return refused('apply_form_version_superseded');
      }
      if (formHead.status === 'closed') {
        return Object.freeze({
          kind: 'closed' as const,
          pin: Object.freeze({
            workspaceId,
            eventId,
            formId: release.formRef.formId,
            formVersionId: release.formRef.formVersionId,
            surfaceReleaseId: release.id,
            surfaceHeadVersion: head.version,
            evidenceIds: Object.freeze([
              `apply-surface:${release.id}`,
              `apply-surface-head:${head.version}`,
              `intake-form:${formHead.id}#${formHead.version}`
            ])
          })
        });
      }
      if (formHead.status !== 'open') return refused('no_published_apply_surface');
      return Object.freeze({
        kind: 'pinned' as const,
        pin: Object.freeze({
          workspaceId,
          eventId,
          formId: release.formRef.formId,
          formVersionId: release.formRef.formVersionId,
          surfaceReleaseId: release.id,
          surfaceHeadVersion: head.version,
          evidenceIds: Object.freeze([
            `apply-surface:${release.id}`,
            `apply-surface-head:${head.version}`,
            `intake-form:${formHead.id}#${formHead.version}`
          ])
        })
      });
    }
  });
}
