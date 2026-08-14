import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OpaqueSecretTextResolver } from './communications-provider-runtime';

/**
 * File-backed resolver for the `deployment.secret` opaque secret store.
 *
 * A reference names one file inside the deployment secret directory
 * (`~/.config/jooevents` by default). The file must be a regular file with
 * mode 0600; its trimmed content is leased to exactly one consumer callback
 * and is never stored on the resolver, never logged, and never carried by an
 * error. Every failure is a typed `DeploymentSecretResolutionError` whose
 * message is exactly its code, so callers can surface an honest typed outcome
 * without any risk of echoing secret material.
 */

export const DEPLOYMENT_SECRET_STORE_KEY = 'deployment.secret';

const MAXIMUM_SECRET_FILE_BYTES = 8_192;
const MAXIMUM_SECRET_TEXT_LENGTH = 4_096;
/** One plain file name: no path separators, no leading dot, bounded length. */
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type DeploymentSecretResolutionErrorCode =
  | 'unknown_store'
  | 'invalid_reference'
  | 'secret_not_found'
  | 'secret_not_a_file'
  | 'secret_permissions_too_open'
  | 'secret_unreadable'
  | 'secret_value_invalid';

export class DeploymentSecretResolutionError extends Error {
  constructor(readonly code: DeploymentSecretResolutionErrorCode) {
    // The message is exactly the code. No path, no file content, and no
    // secret material may ever ride an error out of this resolver.
    super(code);
    this.name = 'DeploymentSecretResolutionError';
  }
}

function validSecretText(value: string): boolean {
  return value.length >= 1
    && value.length <= MAXIMUM_SECRET_TEXT_LENGTH
    && /^[\x21-\x7e]+$/u.test(value);
}

/**
 * Creates the concrete `deployment.secret` resolver. The secret text exists
 * only inside the lease callback frame; the resolver holds neither the bytes
 * nor the decoded value after `use` settles.
 */
export function createDeploymentSecretFileResolver(input?: Readonly<{
  /** Test seam. Defaults to `~/.config/jooevents`. */
  baseDirectory?: string;
}>): OpaqueSecretTextResolver {
  const baseDirectory = input?.baseDirectory ?? join(homedir(), '.config', 'jooevents');
  return Object.freeze({
    async withSecretText<Result>(
      reference: Readonly<{ storeKey: string; reference: string }>,
      use: (value: string) => Promise<Result>
    ): Promise<Result> {
      if (reference.storeKey !== DEPLOYMENT_SECRET_STORE_KEY) {
        throw new DeploymentSecretResolutionError('unknown_store');
      }
      if (!referencePattern.test(reference.reference)) {
        throw new DeploymentSecretResolutionError('invalid_reference');
      }
      const path = join(baseDirectory, reference.reference);
      let mode: number;
      let size: number;
      let regular: boolean;
      try {
        const stats = await stat(path);
        mode = stats.mode & 0o777;
        size = stats.size;
        regular = stats.isFile();
      } catch {
        throw new DeploymentSecretResolutionError('secret_not_found');
      }
      if (!regular) throw new DeploymentSecretResolutionError('secret_not_a_file');
      if (mode !== 0o600) {
        throw new DeploymentSecretResolutionError('secret_permissions_too_open');
      }
      if (size < 1 || size > MAXIMUM_SECRET_FILE_BYTES) {
        throw new DeploymentSecretResolutionError('secret_value_invalid');
      }
      let text: string;
      try {
        text = (await readFile(path, { encoding: 'utf8' })).trim();
      } catch {
        throw new DeploymentSecretResolutionError('secret_unreadable');
      }
      if (!validSecretText(text)) {
        throw new DeploymentSecretResolutionError('secret_value_invalid');
      }
      // Hand the value to exactly this one consumer; keep no other reference.
      return use(text);
    }
  });
}
