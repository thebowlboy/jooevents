export type NoticeSeverity = 'info' | 'warning';

/** A machine-readable and human-readable observation that does not become an exception. */
export interface OperationalNotice {
  readonly code: string;
  readonly severity: NoticeSeverity;
  readonly message: string;
  readonly field?: string;
}

export interface AdapterError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ConfirmationChoice {
  readonly id: string;
  readonly label: string;
  readonly consequence: string;
}

export interface ConfirmationRequest {
  readonly code: string;
  readonly prompt: string;
  readonly choices: readonly ConfirmationChoice[];
  readonly defaultChoiceId?: string;
}

/**
 * Expected integration results are values, not thrown errors. Callers must handle
 * confirmation and warnings instead of treating every non-success as a crash.
 */
export type AdapterOutcome<T> =
  | {
      readonly kind: 'success';
      readonly data: T;
      readonly notices: readonly OperationalNotice[];
    }
  | {
      readonly kind: 'needs_confirmation';
      readonly proposed?: T;
      readonly confirmation: ConfirmationRequest;
      readonly notices: readonly OperationalNotice[];
    }
  | {
      readonly kind: 'error';
      readonly error: AdapterError;
      readonly notices: readonly OperationalNotice[];
    };

export function success<T>(
  data: T,
  notices: readonly OperationalNotice[] = []
): AdapterOutcome<T> {
  return { kind: 'success', data, notices };
}

export function failure<T>(
  error: AdapterError,
  notices: readonly OperationalNotice[] = []
): AdapterOutcome<T> {
  return { kind: 'error', error, notices };
}
