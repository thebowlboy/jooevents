export type SQLiteFoundationErrorCode =
  | 'artifact_checksum_mismatch'
  | 'artifact_invalid_encoding'
  | 'database_class_mismatch'
  | 'database_class_required'
  | 'database_busy'
  | 'database_missing'
  | 'database_path_unsafe'
  | 'foreign_keys_unavailable'
  | 'invalid_migration_options'
  | 'migration_required'
  | 'migration_transaction_failed'
  | 'owner_record_malformed'
  | 'receipt_chain_malformed'
  | 'runner_schema_malformed'
  | 'schema_drift'
  | 'status_unstable'
  | 'rebuild_refused'
  | 'recovery_required';

export class SQLiteFoundationError extends Error {
  readonly code: SQLiteFoundationErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: SQLiteFoundationErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'SQLiteFoundationError';
    this.code = code;
    this.details = details;
  }
}

export function isSQLiteFoundationError(error: unknown): error is SQLiteFoundationError {
  return error instanceof SQLiteFoundationError;
}
