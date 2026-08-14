import type {
	PublicApplicationDraftStatusDto,
	PublicApplicationSubmitResultDto,
	ServedPublicFormDto,
	TransientApplicationAnswerInput
} from '@jooevents/contracts';
import {
	newPublicApplicationBootstrap,
	type PublicApplicationClient,
	type PublicApplicationTransportFailure
} from './public-application-client';
import {
	publicApplicationNotOpenView,
	publicApplicationRefusalView,
	publicApplicationSessionGoneView,
	type PublicApplicationRefusalView
} from './view-models/public-application';

/**
 * One submitter's editing session against the published apply surface:
 * begin on start, autosave while editing, resume after interruption, submit
 * once — the durable draft lives on the server, and this machine only ever
 * reconciles toward it.
 *
 * The machine is framework-free and deterministic: the autosave timer and id
 * sources are injectable, network operations are serialized so an autosave
 * never races a submit, and every terminal answer maps through the reviewed
 * refusal vocabulary instead of leaking server classes into interface copy.
 */

export type PublicApplicationSessionPhase =
	| 'idle'
	| 'starting'
	| 'ready'
	| 'saving'
	| 'submitting'
	| 'submitted'
	| 'stopped';

export interface PublicApplicationSessionSnapshot {
	readonly phase: PublicApplicationSessionPhase;
	readonly draft: PublicApplicationDraftStatusDto | null;
	readonly answers: readonly TransientApplicationAnswerInput[];
	readonly dirty: boolean;
	readonly refusal: PublicApplicationRefusalView | null;
	readonly transport: PublicApplicationTransportFailure | null;
	readonly submission: PublicApplicationSubmitResultDto | null;
	readonly continuation: string | null;
	readonly continuationExpiresAt: string | null;
}

export interface PublicApplicationSession {
	state(): PublicApplicationSessionSnapshot;
	subscribe(listener: (snapshot: PublicApplicationSessionSnapshot) => void): () => void;
	/** Mint + begin, or resume the supplied continuation. Safe to retry. */
	start(): Promise<PublicApplicationSessionSnapshot>;
	/** Record one answer locally and schedule an autosave. */
	setAnswer(answer: TransientApplicationAnswerInput): void;
	/** Remove one answer locally and schedule an autosave. */
	clearAnswer(fieldId: string): void;
	/** Save now, if there is anything unsaved. */
	flush(): Promise<PublicApplicationSessionSnapshot>;
	/** Save anything unsaved, then submit. Retries replay idempotently. */
	submit(): Promise<PublicApplicationSessionSnapshot>;
}

export interface PublicApplicationSessionOptions {
	readonly client: PublicApplicationClient;
	readonly formId: string;
	/** The served target; a session-targeted refusal renders the re-offer. */
	readonly target?: ServedPublicFormDto['target'];
	/** Resume an existing ceremony (embed ↔ standalone handoff). */
	readonly continuation?: string;
	readonly autosaveDelayMs?: number;
	readonly schedule?: (run: () => void, delayMs: number) => () => void;
	readonly newIdempotencyKey?: () => string;
	readonly newBootstrap?: () => string;
}

const DEFAULT_AUTOSAVE_DELAY_MS = 1_500;

function defaultSchedule(run: () => void, delayMs: number): () => void {
	const handle = setTimeout(run, delayMs);
	return () => clearTimeout(handle);
}

export function createPublicApplicationSession(
	options: PublicApplicationSessionOptions
): PublicApplicationSession {
	const client = options.client;
	const formId = options.formId;
	const autosaveDelayMs = options.autosaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_MS;
	const schedule = options.schedule ?? defaultSchedule;
	const newIdempotencyKey = options.newIdempotencyKey ?? (() => crypto.randomUUID());
	const newBootstrap = options.newBootstrap ?? (() => newPublicApplicationBootstrap());

	let phase: PublicApplicationSessionPhase = 'idle';
	let draft: PublicApplicationDraftStatusDto | null = null;
	const answers = new Map<string, TransientApplicationAnswerInput>();
	let edits = 0;
	let savedEdits = 0;
	let refusal: PublicApplicationRefusalView | null = null;
	let transport: PublicApplicationTransportFailure | null = null;
	let submission: PublicApplicationSubmitResultDto | null = null;
	let continuation: string | null = options.continuation ?? null;
	let continuationExpiresAt: string | null = null;
	let submitKey: string | null = null;
	let cancelAutosave: (() => void) | null = null;
	const listeners = new Set<(snapshot: PublicApplicationSessionSnapshot) => void>();
	let chain: Promise<unknown> = Promise.resolve();

	function snapshot(): PublicApplicationSessionSnapshot {
		return Object.freeze({
			phase,
			draft,
			answers: Object.freeze([...answers.values()]),
			dirty: edits !== savedEdits,
			refusal,
			transport,
			submission,
			continuation,
			continuationExpiresAt
		});
	}

	function notify(): void {
		const current = snapshot();
		for (const listener of listeners) listener(current);
	}

	function enqueue<Result>(work: () => Promise<Result>): Promise<Result> {
		const next = chain.then(work, work);
		chain = next.catch(() => undefined);
		return next;
	}

	function stopSession(view: PublicApplicationRefusalView): void {
		phase = 'stopped';
		refusal = view;
		cancelAutosave?.();
		cancelAutosave = null;
	}

	function adoptResume(data: {
		readonly draft: PublicApplicationDraftStatusDto;
		readonly answers: readonly TransientApplicationAnswerInput[];
	}): void {
		draft = data.draft;
		answers.clear();
		for (const answer of data.answers) answers.set(answer.fieldId, answer);
		savedEdits = edits;
	}

	async function reconcileFromServer(markChanged: boolean): Promise<boolean> {
		if (continuation === null) return false;
		const resumed = await client.resume({ formId, continuation });
		if (resumed.kind === 'resume') {
			adoptResume(resumed.data);
			refusal = markChanged
				? publicApplicationRefusalView({
						outcome: {
							class: 'conflict', kind: 'intake.changed', retryable: false,
							subjects: [], detail: null, detailSchemaVersion: 1
						},
						...(options.target ? { target: options.target } : {})
					})
				: null;
			phase = 'ready';
			return true;
		}
		if (resumed.kind === 'submitted') {
			submission = resumed.submission;
			phase = 'submitted';
			return true;
		}
		if (resumed.kind === 'stopped') {
			stopSession(publicApplicationSessionGoneView());
			return true;
		}
		transport = resumed.error;
		return false;
	}

	async function saveNow(): Promise<void> {
		if (phase !== 'ready' || draft === null || continuation === null) return;
		if (edits === savedEdits) return;
		const attempted = edits;
		phase = 'saving';
		notify();
		const saved = await client.mutate({
			formId,
			continuation,
			idempotencyKey: newIdempotencyKey(),
			body: {
				action: 'save',
				input: {
					expectedDraftVersion: draft.draftVersion,
					answers: [...answers.values()]
				}
			}
		});
		if (saved.kind === 'success' && saved.data.action === 'save') {
			draft = saved.data.draft;
			savedEdits = attempted;
			transport = null;
			phase = 'ready';
		} else if (saved.kind === 'outcome') {
			if (saved.outcome.class === 'conflict' && saved.outcome.kind === 'intake.changed') {
				phase = 'ready';
				await reconcileFromServer(true);
			} else {
				phase = 'ready';
				refusal = publicApplicationRefusalView({
					outcome: saved.outcome,
					...(options.target ? { target: options.target } : {})
				});
			}
		} else if (saved.kind === 'stopped') {
			stopSession(publicApplicationSessionGoneView());
		} else if (saved.kind === 'transport_error') {
			// Unsaved work survives a transport failure; the next edit retries.
			transport = saved.error;
			phase = 'ready';
		} else {
			transport = { code: 'invalid_contract', retryable: true };
			phase = 'ready';
		}
		notify();
	}

	function scheduleAutosave(): void {
		cancelAutosave?.();
		cancelAutosave = schedule(() => {
			cancelAutosave = null;
			void enqueue(() => saveNow());
		}, autosaveDelayMs);
	}

	return Object.freeze({
		state: snapshot,

		subscribe(listener: (value: PublicApplicationSessionSnapshot) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		start() {
			return enqueue(async () => {
				if (phase !== 'idle') return snapshot();
				phase = 'starting';
				transport = null;
				notify();
				if (continuation !== null) {
					const settled = await reconcileFromServer(false);
					if (!settled) phase = 'idle';
					notify();
					return snapshot();
				}
				let minted = await client.mint({ formId, bootstrap: newBootstrap() });
				if (minted.kind === 'already_issued') {
					// Another mint of the same secret is already live; a fresh
					// secret starts this visitor's own ceremony.
					minted = await client.mint({ formId, bootstrap: newBootstrap() });
				}
				if (minted.kind === 'not_available' || minted.kind === 'rejected'
					|| minted.kind === 'already_issued') {
					stopSession(publicApplicationNotOpenView());
					notify();
					return snapshot();
				}
				if (minted.kind === 'transport_error') {
					transport = minted.error;
					phase = 'idle';
					notify();
					return snapshot();
				}
				continuation = minted.continuation;
				continuationExpiresAt = minted.expiresAt;
				const begun = await client.mutate({
					formId,
					continuation,
					idempotencyKey: newIdempotencyKey(),
					body: { action: 'begin', input: { formId } }
				});
				if (begun.kind === 'success' && begun.data.action === 'begin') {
					draft = begun.data.draft;
					savedEdits = edits;
					phase = 'ready';
				} else if (begun.kind === 'outcome'
					&& begun.outcome.class === 'conflict'
					&& begun.outcome.kind === 'intake.changed') {
					// The ceremony already carries a draft (an earlier begin's
					// response was lost): the server state is the session.
					const settled = await reconcileFromServer(false);
					if (!settled) phase = 'idle';
				} else if (begun.kind === 'outcome') {
					stopSession(publicApplicationRefusalView({
						outcome: begun.outcome,
						...(options.target ? { target: options.target } : {})
					}));
				} else if (begun.kind === 'stopped') {
					stopSession(publicApplicationSessionGoneView());
				} else if (begun.kind === 'transport_error') {
					transport = begun.error;
					phase = 'idle';
					continuation = null;
					continuationExpiresAt = null;
				} else {
					transport = { code: 'invalid_contract', retryable: true };
					phase = 'idle';
					continuation = null;
					continuationExpiresAt = null;
				}
				notify();
				return snapshot();
			});
		},

		setAnswer(answer: TransientApplicationAnswerInput) {
			if (phase === 'submitted' || phase === 'stopped') return;
			answers.set(answer.fieldId, answer);
			edits += 1;
			scheduleAutosave();
			notify();
		},

		clearAnswer(fieldId: string) {
			if (phase === 'submitted' || phase === 'stopped') return;
			if (!answers.delete(fieldId)) return;
			edits += 1;
			scheduleAutosave();
			notify();
		},

		flush() {
			cancelAutosave?.();
			cancelAutosave = null;
			return enqueue(async () => {
				await saveNow();
				return snapshot();
			});
		},

		submit() {
			cancelAutosave?.();
			cancelAutosave = null;
			return enqueue(async () => {
				await saveNow();
				if (phase !== 'ready' || draft === null || continuation === null) {
					return snapshot();
				}
				phase = 'submitting';
				refusal = null;
				notify();
				// One key per submit intent: a retry after response loss replays
				// the identical commit instead of double-submitting.
				submitKey ??= newIdempotencyKey();
				const submitted = await client.mutate({
					formId,
					continuation,
					idempotencyKey: submitKey,
					body: { action: 'submit', input: { expectedDraftVersion: draft.draftVersion } }
				});
				if (submitted.kind === 'success' && submitted.data.action === 'submit') {
					submission = submitted.data.submission;
					transport = null;
					phase = 'submitted';
				} else if (submitted.kind === 'outcome'
					&& submitted.outcome.class === 'conflict'
					&& submitted.outcome.kind === 'intake.changed') {
					submitKey = null;
					phase = 'ready';
					await reconcileFromServer(true);
				} else if (submitted.kind === 'outcome') {
					submitKey = null;
					phase = 'ready';
					refusal = publicApplicationRefusalView({
						outcome: submitted.outcome,
						...(options.target ? { target: options.target } : {})
					});
				} else if (submitted.kind === 'stopped') {
					stopSession(publicApplicationSessionGoneView());
				} else if (submitted.kind === 'transport_error') {
					// The commit may or may not have landed; the key is kept so a
					// retry replays rather than resubmits.
					transport = submitted.error;
					phase = 'ready';
				} else {
					transport = { code: 'invalid_contract', retryable: true };
					phase = 'ready';
				}
				notify();
				return snapshot();
			});
		}
	});
}
