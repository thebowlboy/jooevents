import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from '@jooevents/application';
import {
  acceleventsExportConfigSaveInputSchema,
  acceleventsExportViewSchema,
  structuredOutcomeSchema,
  type AcceleventsExportConfiguration,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { projectAcceleventsExportView, type AcceleventsExportSource } from '@jooevents/program-export';
import { z } from 'zod';

export const acceleventsExportConfigPlanSchema = z.strictObject({
  kind: z.literal('accelevents_export_config_save'),
  configurationId: z.uuid(),
  actorUserId: z.uuid(),
  updatedAt: z.iso.datetime({ offset: true }),
  request: acceleventsExportConfigSaveInputSchema
});

export const acceleventsExportConfigCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: acceleventsExportViewSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const acceleventsExportConfigContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: acceleventsExportViewSchema }),
    domain: acceleventsExportConfigPlanSchema,
    effectContributions: z.tuple([])
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(),
    effectContributions: z.tuple([])
  })
]);

interface SealedSnapshot {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly source: AcceleventsExportSource;
  readonly configurationId: string;
  phase: 'ready' | 'spent';
}

const snapshots = new WeakMap<object, SealedSnapshot>();

export function sealAcceleventsExportConfigSnapshot(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly source: AcceleventsExportSource;
  readonly configurationId: string;
}): EffectHandlerSnapshot {
  const snapshot = Object.freeze({ strategy: 'accelevents_export_config_save', version: 1 });
  snapshots.set(snapshot, { ...input, phase: 'ready' });
  return snapshot;
}

export function createAcceleventsExportConfigHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  return Object.freeze({
    reference: input.reference,
    effect: 'commit' as const,
    handlerCapability: input.handlerCapability,
    contributionSchema: input.contributionSchema,
    canonicalResultSchema: input.canonicalResultSchema,
    handle({ businessInput, context, snapshot }: {
      readonly businessInput: unknown;
      readonly context: EffectInvocationContext;
      readonly snapshot: EffectHandlerSnapshot;
    }) {
      const sealed = snapshots.get(snapshot);
      if (!sealed || sealed.phase !== 'ready' || sealed.context !== context
          || sealed.capability.key !== input.handlerCapability.key
          || sealed.capability.version !== input.handlerCapability.version) {
        throw new TypeError('invalid_accelevents_export_config_snapshot');
      }
      sealed.phase = 'spent';
      const request = acceleventsExportConfigSaveInputSchema.parse(businessInput);
      if (request.eventId !== context.scope.eventId
          || request.expectedVersion !== sealed.source.configuration.version) {
        return acceleventsExportConfigContributionSchema.parse({
          result: { kind: 'outcome', outcome: {
            class: 'stale_revision', kind: 'program.export.accelevents.configuration_changed',
            retryable: false, subjects: [],
            detail: { expectedVersion: request.expectedVersion, currentVersion: sealed.source.configuration.version },
            detailSchemaVersion: 1
          }},
          domain: null, effectContributions: []
        });
      }
      if (context.actor.kind !== 'workspace_user') throw new TypeError('accelevents_export_config_actor_invalid');
      const configuration: AcceleventsExportConfiguration = {
        schemaVersion: 1,
        eventId: request.eventId,
        version: request.expectedVersion + 1,
        selectedReleaseId: request.selectedReleaseId,
        sessionType: request.sessionType,
        formatMappings: request.formatMappings,
        speakerNames: request.speakerNames,
        roomBindings: request.roomBindings,
        primarySpeakers: request.primarySpeakers,
        updatedAt: context.receivedAt
      };
      const view = projectAcceleventsExportView({ ...sealed.source, configuration });
      return acceleventsExportConfigContributionSchema.parse({
        result: { kind: 'success', data: view },
        domain: {
          kind: 'accelevents_export_config_save',
          configurationId: sealed.configurationId,
          actorUserId: context.actor.userId,
          updatedAt: context.receivedAt,
          request
        },
        effectContributions: []
      });
    }
  });
}
