import { expect } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { operationHistoryPageSchema } from '@jooevents/contracts/operation-history';
import {
  INTAKE_PUBLIC_CONTINUATION_HEADER,
  INTAKE_PUBLIC_CONTINUATION_MINT_PATH,
  INTAKE_PUBLIC_FORM_SELECTOR_HEADER
} from '@jooevents/persistence/intake-public-ceremony';
import { RELEASE_PUBLIC_SCHEDULE_READ_PATH } from '@jooevents/release-operations';
import { openSQLite } from '@jooevents/persistence';
import { loadConfig, loadEphemeralLiveConfig, type ConfiguredServerConfig } from '../../config';
import {
  createEphemeralLiveRuntime,
  type EphemeralLiveRuntime,
  type EphemeralLiveTestActor
} from '../../runtime/ephemeral-live';
import {
  createConfiguredSQLiteLiveRuntimeForTesting,
  type ConfiguredSQLiteLiveRuntime
} from '../../runtime/configured-sqlite-live-runtime';
import type { J2FlowWorld } from './j2-spine.flow';

type FlowResult = {
  readonly kind: 'success';
  readonly data: unknown;
  readonly receipt: { readonly id: string };
};

interface Attempt {
  readonly actor: EphemeralLiveTestActor;
  readonly operation: string;
  readonly input: unknown;
  readonly key: string;
  readonly result: FlowResult;
  readonly historyIds: readonly string[];
}

interface FlowReceipt<T> {
  readonly data: T;
  readonly attempt: Attempt;
}

const config = loadEphemeralLiveConfig({
  JOOEVENTS_BASE_URL: 'http://localhost:5176',
  JOOEVENTS_TRUSTED_ORIGINS: '',
  JOOEVENTS_AUTH_SECRETS: '1:Q7m!2vK9#pL4@xR8%tN5&cW3*zF6$hJ1',
  JOOEVENTS_GOOGLE_CLIENT_ID: 'flow-test-google-client',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'flow-test-google-secret',
  JOOEVENTS_ADMISSION_MODE: 'reservation_only',
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'flow-owner@jooevents.example',
  JOOEVENTS_DATABASE_DRIVER: 'sqlite',
  JOOEVENTS_DATABASE_PATH: 'ignored-flow-test.sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem',
  JOOEVENTS_DATA_DIRECTORY: '/tmp/ignored-flow-test'
});

type FlowRuntime = EphemeralLiveRuntime | ConfiguredSQLiteLiveRuntime;

function retainedConfig(dataDirectory: string): ConfiguredServerConfig {
  const key = (seed: number) => `1:${Buffer.alloc(32, seed).toString('base64url')}`;
  return loadConfig({
    JOOEVENTS_BASE_URL: config.baseUrl,
    JOOEVENTS_TRUSTED_ORIGINS: '',
    JOOEVENTS_AUTH_SECRETS: config.authSecrets.map((entry) => `${entry.version}:${entry.value}`).join(','),
    JOOEVENTS_REQUEST_HASH_KEYS: key(1),
    JOOEVENTS_IDEMPOTENCY_KEYS: key(2),
    JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: key(3),
    JOOEVENTS_PERSISTENT_HMAC_KEYS: key(4),
    JOOEVENTS_GOOGLE_CLIENT_ID: 'flow-test-google-client',
    JOOEVENTS_GOOGLE_CLIENT_SECRET: 'flow-test-google-secret',
    JOOEVENTS_ADMISSION_MODE: 'reservation_only',
    JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'flow-owner@jooevents.example',
    JOOEVENTS_DATABASE_DRIVER: 'sqlite',
    JOOEVENTS_DATABASE_PATH: 'jooevents.sqlite',
    JOOEVENTS_BLOB_DRIVER: 'filesystem',
    JOOEVENTS_DATA_DIRECTORY: dataDirectory
  });
}

function attemptKey(): string {
  return `flow-${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

function cleanupFlowDirectory(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
      || !['jooevents-ephemeral-runtime-', 'jooevents-retained-flow-']
        .some((prefix) => basename(path).startsWith(prefix))
      || dirname(path) !== realpathSync(dirname(path))) {
    throw new Error(`unsafe_flow_world_cleanup:${path}`);
  }
  rmSync(path, { recursive: true });
}

function successful(result: unknown, operation: string): FlowResult {
  if (!result || typeof result !== 'object' || (result as { kind?: unknown }).kind !== 'success') {
    const outcome = result && typeof result === 'object'
      ? JSON.stringify(result) : String(result);
    throw new Error(`${operation} did not succeed: ${outcome}`);
  }
  const candidate = result as {
    readonly data?: unknown;
    readonly receipt?: { readonly id?: unknown };
  };
  if (candidate.receipt?.id === undefined || typeof candidate.receipt.id !== 'string') {
    throw new Error(`${operation} did not return an operation receipt`);
  }
  return candidate as FlowResult;
}

export class ActorHandle {
  #lastAttempt: Attempt | undefined;

  constructor(
    readonly actor: EphemeralLiveTestActor,
    private readonly world: FlowWorld
  ) {}

  get userId() { return this.actor.userId; }
  get membership() { return this.actor.membership; }

  async do<T>(operation: string, input: unknown): Promise<FlowReceipt<T>> {
    const support = this.world.support();
    const key = attemptKey();
    const before = await this.world.historyIds(this.actor);
    const result = successful(await support.invokeEffect({
      actor: this.actor,
      operationName: operation,
      businessInput: input,
      idempotencyKey: key
    }), operation);
    const attempt: Attempt = {
      actor: this.actor, operation, input, key, result,
      historyIds: await this.world.historyIds(this.actor)
    };
    this.world.record(`${operation}@1 → success`);
    this.world.record(`history ${before.length} → ${attempt.historyIds.length}`);
    this.#lastAttempt = attempt;
    return { data: result.data as T, attempt };
  }

  async replay<T>(receipt: FlowReceipt<T>): Promise<FlowReceipt<T>> {
    const { attempt } = receipt;
    const support = this.world.support();
    const result = successful(await support.invokeEffect({
      actor: attempt.actor,
      operationName: attempt.operation,
      businessInput: attempt.input,
      idempotencyKey: attempt.key
    }), `${attempt.operation} replay`);
    const historyIds = await this.world.historyIds(this.actor);
    expect(result).toEqual(attempt.result);
    expect(historyIds).toEqual(attempt.historyIds);
    this.world.record(`${attempt.operation}@1 → replayed`);
    return { data: result.data as T, attempt: { ...attempt, result, historyIds } };
  }

  async expectRefusal(operation: string, input: unknown, outcomeKind: string): Promise<void> {
    const before = await this.world.historyIds(this.actor);
    const result = await this.world.support().invokeEffect({
      actor: this.actor,
      operationName: operation,
      businessInput: input,
      idempotencyKey: attemptKey()
    });
    const after = await this.world.historyIds(this.actor);
    expect(result.kind, this.world.trace()).toBe('outcome');
    if (result.kind !== 'outcome') throw new Error(`${operation} unexpectedly succeeded`);
    expect(result.outcome.kind, this.world.trace()).toBe(outcomeKind);
    expect(after, this.world.trace()).toEqual(before);
    this.world.record(`${operation}@1 → refused ${outcomeKind}`);
  }

  async expectLog(summary: string): Promise<void> {
    const attempt = this.#lastAttempt;
    if (!attempt) throw new Error(`No operation is available for log assertion: ${summary}`);
    const page = await this.world.history(this.actor);
    const entry = page.entries.find((candidate) => candidate.id === attempt.result.receipt.id);
    expect(entry, this.world.trace()).toBeDefined();
    expect(String(page.entries[0]?.id), this.world.trace()).toBe(attempt.result.receipt.id);
    expect(entry?.summary, this.world.trace()).toBe(summary);
    expect(entry?.subjects, this.world.trace()).toEqual(expect.any(Array));
    expect(entry?.subjects.length, this.world.trace()).toBeGreaterThan(0);
    expect(entry?.subjects.some((subject) => subject.kind === 'workspace'), this.world.trace()).toBe(true);
    this.world.record(`${attempt.operation}@1 → ${summary}`);
  }

  async expectRead(
    operation: string,
    assertion: (projection: unknown) => boolean
  ): Promise<void>;
  async expectRead(
    operation: string,
    input: unknown,
    assertion: (projection: unknown) => boolean
  ): Promise<void>;
  async expectRead(
    operation: string,
    inputOrAssertion: unknown | ((projection: unknown) => boolean),
    maybeAssertion?: (projection: unknown) => boolean
  ): Promise<void> {
    const input = typeof inputOrAssertion === 'function' ? {} : inputOrAssertion;
    const assertion = typeof inputOrAssertion === 'function' ? inputOrAssertion : maybeAssertion;
    if (!assertion) throw new Error(`${operation} is missing a flow projection assertion`);
    const support = this.world.support();
    const result = await support.invokeRead({
      actor: this.actor, operationName: operation, businessInput: input
    });
    if (result.kind !== 'success') {
      throw new Error(`${operation} did not produce a readable projection: ${result.outcome.kind}`);
    }
    expect(assertion(result.data), this.world.trace()).toBe(true);
    this.world.record(`${operation}@1 → projection asserted`);
  }
}

class PublicHandle {
  constructor(private readonly runtime: FlowRuntime, private readonly world: FlowWorld) {}

  async submitForm<T>(formId: string, answers: readonly unknown[]): Promise<FlowReceipt<T>> {
    const bootstrap = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
    const mint = await this.runtime.app.request(INTAKE_PUBLIC_CONTINUATION_MINT_PATH, {
      method: 'POST',
      headers: {
        [INTAKE_PUBLIC_FORM_SELECTOR_HEADER]: formId,
        'content-type': 'application/json',
        'x-correlation-id': crypto.randomUUID()
      },
      body: JSON.stringify({ schemaVersion: 1, bootstrap })
    });
    if (mint.status !== 201) throw new Error(`public continuation mint failed: ${mint.status}`);
    const minted = await mint.json() as { readonly continuation?: unknown };
    const continuation = minted.continuation;
    if (typeof continuation !== 'string') throw new Error('public continuation missing');
    const call = async (body: unknown) => {
      const response = await this.runtime.app.request('/api/public/forms/application/mutate', {
        method: 'POST',
        headers: {
          [INTAKE_PUBLIC_FORM_SELECTOR_HEADER]: formId,
          [INTAKE_PUBLIC_CONTINUATION_HEADER]: continuation,
          'content-type': 'application/json',
          'idempotency-key': attemptKey(),
          'x-correlation-id': crypto.randomUUID()
        },
        body: JSON.stringify(body)
      });
      if (response.status !== 200) throw new Error(`public application mutation failed: ${response.status}`);
      return await response.json() as { readonly kind?: unknown; readonly data?: unknown };
    };
    const begun = await call({ action: 'begin', input: { formId } });
    const draft = (begun.data as { readonly draft?: { readonly draftVersion?: unknown } } | undefined)?.draft;
    if (begun.kind !== 'success' || draft?.draftVersion !== 1) throw new Error('public application begin refused');
    const saved = await call({ action: 'save', input: { expectedDraftVersion: 1, answers } });
    const savedDraft = (saved.data as { readonly draft?: { readonly draftVersion?: unknown } } | undefined)?.draft;
    if (saved.kind !== 'success' || savedDraft?.draftVersion !== 2) throw new Error('public application save refused');
    const submitted = await call({ action: 'submit', input: { expectedDraftVersion: 2 } });
    const submission = (submitted.data as { readonly submission?: unknown } | undefined)?.submission;
    if (submitted.kind !== 'success' || !submission) throw new Error('public application submit refused');
    this.world.record('application.public.mutate@1 → submitted');
    // Public ceremony commits are intentionally an ingress-effect lane.  They
    // do not masquerade as an organizer operation-log row.
    return { data: { submission } as T, attempt: undefined as never };
  }

  async expectRead(
    operation: 'schedule.public.read',
    assertion: (projection: unknown) => boolean
  ): Promise<void> {
    const path = operation === 'schedule.public.read' ? RELEASE_PUBLIC_SCHEDULE_READ_PATH : undefined;
    if (!path) throw new Error(`Unsupported public flow read: ${operation}`);
    const response = await this.runtime.app.request(path, {
      headers: { 'x-correlation-id': crypto.randomUUID() }
    });
    if (response.status !== 200) throw new Error(`${operation} returned HTTP ${response.status}`);
    const result = await response.json() as { readonly kind?: unknown; readonly data?: unknown };
    if (result.kind !== 'success') throw new Error(`${operation} did not produce a public projection`);
    expect(assertion(result.data), this.world.trace()).toBe(true);
    this.world.record(`${operation}@1 → projection asserted`);
  }
}

/** A real participant-lane handle, admitted through the dev-fixture link ceremony. */
class SubmitterHandle {
  #cookie: string | undefined;

  constructor(
    private readonly runtime: FlowRuntime,
    private readonly world: FlowWorld,
    private readonly email: string
  ) {}

  async expectRead(
    operation: 'portal.snapshot.read',
    assertion: (projection: unknown) => boolean
  ): Promise<void> {
    if (operation !== 'portal.snapshot.read') throw new Error(`Unsupported submitter flow read: ${operation}`);
    const response = await this.runtime.app.request('/api/portal/snapshot', {
      headers: {
        cookie: await this.sessionCookie(),
        'x-correlation-id': crypto.randomUUID()
      }
    });
    if (response.status !== 200) throw new Error(`${operation} returned HTTP ${response.status}`);
    const result = await response.json() as { readonly kind?: unknown; readonly data?: unknown };
    if (result.kind !== 'success') throw new Error(`${operation} did not produce a submitter projection`);
    expect(assertion(result.data), this.world.trace()).toBe(true);
    this.world.record(`${operation}@1 → submitter projection asserted`);
  }

  private async sessionCookie(): Promise<string> {
    if (this.#cookie !== undefined) return this.#cookie;
    const post = (path: string, body: unknown) => this.runtime.app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: this.world.baseUrl(),
        'x-correlation-id': crypto.randomUUID()
      },
      body: JSON.stringify(body)
    });
    const requested = await post('/api/portal/entry/link', { email: this.email });
    if (requested.status !== 200) throw new Error(`portal link request returned HTTP ${requested.status}`);
    const issued = await post('/api/portal/entry/dev/issued-link', { email: this.email });
    if (issued.status !== 200) throw new Error(`portal issued-link fixture returned HTTP ${issued.status}`);
    const link = await issued.json() as { readonly kind?: unknown; readonly url?: unknown };
    if (link.kind !== 'issued' || typeof link.url !== 'string') {
      throw new Error('portal issued-link fixture did not issue the submitter link');
    }
    const token = new URL(link.url, this.world.baseUrl()).searchParams.get('token');
    if (!token) throw new Error('portal issued-link fixture returned a link without a token');
    const completed = await post('/api/portal/entry/complete', { token });
    if (completed.status !== 200) throw new Error(`portal link completion returned HTTP ${completed.status}`);
    const cookie = /__Host-je_portal_session=([^;]+)/.exec(completed.headers.get('set-cookie') ?? '');
    if (!cookie) throw new Error('portal link completion did not create a participant session');
    this.#cookie = `__Host-je_portal_session=${cookie[1]!}`;
    this.world.record('portal entry → submitter admitted');
    return this.#cookie;
  }
}

export class FlowWorld implements J2FlowWorld {
  #trace: string[] = [];

  private constructor(
    public runtime: FlowRuntime,
    private readonly actors: {
      readonly organizer: EphemeralLiveTestActor;
      readonly reviewer: EphemeralLiveTestActor;
      readonly secondOrganizer: EphemeralLiveTestActor;
    },
    private readonly cleanupDirectory: string | null,
    private retainedConfiguration?: ConfiguredServerConfig
  ) {}

  static async create(input: {
    readonly database?: 'default' | 'migration-initialized-empty' | 'retained-frozen';
    /** Test-only installed/restored runtime configuration; the caller owns its directory. */
    readonly retainedConfiguration?: ConfiguredServerConfig;
  } = {}): Promise<FlowWorld> {
    let runtime: FlowRuntime;
    let cleanupDirectory: string | null;
    let retainedConfiguration: ConfiguredServerConfig | undefined;
    if (input.retainedConfiguration) {
      if (input.database !== 'retained-frozen'
          || input.retainedConfiguration.databaseDriver !== 'sqlite'
          || input.retainedConfiguration.blobDriver !== 'filesystem'
          || !input.retainedConfiguration.dataDirectory) {
        throw new TypeError('flow_world_external_retained_configuration_invalid');
      }
      cleanupDirectory = null;
      retainedConfiguration = input.retainedConfiguration;
      runtime = await createConfiguredSQLiteLiveRuntimeForTesting({ config: retainedConfiguration });
    } else if (input.database === 'retained-frozen') {
      const ownedDirectory = realpathSync(mkdtempSync(`${join(tmpdir(), 'jooevents-retained-flow-')}`));
      chmodSync(ownedDirectory, 0o700);
      cleanupDirectory = ownedDirectory;
      const initialized = openSQLite(join(ownedDirectory, 'jooevents.sqlite'), {
        migrationPolicy: 'apply',
        databaseClass: 'frozen_release'
      });
      initialized.sqlite.close();
      retainedConfiguration = retainedConfig(ownedDirectory);
      runtime = await createConfiguredSQLiteLiveRuntimeForTesting({ config: retainedConfiguration });
    } else {
      runtime = await createEphemeralLiveRuntime({ config, devFixtures: true });
      cleanupDirectory = runtime.database.directoryPath;
    }
    const support = runtime.testSupport;
    if (!support) throw new Error('flow world test support was not composed');
    if (input.database === 'migration-initialized-empty') {
      if (!('retainedBaseline' in runtime.database) || !('installedSchemaArtifacts' in runtime.database)) {
        runtime.close();
        throw new Error('flow_world_ephemeral_database_shape_missing');
      }
      const baseline = runtime.database.retainedBaseline;
      const operationCount = runtime.database.sqlite.query<{ readonly count: number }, []>(
        'SELECT count(*) AS count FROM operation_log'
      ).get()?.count ?? -1;
      const eventCount = runtime.database.sqlite.query<{ readonly count: number }, []>(
        'SELECT count(*) AS count FROM events'
      ).get()?.count ?? -1;
      if (baseline.coordinate?.schemaEpoch !== 2
          || baseline.migrationId !== 'e2_0006_airtable_sync'
          || runtime.database.installedSchemaArtifacts.length !== 0
          || operationCount !== 0 || eventCount !== 0) {
        runtime.close();
        throw new Error('flow_world_migration_initialized_empty_invariant_failed');
      }
    }
    return new FlowWorld(
      runtime,
      await support.bootstrapActors(),
      cleanupDirectory,
      retainedConfiguration
    );
  }

  support() {
    const support = this.runtime.testSupport;
    if (!support) throw new Error('flow world test support disappeared');
    return support;
  }

  as(persona: 'organizer' | 'reviewer' | 'second-organizer'): ActorHandle {
    return new ActorHandle(
      persona === 'second-organizer' ? this.actors.secondOrganizer : this.actors[persona],
      this
    );
  }

  asPublic(): PublicHandle { return new PublicHandle(this.runtime, this); }

  asSubmitter(email: string): SubmitterHandle { return new SubmitterHandle(this.runtime, this, email); }

  async history(actor: EphemeralLiveTestActor) {
    const result = await this.support().invokeRead({
      // Workspace history is available before J2's first event exists; once
      // it does, its newest entry is still the immediately committed step.
      actor, operationName: 'operation.history.list', businessInput: { view: 'workspace', limit: 100 }
    });
    if (result.kind !== 'success') throw new Error(`operation history refused: ${result.outcome.kind}`);
    return operationHistoryPageSchema.parse(result.data);
  }

  async historyIds(actor: EphemeralLiveTestActor): Promise<readonly string[]> {
    return (await this.history(actor)).entries.map((entry) => entry.id);
  }

  record(line: string): void { this.#trace.push(line); }
  baseUrl(): string { return this.retainedConfiguration?.baseUrl ?? config.baseUrl; }
  trace(): string { return this.#trace.length === 0 ? 'J2 trace: no completed steps' : `J2 trace:\n${this.#trace.map((line) => `  ${line}`).join('\n')}`; }
  async restartRetained(): Promise<void> {
    if (!this.retainedConfiguration) throw new TypeError('flow_world_is_not_retained');
    await this.runtime.close();
    this.runtime = await createConfiguredSQLiteLiveRuntimeForTesting({
      config: this.retainedConfiguration
    });
    if (!this.runtime.testSupport) throw new TypeError('retained_flow_test_support_missing_after_restart');
    await this.runtime.testSupport.resumeActors(Object.values(this.actors));
    this.record('retained runtime → graceful restart');
  }
  async pauseRetained(): Promise<void> {
    if (!this.retainedConfiguration) throw new TypeError('flow_world_is_not_retained');
    await this.runtime.close();
    this.record('retained runtime → stopped for installation backup');
  }
  async resumeRetained(configuration: ConfiguredServerConfig): Promise<void> {
    if (!this.retainedConfiguration || configuration.databaseDriver !== 'sqlite'
        || configuration.blobDriver !== 'filesystem' || !configuration.dataDirectory) {
      throw new TypeError('flow_world_resume_configuration_invalid');
    }
    this.retainedConfiguration = configuration;
    this.runtime = await createConfiguredSQLiteLiveRuntimeForTesting({ config: configuration });
    if (!this.runtime.testSupport) throw new TypeError('retained_flow_test_support_missing_after_restore');
    await this.runtime.testSupport.resumeActors(Object.values(this.actors));
    this.record('retained runtime → restored copy resumed');
  }
  close(): void {
    this.runtime.close();
    if (this.cleanupDirectory) cleanupFlowDirectory(this.cleanupDirectory);
  }
}

export async function flowWorld(input: {
  readonly database?: 'default' | 'migration-initialized-empty' | 'retained-frozen';
  readonly retainedConfiguration?: ConfiguredServerConfig;
} = {}): Promise<FlowWorld> { return FlowWorld.create(input); }
