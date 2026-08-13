export type SQLiteFoundationErrorCode =
  | 'artifact_checksum_mismatch'
  | 'artifact_invalid_encoding'
  | 'backup_invalid'
  | 'backup_missing'
  | 'backup_refused'
  | 'backup_too_large'
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
  | 'platform_unsupported'
  | 'receipt_chain_malformed'
  | 'runner_schema_malformed'
  | 'schema_drift'
  | 'status_unstable'
  | 'rebuild_refused'
  | 'recovery_required'
  | 'restore_refused';

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
