import type { Database } from 'bun:sqlite';
import {
  resolveMailSenderPresentation,
  type InstallationMailSenderIdentity,
  type MailSenderPresentationResolver,
  type ResolvedMailSenderPresentation
} from '@jooevents/communications';
import { parseInstant, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';

/**
 * The one workspace-scoped outbound sender setting: display name and reply-to.
 * A never-edited workspace has no row and reads as head version 1 with both
 * values absent, so "unset" is a real absence rather than a seeded default that
 * would be indistinguishable from a deliberate choice.
 *
 * The database repeats the header-safety bound the acceptance layer enforces.
 * That duplication is deliberate: these bytes end up in a mail header, and a
 * row reaching them by any other path — a repair script, a restore, a future
 * writer — must still be structurally incapable of carrying CR or LF.
 *
 * Additive disposable schema. It is intentionally not a retained migration.
 */
export const SQLITE_WORKSPACE_SENDER_IDENTITY_SQL = `
CREATE TABLE workspace_mail_sender_identity (
  workspace_id TEXT PRIMARY KEY,
  head_version INTEGER NOT NULL CHECK(head_version > 1),
  display_name TEXT CHECK(
    display_name IS NULL
    OR (
      length(display_name) BETWEEN 1 AND 200
      AND display_name = trim(display_name)
      AND instr(display_name, char(10)) = 0
      AND instr(display_name, char(13)) = 0
      AND instr(display_name, char(0)) = 0
    )
  ),
  reply_to_address TEXT CHECK(
    reply_to_address IS NULL
    OR (
      length(reply_to_address) BETWEEN 3 AND 320
      AND reply_to_address = trim(reply_to_address)
      AND instr(reply_to_address, char(10)) = 0
      AND instr(reply_to_address, char(13)) = 0
      AND instr(reply_to_address, char(0)) = 0
      AND instr(reply_to_address, ',') = 0
      AND instr(reply_to_address, ';') = 0
      AND instr(reply_to_address, '<') = 0
      AND instr(reply_to_address, '>') = 0
    )
  ),
  updated_at TEXT NOT NULL,
  -- The acting principal, honestly typed: a browser edit names a workspace
  -- user; an agent edit on the app_model lane names its run and has no user.
  updated_by_actor_key TEXT NOT NULL CHECK(length(updated_by_actor_key) BETWEEN 1 AND 256),
  updated_by_user_id TEXT,
  CHECK((updated_by_user_id IS NOT NULL) = (updated_by_actor_key GLOB 'workspace_user:*')),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER workspace_mail_sender_identity_version_advances_once
BEFORE UPDATE OF head_version ON workspace_mail_sender_identity
WHEN NEW.head_version != OLD.head_version + 1
BEGIN SELECT RAISE(ABORT, 'workspace sender identity version must advance once'); END;

CREATE TRIGGER workspace_mail_sender_identity_scope_immutable
BEFORE UPDATE OF workspace_id ON workspace_mail_sender_identity
BEGIN SELECT RAISE(ABORT, 'workspace sender identity scope is immutable'); END;

CREATE TRIGGER workspace_mail_sender_identity_no_delete
BEFORE DELETE ON workspace_mail_sender_identity
BEGIN SELECT RAISE(ABORT, 'workspace sender identity rows are retained'); END;
`;

export function installWorkspaceSenderIdentitySchema(sqlite: Database): void {
  if (sqlite.inTransaction) {
    throw new TypeError('workspace_sender_identity_schema_inside_transaction');
  }
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_WORKSPACE_SENDER_IDENTITY_SQL)).immediate();
}

/** The unedited head: no row, version 1, nothing overriding the installation. */
export const WORKSPACE_SENDER_IDENTITY_INITIAL_HEAD_VERSION = 1;

export interface WorkspaceSenderIdentityHead {
  readonly workspaceId: string;
  readonly headVersion: number;
  readonly displayName: string | null;
  readonly replyToAddress: string | null;
  readonly updatedAt: string | null;
}

export type WorkspaceSenderIdentityApplication =
  | Readonly<{ kind: 'applied'; head: WorkspaceSenderIdentityHead }>
  | Readonly<{ kind: 'stale'; head: WorkspaceSenderIdentityHead }>;

interface HeadRow {
  readonly head_version: number;
  readonly display_name: string | null;
  readonly reply_to_address: string | null;
  readonly updated_at: string;
}

function unedited(workspaceId: string): WorkspaceSenderIdentityHead {
  return Object.freeze({
    workspaceId,
    headVersion: WORKSPACE_SENDER_IDENTITY_INITIAL_HEAD_VERSION,
    displayName: null,
    replyToAddress: null,
    updatedAt: null
  });
}

export class SQLiteWorkspaceSenderIdentityStore {
  constructor(private readonly sqlite: Database) {}

  read(workspaceIdInput: string): WorkspaceSenderIdentityHead {
    const workspaceId = parseWorkspaceId(workspaceIdInput);
    const row = this.sqlite.query<HeadRow, [WorkspaceId]>(`
      SELECT head_version, display_name, reply_to_address, updated_at
        FROM workspace_mail_sender_identity WHERE workspace_id = ?
    `).get(workspaceId);
    if (!row) return unedited(workspaceId);
    return Object.freeze({
      workspaceId,
      headVersion: row.head_version,
      displayName: row.display_name,
      replyToAddress: row.reply_to_address,
      updatedAt: parseInstant(row.updated_at)
    });
  }

  /**
   * Advances the head exactly once when the caller's expected version is the
   * current one; any other expectation reports `stale` with the current head so
   * the surface re-reads rather than overwriting a concurrent edit.
   */
  apply(input: {
    readonly workspaceId: string;
    readonly expectedHeadVersion: number;
    readonly displayName: string | null;
    readonly replyToAddress: string | null;
    readonly updatedAt: string;
    /** `workspace_user:<userId>` for a person, `<actorKind>:<id>` for anything else. */
    readonly updatedByActorKey: string;
    readonly updatedByUserId: string | null;
  }): WorkspaceSenderIdentityApplication {
    if (!this.sqlite.inTransaction) {
      throw new TypeError('workspace_sender_identity_transaction_required');
    }
    const workspaceId = parseWorkspaceId(input.workspaceId);
    const updatedAt = parseInstant(input.updatedAt);
    const current = this.read(workspaceId);
    if (current.headVersion !== input.expectedHeadVersion) {
      return Object.freeze({ kind: 'stale', head: current });
    }
    const nextVersion = current.headVersion + 1;
    const changes = current.updatedAt === null
      ? this.sqlite.query<never, [
          WorkspaceId, number, string | null, string | null, string, string, string | null
        ]>(`
          INSERT INTO workspace_mail_sender_identity (
            workspace_id, head_version, display_name, reply_to_address,
            updated_at, updated_by_actor_key, updated_by_user_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          workspaceId, nextVersion, input.displayName, input.replyToAddress,
          updatedAt, input.updatedByActorKey, input.updatedByUserId
        ).changes
      : this.sqlite.query<never, [
          number, string | null, string | null, string, string, string | null,
          WorkspaceId, number
        ]>(`
          UPDATE workspace_mail_sender_identity
             SET head_version = ?, display_name = ?, reply_to_address = ?,
                 updated_at = ?, updated_by_actor_key = ?, updated_by_user_id = ?
           WHERE workspace_id = ? AND head_version = ?
        `).run(
          nextVersion, input.displayName, input.replyToAddress,
          updatedAt, input.updatedByActorKey, input.updatedByUserId,
          workspaceId, current.headVersion
        ).changes;
    if (changes !== 1) throw new TypeError('workspace_sender_identity_write_not_applied');
    return Object.freeze({ kind: 'applied', head: this.read(workspaceId) });
  }
}

/**
 * The per-send resolver both security-mail deliveries hold. It reads the
 * current head on every call, so an operator's edit lands on the next mail
 * without a restart; the from-address is always the installation's.
 */
export function createSQLiteMailSenderPresentationResolver(input: {
  readonly sqlite: Database;
  readonly workspaceId: string;
  readonly installation: InstallationMailSenderIdentity;
}): MailSenderPresentationResolver {
  const store = new SQLiteWorkspaceSenderIdentityStore(input.sqlite);
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const installation = Object.freeze({ ...input.installation });
  return Object.freeze({
    resolve(): ResolvedMailSenderPresentation {
      const head = store.read(workspaceId);
      return resolveMailSenderPresentation({
        installation,
        workspace: Object.freeze({
          displayName: head.displayName,
          replyToAddress: head.replyToAddress
        })
      });
    }
  });
}
