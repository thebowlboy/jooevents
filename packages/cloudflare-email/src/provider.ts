import type { EmailSetupManifest } from '@jooevents/contracts';
import {
  createEmailDiagnosticSubmissionPreparer,
  createEmailSubmissionPreparer,
  type EmailDeliveryAdapter,
  type EmailDiagnosticsAdapter,
  type EmailSetupAdapter,
  type ImmutableEmailDiagnosticSubmission,
  type ImmutableEmailEnvelope,
  type ImmutableEmailSubmission,
  type PreparedEmailDiagnosticSubmission,
  type PreparedEmailSubmission
} from '@jooevents/communications';
import {
  CLOUDFLARE_EMAIL_DIAGNOSTIC_FIXTURE_KEY,
  CLOUDFLARE_EMAIL_DIAGNOSTIC_FIXTURE_VERSION
} from './constants';
import type { CloudflareEmailReadinessProbe } from './setup';
import { createCloudflareEmailSetupAdapter } from './setup';
import {
  normalizeDiagnosticSendObservation,
  normalizeOrdinarySendObservation,
  unexpectedTransportFailure,
  type CloudflareSendTransport
} from './transport';

export interface CloudflareEmailProvider<Prepared> {
  readonly delivery: EmailDeliveryAdapter<Prepared>;
  readonly diagnostics: EmailDiagnosticsAdapter<Prepared>;
  readonly setup: EmailSetupAdapter;
}

export function createCloudflareEmailProvider<Prepared>(input: Readonly<{
  adapterKey: string;
  adapterVersion: string;
  manifest: EmailSetupManifest;
  transport: CloudflareSendTransport<Prepared>;
  prepareEnvelope(envelope: ImmutableEmailEnvelope): Prepared;
  readinessProbe?: CloudflareEmailReadinessProbe;
}>): CloudflareEmailProvider<Prepared> {
  const ordinaryPreparer = createEmailSubmissionPreparer<Prepared>(
    input.adapterKey,
    input.adapterVersion
  );
  const diagnosticPreparer = createEmailDiagnosticSubmissionPreparer<Prepared>(
    input.adapterKey,
    input.adapterVersion
  );

  async function send(prepared: Prepared) {
    try {
      return await input.transport.send(prepared);
    } catch {
      return unexpectedTransportFailure();
    }
  }

  const delivery: EmailDeliveryAdapter<Prepared> = Object.freeze({
    adapterKey: input.adapterKey,
    adapterVersion: input.adapterVersion,
    capabilities: input.manifest.capabilities,
    prepare(submission: ImmutableEmailSubmission) {
      return ordinaryPreparer.prepare(
        submission,
        (snapshot) => input.prepareEnvelope(snapshot.envelope)
      );
    },
    async submit(prepared: PreparedEmailSubmission<Prepared>) {
      const opened = ordinaryPreparer.open(prepared);
      return normalizeOrdinarySendObservation(
        input.transport.kind,
        prepared.providerRequestDigestSha256,
        await send(opened.opaque)
      );
    }
  });

  const diagnostics: EmailDiagnosticsAdapter<Prepared> = Object.freeze({
    adapterKey: input.adapterKey,
    adapterVersion: input.adapterVersion,
    capabilities: {
      idempotency: input.manifest.capabilities.idempotency,
      reconciliation: input.manifest.capabilities.reconciliation,
      callbacks: input.manifest.capabilities.callbacks
    },
    prepare(submission: ImmutableEmailDiagnosticSubmission) {
      return diagnosticPreparer.prepare(submission, (snapshot) => {
        if (
          snapshot.fixtureKey !== CLOUDFLARE_EMAIL_DIAGNOSTIC_FIXTURE_KEY
          || snapshot.fixtureVersion !== CLOUDFLARE_EMAIL_DIAGNOSTIC_FIXTURE_VERSION
        ) {
          throw new TypeError('Cloudflare diagnostic submission cites an unknown fixture');
        }
        if (snapshot.currency !== 'USD' || snapshot.maximumCostMinorUnits < 1) {
          throw new TypeError('Cloudflare diagnostic submission does not cover the manifest cost bound');
        }
        return input.prepareEnvelope(snapshot.envelope);
      });
    },
    async submit(prepared: PreparedEmailDiagnosticSubmission<Prepared>) {
      const opened = diagnosticPreparer.open(prepared);
      return normalizeDiagnosticSendObservation(
        input.transport.kind,
        prepared.providerRequestDigestSha256,
        await send(opened.opaque)
      );
    }
  });

  const setup = createCloudflareEmailSetupAdapter({
    adapterKey: input.adapterKey,
    adapterVersion: input.adapterVersion,
    manifest: input.manifest,
    transport: input.transport.kind,
    ...(input.readinessProbe === undefined ? {} : { readinessProbe: input.readinessProbe })
  });

  return Object.freeze({ delivery, diagnostics, setup });
}
